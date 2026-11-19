"""Shared-folder file operations. User filenames never become path components alone."""

from __future__ import annotations

import os
import re
import tempfile
import uuid
import zipfile
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from fastapi import UploadFile


CHUNK_SIZE = 1024 * 1024
RELAY_CHUNK_SIZES = (1, 2, 4, 8)
DEFAULT_RELAY_CHUNK_SIZE = 4 * 1024 * 1024
MAX_RELAY_CHUNK_SIZE = max(RELAY_CHUNK_SIZES) * 1024 * 1024
_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_filename(filename: str) -> str:
    # Treat both slash styles as separators so Windows paths are safe on every host OS.
    name = filename.replace("\\", "/").split("/")[-1].strip()
    name = _INVALID_NAME.sub("_", name).strip(" .")
    if name in {"", ".", ".."}:
        name = "upload.bin"
    return name[:180]


def _stored_path(shared_dir: Path, file_id: str, filename: str) -> Path:
    return shared_dir / f"{file_id}__{sanitize_filename(filename)}"


def file_by_id(shared_dir: Path, file_id: str) -> Path | None:
    if not re.fullmatch(r"[0-9a-f]{32}", file_id):
        return None
    matches = list(shared_dir.glob(f"{file_id}__*"))
    return matches[0] if matches and matches[0].is_file() else None


def delete_file(shared_dir: Path, file_id: str) -> dict[str, str] | None:
    """Delete one validated shared file by its opaque ID; never accept a user path."""
    path = file_by_id(shared_dir, file_id)
    if path is None:
        return None
    filename = path.name.split("__", 1)[1]
    path.unlink()
    return {"id": file_id, "name": filename}


def list_files(shared_dir: Path) -> list[dict[str, object]]:
    shared_dir.mkdir(parents=True, exist_ok=True)
    result = []
    for path in shared_dir.iterdir():
        if not path.is_file() or "__" not in path.name:
            continue
        file_id, filename = path.name.split("__", 1)
        if not re.fullmatch(r"[0-9a-f]{32}", file_id):
            continue
        stat = path.stat()
        result.append({
            "id": file_id,
            "name": filename,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        })
    return result


