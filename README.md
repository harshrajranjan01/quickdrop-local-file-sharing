# QuickDrop

QuickDrop is a local file-sharing app hosted by a Windows laptop. Devices on the same Wi-Fi network or laptop hotspot can open the room in a browser to send files, share files, and exchange notes or links.

QuickDrop does not require an account, a cloud service, a database, or a separate mobile app. Internet access is only needed to install Python packages, unless they are already available on the laptop.

## Features

- Connect devices by scanning a room QR code.
- Send files to a selected device. The recipient can accept or reject each transfer.
- Transfer files directly between devices when the browser and network support WebRTC. QuickDrop can relay transfers through the host laptop when a direct connection is unavailable.
- Upload files to the host laptop so everyone in the room can download them.
- Download selected shared files together as a ZIP.
- Delete shared files from the host laptop’s dashboard.
- Send notes, copied text, and links to one connected device or all other connected devices.
- View received notes, copy their text, and open shared links.
- Choose which network interface QuickDrop uses for its room link.
- Configure the host laptop’s file-size setting and hotspot options.

## Requirements

- Windows 10 or newer
- Python 3.10 or newer
- A modern web browser on each device
- A shared Wi-Fi network or the host laptop’s hotspot

## Project structure

```text
QuickDrop_Sharing/
├── main.py
├── requirements.txt
├── README.md
├── quickdrop/
│   ├── __init__.py
│   ├── network.py
│   ├── server.py
│   └── storage.py
├── static/
│   ├── app.js
│   ├── index.html
│   ├── notes.css
│   └── styles.css
└── tests/
    └── test_quickdrop.py
```

## Installation

1. Open PowerShell in the project folder.
2. Create a virtual environment:

   ```powershell
   py -3 -m venv .venv
   ```

3. Activate the environment:

   ```powershell
   .\.venv\Scripts\Activate.ps1
   ```

4. Install the required packages:

   ```powershell
   python -m pip install -r requirements.txt
   ```

If PowerShell prevents environment activation, install the packages using the environment’s Python directly:

