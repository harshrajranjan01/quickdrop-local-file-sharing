# QuickDrop

QuickDrop is a local file-sharing app hosted by a Windows laptop. Nearby devices can use a browser to send files directly to one another, upload files to a shared folder on the host, and exchange notes or links.

QuickDrop does not require an account, a cloud storage service, a database, or a separate mobile app. Devices can connect over the same Wi-Fi network or through the host laptop’s hotspot. Internet access is not required for local transfers, except when installing Python packages or when you choose to use an external STUN/TURN server.

## Features

- Join the room by scanning a QR code or opening its private link.
- Send files to a selected device. The recipient can accept or reject each transfer.
- Use a direct WebRTC connection when available, with the host laptop as a relay fallback.
- Pause and resume transfers manually. QuickDrop can also pause transfers when a connection drops and resume from the last confirmed point after it reconnects.
- View a live performance dashboard with transfer progress, route, speed, estimated time, and other transfer details.
- Upload files to the host laptop so room members can download them later.
- Select and download shared files together as a ZIP.
- Delete one or more shared files from the host laptop. Only the host can delete them.
- Send notes, copied text, and links to one connected device or all other connected devices.
- Configure Wi-Fi interface selection, hotspot settings, relay behaviour, file size, and optional STUN/TURN servers.
- Inspect optional WebRTC diagnostics, including the selected ICE candidate pair and interval measurements.

## Requirements

- Windows 10 or newer for the host laptop and hotspot controls
- Python 3.10 or newer
- A modern web browser on each device
- A shared Wi-Fi network or the host laptop’s hotspot

No separate frontend build or mobile app installation is required.

## Project Structure

```text
QuickDrop_Sharing/
├── main.py
├── requirements.txt
├── README.md
├── relay_benchmark.py
├── quickdrop/
│   ├── __init__.py
│   ├── network.py
│   ├── server.py
│   └── storage.py
├── static/
│   ├── app.js
│   ├── index.html
│   ├── notes.css
│   ├── refresh.css
│   └── styles.css
└── tests/
    └── test_quickdrop.py
```

### Main project files

- `main.py` starts the FastAPI application and configures the listening address, port, and optional HTTPS certificate.
- `quickdrop/server.py` contains the web server, room and device management, WebSocket signalling, transfer coordination, and API routes.
- `quickdrop/storage.py` handles shared-file uploads, downloads, ZIP creation, temporary relay data, and file cleanup.
- `quickdrop/network.py` discovers network interfaces and provides Windows hotspot helpers.
- `static/index.html` defines the application interface.
- `static/app.js` handles browser interactions, WebRTC transfers, relay transfers, notes, and the live dashboard.
- `static/*.css` contains the application’s visual styles.
- `relay_benchmark.py` runs a local, in-process benchmark for relay modes and chunk sizes. It is not a Wi-Fi or WebRTC benchmark.
- `tests/test_quickdrop.py` contains the backend test suite.

## Installation

1. Open PowerShell in the project folder.
2. Create a virtual environment:

   ```powershell
   py -3 -m venv .venv
   ```

3. Activate it:

   ```powershell
   .\.venv\Scripts\Activate.ps1
   ```

4. Install the project dependencies:

   ```powershell
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt
   ```

If PowerShell blocks virtual-environment activation, install the packages using the virtual environment’s Python directly:

