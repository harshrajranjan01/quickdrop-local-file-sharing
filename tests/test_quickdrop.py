import base64
import hashlib
import io
import socket
import zipfile
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient

from quickdrop import network, storage
from quickdrop.server import _qr_data_uri, create_app


def make_client(tmp_path, max_file_mb=2):
    return TestClient(
        create_app(data_root=tmp_path / "QuickDrop", max_file_mb=max_file_mb),
        client=("127.0.0.1", 1234),
    )


def room_credentials(client):
    response = client.get("/api/bootstrap")
    assert response.status_code == 200
    data = response.json()
    return data["room_id"], data["room_token"], data


def test_qr_generation_returns_png_data_uri():
    value = _qr_data_uri("http://192.168.0.12:8000/?room=abc&token=secret")
    header, encoded = value.split(",", 1)
    assert header == "data:image/png;base64"
    image = base64.b64decode(encoded)
    assert image.startswith(b"\x89PNG\r\n\x1a\n")


def test_network_detection_prefers_route_and_hotspot(monkeypatch):
    addresses = {
        "Wi-Fi": [SimpleNamespace(family=socket.AF_INET, address="192.168.1.20")],
        "Local Area Connection* 12": [SimpleNamespace(family=socket.AF_INET, address="192.168.137.1")],
        "Loopback": [SimpleNamespace(family=socket.AF_INET, address="127.0.0.1")],
    }
    stats = {name: SimpleNamespace(isup=True, speed=1000) for name in addresses}
    monkeypatch.setattr(network.psutil, "net_if_addrs", lambda: addresses)
    monkeypatch.setattr(network.psutil, "net_if_stats", lambda: stats)
    monkeypatch.setattr(network, "_default_route_ip", lambda: "192.168.1.20")

    regular = network.network_snapshot()
    hotspot = network.network_snapshot(prefer_hotspot=True)
    selected_wifi = network.network_snapshot(preferred_ip="192.168.1.20")
    missing_hotspot = network.network_snapshot(prefer_hotspot=True, preferred_ip="192.168.9.9")
    assert regular["local_ip"] == "192.168.1.20"
    assert regular["interface"] == "Wi-Fi"
    assert hotspot["local_ip"] == "192.168.137.1"
    assert hotspot["hotspot_status"] == "active"
    assert selected_wifi["interface"] == "Wi-Fi"
    assert missing_hotspot["local_ip"] == "192.168.137.1"
    assert len(hotspot["interfaces"]) == 2


def test_wifi_qr_escapes_wifi_delimiters():
    payload = network.wifi_qr_payload("My;WiFi", "pass:word,123")
    assert payload == r"WIFI:T:WPA;S:My\;WiFi;P:pass\:word\,123;H:false;;"


def test_bootstrap_room_auth_and_join_from_qr(tmp_path):
    with make_client(tmp_path) as client:
        assert "QuickDrop" in client.get("/").text
        assert client.get("/static/app.js").status_code == 200
        room, token, data = room_credentials(client)
        assert data["is_host"] is True
        assert len(room) == 12
        assert len(token) >= 64
        assert data["connection_qr"].startswith("data:image/png;base64,")
        assert client.get("/api/bootstrap", params={"room": "wrong", "token": token}).status_code == 403
        guest = client.get("/api/bootstrap", params={"room": room, "token": token})
        assert guest.status_code == 200
        assert guest.json()["room_id"] == room
        assert client.get("/api/files").status_code == 403
        assert client.get("/api/files", headers={"X-Room-Token": token}).status_code == 200


def test_host_can_choose_and_persist_a_network_interface(tmp_path, monkeypatch):
    interfaces = [
        {"name": "Wi-Fi", "ip": "192.168.1.20", "is_wifi": True, "is_hotspot": False, "speed_mbps": 866},
        {"name": "Ethernet", "ip": "10.0.0.8", "is_wifi": False, "is_hotspot": False, "speed_mbps": 1000},
    ]
    monkeypatch.setattr(network, "discover_interfaces", lambda: interfaces)
    monkeypatch.setattr(network, "_default_route_ip", lambda: "10.0.0.8")
    with make_client(tmp_path) as client:
        _, token, _ = room_credentials(client)
        response = client.post(
            "/api/network/interface", headers={"X-Room-Token": token}, json={"ip": "10.0.0.8"}
        )
        assert response.status_code == 200
        assert response.json()["local_ip"] == "10.0.0.8"
        assert response.json()["preferred_ip"] == "10.0.0.8"
        assert client.get("/api/bootstrap").json()["network"]["interface"] == "Ethernet"
        assert "10.0.0.8" in (tmp_path / "QuickDrop" / "settings.json").read_text(encoding="utf-8")


