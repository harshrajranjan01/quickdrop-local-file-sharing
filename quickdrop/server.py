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
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import qrcode
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
        self.hotspot_ssid: str | None = None
        self.hotspot_password: str | None = None
        self.network_mode = "wifi"
        self.hotspot_auto = False
        self.preferred_ip: str | None = None
        self._load_saved_settings()
        self.shared_dir.mkdir(parents=True, exist_ok=True)
        self.relay_dir.mkdir(parents=True, exist_ok=True)
        self.upload_temp_dir.mkdir(parents=True, exist_ok=True)
        # In-flight relay state is in memory only, so leftovers from a prior process cannot resume.
        for item in self.relay_dir.iterdir():
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
        for item in self.upload_temp_dir.iterdir():
            if item.is_file():
                item.unlink(missing_ok=True)
            elif item.is_dir():
                shutil.rmtree(item, ignore_errors=True)

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


def create_app(data_root: Path | None = None, max_file_mb: int | None = None) -> FastAPI:
    state = AppSettings(data_root, max_file_mb)

    async def cleanup_loop() -> None:
        while True:
            await asyncio.sleep(300)
            cutoff = asyncio.get_running_loop().time() - 3600
            async with state.transfer_lock:
                expired = [key for key, transfer in state.transfers.items() if transfer.get("created", 0) < cutoff]
                for transfer_id in expired:
                    state.transfers.pop(transfer_id, None)
                    shutil.rmtree(state.relay_dir / transfer_id, ignore_errors=True)
            for item in state.temp_dir.glob("quickdrop-*.zip"):
                try:
                    if item.stat().st_mtime < time.time() - 3600:
                        item.unlink(missing_ok=True)
                except OSError:
                    pass

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(cleanup_loop())
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
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
                written = await storage.write_relay_chunk(path, request.stream(), offset, item["size"])
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
            except OSError:
                raise HTTPException(status_code=507, detail="The laptop relay ran out of storage or could not write its temporary file.")
        return {"offset": written, "size": item["size"]}

    @app.get("/api/relay/{transfer_id}/{file_index}")
    async def relay_download(
        transfer_id: str,
        file_index: int,
        x_room_token: str | None = Header(default=None),
        x_device_id: str | None = Header(default=None),
    ):
        transfer = get_transfer(transfer_id, x_room_token, x_device_id)
        if x_device_id != transfer["to"]:
            raise HTTPException(status_code=403, detail="Only the selected recipient can download this relay file.")
        if not transfer.get("relay_ready"):
            raise HTTPException(status_code=409, detail="The sender is still uploading the file.")
        if file_index < 0 or file_index >= len(transfer["files"]):
            raise HTTPException(status_code=404, detail="File index is invalid.")
        item = transfer["files"][file_index]
        path = state.relay_dir / transfer_id / f"{file_index}.bin"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="The relay file expired.")
        return StreamingResponse(
            storage.stream_file(path),
            media_type="application/octet-stream",
            headers={
                "Content-Length": str(item["size"]),
                "Content-Disposition": f'attachment; filename="{quote(item["name"])}"',
                "X-Content-SHA256": item.get("sha256", ""),
            },
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
                        "lock": asyncio.Lock(),
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
                    delivered = await send_to(transfer["from"], {
                        "type": "transfer_decision",
                        "transfer_id": transfer_id,
                        "accepted": accepted,
                        "reason": str(message.get("reason", ""))[:160],
                    })
                    if accepted and not delivered:
                        state.transfers.pop(transfer_id, None)
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": "The sender disconnected before the transfer started."})
                        shutil.rmtree(state.relay_dir / transfer_id, ignore_errors=True)
                        continue
                    if not accepted:
                        state.transfers.pop(transfer_id, None)
                elif kind == "relay_ready":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if not transfer or device_id != transfer["from"] or not transfer["accepted"]:
                        continue
                    submitted_hashes = message.get("hashes") or []
                    ready = len(submitted_hashes) == len(transfer["files"])
                    failure_message = "The laptop relay could not verify every file."
                    for index, item in enumerate(transfer["files"]):
                        if not ready:
                            break
                        path = state.relay_dir / transfer_id / f"{index}.bin"
                        try:
                            if not path.is_file() or path.stat().st_size != item["size"]:
                                ready = False
                                break
                            digest = hashlib.sha256()
                            with path.open("rb") as source:
                                while chunk := source.read(storage.CHUNK_SIZE):
                                    digest.update(chunk)
                        except OSError:
                            ready = False
                            failure_message = "QuickDrop could not read the relay file. Check free disk space and permissions."
                            break
                        item["sha256"] = digest.hexdigest()
                        if item["sha256"] != str(submitted_hashes[index]):
                            ready = False
                            break
                    if not ready:
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": failure_message})
                        continue
                    transfer["relay_ready"] = True
                    delivered = await send_to(transfer["to"], {"type": "relay_ready", "transfer_id": transfer_id, "files": transfer["files"]})
                    if not delivered:
                        state.transfers.pop(transfer_id, None)
                        shutil.rmtree(state.relay_dir / transfer_id, ignore_errors=True)
                        await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": "The recipient disconnected before the relay was ready."})
                elif kind == "relay_begin":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if transfer and device_id == transfer["from"] and transfer["accepted"]:
                        transfer["relay_ready"] = False
                        shutil.rmtree(state.relay_dir / transfer_id, ignore_errors=True)
                        if not await send_to(transfer["to"], {"type": "relay_begin", "transfer_id": transfer_id}):
                            state.transfers.pop(transfer_id, None)
                            await websocket.send_json({"type": "transfer_error", "transfer_id": transfer_id, "message": "The recipient disconnected before the relay started."})
                elif kind == "transfer_progress":
                    transfer = state.transfers.get(str(message.get("transfer_id", "")))
                    if transfer and device_id in {transfer["from"], transfer["to"]}:
                        other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                        await send_to(other, {
                            "type": "transfer_progress",
                            "transfer_id": transfer["id"],
                            "file_index": int(message.get("file_index", 0)),
                            "loaded": int(message.get("loaded", 0)),
                            "total": int(message.get("total", 0)),
                            "phase": str(message.get("phase", "transfer"))[:32],
                        })
                elif kind == "transfer_complete":
                    transfer_id = str(message.get("transfer_id", ""))
                    transfer = state.transfers.get(transfer_id)
                    if transfer and device_id in {transfer["from"], transfer["to"]}:
                        other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                        await send_to(other, {"type": "transfer_complete", "transfer_id": transfer_id, "ok": bool(message.get("ok", True)), "message": str(message.get("message", ""))[:200]})
                        state.transfers.pop(transfer_id, None)
                        shutil.rmtree(state.relay_dir / transfer_id, ignore_errors=True)
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
                                other = transfer["to"] if device_id == transfer["from"] else transfer["from"]
                                await send_to(other, {"type": "transfer_error", "transfer_id": transfer_id, "message": "A device disconnected during this transfer."})

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)

    return app
