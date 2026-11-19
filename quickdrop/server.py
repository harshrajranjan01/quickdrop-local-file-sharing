"""FastAPI application, room signaling, shared storage, and relay fallback."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import time
import uuid
import zlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import qrcode
import psutil
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import network, storage


PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = PROJECT_ROOT / "static"


class AppSettings:
    def __init__(self, data_root: Path | None = None, max_file_mb: int | None = None):
        self.data_root = Path(data_root) if data_root else PROJECT_ROOT / "QuickDrop"
        self.shared_dir = self.data_root / "Shared"
        self.temp_dir = self.data_root / "Temp"
        self.relay_dir = self.temp_dir / "relays"
        self.upload_temp_dir = self.temp_dir / "uploads"
        self.max_file_mb = max_file_mb or int(os.getenv("QUICKDROP_MAX_FILE_MB", "2048"))
        self.room_id = uuid.uuid4().hex[:12]
        self.room_token = uuid.uuid4().hex + uuid.uuid4().hex
        self.devices: dict[str, dict[str, Any]] = {}
        self.transfers: dict[str, dict[str, Any]] = {}
        self.ws_lock = asyncio.Lock()
        self.transfer_lock = asyncio.Lock()
        self.relay_io_semaphore = asyncio.Semaphore(4)
        self.hotspot_ssid: str | None = None
        self.hotspot_password: str | None = None
        self.network_mode = "wifi"
        self.hotspot_auto = False
        self.preferred_ip: str | None = None
        self._load_saved_settings()
        self.shared_dir.mkdir(parents=True, exist_ok=True)
        self.relay_dir.mkdir(parents=True, exist_ok=True)
        self.upload_temp_dir.mkdir(parents=True, exist_ok=True)

    @property
    def max_file_bytes(self) -> int:
        return self.max_file_mb * 1024 * 1024

    def _load_saved_settings(self) -> None:
        path = self.data_root / "settings.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            value = int(data.get("max_file_mb", self.max_file_mb))
            if 1 <= value <= 100_000:
                self.max_file_mb = value
            self.preferred_ip = data.get("preferred_ip") or None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    def save_max_file_mb(self) -> None:
        self.data_root.mkdir(parents=True, exist_ok=True)
        (self.data_root / "settings.json").write_text(
            json.dumps({"max_file_mb": self.max_file_mb, "preferred_ip": self.preferred_ip}, indent=2), encoding="utf-8"
        )


class SettingsUpdate(BaseModel):
    max_file_mb: int = Field(ge=1, le=100_000)


class HotspotRequest(BaseModel):
    action: str
    ssid: str | None = None
    password: str | None = None


class NetworkInterfaceRequest(BaseModel):
    ip: str | None = None


class ZipRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1, max_length=500)


class DeleteFilesRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1, max_length=500)


def _qr_data_uri(value: str) -> str:
    image = qrcode.make(value)
    from io import BytesIO

    output = BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def _connection_url(request: Request, state: AppSettings, snapshot: dict[str, Any]) -> str | None:
    ip = snapshot.get("local_ip")
    if not ip:
        return None
    scheme = "https" if request.url.scheme == "https" else "http"
    port = request.url.port or (443 if scheme == "https" else 80)
    default_port = 443 if scheme == "https" else 80
    authority = ip if port == default_port else f"{ip}:{port}"
    return f"{scheme}://{authority}/?room={state.room_id}&token={state.room_token}"


def _is_local_request(request: Request, snapshot: dict[str, Any]) -> bool:
    host = request.client.host if request.client else ""
    local_ips = {item["ip"] for item in snapshot.get("interfaces", [])}
    return host in {"127.0.0.1", "::1", "localhost"} or host in local_ips


def _snapshot(state: AppSettings) -> dict[str, Any]:
    snapshot = network.network_snapshot(prefer_hotspot=state.network_mode == "hotspot", preferred_ip=state.preferred_ip)
    if state.preferred_ip and not any(item["ip"] == state.preferred_ip for item in snapshot["interfaces"]):
        state.preferred_ip = None
        state.save_max_file_mb()
    snapshot["preferred_ip"] = state.preferred_ip
    return snapshot


def _require_room(state: AppSettings, room_token: str | None) -> None:
    if not room_token or not secrets_compare(room_token, state.room_token):
        raise HTTPException(status_code=403, detail="This QuickDrop room link is invalid or expired.")


def secrets_compare(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a, b)


def _cleanup_stale_temp(state: AppSettings, relay_cutoff: float, upload_cutoff: float, active_transfers: set[str]) -> None:
    """Remove abandoned transfer data off the startup path, leaving fresh work alone."""
    for root, cutoff, skip_names in (
        (state.relay_dir, relay_cutoff, active_transfers),
        (state.upload_temp_dir, upload_cutoff, set()),
    ):
        try:
            items = list(root.iterdir())
        except OSError:
            continue
        for item in items:
            try:
                if item.name in skip_names or item.stat().st_mtime >= cutoff:
                    continue
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)
            except OSError:
                pass


def _hash_relay_file(path: Path, expected_size: int, chunk_size: int) -> tuple[str, str] | None:
    if not path.is_file() or path.stat().st_size != expected_size:
        return None
    digest = hashlib.sha256()
    crc = 0
    with path.open("rb") as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
    return digest.hexdigest(), f"{crc & 0xffffffff:08x}"


def _sample_transfer_rate(metrics: dict[str, Any], stage: str, loaded: int, now: float) -> None:
    samples = metrics.setdefault("_samples", {})
    previous = samples.get(stage)
    loaded = max(0, int(loaded))
    if previous is None:
        samples[stage] = (now, loaded)
        return
    previous_at, previous_loaded = previous
    elapsed = now - previous_at
    if elapsed < 0.25 or loaded < previous_loaded:
        return
    instant = (loaded - previous_loaded) / max(elapsed, 0.001)
    key = f"{stage}_rate_bps"
    old_rate = float(metrics.get(key, 0.0))
    metrics[key] = instant if not old_rate else old_rate * 0.65 + instant * 0.35
    samples[stage] = (now, loaded)


async def _stream_verified_relay_file(
    path: Path,
    relay_file: dict[str, Any],
    expected_size: int,
    chunk_size: int,
    io_semaphore: asyncio.Semaphore,
    offset: int = 0,
):
    """Wait for whole-file verification, then stream it in bounded disk reads."""
    if offset < 0 or offset > expected_size:
        raise ValueError("The requested relay offset is outside the file.")
    while True:
        async with relay_file["condition"]:
            await relay_file["condition"].wait_for(lambda: relay_file["verified"] or relay_file["failure"])
            committed = min(expected_size, int(relay_file["committed_offset"]))
            verified = bool(relay_file["verified"])
            failure = relay_file["failure"]
        if failure:
            raise RuntimeError(failure)
        if not verified or committed != expected_size:
            raise RuntimeError("The relay marked a file verified before all bytes were saved.")
        if offset == expected_size:
            return
        amount = min(chunk_size, committed - offset)
        async with io_semaphore:
            chunk = await asyncio.to_thread(storage.read_file_range, path, offset, amount)
        if not chunk:
            raise RuntimeError("The relay file changed while it was being streamed.")
        offset += len(chunk)
        yield chunk


def create_app(data_root: Path | None = None, max_file_mb: int | None = None) -> FastAPI:
    state = AppSettings(data_root, max_file_mb)

    async def cleanup_startup_temp() -> None:
        # Let the server become available first. Old relay state cannot resume after a
        # restart, but large abandoned folders must not delay the next launch.
        await asyncio.sleep(2)
        async with state.transfer_lock:
            active_transfers = set(state.transfers)
        now = time.time()
        await asyncio.to_thread(
            _cleanup_stale_temp,
            state,
            now - 30,
            now - 24 * 60 * 60,
            active_transfers,
        )

    async def cleanup_loop() -> None:
        while True:
            await asyncio.sleep(300)
            cutoff = asyncio.get_running_loop().time() - 6 * 3600
            async with state.transfer_lock:
                expired = [key for key, transfer in state.transfers.items() if transfer.get("last_activity", transfer.get("created", 0)) < cutoff]
                for transfer_id in expired:
                    transfer = state.transfers.pop(transfer_id, None)
                    if transfer:
                        await wake_relay_streams(transfer, failure="The relay transfer expired.")
            for transfer_id in expired:
                await asyncio.to_thread(shutil.rmtree, state.relay_dir / transfer_id, ignore_errors=True)
            for item in state.temp_dir.glob("quickdrop-*.zip"):
                try:
                    if item.stat().st_mtime < time.time() - 3600:
                        item.unlink(missing_ok=True)
                except OSError:
                    pass

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(cleanup_loop())
        startup_cleanup_task = asyncio.create_task(cleanup_startup_temp())
        try:
            yield
        finally:
            task.cancel()
            startup_cleanup_task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            try:
                await startup_cleanup_task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="QuickDrop", version="1.0.0", lifespan=lifespan)
    app.state.quickdrop = state
    app.mount("/static", StaticFiles(directory=WEB_ROOT), name="static")

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(WEB_ROOT / "index.html")

    @app.get("/api/bootstrap")
    async def bootstrap(request: Request, room: str | None = None, token: str | None = None):
        snapshot = _snapshot(state)
        local_host = _is_local_request(request, snapshot)
        if room is not None or token is not None:
            if room != state.room_id or not secrets_compare(token or "", state.room_token):
                raise HTTPException(status_code=403, detail="This QuickDrop room link is invalid or expired.")
        elif not local_host:
            raise HTTPException(status_code=403, detail="Join this room by scanning the host's QR code.")
        url = _connection_url(request, state, snapshot)
        wifi_qr = None
        if state.hotspot_ssid and state.hotspot_password:
            wifi_qr = _qr_data_uri(network.wifi_qr_payload(state.hotspot_ssid, state.hotspot_password))
        payload = {
            "app": "QuickDrop",
            "room_id": state.room_id,
            "room_token": state.room_token,
            "is_host": local_host,
            "network_mode": state.network_mode,
            "connection_url": url,
            "connection_qr": _qr_data_uri(url) if url else None,
            "wifi_qr": wifi_qr,
            "network": snapshot,
            "max_file_mb": state.max_file_mb,
            "shared_directory": str(state.shared_dir),
            "devices": [
                {key: value for key, value in device.items() if key != "websocket"}
                for device in state.devices.values()
            ],
        }
        response = JSONResponse(payload)
        response.set_cookie(
            "quickdrop_room", state.room_token, httponly=True,
            secure=request.url.scheme == "https", samesite="strict", path="/api", max_age=24 * 60 * 60,
        )
        return response

    @app.get("/api/network")
    async def get_network(x_room_token: str | None = Header(default=None)):
        _require_room(state, x_room_token)
        return _snapshot(state)

    @app.post("/api/network/interface")
    async def set_network_interface(
        payload: NetworkInterfaceRequest,
        request: Request,
        x_room_token: str | None = Header(default=None),
    ):
        _require_room(state, x_room_token)
        if not _is_local_request(request, _snapshot(state)):
            raise HTTPException(status_code=403, detail="Only the host laptop can choose the network interface.")
        ip = (payload.ip or "").strip() or None
        available = {item["ip"] for item in network.discover_interfaces()}
        if ip and ip not in available:
            raise HTTPException(status_code=400, detail="Choose an active local network interface.")
        state.preferred_ip = ip
        state.save_max_file_mb()
        return _snapshot(state)

    @app.post("/api/settings")
    async def update_settings(payload: SettingsUpdate, request: Request, x_room_token: str | None = Header(default=None)):
        _require_room(state, x_room_token)
        if not _is_local_request(request, _snapshot(state)):
            raise HTTPException(status_code=403, detail="Only the host laptop can change the file size limit.")
        state.max_file_mb = payload.max_file_mb
        state.save_max_file_mb()
        return {"max_file_mb": state.max_file_mb}

    @app.post("/api/hotspot")
    async def hotspot(payload: HotspotRequest, request: Request, x_room_token: str | None = Header(default=None)):
        _require_room(state, x_room_token)
        if not _is_local_request(request, _snapshot(state)):
            raise HTTPException(status_code=403, detail="Only the host laptop can change network settings.")
        if payload.action == "start":
            ssid = (payload.ssid or "").strip()
            password = payload.password or ""
            result = network.start_legacy_hotspot(ssid, password)
            if result["ok"]:
                state.hotspot_ssid, state.hotspot_password = ssid, password
                state.hotspot_auto = True
                state.network_mode = "hotspot"
                state.preferred_ip = None
        elif payload.action == "stop":
            result = network.stop_legacy_hotspot()
            state.hotspot_ssid = state.hotspot_password = None
            state.hotspot_auto = False
            state.network_mode = "wifi"
            state.preferred_ip = None
        elif payload.action == "manual":
            state.hotspot_ssid = (payload.ssid or "").strip() or None
            state.hotspot_password = payload.password or None
            state.hotspot_auto = False
            state.network_mode = "hotspot"
            state.preferred_ip = None
            result = {
                "ok": True,
                "message": "In Windows settings, configure Mobile Hotspot with exactly the name and password shown above. Once it is on, scan the Wi-Fi QR code to join. QuickDrop detects its IP when Windows brings the adapter online.",
                "open_settings": "ms-settings:network-mobilehotspot",
            }
        elif payload.action == "wifi":
            if state.hotspot_auto:
                result = network.stop_legacy_hotspot()
            else:
                result = {"ok": True, "message": "QuickDrop is using the existing Wi-Fi network. Turn off a manually enabled Windows hotspot in Settings if it is still running."}
            state.hotspot_ssid = state.hotspot_password = None
            state.hotspot_auto = False
            state.network_mode = "wifi"
            state.preferred_ip = None
        else:
            raise HTTPException(status_code=400, detail="Choose start, stop, or manual.")
        state.save_max_file_mb()
        result["network"] = _snapshot(state)
        result["network_mode"] = state.network_mode
        result["wifi_qr"] = (
            _qr_data_uri(network.wifi_qr_payload(state.hotspot_ssid, state.hotspot_password))
            if state.hotspot_ssid and state.hotspot_password
            else None
        )
        return result

    @app.get("/api/files")
    async def get_files(x_room_token: str | None = Header(default=None)):
        _require_room(state, x_room_token)
        return {"files": storage.list_files(state.shared_dir), "max_file_mb": state.max_file_mb}

    @app.post("/api/files")
    async def upload_files(
        files: list[UploadFile] = File(...),
        x_room_token: str | None = Header(default=None),
    ):
        _require_room(state, x_room_token)
        results = []
        for upload in files:
            try:
                results.append({"ok": True, **(await storage.save_upload(upload, state.shared_dir, state.max_file_bytes, state.upload_temp_dir))})
            except ValueError as exc:
                results.append({"ok": False, "name": storage.sanitize_filename(upload.filename or "upload.bin"), "error": str(exc)})
            except OSError:
                results.append({"ok": False, "name": storage.sanitize_filename(upload.filename or "upload.bin"), "error": "The shared drive could not save this file. Check available disk space."})
        return {"results": results}

    @app.post("/api/files/delete")
    async def delete_files(
        payload: DeleteFilesRequest,
        request: Request,
        x_room_token: str | None = Header(default=None),
    ):
        _require_room(state, x_room_token)
        if not _is_local_request(request, _snapshot(state)):
            raise HTTPException(status_code=403, detail="Only the host laptop can delete shared files.")
        deleted = []
        errors = []
        for file_id in dict.fromkeys(payload.file_ids):
            try:
                result = storage.delete_file(state.shared_dir, file_id)
                if result is None:
                    errors.append({"id": file_id, "error": "File is no longer available."})
                else:
                    deleted.append(result)
            except OSError:
                errors.append({"id": file_id, "error": "Could not delete this file. It may be open or the folder may be read-only."})
        return {"deleted": deleted, "errors": errors, "deleted_count": len(deleted)}

    @app.get("/api/files/{file_id}/download")
    async def download_file(
        file_id: str,
        request: Request,
        token: str | None = Query(default=None),
        x_room_token: str | None = Header(default=None),
    ):
        _require_room(state, x_room_token or token or request.cookies.get("quickdrop_room"))
        path = storage.file_by_id(state.shared_dir, file_id)
        if path is None:
            raise HTTPException(status_code=404, detail="That shared file is no longer available.")
        filename = path.name.split("__", 1)[1]
        return FileResponse(path, filename=filename, media_type="application/octet-stream")

    @app.get("/api/transfers/performance")
    async def transfer_performance(
        x_room_token: str | None = Header(default=None),
        x_device_id: str | None = Header(default=None),
    ):
        _require_room(state, x_room_token)
        now = time.monotonic()
        try:
            process = psutil.Process(os.getpid())
            host_cpu_percent = process.cpu_percent(interval=None)
            host_memory_bytes = process.memory_info().rss
        except (OSError, psutil.Error):
            host_cpu_percent = None
            host_memory_bytes = None
        active = []
        for transfer in state.transfers.values():
            if transfer.get("completed"):
                continue
            if x_device_id and x_device_id not in {transfer["from"], transfer["to"]}:
                continue
            source = state.devices.get(transfer["from"], {})
            target = state.devices.get(transfer["to"], {})
            metrics = transfer.get("metrics", {})
            started_at = metrics.get("started_at")
            active.append({
                "id": transfer["id"],
                "from": {"id": transfer["from"], "name": source.get("name", "Disconnected device")},
                "to": {"id": transfer["to"], "name": target.get("name", "Disconnected device")},
                "files": transfer["files"],
                "loaded": transfer.get("loaded", 0),
                "total": transfer.get("total", sum(item["size"] for item in transfer["files"])),
                "rate_bps": transfer.get("rate_bps", 0),
                "uploaded_bytes": metrics.get("uploaded_bytes", 0),
                "downloaded_bytes": metrics.get("downloaded_bytes", 0),
                "end_to_end_bytes": metrics.get("end_to_end_bytes", 0),
                "upload_rate_bps": metrics.get("upload_rate_bps", 0),
                "download_rate_bps": metrics.get("download_rate_bps", 0),
                "end_to_end_rate_bps": metrics.get("end_to_end_rate_bps", 0),
                "duration_seconds": max(0, now - started_at) if started_at else 0,
                "phase": transfer.get("phase", "Waiting for approval"),
                "transport": transfer.get("transport", "pending"),
                "paused": bool(transfer.get("paused")),
                "manual_paused": bool(transfer.get("manual_paused")),
                "connection_paused": bool(transfer.get("connection_paused_devices")),
                "age_seconds": max(0, now - transfer.get("created", now)),
                "last_activity_seconds": max(0, now - transfer.get("last_activity", now)),
            })
        return {
            "server_online": True,
            "active_transfers": active,
            "host_cpu_percent": host_cpu_percent,
            "host_memory_bytes": host_memory_bytes,
            "sampled_at": datetime.now(timezone.utc).isoformat(),
        }

    @app.post("/api/files/zip")
    async def download_zip(payload: ZipRequest, x_room_token: str | None = Header(default=None)):
        _require_room(state, x_room_token)
        try:
            path = await asyncio.to_thread(storage.create_zip, state.shared_dir, payload.file_ids, state.temp_dir)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="One or more selected files are no longer available.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except OSError:
            raise HTTPException(status_code=507, detail="QuickDrop could not create the ZIP. Check free disk space and folder permissions.")
        return FileResponse(
            path,
            filename="QuickDrop-files.zip",
            media_type="application/zip",
            background=BackgroundTask(path.unlink, missing_ok=True),
        )

    @app.get("/api/files/zip-download")
    async def download_zip_stream(
        request: Request,
        file_ids: str = Query(min_length=1, max_length=20_000),
        token: str | None = Query(default=None),
    ):
        _require_room(state, token or request.cookies.get("quickdrop_room"))
        ids = [item for item in file_ids.split(",") if item]
        if not ids or len(ids) > 500:
            raise HTTPException(status_code=400, detail="Select between 1 and 500 files.")
        try:
            path = await asyncio.to_thread(storage.create_zip, state.shared_dir, ids, state.temp_dir)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="One or more selected files are no longer available.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except OSError:
            raise HTTPException(status_code=507, detail="QuickDrop could not create the ZIP. Check free disk space and folder permissions.")
        return FileResponse(
            path,
            filename="QuickDrop-files.zip",
            media_type="application/zip",
            background=BackgroundTask(path.unlink, missing_ok=True),
        )

    @app.post("/api/files/zip-download")
    async def download_zip_form(request: Request, file_ids: list[str] = Form(...)):
        _require_room(state, request.cookies.get("quickdrop_room"))
        if not 1 <= len(file_ids) <= 500:
            raise HTTPException(status_code=400, detail="Select between 1 and 500 files.")
        try:
            path = await asyncio.to_thread(storage.create_zip, state.shared_dir, file_ids, state.temp_dir)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="One or more selected files are no longer available.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except OSError:
            raise HTTPException(status_code=507, detail="QuickDrop could not create the ZIP. Check free disk space and folder permissions.")
        return FileResponse(
            path,
            filename="QuickDrop-files.zip",
            media_type="application/zip",
            background=BackgroundTask(path.unlink, missing_ok=True),
        )

    def get_transfer(transfer_id: str, room_token: str | None, device_id: str | None) -> dict[str, Any]:
        _require_room(state, room_token)
        transfer = state.transfers.get(transfer_id)
        if transfer is None or device_id not in {transfer["from"], transfer["to"]}:
            raise HTTPException(status_code=404, detail="That transfer has expired or is unavailable.")
        if not transfer.get("accepted"):
            raise HTTPException(status_code=409, detail="The receiver has not accepted this transfer.")
        return transfer

    async def wake_relay_streams(transfer: dict[str, Any], failure: str | None = None, verified: bool = False) -> None:
        for relay_file in transfer.get("relay_file_states", []):
            async with relay_file["condition"]:
                if failure:
                    relay_file["failure"] = failure
                if verified:
                    relay_file["verified"] = True
                relay_file["condition"].notify_all()

    async def live_relay_body(transfer: dict[str, Any], file_index: int, offset: int):
        item = transfer["files"][file_index]
        relay_file = transfer["relay_file_states"][file_index]
        path = state.relay_dir / transfer["id"] / f"{file_index}.bin"
        expected_size = int(item["size"])
        chunk_size = int(transfer.get("relay_chunk_size", storage.DEFAULT_RELAY_CHUNK_SIZE))
        async for chunk in _stream_verified_relay_file(
            path,
            relay_file,
            expected_size,
            chunk_size,
            state.relay_io_semaphore,
            offset=offset,
        ):
            transfer["last_activity"] = asyncio.get_running_loop().time()
            yield chunk

    @app.post("/api/relay/{transfer_id}/{file_index}")
    async def relay_upload(
        transfer_id: str,
        file_index: int,
        request: Request,
        offset: int = Query(ge=0),
        x_room_token: str | None = Header(default=None),
        x_device_id: str | None = Header(default=None),
    ):
        transfer = get_transfer(transfer_id, x_room_token, x_device_id)
        if x_device_id != transfer["from"]:
            raise HTTPException(status_code=403, detail="Only the sender can upload relay chunks.")
        if file_index < 0 or file_index >= len(transfer["files"]):
            raise HTTPException(status_code=404, detail="File index is invalid.")
        item = transfer["files"][file_index]
        path = state.relay_dir / transfer_id / f"{file_index}.bin"
        async with transfer["lock"]:
            try:
                raw_length = request.headers.get("content-length")
                content_length = int(raw_length) if raw_length is not None else None
                async with state.relay_io_semaphore:
                    written = await storage.write_relay_chunk(
                        path,
                        request.stream(),
                        offset,
                        item["size"],
                        max_chunk=int(transfer.get("relay_chunk_size", storage.CHUNK_SIZE)),
                        content_length=content_length,
                    )
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
            except (TypeError, OverflowError):
                raise HTTPException(status_code=400, detail="Invalid relay request body length.")
            except OSError:
                raise HTTPException(status_code=507, detail="The laptop relay ran out of storage or could not write its temporary file.")
            relay_file = transfer["relay_file_states"][file_index]
            async with relay_file["condition"]:
                relay_file["committed_offset"] = written
                relay_file["condition"].notify_all()
            transfer["metrics"]["uploaded_bytes"] = sum(int(file["size"]) for file in transfer["files"][:file_index]) + written
            transfer["last_activity"] = asyncio.get_running_loop().time()
        return {"offset": written, "size": item["size"]}

    @app.get("/api/relay/{transfer_id}/{file_index}/offset")
    async def relay_upload_offset(
        transfer_id: str,
        file_index: int,
        x_room_token: str | None = Header(default=None),
        x_device_id: str | None = Header(default=None),
    ):
        transfer = get_transfer(transfer_id, x_room_token, x_device_id)
        if x_device_id != transfer["from"]:
            raise HTTPException(status_code=403, detail="Only the sender can inspect relay upload progress.")
        if file_index < 0 or file_index >= len(transfer["files"]):
            raise HTTPException(status_code=404, detail="File index is invalid.")
        path = state.relay_dir / transfer_id / f"{file_index}.bin"
        offset = int(transfer["relay_file_states"][file_index]["committed_offset"])
        if offset > transfer["files"][file_index]["size"]:
            raise HTTPException(status_code=409, detail="The relay file is larger than the transfer request.")
        return {"offset": offset, "size": transfer["files"][file_index]["size"]}

    @app.get("/api/relay/{transfer_id}/{file_index}")
    async def relay_download(
        transfer_id: str,
        file_index: int,
        offset: int = Query(default=0, ge=0),
        stream: bool = Query(default=False),
        x_room_token: str | None = Header(default=None),
        x_device_id: str | None = Header(default=None),
    ):
        transfer = get_transfer(transfer_id, x_room_token, x_device_id)
        if x_device_id != transfer["to"]:
            raise HTTPException(status_code=403, detail="Only the selected recipient can download this relay file.")
        if file_index < 0 or file_index >= len(transfer["files"]):
            raise HTTPException(status_code=404, detail="File index is invalid.")
        item = transfer["files"][file_index]
        path = state.relay_dir / transfer_id / f"{file_index}.bin"
        if stream:
            if transfer.get("relay_mode") != "streaming":
                raise HTTPException(status_code=409, detail="Streaming relay was not enabled for this transfer.")
            relay_file = transfer["relay_file_states"][file_index]
            size = int(item["size"])
            committed = int(relay_file["committed_offset"])
            if offset > size or offset > committed:
                raise HTTPException(status_code=416, detail="The requested resume position has not been committed by the sender.")
            headers = {
                "Content-Disposition": f'attachment; filename="{quote(item["name"])}"',
                "Accept-Ranges": "bytes",
                "X-Relay-Mode": "streaming",
            }
            if offset:
                headers["Content-Range"] = f"bytes {offset}-{max(offset, size) - 1}/{size}"
            return StreamingResponse(
                live_relay_body(transfer, file_index, offset),
                media_type="application/octet-stream",
                status_code=206 if offset else 200,
                headers=headers,
            )
        if not transfer.get("relay_ready"):
            raise HTTPException(status_code=409, detail="The sender is still uploading the file.")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="The relay file expired.")
        size = path.stat().st_size
        if offset > size:
            raise HTTPException(status_code=416, detail="The requested resume position is past the end of the relay file.")
        chunk_size = int(transfer.get("relay_chunk_size", storage.DEFAULT_RELAY_CHUNK_SIZE))
        headers = {
            "Content-Length": str(size - offset),
            "Content-Disposition": f'attachment; filename="{quote(item["name"])}"',
            "Accept-Ranges": "bytes",
            "X-Content-SHA256": item.get("sha256", ""),
            "X-Content-CRC32": item.get("crc32", ""),
        }
        if offset:
            headers["Content-Range"] = f"bytes {offset}-{size - 1}/{size}"
        return StreamingResponse(
            storage.stream_file_async(
                path,
                chunk_size=chunk_size,
                offset=offset,
                semaphore=state.relay_io_semaphore,
            ),
            media_type="application/octet-stream",
            status_code=206 if offset else 200,
            headers=headers,
        )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        room = websocket.query_params.get("room")
        token = websocket.query_params.get("token", "")
        if room != state.room_id or not secrets_compare(token, state.room_token):
            await websocket.close(code=4403, reason="Invalid QuickDrop room link")
            return
        await websocket.accept()
        device_id: str | None = None

        async def send_to(target_id: str, message: dict[str, Any]) -> bool:
            target = state.devices.get(target_id)
            if not target:
                return False
            try:
                await target["websocket"].send_json(message)
                return True
            except Exception:
                return False

        async def broadcast(message: dict[str, Any]) -> None:
            for device in list(state.devices.values()):
                try:
                    await device["websocket"].send_json(message)
                except Exception:
                    pass

        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=10)
            if hello.get("type") != "join":
                await websocket.close(code=4400, reason="Send join details first")
                return
            device_id = str(hello.get("device_id", ""))
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
                await websocket.close(code=4400, reason="Invalid device identifier")
                return
            device = {
                "id": device_id,
                "name": str(hello.get("name") or "Unnamed device")[:64],
                "device_type": str(hello.get("device_type") or "Unknown")[:32],
                "online": True,
                "websocket": websocket,
            }
            async with state.ws_lock:
                previous = state.devices.get(device_id)
                if previous and previous["websocket"] is not websocket:
                    try:
                        await previous["websocket"].close(code=4001, reason="Device reconnected elsewhere")
                    except Exception:
                        pass
                state.devices[device_id] = device
            await broadcast({"type": "devices", "devices": [
                {key: value for key, value in item.items() if key != "websocket"}
                for item in state.devices.values()
            ]})
            for transfer in list(state.transfers.values()):
                if transfer.get("completed") and device_id == transfer["from"]:
                    await websocket.send_json(transfer["completed"])
                    state.transfers.pop(transfer["id"], None)
                    await asyncio.to_thread(shutil.rmtree, state.relay_dir / transfer["id"], ignore_errors=True)
                    continue
                if device_id in {transfer["from"], transfer["to"]}:
                    was_offline = device_id in transfer.get("connection_paused_devices", set())
                    transfer["connection_paused_devices"].discard(device_id)
                    transfer["paused"] = bool(transfer.get("manual_paused") or transfer["connection_paused_devices"])
                    transfer["last_activity"] = asyncio.get_running_loop().time()
                    if not transfer["paused"]:
                        resume_phase = transfer.pop("resume_phase", None) or transfer.pop("connection_resume_phase", None)
                        transfer["phase"] = resume_phase or transfer.get("phase", "Transferring")
                        transfer.pop("connection_resume_phase", None)
                    notice = {
                        "type": "transfer_connection",
                        "transfer_id": transfer["id"],
                        "connected": True,
                        "paused": transfer["paused"],
                        "manual_paused": bool(transfer.get("manual_paused")),
                        "reason": "A device reconnected. Resuming from the last confirmed position.",
                    }
                    if was_offline or transfer["paused"]:
                        await websocket.send_json(notice)
                    if was_offline:
                        other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                        await send_to(other, notice)
                if device_id == transfer["from"] and transfer.get("accepted"):
                    await websocket.send_json({
                        "type": "transfer_decision", "transfer_id": transfer["id"],
                        "relay_stream_capable": bool(transfer.get("relay_stream_capable")),
                        "accepted": True, "reason": "Recipient approval was saved while you were reconnecting.",
                    })
                if device_id == transfer["to"] and transfer.get("transport") == "laptop relay":
                    await websocket.send_json({
                        "type": "relay_begin",
                        "transfer_id": transfer["id"],
                        "mode": "automatic" if transfer.get("relay_mode") == "pending" else transfer.get("relay_mode", "disk"),
                        "chunk_size": transfer.get("relay_chunk_size", storage.DEFAULT_RELAY_CHUNK_SIZE),
                    })
                    for file_index, relay_file in enumerate(transfer["relay_file_states"]):
                        if relay_file["verified"]:
                            await websocket.send_json({
                                "type": "relay_file_ready",
                                "transfer_id": transfer["id"],
                                "file_index": file_index,
                                "file": transfer["files"][file_index],
                            })
                    if transfer.get("relay_ready"):
                        await websocket.send_json({"type": "relay_ready", "transfer_id": transfer["id"], "files": transfer["files"]})
            while True:
                message = await websocket.receive_json()
                kind = message.get("type")
                if kind == "webrtc_signal":
                    recipient = str(message.get("to", ""))
                    transfer = state.transfers.get(str(message.get("transfer_id", "")))
                    if transfer and device_id in {transfer["from"], transfer["to"]} and recipient in {transfer["from"], transfer["to"]}:
                        await send_to(recipient, {
                            "type": "webrtc_signal",
                            "from": device_id,
                            "transfer_id": transfer["id"],
                            "signal": message.get("signal"),
                        })
                elif kind == "transfer_request":
                    recipient = str(message.get("to", ""))
                    target = state.devices.get(recipient)
                    raw_files = message.get("files") or []
                    files = []
                    if not isinstance(raw_files, list) or not 1 <= len(raw_files) <= 100:
                        await websocket.send_json({"type": "transfer_error", "message": "Choose between 1 and 100 files."})
                        continue
                    invalid = False
                    for item in raw_files:
                        try:
                            name = storage.sanitize_filename(str(item.get("name", "file.bin")))
                            size = int(item.get("size", -1))
                            if size < 0 or size > state.max_file_bytes:
                                invalid = True
                            files.append({"name": name, "size": size})
                        except (AttributeError, TypeError, ValueError):
                            invalid = True
                    if invalid:
                        await websocket.send_json({"type": "transfer_error", "message": f"Each file must be no larger than {state.max_file_mb} MB."})
                        continue
                    if not target:
                        await websocket.send_json({"type": "transfer_error", "message": "That device is no longer connected."})
                        continue
                    transfer_id = uuid.uuid4().hex
                    sender = {key: value for key, value in device.items() if key != "websocket"}
                    transfer = {
                        "id": transfer_id,
                        "from": device_id,
                        "to": recipient,
                        "files": files,
                        "accepted": False,
                        "relay_ready": False,
                        "created": asyncio.get_running_loop().time(),
                        "last_activity": asyncio.get_running_loop().time(),
                        "loaded": 0,
                        "total": sum(item["size"] for item in files),
                        "rate_bps": 0.0,
                        "phase": "Waiting for recipient approval",
                        "transport": "pending",
                        "paused": False,
                        "manual_paused": False,
                        "connection_paused_devices": set(),
                        "lock": asyncio.Lock(),
                        "relay_mode": "disk",
                        "relay_preference": None,
                        "relay_mode_decided": False,
                        "relay_chunk_size": storage.DEFAULT_RELAY_CHUNK_SIZE,
                        "relay_stream_capable": False,
                        "relay_file_states": [
                            {"committed_offset": 0, "verified": False, "failure": None, "condition": asyncio.Condition()}
                            for _ in files
                        ],
                        "metrics": {
                            "uploaded_bytes": 0,
                            "downloaded_bytes": 0,
                            "end_to_end_bytes": 0,
                            "upload_rate_bps": 0.0,
                            "download_rate_bps": 0.0,
                            "end_to_end_rate_bps": 0.0,
                            "started_at": None,
                            "samples": {},
                        },
                    }
                    state.transfers[transfer_id] = transfer
                    delivered = await send_to(recipient, {
                        "type": "incoming_transfer",
                        "transfer_id": transfer_id,
                        "sender": sender,
                        "files": files,
                    })
                    if not delivered:
                        state.transfers.pop(transfer_id, None)
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": "That device disconnected before the request arrived."})
                        continue
                    await websocket.send_json({"type": "transfer_pending", "transfer_id": transfer_id, "to": recipient})
                elif kind == "transfer_decision":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if not transfer or device_id != transfer["to"]:
                        continue
                    accepted = bool(message.get("accepted"))
                    transfer["accepted"] = accepted
                    transfer["relay_stream_capable"] = bool(accepted and message.get("relay_stream_capable"))
                    transfer["last_activity"] = asyncio.get_running_loop().time()
                    if accepted and transfer["metrics"].get("started_at") is None:
                        transfer["metrics"]["started_at"] = transfer["last_activity"]
                    transfer["phase"] = "Connecting directly" if accepted else "Declined by recipient"
                    delivered = await send_to(transfer["from"], {
                        "type": "transfer_decision",
                        "transfer_id": transfer_id,
                        "accepted": accepted,
                        "relay_stream_capable": transfer["relay_stream_capable"],
                        "reason": str(message.get("reason", ""))[:160],
                    })
                    if accepted and not delivered:
                        transfer["connection_paused_devices"].add(transfer["from"])
                        transfer["paused"] = True
                        transfer["phase"] = "Paused · waiting for sender"
                        await websocket.send_json({
                            "type": "transfer_paused", "transfer_id": transfer_id,
                            "message": "The sender is offline. Approval is saved; the transfer will start when they reconnect.",
                        })
                        continue
                    if not accepted:
                        state.transfers.pop(transfer_id, None)
                elif kind == "relay_ready":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if not transfer or device_id != transfer["from"] or not transfer["accepted"]:
                        continue
                    submitted_hashes = message.get("hashes") or []
                    ready = not submitted_hashes or len(submitted_hashes) == len(transfer["files"])
                    failure_message = "The laptop relay could not verify every file."
                    for index, item in enumerate(transfer["files"]):
                        if not ready:
                            break
                        if transfer["relay_file_states"][index]["verified"]:
                            continue
                        path = state.relay_dir / transfer_id / f"{index}.bin"
                        try:
                            async with state.relay_io_semaphore:
                                hashes = await asyncio.to_thread(
                                    _hash_relay_file, path, int(item["size"]), 4 * 1024 * 1024
                                )
                        except OSError:
                            ready = False
                            failure_message = "QuickDrop could not read the relay file. Check free disk space and permissions."
                            break
                        if hashes is None:
                            ready = False
                            break
                        item["sha256"], item["crc32"] = hashes
                        if submitted_hashes and item["sha256"] != str(submitted_hashes[index]):
                            ready = False
                            break
                    if not ready:
                        await wake_relay_streams(transfer, failure=failure_message)
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": failure_message})
                        await send_to(transfer["to"], {"type": "transfer_error", "transfer_id": transfer_id, "message": failure_message})
                        continue
                    transfer["relay_ready"] = True
                    transfer["phase"] = "Downloading from laptop relay"
                    delivered = await send_to(transfer["to"], {"type": "relay_ready", "transfer_id": transfer_id, "files": transfer["files"]})
                    await wake_relay_streams(transfer, verified=True)
                    if not delivered:
                        transfer["connection_paused_devices"].add(transfer["to"])
                        transfer["paused"] = True
                        await websocket.send_json({
                            "type": "transfer_paused", "transfer_id": transfer_id,
                            "message": "The recipient went offline. The relay is ready and will resume when they reconnect.",
                        })
                elif kind == "relay_file_complete":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    try:
                        file_index = int(message.get("file_index", -1))
                    except (TypeError, ValueError):
                        file_index = -1
                    if (
                        not transfer
                        or device_id != transfer["from"]
                        or not transfer["accepted"]
                        or transfer.get("relay_mode") != "streaming"
                        or not 0 <= file_index < len(transfer["files"])
                    ):
                        continue
                    item = transfer["files"][file_index]
                    relay_file = transfer["relay_file_states"][file_index]
                    if relay_file["committed_offset"] != int(item["size"]):
                        await websocket.send_json({
                            "type": "transfer_error",
                            "transfer_id": transfer_id,
                            "message": "The relay cannot finish a file before every byte has been saved.",
                        })
                        continue
                    path = state.relay_dir / transfer_id / f"{file_index}.bin"
                    try:
                        async with state.relay_io_semaphore:
                            hashes = await asyncio.to_thread(
                                _hash_relay_file, path, int(item["size"]), 4 * 1024 * 1024
                            )
                    except OSError:
                        hashes = None
                    if hashes is None:
                        message_text = "The laptop relay could not verify the completed file."
                        async with relay_file["condition"]:
                            relay_file["failure"] = message_text
                            relay_file["condition"].notify_all()
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": message_text})
                        await send_to(transfer["to"], {"type": "transfer_error", "transfer_id": transfer_id, "message": message_text})
                        continue
                    item["sha256"], item["crc32"] = hashes
                    async with relay_file["condition"]:
                        relay_file["verified"] = True
                        relay_file["condition"].notify_all()
                    transfer["last_activity"] = asyncio.get_running_loop().time()
                    await send_to(transfer["to"], {
                        "type": "relay_file_ready",
                        "transfer_id": transfer_id,
                        "file_index": file_index,
                        "file": item,
                    })
                elif kind == "relay_begin":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if transfer and device_id == transfer["from"] and transfer["accepted"]:
                        requested_mode = str(message.get("mode", "standard"))
                        if requested_mode not in {"automatic", "standard"}:
                            requested_mode = "standard"
                        if not (
                            transfer.get("relay_mode_decided")
                            and transfer.get("relay_preference") == requested_mode
                            and transfer.get("relay_mode") in {"streaming", "disk"}
                        ):
                            transfer["relay_preference"] = requested_mode
                            transfer["relay_mode_decided"] = requested_mode == "standard"
                            transfer["relay_mode"] = "disk" if requested_mode == "standard" else "pending"
                            transfer["relay_stream_capable"] = False
                        try:
                            requested_chunk = int(message.get("chunk_size", storage.DEFAULT_RELAY_CHUNK_SIZE))
                        except (TypeError, ValueError):
                            requested_chunk = storage.DEFAULT_RELAY_CHUNK_SIZE
                        allowed_chunks = {value * 1024 * 1024 for value in storage.RELAY_CHUNK_SIZES}
                        transfer["relay_chunk_size"] = requested_chunk if requested_chunk in allowed_chunks else storage.DEFAULT_RELAY_CHUNK_SIZE
                        transfer["relay_ready"] = False
                        transfer["transport"] = "laptop relay"
                        transfer["phase"] = "Sending to laptop relay"
                        transfer["last_activity"] = asyncio.get_running_loop().time()
                        await asyncio.to_thread((state.relay_dir / transfer_id).mkdir, parents=True, exist_ok=True)
                        recipient_mode = "automatic" if transfer["relay_mode"] == "pending" else transfer["relay_mode"]
                        if not await send_to(transfer["to"], {
                            "type": "relay_begin",
                            "transfer_id": transfer_id,
                            "mode": recipient_mode,
                            "chunk_size": transfer["relay_chunk_size"],
                        }):
                            transfer["connection_paused_devices"].add(transfer["to"])
                            transfer["paused"] = True
                            transfer["phase"] = "Paused · waiting for recipient"
                            await websocket.send_json({"type": "transfer_paused", "transfer_id": transfer_id, "message": "The recipient went offline. The transfer is paused and can resume when they reconnect."})
                        if transfer["relay_mode_decided"]:
                            await websocket.send_json({
                                "type": "relay_mode_selected",
                                "transfer_id": transfer_id,
                                "mode": transfer["relay_mode"],
                            })
                        for file_index, relay_file in enumerate(transfer["relay_file_states"]):
                            if relay_file["verified"]:
                                await send_to(transfer["to"], {
                                    "type": "relay_file_ready",
                                    "transfer_id": transfer_id,
                                    "file_index": file_index,
                                    "file": transfer["files"][file_index],
                                })
                elif kind == "relay_mode_decision":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if (
                        not transfer
                        or device_id != transfer["to"]
                        or not transfer["accepted"]
                        or transfer.get("relay_preference") != "automatic"
                    ):
                        continue
                    if transfer.get("relay_mode_decided"):
                        selected_mode = transfer["relay_mode"]
                    else:
                        wants_streaming = str(message.get("mode", "disk")) == "streaming"
                        capable = bool(message.get("capable"))
                        selected_mode = "streaming" if wants_streaming and capable else "disk"
                        transfer["relay_mode"] = selected_mode
                        transfer["relay_mode_decided"] = True
                        transfer["relay_stream_capable"] = selected_mode == "streaming"
                        transfer["phase"] = "Sending to laptop relay"
                        transfer["last_activity"] = asyncio.get_running_loop().time()
                    confirmation = {
                        "type": "relay_mode_selected",
                        "transfer_id": transfer_id,
                        "mode": selected_mode,
                    }
                    await websocket.send_json(confirmation)
                    await send_to(transfer["from"], confirmation)
                elif kind == "transfer_control":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    action = str(message.get("action", ""))
                    if not transfer or device_id not in {transfer["from"], transfer["to"]} or action not in {"pause", "resume"}:
                        continue
                    transfer["manual_paused"] = action == "pause"
                    transfer["paused"] = bool(transfer["manual_paused"] or transfer["connection_paused_devices"])
                    if transfer["manual_paused"]:
                        current_phase = transfer.get("phase", "Transferring")
                        if current_phase.startswith("Paused"):
                            transfer["resume_phase"] = transfer.get("resume_phase") or transfer.get("connection_resume_phase") or "Transferring"
                        else:
                            transfer["resume_phase"] = current_phase
                        transfer["phase"] = "Paused by user"
                    elif not transfer["connection_paused_devices"]:
                        resume_phase = transfer.pop("resume_phase", None) or transfer.pop("connection_resume_phase", None)
                        transfer["phase"] = resume_phase or transfer.get("phase", "Transferring")
                        transfer.pop("connection_resume_phase", None)
                    else:
                        transfer["phase"] = "Paused · waiting for connection"
                    transfer["last_activity"] = asyncio.get_running_loop().time()
                    other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                    control = {
                        "type": "transfer_control",
                        "transfer_id": transfer_id,
                        "action": action,
                        "paused": transfer["paused"],
                        "by": device_id,
                    }
                    await websocket.send_json(control)
                    await send_to(other, control)
                elif kind == "transfer_health":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if not transfer or device_id not in {transfer["from"], transfer["to"]}:
                        continue
                    connected = bool(message.get("connected", False))
                    if connected:
                        transfer["connection_paused_devices"].discard(device_id)
                    else:
                        transfer["connection_paused_devices"].add(device_id)
                    transfer["paused"] = bool(transfer["manual_paused"] or transfer["connection_paused_devices"])
                    transfer["last_activity"] = asyncio.get_running_loop().time()
                    other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                    if not connected and not transfer["manual_paused"]:
                        transfer.setdefault("connection_resume_phase", transfer.get("phase", "Transferring"))
                        transfer["phase"] = "Paused · connection interrupted"
                    elif connected and not transfer["paused"]:
                        resume_phase = transfer.pop("resume_phase", None) or transfer.pop("connection_resume_phase", None)
                        transfer["phase"] = resume_phase or transfer.get("phase", "Transferring")
                        transfer.pop("connection_resume_phase", None)
                    notice = {
                        "type": "transfer_connection",
                        "transfer_id": transfer_id,
                        "connected": connected,
                        "paused": transfer["paused"],
                        "manual_paused": bool(transfer.get("manual_paused")),
                        "reason": str(message.get("reason", "Connection is unstable. Transfer paused."))[:160],
                    }
                    await websocket.send_json(notice)
                    await send_to(other, notice)
                elif kind == "transfer_progress":
                    transfer = state.transfers.get(str(message.get("transfer_id", "")))
                    if transfer and device_id in {transfer["from"], transfer["to"]}:
                        now = asyncio.get_running_loop().time()
                        loaded = max(0, int(message.get("loaded", 0)))
                        total = max(0, int(message.get("total", transfer.get("total", 0))))
                        phase = str(message.get("phase", "transfer"))[:48]
                        metrics = transfer["metrics"]
                        if metrics.get("started_at") is None:
                            metrics["started_at"] = now
                        if device_id == transfer["from"] and phase == "relay-upload":
                            metrics["uploaded_bytes"] = max(metrics["uploaded_bytes"], min(loaded, total) if total else loaded)
                            _sample_transfer_rate(metrics, "upload", metrics["uploaded_bytes"], now)
                        elif device_id == transfer["to"] and phase == "relay-download":
                            metrics["downloaded_bytes"] = max(metrics["downloaded_bytes"], min(loaded, total) if total else loaded)
                            metrics["end_to_end_bytes"] = max(metrics["end_to_end_bytes"], metrics["downloaded_bytes"])
                            _sample_transfer_rate(metrics, "download", metrics["downloaded_bytes"], now)
                            _sample_transfer_rate(metrics, "end_to_end", metrics["end_to_end_bytes"], now)
                        elif device_id == transfer["to"] and phase == "direct":
                            metrics["end_to_end_bytes"] = max(metrics["end_to_end_bytes"], min(loaded, total) if total else loaded)
                            _sample_transfer_rate(metrics, "end_to_end", metrics["end_to_end_bytes"], now)
                        current_stage_loaded = min(loaded, total) if total else loaded
                        if metrics["end_to_end_bytes"]:
                            transfer["loaded"] = metrics["end_to_end_bytes"]
                        elif phase == "relay-upload":
                            transfer["loaded"] = max(metrics["uploaded_bytes"], current_stage_loaded)
                        else:
                            transfer["loaded"] = current_stage_loaded
                        transfer["total"] = total
                        transfer["phase"] = phase
                        transfer["transport"] = "laptop relay" if "relay" in transfer["phase"] else "direct"
                        transfer["rate_bps"] = metrics.get("end_to_end_rate_bps") or metrics.get("upload_rate_bps", 0)
                        transfer["last_activity"] = now
                        other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                        await send_to(other, {
                            "type": "transfer_progress",
                            "transfer_id": transfer["id"],
                            "file_index": int(message.get("file_index", 0)),
                            "loaded": int(metrics["end_to_end_bytes"] or loaded),
                            "total": total,
                            "phase": phase[:32],
                            "transport": transfer["transport"],
                            "rate_bps": transfer["rate_bps"],
                            "uploaded_bytes": metrics["uploaded_bytes"],
                            "downloaded_bytes": metrics["downloaded_bytes"],
                            "end_to_end_bytes": metrics["end_to_end_bytes"],
                            "upload_rate_bps": metrics["upload_rate_bps"],
                            "download_rate_bps": metrics["download_rate_bps"],
                            "end_to_end_rate_bps": metrics["end_to_end_rate_bps"],
                            "duration_seconds": now - metrics["started_at"],
                        })
                elif kind == "transfer_complete":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if transfer and device_id in {transfer["from"], transfer["to"]}:
                        other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                        metrics = transfer.get("metrics", {})
                        started_at = metrics.get("started_at")
                        duration = max(0, asyncio.get_running_loop().time() - started_at) if started_at else 0
                        result = {
                            "type": "transfer_complete",
                            "transfer_id": transfer_id,
                            "ok": bool(message.get("ok", True)),
                            "message": str(message.get("message", ""))[:200],
                            "duration_seconds": duration,
                            "uploaded_bytes": metrics.get("uploaded_bytes", 0),
                            "downloaded_bytes": metrics.get("downloaded_bytes", 0),
                            "end_to_end_bytes": metrics.get("end_to_end_bytes", 0),
                            "upload_rate_bps": metrics.get("upload_rate_bps", 0),
                            "download_rate_bps": metrics.get("download_rate_bps", 0),
                            "end_to_end_rate_bps": metrics.get("end_to_end_rate_bps", 0),
                        }
                        delivered = await send_to(other, result)
                        if not result["ok"]:
                            await wake_relay_streams(transfer, failure=result["message"] or "The sender cancelled the transfer.")
                        if delivered or not result["ok"]:
                            state.transfers.pop(transfer_id, None)
                            await asyncio.to_thread(shutil.rmtree, state.relay_dir / transfer_id, ignore_errors=True)
                        else:
                            transfer["completed"] = result
                            transfer["phase"] = "Completed"
                            transfer["last_activity"] = asyncio.get_running_loop().time()
                            await asyncio.to_thread(shutil.rmtree, state.relay_dir / transfer_id, ignore_errors=True)
                elif kind == "note_send":
                    client_id = str(message.get("client_id", ""))[:80]
                    note_text = message.get("text")
                    if not isinstance(note_text, str) or not note_text.strip():
                        await websocket.send_json({"type": "note_result", "client_id": client_id, "delivered_to": [], "errors": ["Write a note or paste a link first."]})
                        continue
                    requested_to = str(message.get("to", ""))
                    if requested_to == "all":
                        recipients = [item for key, item in state.devices.items() if key != device_id]
                    else:
                        recipient = state.devices.get(requested_to)
                        recipients = [recipient] if recipient and requested_to != device_id else []
                    note_id = uuid.uuid4().hex
                    note = {
                        "id": note_id,
                        "text": note_text,
                        "sender": {"id": device_id, "name": device["name"]},
                        "sent_at": datetime.now(timezone.utc).isoformat(),
                    }
                    delivered_to = []
                    errors = []
                    for recipient in recipients:
                        if await send_to(recipient["id"], {"type": "note_received", "note": note}):
                            delivered_to.append({"id": recipient["id"], "name": recipient["name"]})
                        else:
                            errors.append(str(recipient["name"]) + " is no longer connected.")
                    if not recipients:
                        errors.append("Choose another connected device before sending.")
                    await websocket.send_json({
                        "type": "note_result",
                        "client_id": client_id,
                        "note_id": note_id,
                        "delivered_to": delivered_to,
                        "errors": errors,
                    })
                elif kind == "ping":
                    await websocket.send_json({"type": "pong"})
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except Exception:
            # A malformed client or transient network issue must not take down the room server.
            pass
        finally:
            if device_id:
                async with state.ws_lock:
                    current = state.devices.get(device_id)
                    if current and current.get("websocket") is websocket:
                        state.devices.pop(device_id, None)
                        await broadcast({"type": "devices", "devices": [
                            {key: value for key, value in item.items() if key != "websocket"}
                            for item in state.devices.values()
                        ]})
                        for transfer_id, transfer in list(state.transfers.items()):
                            if device_id in {transfer["from"], transfer["to"]}:
                                transfer["connection_paused_devices"].add(device_id)
                                transfer["paused"] = True
                                transfer["last_activity"] = asyncio.get_running_loop().time()
                                if not transfer["manual_paused"]:
                                    transfer.setdefault("connection_resume_phase", transfer.get("phase", "Transferring"))
                                    transfer["phase"] = "Paused · connection interrupted"
                                other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                                await send_to(other, {
                                    "type": "transfer_connection",
                                    "transfer_id": transfer_id,
                                    "connected": False,
                                    "paused": True,
                                    "reason": "A device disconnected. The transfer is paused and will resume when it reconnects.",
                                })

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)

    return app
