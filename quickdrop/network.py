"""Local network discovery and Windows hotspot helpers."""

from __future__ import annotations

import platform
import socket
import subprocess
from typing import Any

import psutil


def discover_interfaces() -> list[dict[str, Any]]:
    stats = psutil.net_if_stats()
    found: list[dict[str, Any]] = []
    for name, addresses in psutil.net_if_addrs().items():
        status = stats.get(name)
        if not status or not status.isup:
            continue
        for address in addresses:
            if address.family != socket.AF_INET:
                continue
            ip = address.address
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            lowered = name.lower()
            hotspot = "local area connection" in lowered or "wi-fi direct" in lowered
            wifi = any(word in lowered for word in ("wi-fi", "wifi", "wireless", "wlan"))
            found.append({"name": name, "ip": ip, "is_wifi": wifi, "is_hotspot": hotspot, "speed_mbps": status.speed})
    return found


def _default_route_ip() -> str | None:
    """Ask the OS routing table which interface would reach a non-routable test address."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        ip = sock.getsockname()[0]
        return ip if ip and not ip.startswith("127.") else None
    except OSError:
        return None
    finally:
        sock.close()


def network_snapshot(prefer_hotspot: bool = False, preferred_ip: str | None = None) -> dict[str, Any]:
    interfaces = discover_interfaces()
    route_ip = _default_route_ip()
    selected = None
    if preferred_ip:
        selected = next((item for item in interfaces if item["ip"] == preferred_ip), None)
    if selected is None and prefer_hotspot:
        selected = next((item for item in interfaces if item.get("is_hotspot")), None)
    if selected is None and not prefer_hotspot:
        routed = next((item for item in interfaces if item["ip"] == route_ip), None)
        selected = routed if routed and routed["is_wifi"] else next((item for item in interfaces if item["is_wifi"]), None)
        if selected is None:
            selected = routed
    if selected is None and interfaces and not prefer_hotspot:
        selected = interfaces[0]
    return {
        "interfaces": interfaces,
        "local_ip": selected["ip"] if selected else None,
        "interface": selected["name"] if selected else None,
        "is_wifi": selected["is_wifi"] if selected else False,
        "available": bool(interfaces),
        "hotspot_status": "active" if selected and selected.get("is_hotspot") else "not_detected" if prefer_hotspot else "unknown",
    }


def wifi_qr_payload(ssid: str, password: str) -> str:
    def escape(value: str) -> str:
        return "".join("\\" + char if char in "\\;,:\"" else char for char in value)

    return f"WIFI:T:WPA;S:{escape(ssid)};P:{escape(password)};H:false;;"


def start_legacy_hotspot(ssid: str, password: str) -> dict[str, Any]:
    """Try Windows' legacy hosted-network API; modern adapters may not support it."""
    if platform.system() != "Windows":
        return {"ok": False, "message": "Automatic hotspot activation is available only on Windows."}
    if not 1 <= len(ssid) <= 32:
        return {"ok": False, "message": "The hotspot name must contain 1 to 32 characters."}
    if not 8 <= len(password) <= 63:
        return {"ok": False, "message": "The hotspot password must contain 8 to 63 characters."}
    try:
        configured = subprocess.run(
            ["netsh", "wlan", "set", "hostednetwork", "mode=allow", f"ssid={ssid}", f"key={password}"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if configured.returncode != 0:
            detail = (configured.stderr or configured.stdout).strip()
            return {"ok": False, "message": detail or "This Wi-Fi adapter does not support Windows hosted networks."}
        started = subprocess.run(
            ["netsh", "wlan", "start", "hostednetwork"], capture_output=True, text=True, timeout=15, check=False
        )
        if started.returncode != 0:
            detail = (started.stderr or started.stdout).strip()
            return {"ok": False, "message": detail or "Windows could not start the hosted network."}
        return {"ok": True, "message": "Windows hosted network started. Refresh network details in a few seconds."}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "message": str(exc)}


def stop_legacy_hotspot() -> dict[str, Any]:
    if platform.system() != "Windows":
        return {"ok": False, "message": "Automatic hotspot control is available only on Windows."}
    try:
        result = subprocess.run(
            ["netsh", "wlan", "stop", "hostednetwork"], capture_output=True, text=True, timeout=15, check=False
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            return {"ok": False, "message": detail or "Windows could not stop the hosted network."}
        return {"ok": True, "message": "Windows hosted network stopped."}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "message": str(exc)}