```powershell
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

   If you did not activate the environment, run:

   ```powershell
   .\.venv\Scripts\python.exe main.py
   ```

4. Keep the terminal open while QuickDrop is running.
5. On the host laptop, open:

   ```text
   http://127.0.0.1:8000
   ```

If Windows Firewall asks whether Python can communicate on a network, allow it on private networks so nearby devices can connect.

### Optional running settings

QuickDrop uses port `8000` by default. To use another port, set it before starting the app:

```powershell
$env:QUICKDROP_PORT = "8080"
python main.py
```

The default file-size setting is 2,048 MB per file. You can change it in **Network settings** in the dashboard. The setting is saved for the host. To choose a different initial value before the first run:

```powershell
$env:QUICKDROP_MAX_FILE_MB = "4096"
python main.py
```

## Connecting devices

1. Connect the host laptop and nearby devices to the same Wi-Fi network, or turn on the laptop hotspot.
2. Start QuickDrop and open the host dashboard.
3. Scan the **QuickDrop connection QR** with each phone or other device.
4. Open the room link in the device’s browser. The device will appear in the dashboard when it connects.

The room link contains a private access token. Share the QR only with people you want to join. Restarting QuickDrop creates a new room link, so devices need to scan the updated QR after a restart.

## Sending files to a device

1. Open **Device transfer**.
2. Select a connected recipient.
3. Choose or drop one or more files into the transfer area.
4. Select **Send**.
5. The recipient can accept or reject the request.

QuickDrop tries to send files directly between devices first. If the browser or network cannot establish a direct connection, the host laptop relays the transfer. Transfers show progress and use SHA-256 checks to verify received files.

## Sharing files from the host laptop

Open **Shared files** and upload files to make them available to everyone in the room. QuickDrop stores these files in:

```text
QuickDrop/Shared/
```

Room members can download individual files or select several files and download them as a ZIP.

The host can delete one file or delete multiple selected files from the dashboard. Only the host can delete shared files. Deletion permanently removes the selected files from the shared folder.

ZIP downloads are created in temporary storage and removed after the download finishes or the temporary file expires. The original shared files remain in place.

## Sharing notes and links

Open **Notes & Links** to type a note, paste text, or share a link. Choose one connected device or **All other connected devices**, then select **Send**.

Received notes appear in the inbox. Use **Copy** to copy a note or **Open link** to open a shared web address. The Paste button uses browser clipboard access when available. If clipboard access is unavailable, focus the text box and paste using your device’s normal keyboard shortcut.

Notes are delivered live to devices connected to the room. They are not saved as history and disappear from the inbox when its page is refreshed or closed.

## Network setup

### Using existing Wi-Fi

QuickDrop uses the host laptop’s current Wi-Fi connection by default. Connect all devices to the same Wi-Fi network, then scan the room QR.

If the laptop has multiple active network interfaces, the host can choose which one QuickDrop uses for the room link under **Network settings**. Some routers block devices from communicating with one another. If devices can open the dashboard but cannot connect directly, try the laptop hotspot or check the router’s client-isolation setting.

### Using the laptop hotspot

In **Network settings**, enter a hotspot name and password, then select **Try automatic start**. Automatic startup depends on the laptop’s Wi-Fi adapter and driver.

If automatic startup is unavailable:

1. Select **Open Windows settings** in QuickDrop.
2. Set up and turn on **Mobile hotspot** in Windows.
3. Return to QuickDrop and refresh network details if needed.
4. Scan the **Wi-Fi QR** on the phone and accept the prompt to join.
5. Scan the separate **QuickDrop connection QR** to open the room.

The Wi-Fi QR joins the hotspot. The QuickDrop QR opens the app; they serve different purposes.

Choose **Use existing Wi-Fi** in QuickDrop to switch back. If you turned on Mobile hotspot manually in Windows, turn it off from Windows Settings when you are finished.

## Optional: HTTPS for direct transfers

Some browsers restrict WebRTC on plain HTTP network addresses, which can prevent direct transfers from working reliably on phones. File uploads, downloads, room presence, and transfers relayed through the laptop can work over HTTP. Trusted HTTPS can enable direct transfers in more browsers.

One option for creating a local certificate is [mkcert](https://github.com/FiloSottile/mkcert).

1. Install mkcert on the host laptop and install its local certificate authority:

   ```powershell
   mkcert -install
   ```

2. Find the host laptop’s current local IP address under **Network settings** in QuickDrop.
3. Create a certificate for that address. Replace `192.168.1.5` with the address shown in QuickDrop:

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

5. Install and trust mkcert’s root CA certificate on each phone, then scan the HTTPS room QR. Use `mkcert -CAROOT` to find the folder containing `rootCA.pem`. Transfer only `rootCA.pem` to your devices; keep `rootCA-key.pem` private. On iOS, enable full trust for the installed root certificate.

The certificate must include the host laptop’s current IP address. If that address changes, create a new certificate and restart QuickDrop.

QuickDrop does not use a public STUN server by default. If a network blocks direct connections, you can configure a private STUN or TURN server under **Network settings** on both devices. QuickDrop does not provide a TURN server.

## Files and settings

QuickDrop stores app data in the `QuickDrop/` folder:

- Shared files: `QuickDrop/Shared/`
- Temporary ZIP and relay data: `QuickDrop/Temp/`
- Saved host settings: `QuickDrop/settings.json`
- Optional TLS certificate files: `QuickDrop/`

Relay data is temporary and is removed after a transfer completes, expires, or QuickDrop restarts. Leave enough free disk space for shared files and relayed transfers.

## Troubleshooting

- **No room QR or local address:** Connect the laptop to Wi-Fi or turn on its hotspot, then refresh network details.
- **A phone cannot open the room:** Check that it joined the same Wi-Fi or hotspot. Check the Windows Firewall prompt and the selected network interface.
- **The room link is invalid:** QuickDrop may have restarted. Scan the new room QR.
- **A direct transfer cannot connect:** Try trusted HTTPS, check whether the router blocks device-to-device traffic, or try the laptop hotspot. QuickDrop can relay accepted transfers through the host.
- **Hotspot startup fails:** Turn on Mobile hotspot manually in Windows Settings. Automatic startup depends on Wi-Fi adapter support.
- **An upload fails:** Check available disk space and the configured per-file size setting, then try again.
- **A ZIP download fails:** Confirm the selected files are still shared and that the host has enough temporary disk space.
- **A certificate warning appears:** Make sure the device trusts the CA and that the certificate includes the host’s current IP address.

## Running the tests

With the virtual environment active, run:

```powershell
python -m pytest -q
```

The tests cover room access, device connections, signaling, file uploads and downloads, host-only deletion, ZIP creation, network selection, hotspot behavior, and relayed transfers.

## Browser and transfer notes

Transfer speed depends on the Wi-Fi connection, network adapters, browser, and storage speed. Direct transfers use the recipient’s browser support. Browsers without the File System Access API use their normal download flow, which may use more memory for very large transfers.