def test_upload_download_and_zip_preserve_names_and_contents(tmp_path):
    with make_client(tmp_path) as client:
        _, token, _ = room_credentials(client)
        response = client.post(
            "/api/files",
            headers={"X-Room-Token": token},
            files=[
                ("files", ("../first.txt", b"alpha", "text/plain")),
                ("files", ("first.txt", b"beta", "text/plain")),
                ("files", ("../../folder/space name.bin", b"\x00\x01\xff", "application/octet-stream")),
            ],
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert all(item["ok"] for item in results)
        assert {item["name"] for item in results} == {"first.txt", "space name.bin"}
        files = client.get("/api/files", headers={"X-Room-Token": token}).json()["files"]
        assert len(files) == 3
        downloaded = []
        for file_info in files:
            download = client.get(
                f"/api/files/{file_info['id']}/download",
            )
            assert download.status_code == 200
            downloaded.append(download.content)
        assert sorted(downloaded) == sorted([b"alpha", b"beta", b"\x00\x01\xff"])

        ids = [item["id"] for item in files]
        zip_response = client.post(
            "/api/files/zip", headers={"X-Room-Token": token}, json={"file_ids": ids}
        )
        assert zip_response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(zip_response.content)) as archive:
            assert set(archive.namelist()) == {"first.txt", "first (1).txt", "space name.bin"}
            assert sorted(archive.read(name) for name in archive.namelist()) == sorted([b"alpha", b"beta", b"\x00\x01\xff"])

        zip_stream = client.get(
            "/api/files/zip-download",
            params={"file_ids": ",".join(ids)},
            headers={"X-Room-Token": token},
        )
        assert zip_stream.status_code == 200
        assert zipfile.is_zipfile(io.BytesIO(zip_stream.content))
        zip_form = client.post("/api/files/zip-download", data={"file_ids": ids})
        assert zip_form.status_code == 200, zip_form.text
        assert zipfile.is_zipfile(io.BytesIO(zip_form.content))
        assert list((tmp_path / "QuickDrop" / "Temp").glob("quickdrop-*.zip")) == []


def test_filename_sanitization_and_zip_never_deletes_shared_files(tmp_path):
    shared = tmp_path / "Shared"
    shared.mkdir()
    assert storage.sanitize_filename(r"C:\Users\someone\..\secret?.txt") == "secret_.txt"
    assert storage.sanitize_filename("../../") == "upload.bin"
    files = []
    for name, content in (("same.txt", b"one"), ("same.txt", b"two")):
        path = shared / f"{uuid4().hex}__{name}"
        path.write_bytes(content)
        files.append(path)
    identifiers = [path.name.split("__", 1)[0] for path in files]
    archive_path = storage.create_zip(shared, identifiers, tmp_path / "Temp")
    assert archive_path.is_file()
    assert all(path.exists() for path in files)
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.namelist() == ["same.txt", "same (1).txt"]


def test_host_can_delete_one_or_many_shared_files_but_room_devices_cannot(tmp_path):
    app = create_app(data_root=tmp_path / "QuickDrop", max_file_mb=2)
    with TestClient(app, client=("127.0.0.1", 1234)) as host:
        room, token, _ = room_credentials(host)
        upload = host.post(
            "/api/files",
            headers={"X-Room-Token": token},
            files=[
                ("files", ("one.txt", b"one", "text/plain")),
                ("files", ("two.txt", b"two", "text/plain")),
                ("files", ("three.txt", b"three", "text/plain")),
            ],
        )
        ids = [item["id"] for item in upload.json()["results"]]

        guest = TestClient(app, client=("192.168.1.99", 2345))
        joined = guest.get("/api/bootstrap", params={"room": room, "token": token})
        assert joined.status_code == 200
        assert joined.json()["is_host"] is False
        denied = guest.post(
            "/api/files/delete", headers={"X-Room-Token": token}, json={"file_ids": [ids[0]]}
        )
        assert denied.status_code == 403

        single = host.post("/api/files/delete", headers={"X-Room-Token": token}, json={"file_ids": [ids[0]]})
        assert single.status_code == 200
        assert single.json()["deleted_count"] == 1

        multiple = host.post(
            "/api/files/delete", headers={"X-Room-Token": token}, json={"file_ids": ids[1:]}
        )
        assert multiple.status_code == 200
        assert multiple.json()["deleted_count"] == 2
        assert host.get("/api/files", headers={"X-Room-Token": token}).json()["files"] == []