```powershell
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Running

1. Open PowerShell in the project folder.
2. Activate the virtual environment if it is not already active:

   ```powershell
   .\.venv\Scripts\Activate.ps1
   ```

3. Start QuickDrop:

   ```powershell
   python main.py
   ```

   Or, without activating the environment:

   ```powershell
   .\.venv\Scripts\python.exe main.py
   ```

4. Keep the PowerShell window open while QuickDrop is running.
5. On the host laptop, open:

   ```text
   http://127.0.0.1:8000
   ```

If Windows Firewall asks whether Python can communicate over a network, allow it on private networks so nearby devices can connect. Press **Ctrl+C** in the PowerShell window to stop QuickDrop.

## Connecting Devices

1. Connect the host laptop and nearby devices to the same Wi-Fi network, or enable the laptop hotspot.
2. Start QuickDrop and open the host dashboard.
3. Scan the **QuickDrop room QR code** with each device, or copy and open the room link.
4. Open the link in the device’s browser. The device appears in the room when it connects.

The room link contains a private access token. Share it only with people you want to join. Restarting QuickDrop creates a new room and token, so devices must use the new QR code or link afterward.

## Sending Files to a Device

1. Open **Device transfer**.
2. Select a connected recipient.
3. Choose or drop one or more files.
4. Select **Send**.
5. The recipient can accept or reject the request.

QuickDrop attempts a direct WebRTC transfer first. If a direct connection cannot be established, an accepted transfer can use the host laptop as a relay.

### Direct WebRTC transfers

Direct transfers send data between the two devices through an ordered, reliable WebRTC DataChannel. QuickDrop divides data into 64 KiB messages, checks 1 MiB blocks with CRC32, and uses acknowledgements to confirm received blocks. The recipient’s normal browser download is created after a file completes; the standard direct-transfer path assembles the file in memory while it is being received.

Connection interruptions can pause a transfer. QuickDrop attempts to resume from the last confirmed point after connectivity returns. You can also use the **Pause**, **Resume**, and **Cancel** controls on the transfer card.

### Laptop relay transfers

If WebRTC cannot connect directly, the sender uploads data to temporary disk-backed storage on the laptop. QuickDrop can resume relay uploads from the last saved offset after a temporary interruption.

The **Relay download behaviour** preference is available under **Network** settings:

- **Automatic (Recommended):** When the recipient’s browser supports folder access, the recipient can choose a destination folder. QuickDrop makes each fully uploaded and verified file available while later files are uploading. It does not expose a partially uploaded file as complete.
- **Standard:** The recipient waits for the whole batch to finish uploading and pass verification before downloading begins.

If folder access is unavailable or the recipient declines it, QuickDrop uses Standard Relay. This preference is saved in the current browser and is used for transfers sent from that browser.

### Integrity checks

Direct WebRTC transfers check each 1 MiB block with CRC32. The laptop relay verifies completed files with SHA-256 and CRC32 before making them available. A transfer is marked complete after the receiving device confirms its files.

## Live Performance Dashboard

The dashboard shows active transfer information, including progress, current route, end-to-end speed, transferred data, and estimated remaining time.

For laptop-relay transfers, the dashboard also shows the sender-to-laptop upload rate and laptop-to-recipient download rate. The host CPU and memory figures describe the QuickDrop server process.

Speed depends on the devices, Wi-Fi equipment, browser, and network conditions. An internet speed test measures a different path and does not predict the speed between two devices on the local network.

## Shared Files

Open **Shared files** and upload files to make them available to members of the room. Completed uploads appear in the host laptop’s shared folder:

```text
QuickDrop/Shared/
```

Room members can download individual files or select several files and download them as a ZIP.

The host can select and delete one or more shared files from the dashboard. Deletion permanently removes those files from the shared folder. Room members can download files but cannot delete them.

When a file is uploaded, QuickDrop stages it under temporary storage and adds it to `Shared` after the upload completes. ZIP archives are also created under temporary storage and removed after the download or when temporary files are cleaned up.

## Notes & Links

Open **Notes & Links** to type a note, paste text, or share a link. Choose one connected device or **All other connected devices**, then select **Send**.

Received notes appear in the inbox. Use **Copy** to copy a note or **Open link** to open a shared web address. Clipboard access depends on browser permissions and may require HTTPS.

Notes are delivered to devices currently connected to the room. QuickDrop does not keep a permanent notes history; received notes are lost when the page is refreshed or closed.

## Network Tab

The **Network** tab contains connection and transfer settings.

### Existing Wi-Fi

QuickDrop uses the host laptop’s current Wi-Fi connection by default. The host can choose which active network interface is used in the room QR link. This changes the address QuickDrop advertises; it does not switch the laptop’s Wi-Fi connection.

Select **Refresh details** to update the active interface and local IP address. Devices must be able to communicate on the selected network. Some routers enable client isolation, which prevents devices from reaching one another.

### Laptop hotspot

The host can configure a hotspot name and password and try to start it automatically. Automatic startup depends on Windows and Wi-Fi adapter support.

If automatic startup is unavailable, use **Open Windows settings** to enable Mobile Hotspot in Windows. Once it is active:

1. Scan the **Wi-Fi QR code** on the phone and confirm the request to join.
2. Scan the separate **QuickDrop room QR code** to open the app.

The Wi-Fi QR code joins the hotspot; the room QR code opens QuickDrop. Select **Use existing Wi-Fi** to return to the laptop’s regular Wi-Fi network.

### Host file size setting

The host can set a maximum size per file for server uploads and device transfers. The setting is saved on the laptop in:

```text
QuickDrop/settings.json
```

The default is 2,048 MB per file. The host can change it in **Network** settings.

### HTTPS and direct transfers

Some browsers restrict WebRTC on plain HTTP local-network addresses. A trusted local HTTPS certificate can enable direct WebRTC transfers in more browsers. The host needs to run QuickDrop with the certificate, and each phone must trust the certificate authority.

Server uploads and laptop-relay transfers can still work over HTTP. If devices can open QuickDrop but cannot connect directly to each other, the router may have client isolation enabled. Try the laptop hotspot or check the router settings.

#### Optional HTTPS setup with mkcert

[mkcert](https://github.com/FiloSottile/mkcert) can create a locally trusted certificate for development.

1. Install mkcert on the host laptop and install its local certificate authority:

   ```powershell
   mkcert -install
   ```

2. Find the host laptop’s current local IP address under **Network** settings.
3. Create a certificate for that address. Replace `192.168.1.5` with the IP shown in QuickDrop:

   ```powershell
   New-Item -ItemType Directory -Force QuickDrop | Out-Null
   mkcert -key-file QuickDrop\https-key.pem -cert-file QuickDrop\https-cert.pem localhost 127.0.0.1 192.168.1.5
   ```

4. Set the certificate paths and start QuickDrop from the same PowerShell window:

   ```powershell
   $env:QUICKDROP_TLS_CERT = "QuickDrop\https-cert.pem"
   $env:QUICKDROP_TLS_KEY = "QuickDrop\https-key.pem"
   python main.py
   ```

5. Install and trust mkcert’s root CA certificate on each phone, then open the HTTPS room link. Run `mkcert -CAROOT` to find the folder containing `rootCA.pem`. Transfer only `rootCA.pem` to your devices; keep `rootCA-key.pem` private. On iOS, enable full trust for the installed root certificate.

The certificate must include the laptop’s current IP address. If that address changes, create a new certificate and restart QuickDrop.

### Optional private STUN/TURN server

QuickDrop does not provide a STUN or TURN server by default. For networks where direct WebRTC connections are blocked, you can enter one or more server URLs under **Optional private STUN/TURN server**. Add credentials if the server requires them, then select **Save on this device**.

These settings are saved in that browser and are not shared automatically with other devices. Configure the browsers involved in WebRTC transfers as needed. Leave the fields blank for ordinary same-network use.

## Optional WebRTC Diagnostics

The diagnostics panel is hidden unless enabled through the room link. Append `&webrtc-diagnostics=1` to the link on each device you want to measure.

The panel samples WebRTC statistics approximately once per second. It can record the selected ICE candidate pair, candidate types and protocols, RTT, available byte and packet counters, throughput samples, buffered amount, and timing for CRC checks, acknowledgements, receiver processing, and file writes. Select **Download report** on each device to save its JSON report.

For a receiving comparison, you can also append one of these parameters:

- `&webrtc-output=memory` verifies received data and then discards it. No file is saved.
- `&webrtc-output=file` asks for a destination folder and writes received blocks there. This requires a secure browser context and folder-access support.

The default diagnostic output mode follows QuickDrop’s normal browser-download path. Do not use memory mode when you need to keep the transferred file. Inspect reports before sharing them because they can contain browser, device, peer, and file-name information.

## Files and Temporary Data

QuickDrop creates a data folder beside the project entry point:

```text
QuickDrop/
├── Shared/
├── Temp/
│   ├── uploads/
│   ├── relays/
│   └── temporary ZIP files
├── settings.json
└── optional HTTPS certificate files
```

- `Shared/` contains completed files uploaded to the host for room members.
- `Temp/uploads/` holds incomplete server uploads until they finish.
- `Temp/relays/` holds disk-backed relay data used for transfer and resume.
- Temporary ZIP files are created when selected shared files are downloaded together.
- `settings.json` stores host settings such as the file-size limit and preferred network interface.

Temporary upload, relay, and ZIP data is removed after it is no longer needed or when stale temporary data is cleaned up. Keep enough free disk space on the host for shared files and active relayed transfers.

## Configuration

QuickDrop reads these optional environment variables when it starts:

| Variable | Default | Purpose |
|---|---:|---|
| `QUICKDROP_HOST` | `0.0.0.0` | Network address the server listens on |
| `QUICKDROP_PORT` | `8000` | Server port |
| `QUICKDROP_MAX_FILE_MB` | `2048` | Initial per-file size limit, used when no saved value overrides it |
| `QUICKDROP_TLS_CERT` | — | Path to the HTTPS certificate |
| `QUICKDROP_TLS_KEY` | — | Path to the HTTPS private key |

For example, to use port `8080`:

```powershell
$env:QUICKDROP_PORT = "8080"
python main.py
```

The host’s saved settings take precedence over the initial file-size environment value once `QuickDrop/settings.json` exists.

## Testing and Relay Benchmarking

Run the backend tests with the virtual environment active:

```powershell
python -m pytest -q
```

Run the local relay benchmark with a 16 MiB test file and three runs per case:

```powershell
python relay_benchmark.py --file-mb 16 --runs 3
```

The benchmark compares local relay modes and chunk sizes using an in-process test server and temporary disk. It does not measure Wi-Fi performance and should not be treated as a real-device WebRTC benchmark.

## Troubleshooting

- **No local IP or room QR appears:** Connect the laptop to Wi-Fi or enable its hotspot, then refresh network details.
- **A phone cannot open the room:** Confirm it joined the same Wi-Fi or hotspot. Check the host’s selected network interface and Windows Firewall settings.
- **The room link is invalid:** QuickDrop may have restarted. Scan the current room QR code.
- **Direct transfer does not connect:** Try trusted HTTPS, check the router’s client-isolation setting, or try the laptop hotspot. An accepted transfer can use the laptop relay.
- **Hotspot startup fails:** Enable Mobile Hotspot manually in Windows Settings. Automatic startup depends on adapter and driver support.
- **A transfer pauses:** Check whether either device lost Wi-Fi or left the room. QuickDrop attempts to resume when the connection returns; you can also use the transfer’s **Resume** control.
- **A file upload fails:** Check available disk space and the current per-file size setting.
- **A ZIP download fails:** Confirm the selected files are still shared and that the host has free temporary disk space.
- **A phone shows a certificate warning:** Confirm it trusts the certificate authority and that the certificate includes the laptop’s current IP address.
- **A very large direct transfer uses substantial memory:** The normal direct WebRTC receive path assembles a file in browser memory before creating the download. Browser and device memory can therefore affect large transfers.

## Privacy and Network Use

QuickDrop has no user accounts or cloud storage service. The room link includes a private token, so share it only with people you trust. The host laptop stores shared files and relay data locally.

By default, devices use the local network and the host relay. If you configure a STUN/TURN service, WebRTC may contact that configured service to establish or relay a connection. QuickDrop does not operate that service.