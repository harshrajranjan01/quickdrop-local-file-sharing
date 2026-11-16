"""Shared-folder file operations. User filenames never become path components alone."""

from __future__ import annotations

import os
import re
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from fastapi import UploadFile


CHUNK_SIZE = 1024 * 1024
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


async def write_relay_chunk(path: Path, body, offset: int, expected_size: int, max_chunk: int = CHUNK_SIZE) -> int:
    """Append a single bounded HTTP chunk and reject gaps or oversize bodies."""
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.stat().st_size if path.exists() else 0
    if current != offset:
        raise ValueError(f"Unexpected chunk offset: expected {current}, got {offset}.")
    written = 0
    with path.open("ab") as output:
        async for chunk in body:
            written += len(chunk)
            if written > max_chunk or current + written > expected_size:
                raise ValueError("Relay chunk exceeds the declared file size.")
            output.write(chunk)
    if written == 0 and current < expected_size:
        raise ValueError("Empty relay chunk.")
    return current + written


def stream_file(path: Path, chunk_size: int = CHUNK_SIZE):
    with path.open("rb") as source:
        while chunk := source.read(chunk_size):
            yield chunk