def test_notes_are_delivered_to_one_or_all_connected_room_devices(tmp_path):
    with make_client(tmp_path) as client:
        room, token, _ = room_credentials(client)
        with client.websocket_connect(f"/ws?room={room}&token={token}") as sender:
            sender.send_json({"type": "join", "device_id": "notes_sender_0001", "name": "Laptop", "device_type": "Computer"})
            assert sender.receive_json()["type"] == "devices"
            with client.websocket_connect(f"/ws?room={room}&token={token}") as first:
                first.send_json({"type": "join", "device_id": "notes_phone_0002", "name": "Phone", "device_type": "Phone"})
                sender.receive_json(); first.receive_json()
                with client.websocket_connect(f"/ws?room={room}&token={token}") as second:
                    second.send_json({"type": "join", "device_id": "notes_tablet_0003", "name": "Tablet", "device_type": "Tablet"})
                    sender.receive_json(); first.receive_json(); second.receive_json()

                    sender.send_json({
                        "type": "note_send", "client_id": "single-note",
                        "to": "notes_phone_0002", "text": "Remember this link: https://example.com",
                    })
                    received = first.receive_json()
                    result = sender.receive_json()
                    assert received["type"] == "note_received"
                    assert received["note"]["text"] == "Remember this link: https://example.com"
                    assert received["note"]["sender"] == {"id": "notes_sender_0001", "name": "Laptop"}
                    assert result["type"] == "note_result"
                    assert result["client_id"] == "single-note"
                    assert result["delivered_to"] == [{"id": "notes_phone_0002", "name": "Phone"}]

                    sender.send_json({"type": "note_send", "client_id": "room-note", "to": "all", "text": "Meet here"})
                    first_room_note = first.receive_json()
                    second_room_note = second.receive_json()
                    room_result = sender.receive_json()
                    assert first_room_note["type"] == second_room_note["type"] == "note_received"
                    assert first_room_note["note"]["text"] == second_room_note["note"]["text"] == "Meet here"
                    assert room_result["type"] == "note_result"
                    assert {item["id"] for item in room_result["delivered_to"]} == {"notes_phone_0002", "notes_tablet_0003"}

                    sender.send_json({"type": "note_send", "client_id": "bad-note", "to": "missing-device", "text": "Hello"})
                    invalid = sender.receive_json()
                    assert invalid["type"] == "note_result"
                    assert invalid["delivered_to"] == []
                    assert invalid["errors"]


def test_upload_limit_and_traversal_download_protection(tmp_path):
    with make_client(tmp_path, max_file_mb=1) as client:
        _, token, _ = room_credentials(client)
        payload = b"x" * (1024 * 1024 + 1)
        response = client.post(
            "/api/files", headers={"X-Room-Token": token},
            files=[("files", ("too-large.bin", payload, "application/octet-stream"))],
        )
        assert response.status_code == 200
        result = response.json()["results"][0]
        assert result["ok"] is False
        assert "limit" in result["error"].lower()
        assert client.get("/api/files", headers={"X-Room-Token": token}).json()["files"] == []
        assert client.get("/api/files/../../README.md/download", headers={"X-Room-Token": token}).status_code in {404, 422}


def test_room_devices_signaling_and_disconnect(tmp_path):
    with make_client(tmp_path) as client:
        room, token, _ = room_credentials(client)
        with client.websocket_connect(f"/ws?room={room}&token={token}") as sender:
            sender.send_json({"type": "join", "device_id": "device_sender_0001", "name": "Laptop", "device_type": "Computer"})
            one = sender.receive_json()
            assert one["type"] == "devices" and len(one["devices"]) == 1
            with client.websocket_connect(f"/ws?room={room}&token={token}") as recipient:
                recipient.send_json({"type": "join", "device_id": "device_phone_0002", "name": "Phone", "device_type": "Phone"})
                joined_sender = sender.receive_json()
                joined_recipient = recipient.receive_json()
                assert joined_sender["type"] == joined_recipient["type"] == "devices"
                assert len(joined_sender["devices"]) == 2

                sender.send_json({"type": "transfer_request", "to": "device_phone_0002", "files": [{"name": "x.txt", "size": 3}]})
                pending = sender.receive_json()
                incoming = recipient.receive_json()
                assert pending["type"] == "transfer_pending"
                assert incoming["type"] == "incoming_transfer"
                recipient.send_json({"type": "transfer_decision", "transfer_id": incoming["transfer_id"], "accepted": True})
                assert sender.receive_json()["type"] == "transfer_decision"
                sender.send_json({
                    "type": "webrtc_signal", "to": "device_phone_0002", "transfer_id": incoming["transfer_id"],
                    "signal": {"type": "candidate", "candidate": {"candidate": "candidate:local"}},
                })
                signal = recipient.receive_json()
                assert signal["type"] == "webrtc_signal"
                assert signal["signal"]["candidate"]["candidate"] == "candidate:local"
                recipient.close()
                offline = sender.receive_json()
                assert offline["type"] == "devices"
                assert [item["id"] for item in offline["devices"]] == ["device_sender_0001"]