async def save_upload(upload: UploadFile, shared_dir: Path, max_bytes: int, temp_dir: Path | None = None) -> dict[str, object]:
    shared_dir.mkdir(parents=True, exist_ok=True)
    filename = sanitize_filename(upload.filename or "upload.bin")
    file_id = uuid.uuid4().hex
    destination = _stored_path(shared_dir, file_id, filename)
    size = 0
    temporary: Path | None = None
    try:
        scratch = temp_dir or (shared_dir.parent / "Temp")
        scratch.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix="upload-", suffix=".part", dir=scratch)
        os.close(descriptor)
        temporary = Path(temporary_name)
        with temporary.open("wb") as output:
            while True:
                chunk = await upload.read(CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError(f"File exceeds the {max_bytes // (1024 * 1024)} MB per-file limit.")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        for _ in range(10):
            try:
                os.link(temporary, destination)
                break
            except FileExistsError:
                file_id = uuid.uuid4().hex
                destination = _stored_path(shared_dir, file_id, filename)
        else:
            raise FileExistsError("Could not allocate a unique shared file identifier.")
        temporary.unlink()
    except BaseException:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    return {"id": file_id, "name": filename, "size": size}


def create_zip(shared_dir: Path, file_ids: Iterable[str], temp_dir: Path) -> Path:
    paths: list[Path] = []
    for file_id in file_ids:
        path = file_by_id(shared_dir, file_id)
        if path is None:
            raise FileNotFoundError(file_id)
        paths.append(path)
    if not paths:
        raise ValueError("Select at least one file.")

    temp_dir.mkdir(parents=True, exist_ok=True)
    descriptor, target_name = tempfile.mkstemp(prefix="quickdrop-", suffix=".zip", dir=temp_dir)
    os.close(descriptor)
    target = Path(target_name)
    used_names: set[str] = set()
    try:
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            for path in paths:
                original = path.name.split("__", 1)[1]
                candidate = original
                stem, suffix = os.path.splitext(original)
                index = 1
                while candidate.casefold() in used_names:
                    candidate = f"{stem} ({index}){suffix}"
                    index += 1
                used_names.add(candidate.casefold())
                archive.write(path, arcname=candidate)
        return target
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def _append_relay_payload(path: Path, payload: bytes | bytearray, offset: int, expected_size: int) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.stat().st_size if path.exists() else 0
    if current != offset:
        raise ValueError(f"Unexpected chunk offset: expected {current}, got {offset}.")
    if current + len(payload) > expected_size:
        raise ValueError("Relay chunk exceeds the declared file size.")
    try:
        with path.open("ab") as output:
            output.write(payload)
    except OSError:
        try:
            with path.open("r+b") as output:
                output.truncate(offset)
        except OSError:
            pass
        raise
    return current + len(payload)


async def write_relay_chunk(
    path: Path,
    body,
    offset: int,
    expected_size: int,
    max_chunk: int = CHUNK_SIZE,
    content_length: int | None = None,
    on_commit: Callable[[bytes | bytearray], None] | None = None,
) -> int:
    """Buffer one bounded request chunk, then append it in one worker-thread write.

    Nothing is appended until the request body has been read successfully. This
    keeps interrupted requests resumable from the previous committed offset.
    """
    if max_chunk < 0 or max_chunk > MAX_RELAY_CHUNK_SIZE:
        raise ValueError("Invalid relay chunk size.")
    if content_length is not None and (content_length < 0 or content_length > max_chunk):
        raise ValueError("Relay request body exceeds the configured chunk size.")
    current = await asyncio.to_thread(lambda: path.stat().st_size if path.exists() else 0)
    if current != offset:
        raise ValueError(f"Unexpected chunk offset: expected {current}, got {offset}.")
    payload = bytearray()
    async for chunk in body:
        if not chunk:
            continue
        if len(payload) + len(chunk) > max_chunk or current + len(payload) + len(chunk) > expected_size:
            raise ValueError("Relay chunk exceeds the declared file size.")
        payload.extend(chunk)
    if content_length is not None and len(payload) != content_length:
        raise ValueError("Relay request ended before its declared body length.")
    if not payload and current < expected_size:
        raise ValueError("Empty relay chunk.")
    if payload or expected_size == 0:
        written = await asyncio.to_thread(_append_relay_payload, path, payload, offset, expected_size)
        if payload and on_commit:
            on_commit(payload)
        return written
    return current


def stream_file(path: Path, chunk_size: int = CHUNK_SIZE, offset: int = 0):
    with path.open("rb") as source:
        source.seek(max(0, offset))
        while chunk := source.read(chunk_size):
            yield chunk


async def stream_file_async(
    path: Path,
    chunk_size: int = CHUNK_SIZE,
    offset: int = 0,
    limit: int | None = None,
    semaphore: asyncio.Semaphore | None = None,
):
    """Stream a file with bounded reads performed outside the event loop."""

    async def run_io(function, *args):
        if semaphore is None:
            return await asyncio.to_thread(function, *args)
        async with semaphore:
            return await asyncio.to_thread(function, *args)

    source = await run_io(path.open, "rb")
    remaining = None if limit is None else max(0, limit)
    try:
        await run_io(source.seek, max(0, offset))
        while remaining is None or remaining > 0:
            read_size = chunk_size if remaining is None else min(chunk_size, remaining)
            chunk = await run_io(source.read, read_size)
            if not chunk:
                break
            if remaining is not None:
                remaining -= len(chunk)
            yield chunk
    finally:
        await run_io(source.close)


def read_file_range(path: Path, offset: int, size: int) -> bytes:
    """Read at most one bounded committed range for a live relay consumer."""
    with path.open("rb") as source:
        source.seek(max(0, offset))
        return source.read(max(0, size))
