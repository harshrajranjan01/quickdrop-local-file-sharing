"""Repeatable local benchmark for relay request patterns and chunk sizes.

Run from the repository root: python relay_benchmark.py --file-mb 32
This is an in-process ASGI/local-disk benchmark, not a substitute for a
two-device Wi-Fi run. The dashboard reports actual device-to-device rates.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psutil
from fastapi.testclient import TestClient

from quickdrop.server import create_app

MIB = 1024 * 1024
CASES = [
    ("baseline-pattern-1MiB", "disk", MIB, True),
    ("disk-1MiB", "disk", MIB, False),
    ("disk-2MiB", "disk", 2 * MIB, False),
    ("disk-4MiB", "disk", 4 * MIB, False),
    ("disk-8MiB", "disk", 8 * MIB, False),
    ("streaming-1MiB", "streaming", MIB, False),
    ("streaming-2MiB", "streaming", 2 * MIB, False),
    ("streaming-4MiB", "streaming", 4 * MIB, False),
    ("streaming-8MiB", "streaming", 8 * MIB, False),
]


def make_payload(size: int) -> bytes:
    pattern = bytes(range(251))
    repetitions, remainder = divmod(size, len(pattern))
    return pattern * repetitions + pattern[:remainder]


def connect_devices(client: TestClient, room: str, token: str):
    sender_context = client.websocket_connect(f"/ws?room={room}&token={token}")
    sender = sender_context.__enter__()
    sender.send_json({"type": "join", "device_id": "bench_sender_0001", "name": "Benchmark sender", "device_type": "Computer"})
    sender.receive_json()
    recipient_context = client.websocket_connect(f"/ws?room={room}&token={token}")
    recipient = recipient_context.__enter__()
    recipient.send_json({"type": "join", "device_id": "bench_receiver_0002", "name": "Benchmark receiver", "device_type": "Phone"})
    sender.receive_json()
    recipient.receive_json()
    return sender_context, sender, recipient_context, recipient


def benchmark_case(client, sender, recipient, token: str, payload: bytes, case):
    label, requested_mode, chunk_size, poll_every_chunk = case
    sender_id, recipient_id = "bench_sender_0001", "bench_receiver_0002"
    sender.send_json({"type": "transfer_request", "to": recipient_id, "files": [{"name": "relay-benchmark.bin", "size": len(payload)}]})
    pending = sender.receive_json()
    recipient.receive_json()
    transfer_id = pending["transfer_id"]
    recipient.send_json({"type": "transfer_decision", "transfer_id": transfer_id, "accepted": True})
    sender.receive_json()
    requested_behavior = "automatic" if requested_mode == "streaming" else "standard"
    sender.send_json({"type": "relay_begin", "transfer_id": transfer_id, "mode": requested_behavior, "chunk_size": chunk_size})
    mode_request = recipient.receive_json()
    if requested_behavior == "automatic":
        if mode_request.get("mode") != "automatic":
            raise RuntimeError("Automatic relay did not ask the recipient to decide capability.")
        recipient.send_json({"type": "relay_mode_decision", "transfer_id": transfer_id, "mode": "streaming", "capable": True})
        selected = recipient.receive_json()
        sender_selected = sender.receive_json()
        if selected.get("mode") != "streaming" or sender_selected.get("mode") != "streaming":
            raise RuntimeError("Live relay mode selection was not confirmed to both devices.")
        mode = "streaming"
    else:
        mode = mode_request["mode"]
        sender_selected = sender.receive_json()
        if mode != "disk" or sender_selected.get("mode") != "disk":
            raise RuntimeError("Standard relay mode was not confirmed to both devices.")

    upload_headers = {"X-Room-Token": token, "X-Device-ID": sender_id}
    download_headers = {"X-Room-Token": token, "X-Device-ID": recipient_id}
    base = f"/api/relay/{transfer_id}/0"
    process = psutil.Process(os.getpid())
    cpu_before = sum(process.cpu_times()[:2])
    started = time.perf_counter()
    download_started = None
    receiver_future = None
    receiver_pool = None

    if mode == "streaming":
        request_started = threading.Event()

        def receive_live():
            request_started.set()
            return client.get(base + "?offset=0&stream=1", headers=download_headers)

        receiver_pool = ThreadPoolExecutor(max_workers=1)
        receiver_future = receiver_pool.submit(receive_live)
        if not request_started.wait(timeout=5):
            raise RuntimeError("The streaming download request did not start.")
        download_started = time.perf_counter()

    offset, offset_queries = 0, 0
    while offset < len(payload):
        if poll_every_chunk or offset == 0:
            position = client.get(base + "/offset", headers=upload_headers)
            if position.status_code != 200:
                raise RuntimeError(f"Offset query failed: {position.status_code} {position.text}")
            offset = int(position.json()["offset"])
            offset_queries += 1
        end = min(len(payload), offset + chunk_size)
        response = client.post(base + f"?offset={offset}", headers=upload_headers, content=payload[offset:end])
        if response.status_code != 200:
            raise RuntimeError(f"Relay upload failed: {response.status_code} {response.text}")
        offset = int(response.json()["offset"])
    uploaded_at = time.perf_counter()

    if mode == "streaming":
        sender.send_json({"type": "relay_file_complete", "transfer_id": transfer_id, "file_index": 0})
        if recipient.receive_json().get("type") != "relay_file_ready":
            raise RuntimeError("The streaming relay did not verify the file.")
        downloaded = receiver_future.result(timeout=60)
        downloaded_at = time.perf_counter()
        receiver_pool.shutdown(wait=True)
    else:
        sender.send_json({"type": "relay_ready", "transfer_id": transfer_id, "hashes": []})
        if recipient.receive_json().get("type") != "relay_ready":
            raise RuntimeError("The disk relay did not verify the file.")
        download_started = time.perf_counter()
        downloaded = client.get(base + "?offset=0", headers=download_headers)
        downloaded_at = time.perf_counter()

    if downloaded.status_code != 200 or downloaded.content != payload:
        raise RuntimeError(f"Download failed integrity/length verification: HTTP {downloaded.status_code}.")
    finished = time.perf_counter()
    cpu_after = sum(process.cpu_times()[:2])
    rss_after = process.memory_info().rss
    recipient.send_json({"type": "transfer_complete", "transfer_id": transfer_id, "ok": True})
    if sender.receive_json().get("type") != "transfer_complete":
        raise RuntimeError("The transfer completion acknowledgement was not received.")

    size_mib = len(payload) / MIB
    upload_seconds = uploaded_at - started
    download_seconds = downloaded_at - download_started
    return {
        "case": label,
        "effective_mode": mode,
        "chunk_mib": chunk_size / MIB,
        "offset_queries": offset_queries,
        "upload_seconds": round(upload_seconds, 3),
        "upload_mib_s": round(size_mib / max(upload_seconds, 0.001), 2),
        "download_seconds": round(download_seconds, 3),
        "download_mib_s": round(size_mib / max(download_seconds, 0.001), 2),
        "end_to_end_seconds": round(finished - started, 3),
        "end_to_end_mib_s": round(size_mib / max(finished - started, 0.001), 2),
        "process_cpu_seconds": round(cpu_after - cpu_before, 3),
        "process_rss_mib": round(rss_after / MIB, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark local QuickDrop relay chunk sizes and transfer modes.")
    parser.add_argument("--file-mb", type=int, default=32, help="Generated file size in MiB (minimum 8, default 32).")
    parser.add_argument("--runs", type=int, default=3, help="Runs per case; reported values are medians (default: 3).")
    parser.add_argument("--cases", nargs="*", help="Optional case names to run.")
    args = parser.parse_args()
    if args.file_mb < 8:
        parser.error("--file-mb must be at least 8 to exercise every chunk size.")
    if args.runs < 1:
        parser.error("--runs must be at least 1.")
    unknown = set(args.cases or ()) - {case[0] for case in CASES}
    if unknown:
        parser.error("Unknown case name(s): " + ", ".join(sorted(unknown)))
    cases = [case for case in CASES if not args.cases or case[0] in args.cases]
    payload = make_payload(args.file_mb * MIB)
    with tempfile.TemporaryDirectory(prefix="quickdrop-relay-bench-") as folder:
        with TestClient(create_app(Path(folder)), client=("127.0.0.1", 1234)) as client:
            bootstrap = client.get("/api/bootstrap").json()
            contexts = connect_devices(client, bootstrap["room_id"], bootstrap["room_token"])
            sender_context, sender, recipient_context, recipient = contexts
            try:
                observations = {case[0]: [] for case in cases}
                for run_index in range(args.runs):
                    rotated_cases = cases[run_index % len(cases):] + cases[:run_index % len(cases)]
                    for case in rotated_cases:
                        result = benchmark_case(client, sender, recipient, bootstrap["room_token"], payload, case)
                        observations[case[0]].append(result)
                metric_keys = (
                    "upload_seconds", "upload_mib_s", "download_seconds", "download_mib_s",
                    "end_to_end_seconds", "end_to_end_mib_s", "process_cpu_seconds", "process_rss_mib",
                )
                results = []
                for case in cases:
                    runs = observations[case[0]]
                    summary = {key: round(statistics.median(item[key] for item in runs), 3 if key.endswith("seconds") or key.endswith("mib") else 2) for key in metric_keys}
                    results.append({
                        "case": case[0],
                        "effective_mode": runs[0]["effective_mode"],
                        "chunk_mib": runs[0]["chunk_mib"],
                        "offset_queries": runs[0]["offset_queries"],
                        "median": summary,
                        "observations": runs,
                    })
            finally:
                recipient_context.__exit__(None, None, None)
                sender_context.__exit__(None, None, None)
    print(json.dumps({
        "environment": "in-process ASGI and local temporary disk; not a Wi-Fi benchmark",
        "file_mib": args.file_mb,
        "runs_per_case": args.runs,
        "baseline_note": "The baseline emulates 1 MiB upload chunks plus an offset GET before every chunk; disk writes still use the current server implementation.",
        "streaming_note": "In-process TestClient buffers response bodies; the streaming download duration includes time waiting for the upload and is not a real recipient-link rate.",
        "results": results,
    }, indent=2))


if __name__ == "__main__":
    main()