def test_accepted_transfer_uses_verified_server_relay_fallback(tmp_path):
    payload = b"fallback data including binary \x00\xfe"
    digest = hashlib.sha256(payload).hexdigest()
    with make_client(tmp_path, max_file_mb=1) as client:
        room, token, _ = room_credentials(client)
        with client.websocket_connect(f"/ws?room={room}&token={token}") as sender:
            sender.send_json({"type": "join", "device_id": "device_sender_0011", "name": "Sender", "device_type": "Computer"})
            sender.receive_json()
            with client.websocket_connect(f"/ws?room={room}&token={token}") as recipient:
                recipient.send_json({"type": "join", "device_id": "device_phone_0012", "name": "Recipient", "device_type": "Phone"})
                sender.receive_json(); recipient.receive_json()
                sender.send_json({
                    "type": "transfer_request", "to": "device_phone_0012",
                    "files": [{"name": "too-big.bin", "size": 1024 * 1024 + 1}],
                })
                too_big = sender.receive_json()
                assert too_big["type"] == "transfer_error"
                sender.send_json({"type": "transfer_request", "to": "device_phone_0012", "files": [{"name": "data.bin", "size": len(payload)}]})
                pending = sender.receive_json()
                incoming = recipient.receive_json()
                recipient.send_json({"type": "transfer_decision", "transfer_id": pending["transfer_id"], "accepted": True})
                sender.receive_json()
                sender.send_json({"type": "relay_begin", "transfer_id": pending["transfer_id"]})
                assert recipient.receive_json()["type"] == "relay_begin"

                upload = client.post(
                    f"/api/relay/{pending['transfer_id']}/0?offset=0",
                    headers={"X-Room-Token": token, "X-Device-ID": "device_sender_0011"},
                    content=payload,
                )
                assert upload.status_code == 200
                sender.send_json({"type": "relay_ready", "transfer_id": pending["transfer_id"], "hashes": [digest]})
                ready = recipient.receive_json()
                assert ready["type"] == "relay_ready"
                assert ready["files"][0]["sha256"] == digest
                download = client.get(
                    f"/api/relay/{pending['transfer_id']}/0",
                    headers={"X-Room-Token": token, "X-Device-ID": "device_phone_0012"},
                )
                assert download.status_code == 200
                assert download.content == payload
                recipient.send_json({"type": "transfer_complete", "transfer_id": pending["transfer_id"], "ok": True})
                sender_result = sender.receive_json()
                assert sender_result["type"] == "transfer_complete"
                assert sender_result["ok"] is True

                sender.send_json({"type": "transfer_request", "to": "device_phone_0012", "files": [{"name": "tamper.bin", "size": len(payload)}]})
                pending = sender.receive_json()
                incoming = recipient.receive_json()
                recipient.send_json({"type": "transfer_decision", "transfer_id": pending["transfer_id"], "accepted": True})
                sender.receive_json()
                sender.send_json({"type": "relay_begin", "transfer_id": pending["transfer_id"]})
                recipient.receive_json()
                client.post(
                    f"/api/relay/{pending['transfer_id']}/0?offset=0",
                    headers={"X-Room-Token": token, "X-Device-ID": "device_sender_0011"},
                    content=payload,
                )
                sender.send_json({"type": "relay_ready", "transfer_id": pending["transfer_id"], "hashes": ["0" * 64]})
                mismatch = sender.receive_json()
                assert mismatch["type"] == "transfer_error"
                assert "verify" in mismatch["message"].lower()


def test_hotspot_failure_is_reported_and_manual_mode_builds_wifi_qr(tmp_path, monkeypatch):
    monkeypatch.setattr(network.platform, "system", lambda: "Linux")
    with make_client(tmp_path) as client:
        _, token, _ = room_credentials(client)
        headers = {"X-Room-Token": token}
        failed = client.post("/api/hotspot", headers=headers, json={"action": "start", "ssid": "QuickDrop", "password": "quickdrop123"})
        assert failed.status_code == 200
        assert failed.json()["ok"] is False
        assert failed.json()["network_mode"] == "wifi"
        manual = client.post("/api/hotspot", headers=headers, json={"action": "manual", "ssid": "QuickDrop", "password": "quickdrop123"})
        assert manual.status_code == 200
        assert manual.json()["network_mode"] == "hotspot"
        assert manual.json()["wifi_qr"].startswith("data:image/png;base64,")
