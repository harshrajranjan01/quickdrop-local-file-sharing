(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const suppliedRoom = params.get('room');
  const suppliedToken = params.get('token');
  const query = new URLSearchParams();
  if (suppliedRoom) query.set('room', suppliedRoom);
  if (suppliedToken) query.set('token', suppliedToken);
  const deviceId = getDeviceId();
  let access = null;
  let roomId = null;
  let isHost = false;
  let maxFileMb = 2048;
  let myName = localStorage.getItem('quickdrop-device-name') || guessName();
  let myType = guessType();
  let socket = null;
  let reconnectDelay = 1000;
  let devices = [];
  let sharedFiles = [];
  let selectedPeer = '';
  let selectedServerFiles = new Set();
  let transfers = new Map();
  let receivedNotes = [];
  let unreadNotes = 0;
  const pendingNotes = new Map();
  let outgoingSelection = [];
  let connectionUrl = '';

  function getDeviceId() {
    let value = localStorage.getItem('quickdrop-device-id');
    if (!value) {
      value = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replaceAll('-', '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('quickdrop-device-id', value);
    }
    return value;
  }

  function guessType() {
    const ua = navigator.userAgent || '';
    if (/ipad|tablet/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'Tablet';
    if (/android|iphone|ipod/i.test(ua)) return 'Phone';
    return 'Computer';
  }

  function guessName() {
    const ua = navigator.userAgent || '';
    if (/windows/i.test(ua)) return 'Windows laptop';
    if (/android/i.test(ua)) return 'Android phone';
    if (/iphone|ipad/i.test(ua)) return /ipad/i.test(ua) ? 'iPad' : 'iPhone';
    if (/macintosh/i.test(ua)) return 'Mac';
    return 'This device';
  }

  function prettyBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[index];
  }

  function safeFileName(name) {
    const leaf = String(name || 'upload.bin').replace(/\\/g, '/').split('/').pop();
    const safe = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 180);
    return safe || 'upload.bin';
  }

  function measuredRate(bytes, started) {
    if (!started || !bytes) return '';
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);
    return (bytes / seconds / (1024 * 1024)).toFixed(1) + ' MB/s';
  }

  function toast(message, type = '') {
    const item = document.createElement('div');
    item.className = 'toast ' + type;
    item.textContent = message;
    byId('toast-region').append(item);
    setTimeout(() => item.remove(), 4500);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (access) headers.set('X-Room-Token', access);
    const response = await fetch(path, { ...options, headers });
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error((body && body.detail) || response.statusText || 'Request failed');
    return body;
  }

  async function initialize() {
    try {
      const response = await fetch('/api/bootstrap' + (query.size ? '?' + query.toString() : ''));
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not join the QuickDrop room.');
      access = data.room_token;
      roomId = data.room_id;
      isHost = !!data.is_host;
      maxFileMb = data.max_file_mb || maxFileMb;
      connectionUrl = data.connection_url || '';
      document.body.classList.toggle('dark', localStorage.getItem('quickdrop-theme') === 'dark');
      byId('app-content').classList.remove('hidden');
      byId('join-gate').classList.add('hidden');
      byId('room-label').textContent = roomId;
      byId('device-name').value = myName;
      byId('identity-name').textContent = myName;
      byId('identity-type').textContent = myType;
      byId('device-id-label').textContent = 'ID ' + deviceId.slice(0, 12);
      byId('host-label').classList.toggle('hidden', !isHost);
      document.querySelectorAll('.host-only').forEach((element) => element.classList.toggle('hidden', !isHost));
      document.querySelector('.participant-hotspot').classList.toggle('hidden', isHost);
      byId('max-file-mb').value = maxFileMb;
      byId('max-size-label').textContent = maxFileMb + ' MB per file';
      updateNetworkUi(data.network, data);
      renderNotes();
      renderNoteRecipients();
      if (isHost) byId('shared-path').textContent = data.shared_directory;
      loadTurnSettings();
      setServerStatus(true, 'Room ready');
      connectSocket();
      await loadSharedFiles();
      refreshBootstrap();
      setInterval(refreshBootstrap, 12000);
      setInterval(loadSharedFiles, 12000);
      setInterval(() => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 20000);
    } catch (error) {
      byId('join-gate').classList.remove('hidden');
      byId('app-content').classList.add('hidden');
      byId('join-error').textContent = error.message;
      byId('join-error').classList.remove('hidden');
    }
  }

  async function refreshBootstrap() {
    try {
      const response = await fetch('/api/bootstrap?' + new URLSearchParams({ room: roomId, token: access }));
      if (!response.ok) return;
      const data = await response.json();
      connectionUrl = data.connection_url || connectionUrl;
      updateNetworkUi(data.network, data);
      if (data.devices) setDevices(data.devices);
    } catch (_) { /* the WebSocket status handles connectivity */ }
  }

  function updateNetworkUi(network, data) {
    if (data && data.connection_url) {
      connectionUrl = data.connection_url;
      byId('connection-url').value = connectionUrl;
      byId('qr-wrap').replaceChildren();
      if (data.connection_qr) {
        const img = document.createElement('img');
        img.src = data.connection_qr;
        img.alt = 'QuickDrop room connection QR code';
        byId('qr-wrap').append(img);
      }
      byId('connection-state').textContent = new URL(connectionUrl).protocol === 'https:' ? 'Secure link' : 'Local link';
      byId('connection-state').className = 'tag ' + (new URL(connectionUrl).protocol === 'https:' ? 'good' : 'warning');
      byId('secure-context-note').classList.toggle('hidden', !!window.isSecureContext);
    } else {
      byId('connection-url').value = 'No active local network address';
      byId('connection-state').textContent = 'Network unavailable';
      byId('connection-state').className = 'tag warning';
    }
    if (network) {
      byId('local-ip').textContent = network.local_ip || 'No active IPv4 address';
      byId('active-interface').textContent = network.interface || 'Not detected';
      byId('network-name').textContent = network.interface ? network.interface + ' · ' + (network.local_ip || 'No IPv4') : 'No network';
      if (isHost) {
        const select = byId('network-interface');
        const selected = network.preferred_ip || network.local_ip || '';
        select.replaceChildren();
        if (!network.interfaces || !network.interfaces.length) {
          const option = document.createElement('option'); option.value = ''; option.textContent = 'No active interface'; select.append(option);
        } else {
          for (const item of network.interfaces) {
            const option = document.createElement('option'); option.value = item.ip;
            option.textContent = item.name + ' · ' + item.ip + (item.is_hotspot ? ' · Hotspot' : item.is_wifi ? ' · Wi-Fi' : '');
            select.append(option);
          }
          select.value = selected;
        }
      }
    }
    if (data && data.wifi_qr) showWifiQr(data.wifi_qr);
    else if (data && data.network_mode === 'wifi') byId('wifi-qr-row').classList.add('hidden');
    if (data && data.network_mode) {
      const hotspot = data.network_mode === 'hotspot';
      byId('wifi-mode-tag').classList.toggle('hidden', hotspot);
      byId('hotspot-mode-tag').classList.toggle('hidden', !hotspot);
      if (isHost) {
        const status = network && network.hotspot_status;
        byId('hotspot-status').textContent = hotspot
          ? (status === 'active' ? 'Adapter detected' : 'Waiting for Windows adapter')
          : 'Off · using existing Wi-Fi';
      }
    }
  }

  function showWifiQr(src) {
    byId('wifi-qr').src = src;
    byId('wifi-qr-row').classList.remove('hidden');
  }

  function setServerStatus(ok, label) {
    byId('server-dot').className = 'status-dot ' + (ok ? 'online' : 'offline');
    byId('server-status').textContent = label;
  }

  function connectSocket() {
    if (!access) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = scheme + '//' + location.host + '/ws?' + new URLSearchParams({ room: roomId, token: access });
    socket = new WebSocket(url);
    socket.onopen = () => {
      reconnectDelay = 1000;
      setServerStatus(true, 'Connected to room');
      byId('peer-support').textContent = window.isSecureContext ? 'WebRTC direct · relay fallback' : 'Laptop relay · direct transfer may be blocked';
      socket.send(JSON.stringify({ type: 'join', device_id: deviceId, name: myName, device_type: myType }));
      updateNoteSendButton();
    };
    socket.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch (_) { toast('A room message could not be read.', 'error'); }
    };
    socket.onerror = () => setServerStatus(false, 'Connection interrupted');
    socket.onclose = () => {
      setServerStatus(false, 'Reconnecting…');
      updateNoteSendButton();
      setTimeout(connectSocket, reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 1.7);
    };
  }

  function sendSocket(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('The room connection is offline. Reconnecting…');
    socket.send(JSON.stringify(message));
  }

  function handleMessage(message) {
    if (message.type === 'devices') setDevices(message.devices || []);
    else if (message.type === 'pong') setServerStatus(true, 'Connected to room');
    else if (message.type === 'note_received') {
      if (message.note && message.note.id) {
        receivedNotes.unshift(message.note);
        if (!byId('notes-view').classList.contains('active-view')) unreadNotes++;
        renderNotes();
        if (!byId('notes-view').classList.contains('active-view')) toast('New note from ' + (message.note.sender && message.note.sender.name || 'a device') + '.');
      }
    } else if (message.type === 'note_result') {
      const pending = pendingNotes.get(message.client_id);
      pendingNotes.delete(message.client_id);
      const delivered = message.delivered_to || [];
      const errors = message.errors || [];
      if (delivered.length) {
        if (pending && byId('note-text').value === pending.text) byId('note-text').value = '';
        updateNoteCharacterCount();
        toast('Note sent to ' + delivered.map((item) => item.name).join(', ') + '.');
      }
      if (errors.length) toast(errors.join(' '), 'error');
      updateNoteSendButton();
    }
    else if (message.type === 'transfer_pending') {
      const state = {
        id: message.transfer_id, direction: 'out', peerId: message.to,
        peerName: deviceName(message.to), files: outgoingSelection.slice(), status: 'Waiting for recipient approval',
        progress: 0, incoming: false, created: Date.now(), verified: new Set(), hashes: []
      };
      transfers.set(state.id, state);
      renderTransfers();
    } else if (message.type === 'incoming_transfer') {
      const state = {
        id: message.transfer_id, direction: 'in', peerId: message.sender.id,
        peerName: message.sender.name, files: message.files || [], status: 'Waiting for your approval',
        progress: 0, incoming: true, accepted: false, created: Date.now(), verified: new Set(),
        candidates: [], remoteSet: false, receiveQueue: Promise.resolve()
      };
      transfers.set(state.id, state);
      renderTransfers();
    } else if (message.type === 'transfer_decision') {
      const state = transfers.get(message.transfer_id);
      if (!state) return;
      if (!message.accepted) {
        state.status = 'Declined by recipient';
        state.done = true;
        renderTransfers();
        expireTransfer(state);
      } else {
        state.accepted = true;
        state.status = 'Connecting directly…';
        renderTransfers();
        startDirect(state);
      }
    } else if (message.type === 'webrtc_signal') {
      handleSignal(message).catch((error) => {
        const state = transfers.get(message.transfer_id);
        if (state) { state.status = 'Direct connection failed · using laptop relay'; renderTransfers(); }
      });
    } else if (message.type === 'relay_begin') {
      const state = transfers.get(message.transfer_id);
      if (state) abortPartialReceive(state, true).then(() => { state.mode = 'relay'; state.status = 'Using the laptop relay…'; renderTransfers(); });
    } else if (message.type === 'relay_ready') {
      const state = transfers.get(message.transfer_id);
      if (state) receiveRelay(state, message.files || []).catch((error) => failTransfer(state, error.message));
    } else if (message.type === 'transfer_progress') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        state.progress = total ? Math.min(100, (Number(message.loaded || 0) / total) * 100) : 100;
        state.status = (message.phase === 'relay-upload' ? 'Sending through laptop · ' : 'Transferring · ') + prettyBytes(message.loaded || 0) + ' of ' + prettyBytes(message.total || total) + ' · ' + measuredRate(message.loaded || 0, state.transferStarted);
        renderTransfers();
      }
    } else if (message.type === 'transfer_complete') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        state.status = message.ok ? 'Completed · integrity verified' : (message.message || 'Transfer failed');
        state.progress = message.ok ? 100 : state.progress;
        state.done = true;
        closePeer(state);
        renderTransfers();
        expireTransfer(state);
      }
    } else if (message.type === 'transfer_error') {
      const state = transfers.get(message.transfer_id);
      if (state) failTransfer(state, message.message || 'The transfer failed.');
      else toast(message.message || 'Could not start the transfer.', 'error');
    }
  }

  function deviceName(id) {
    const item = devices.find((device) => device.id === id);
    return item ? item.name : 'selected device';
  }

  function setDevices(items) {
    devices = items;
    byId('device-count').textContent = String(devices.length);
    byId('tab-device-count').textContent = String(Math.max(0, devices.length - 1));
    const list = byId('devices-list');
    list.replaceChildren();
    if (!devices.length) {
      list.append(makeText('div', 'empty-state', 'Waiting for devices to join…'));
    }
    if (!devices.some((item) => item.id === selectedPeer)) selectedPeer = '';
    for (const device of devices) {
      const row = document.createElement('label');
      row.className = 'device-row' + (selectedPeer === device.id ? ' selected' : '');
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'recipient'; radio.value = device.id;
      radio.checked = selectedPeer === device.id;
      radio.disabled = device.id === deviceId;
      radio.addEventListener('change', () => { selectedPeer = device.id; renderDevices(); updateSendButton(); });
      const icon = makeText('span', 'device-icon', iconFor(device.device_type));
      const detail = document.createElement('span'); detail.className = 'device-detail';
      const name = document.createElement('span'); name.className = 'device-name'; name.textContent = device.name;
      if (device.id === deviceId) name.append(makeText('span', 'device-you', 'YOU'));
      const meta = makeText('span', 'device-info', device.device_type + ' · ID ' + device.id.slice(0, 10));
      detail.append(name, meta);
      row.append(radio, icon, detail);
      if (device.id !== deviceId) row.append(makeText('span', 'online-label', '● Online'));
      else row.append(makeText('span', 'online-label', 'This device'));
      list.append(row);
    }
    renderDevices();
    updateSendButton();
    renderNoteRecipients();
    updateNoteSendButton();
  }

  function renderNoteRecipients() {
    const select = byId('note-recipient');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a connected device';
    select.append(placeholder);

    const others = devices.filter((item) => item.id !== deviceId);
    if (others.length > 1) {
      const all = document.createElement('option');
      all.value = 'all';
      all.textContent = 'All other connected devices (' + others.length + ')';
      select.append(all);
    }
    for (const device of others) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.name + ' · ' + device.device_type;
      select.append(option);
    }
    if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
    updateNoteSendButton();
  }

  function updateNoteCharacterCount() {
    const length = byId('note-text').value.length;
    byId('note-character-count').textContent = length + (length === 1 ? ' character' : ' characters');
    updateNoteSendButton();
  }

  function updateNoteSendButton() {
    const button = byId('send-note');
    if (!button) return;
    const hasRecipient = !!byId('note-recipient').value;
    const hasText = !!byId('note-text').value.trim();
    const connected = socket && socket.readyState === WebSocket.OPEN;
    button.disabled = !hasRecipient || !hasText || !connected;
    button.textContent = connected ? 'Send' : 'Connecting…';
  }

  function sendNote() {
    const text = byId('note-text').value;
    const target = byId('note-recipient').value;
    if (!target || !text.trim()) return;
    const clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    pendingNotes.set(clientId, { text });
    try {
      sendSocket({ type: 'note_send', client_id: clientId, to: target, text });
      updateNoteSendButton();
    } catch (error) {
      pendingNotes.delete(clientId);
      toast(error.message, 'error');
    }
  }

  async function pasteNote() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('Clipboard access is unavailable here.');
      const text = await navigator.clipboard.readText();
      if (!text) return toast('Your clipboard is empty.');
      const field = byId('note-text');
      const start = field.selectionStart;
      const end = field.selectionEnd;
      field.setRangeText(text, start, end, 'end');
      field.focus();
      updateNoteCharacterCount();
    } catch (_) {
      byId('note-text').focus();
      toast('Use Ctrl+V or Paste from your device keyboard in the text box.');
    }
  }

  function firstNoteUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    if (!match) return '';
    const candidate = match[0].replace(/[.,!?;:)\]}]+$/g, '');
    try {
      const url = new URL(candidate);
      return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : '';
    } catch (_) { return ''; }
  }

  function appendNoteText(parent, text) {
    const pattern = /https?:\/\/[^\s<>"']+/gi;
    let cursor = 0;
    for (const match of String(text || '').matchAll(pattern)) {
      const raw = match[0];
      const url = firstNoteUrl(raw);
      if (!url) continue;
      let end = match.index + raw.length;
      let href = url;
      while (/[.,!?;:)\]}]$/.test(href)) href = href.slice(0, -1);
      end = match.index + href.length;
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = href;
      parent.append(link, document.createTextNode(raw.slice(href.length)));
      cursor = end + (raw.length - href.length);
    }
    parent.append(document.createTextNode(String(text || '').slice(cursor)));
  }

  async function copyNote(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Clipboard access is unavailable here.');
      toast('Note copied.');
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      toast(copied ? 'Note copied.' : 'Could not copy this note. Select and copy it manually.', copied ? '' : 'error');
    }
  }

  function renderNotes() {
    const host = byId('received-notes-list');
    if (!host) return;
    host.replaceChildren();
    byId('received-notes-count').textContent = String(receivedNotes.length);
    const badge = byId('notes-unread');
    badge.textContent = unreadNotes > 9 ? '9+' : String(unreadNotes);
    badge.classList.toggle('hidden', unreadNotes === 0);
    if (!receivedNotes.length) {
      host.append(makeText('div', 'empty-state', 'Notes from your friends will appear here.'));
      return;
    }
    for (const note of receivedNotes) {
      const card = document.createElement('article'); card.className = 'note-item';
      const heading = document.createElement('div'); heading.className = 'note-item-header';
      heading.append(makeText('strong', '', note.sender && note.sender.name || 'A device'));
      const date = note.sent_at ? new Date(note.sent_at) : null;
      heading.append(makeText('span', '', date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Just now'));
      const body = document.createElement('div'); body.className = 'note-text';
      appendNoteText(body, note.text || '');
      const actions = document.createElement('div'); actions.className = 'note-item-actions';
      const copy = makeText('button', 'button secondary compact', 'Copy');
      copy.addEventListener('click', () => copyNote(note.text || ''));
      actions.append(copy);
      const url = firstNoteUrl(note.text);
      if (url) {
        const open = makeText('a', 'button secondary compact', 'Open link');
        open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer';
        actions.append(open);
      }
      card.append(heading, body, actions);
      host.append(card);
    }
  }

  function renderDevices() {
    for (const row of byId('devices-list').querySelectorAll('.device-row')) {
      const radio = row.querySelector('input');
      row.classList.toggle('selected', !!radio && radio.checked);
    }
  }

  function iconFor(type) {
    if (/phone/i.test(type)) return '▯';
    if (/tablet/i.test(type)) return '▤';
    return '▣';
  }

  function makeText(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function updateSendButton() {
    const button = byId('send-files');
    const targetOnline = devices.some((device) => device.id === selectedPeer && device.id !== deviceId);
    button.disabled = !targetOnline || !outgoingSelection.length;
    button.textContent = !targetOnline ? 'Choose a recipient' : !outgoingSelection.length ? 'Choose files first' : 'Send ' + outgoingSelection.length + ' file' + (outgoingSelection.length === 1 ? '' : 's');
  }

  function updatePeerSelection(files) {
    outgoingSelection = Array.from(files || []);
    const total = outgoingSelection.reduce((sum, file) => sum + file.size, 0);
    byId('peer-file-summary').textContent = outgoingSelection.length ? outgoingSelection.length + ' file' + (outgoingSelection.length === 1 ? '' : 's') + ' · ' + prettyBytes(total) : 'No files selected';
    updateSendButton();
  }

  function renderTransfers() {
    const host = byId('transfers-list');
    host.replaceChildren();
    const items = Array.from(transfers.values()).sort((a, b) => b.created - a.created);
    if (!items.length) host.append(makeText('div', 'empty-state', 'Transfers will appear here.'));
    for (const item of items) {
      const row = document.createElement('article'); row.className = 'transfer-item';
      const icon = makeText('span', 'transfer-icon', item.direction === 'in' ? '↓' : '↑');
      const main = document.createElement('div'); main.className = 'transfer-main';
      const title = makeText('strong', '', (item.direction === 'in' ? item.peerName + ' is sending' : 'Sending to ' + item.peerName));
      const summary = item.files.map((file) => file.name).join(', ');
      const sub = makeText('small', '', item.files.length + ' file' + (item.files.length === 1 ? '' : 's') + ' · ' + summary);
      main.append(title, sub);
      const status = makeText('div', 'transfer-status', item.status);
      row.append(icon, main, status);
      if (item.incoming && !item.accepted && !item.done) {
        const actions = document.createElement('div'); actions.className = 'transfer-actions';
        const accept = makeText('button', 'button primary compact', 'Accept');
        const reject = makeText('button', 'button secondary compact', 'Reject');
        accept.addEventListener('click', () => acceptIncoming(item));
        reject.addEventListener('click', () => rejectIncoming(item));
        actions.append(accept, reject); row.append(actions);
      } else if (!item.done && (item.direction === 'out' || item.accepted)) {
        const track = document.createElement('div'); track.className = 'progress-track'; track.style.width = '100%';
        const fill = document.createElement('span'); fill.style.width = Math.max(2, item.progress || 0) + '%'; track.append(fill); row.append(track);
        const cancel = makeText('button', 'button secondary compact', 'Cancel');
        cancel.addEventListener('click', () => cancelTransfer(item));
        const actions = document.createElement('div'); actions.className = 'transfer-actions'; actions.append(cancel); row.append(actions);
      }
      host.append(row);
    }
  }

  async function requestSend() {
    if (!selectedPeer || !outgoingSelection.length) return;
    const tooLarge = outgoingSelection.find((file) => file.size > maxFileMb * 1024 * 1024);
    if (tooLarge) { toast(tooLarge.name + ' is above the ' + maxFileMb + ' MB per-file limit.', 'error'); return; }
    try {
      sendSocket({ type: 'transfer_request', to: selectedPeer, files: outgoingSelection.map((file) => ({ name: safeFileName(file.name), size: file.size })) });
      toast('Transfer request sent to ' + deviceName(selectedPeer) + '.');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function acceptIncoming(state) {
    state.accepted = true;
    state.status = 'Accepted · preparing connection';
    if (window.showDirectoryPicker && window.isSecureContext) {
      try { state.directory = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (error) { if (error.name !== 'AbortError') toast('Could not open the destination folder. Files will use browser downloads.', 'error'); }
    }
    try { sendSocket({ type: 'transfer_decision', transfer_id: state.id, accepted: true }); }
    catch (error) { state.status = error.message; }
    renderTransfers();
  }

  function rejectIncoming(state) {
    state.status = 'Declined'; state.done = true;
    try { sendSocket({ type: 'transfer_decision', transfer_id: state.id, accepted: false }); } catch (_) { }
    renderTransfers();
    expireTransfer(state);
  }

  function rtcConfig() {
    const serverText = localStorage.getItem('quickdrop-turn-url');
    if (!serverText) return { iceServers: [] };
    try { return JSON.parse(serverText); } catch (_) { return { iceServers: [] }; }
  }

  function setupPeer(state, sender) {
    const pc = new RTCPeerConnection(rtcConfig());
    state.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try { sendSocket({ type: 'webrtc_signal', to: state.peerId, transfer_id: state.id, signal: { type: 'candidate', candidate: event.candidate } }); } catch (_) { }
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (sender && !state.directDone) fallbackRelay(state).catch((error) => failTransfer(state, error.message));
      }
    };
    pc.ondatachannel = (event) => attachChannel(state, event.channel);
    if (sender) {
      const channel = pc.createDataChannel('quickdrop-files', { ordered: true });
      attachChannel(state, channel);
    }
    return pc;
  }

  function attachChannel(state, channel) {
    state.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onopen = () => {
      if (state.direction === 'out' && !state.startedDirect) {
        state.startedDirect = true;
        state.mode = 'direct';
        sendDirect(state).catch((error) => fallbackRelay(state, error));
      }
    };
    channel.onmessage = (event) => {
      if (state.receiveQueue) state.receiveQueue = state.receiveQueue.then(() => receiveMessage(state, event.data)).catch((error) => failTransfer(state, error.message));
    };
    channel.onerror = () => {
      if (state.direction === 'out' && !state.directDone) fallbackRelay(state).catch((error) => failTransfer(state, error.message));
    };
  }

  async function startDirect(state) {
    if (state.mode === 'fallback' || state.mode === 'fallbackstarting') return;
    if (!window.RTCPeerConnection) { await fallbackRelay(state); return; }
    try {
      setupPeer(state, true);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      sendSocket({ type: 'webrtc_signal', to: state.peerId, transfer_id: state.id, signal: { type: 'description', description: JSON.parse(JSON.stringify(state.pc.localDescription)) } });
      state.status = 'Connecting directly…'; renderTransfers();
      await waitForChannel(state.channel, state, 14000);
    } catch (error) {
      await fallbackRelay(state, error);
    }
  }

  function waitForChannel(channel, state, timeoutMs) {
    if (channel.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Direct connection timed out.')), timeoutMs);
      const opened = () => { clearTimeout(timeout); resolve(); };
      const closed = () => { clearTimeout(timeout); reject(new Error('Direct connection closed.')); };
      channel.addEventListener('open', opened, { once: true });
      channel.addEventListener('close', closed, { once: true });
      if (state.pc) state.pc.addEventListener('connectionstatechange', () => {
        if (state.pc.connectionState === 'failed') closed();
      }, { once: true });
    });
  }

  async function handleSignal(message) {
    const state = transfers.get(message.transfer_id);
    if (!state || !state.accepted) return;
    const signal = message.signal || {};
    if (signal.type === 'description' && signal.description && signal.description.type === 'offer') {
      if (!window.RTCPeerConnection) return;
      if (!state.pc) setupPeer(state, false);
      await state.pc.setRemoteDescription(signal.description);
      state.remoteSet = true;
      for (const candidate of state.candidates.splice(0)) await state.pc.addIceCandidate(candidate);
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      sendSocket({ type: 'webrtc_signal', to: state.peerId, transfer_id: state.id, signal: { type: 'description', description: JSON.parse(JSON.stringify(state.pc.localDescription)) } });
      state.status = 'Connecting directly…'; renderTransfers();
    } else if (signal.type === 'description' && signal.description && signal.description.type === 'answer') {
      if (!state.pc) return;
      await state.pc.setRemoteDescription(signal.description);
      state.remoteSet = true;
      for (const candidate of state.candidates.splice(0)) await state.pc.addIceCandidate(candidate);
    } else if (signal.type === 'candidate' && signal.candidate) {
      if (state.pc && state.remoteSet) await state.pc.addIceCandidate(signal.candidate);
      else state.candidates.push(signal.candidate);
    }
  }

  async function sendDirect(state) {
    const channel = state.channel;
    if (!channel || channel.readyState !== 'open') throw new Error('Direct connection is unavailable.');
    const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
    let sentTotal = 0;
    for (let index = 0; index < state.files.length; index++) {
      const file = state.files[index];
      state.status = 'Checking file integrity · ' + file.name; renderTransfers();
      const digest = await hashFile(file);
      state.hashes[index] = digest;
      if (!state.transferStarted) state.transferStarted = performance.now();
      channel.send(JSON.stringify({ type: 'file_start', index, name: safeFileName(file.name), size: file.size, sha256: digest }));
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        await waitForCapacity(channel);
        const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
        channel.send(buffer);
        sentTotal += buffer.byteLength;
        state.progress = totalSize ? (sentTotal / totalSize) * 100 : 100;
        if (offset === 0 || offset + chunkSize >= file.size || offset % (chunkSize * 20) === 0) {
          try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: sentTotal, total: totalSize, phase: 'direct' }); } catch (_) { }
          renderTransfers();
        }
      }
      channel.send(JSON.stringify({ type: 'file_end', index }));
    }
    channel.send(JSON.stringify({ type: 'all_done' }));
    state.status = 'Sent · waiting for recipient integrity check';
    state.progress = 100;
    renderTransfers();
  }

  function waitForCapacity(channel) {
    if (channel.bufferedAmount < 2 * 1024 * 1024) return Promise.resolve();
    return new Promise((resolve) => {
      channel.addEventListener('bufferedamountlow', resolve, { once: true });
      setTimeout(resolve, 300);
    });
  }

  async function fallbackRelay(state, reason) {
    if (!state || state.done || state.mode === 'fallback' || state.mode === 'fallbackstarting' || state.directDone) return;
    state.mode = 'fallbackstarting';
    state.status = 'Direct link unavailable · preparing laptop relay';
    closePeer(state);
    renderTransfers();
    try {
      sendSocket({ type: 'relay_begin', transfer_id: state.id });
      if (!state.transferStarted) state.transferStarted = performance.now();
      const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
      let sent = 0;
      const digests = [];
      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        const digest = await hashFile(file);
        digests.push(digest);
        if (file.size === 0) {
          const response = await fetch('/api/relay/' + encodeURIComponent(state.id) + '/' + index + '?offset=0', {
            method: 'POST',
            headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId, 'Content-Type': 'application/octet-stream' },
            body: new Blob([])
          });
          if (!response.ok) throw new Error('The laptop relay could not receive ' + file.name + '.');
        }
        for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
          const end = Math.min(file.size, offset + 1024 * 1024);
          const response = await fetch('/api/relay/' + encodeURIComponent(state.id) + '/' + index + '?offset=' + offset, {
            method: 'POST',
            headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId, 'Content-Type': 'application/octet-stream' },
            body: file.slice(offset, end)
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'The laptop relay could not receive ' + file.name + '.');
          }
          sent += end - offset;
          state.progress = totalSize ? sent / totalSize * 100 : 100;
          state.status = 'Sending through laptop · ' + prettyBytes(sent) + ' of ' + prettyBytes(totalSize);
          sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: sent, total: totalSize, phase: 'relay-upload' });
          renderTransfers();
        }
      }
      state.mode = 'fallback';
      state.status = 'Laptop relay ready · waiting for recipient';
      sendSocket({ type: 'relay_ready', transfer_id: state.id, hashes: digests });
      renderTransfers();
    } catch (error) {
      failTransfer(state, error.message || (reason && reason.message) || 'The laptop relay failed.');
    }
  }

  async function receiveMessage(state, data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'file_start') await startReceivingFile(state, message);
      else if (message.type === 'file_end') await finishReceivingFile(state, message.index);
      else if (message.type === 'all_done') {
        if (state.verified.size !== state.files.length) throw new Error('The recipient could not verify every file.');
        state.status = 'Completed · integrity verified'; state.progress = 100; state.done = true;
        sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok: true });
        closePeer(state); renderTransfers(); expireTransfer(state);
      }
      return;
    }
    if (!state.currentFile) throw new Error('Received file data before its metadata.');
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    const bytes = new Uint8Array(chunk);
    state.currentFile.hash.update(bytes);
    if (state.currentFile.writer) await state.currentFile.writer.write(bytes);
    else state.currentFile.chunks.push(bytes);
    state.currentFile.received += bytes.byteLength;
    const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const loadedBefore = state.files.slice(0, state.currentFile.index).reduce((sum, file) => sum + Number(file.size || 0), 0);
    state.progress = total ? ((loadedBefore + state.currentFile.received) / total) * 100 : 100;
    state.status = 'Receiving · ' + prettyBytes(state.currentFile.received) + ' of ' + prettyBytes(state.currentFile.size);
    renderTransfers();
  }

  async function startReceivingFile(state, metadata) {
    if (!state.transferStarted) state.transferStarted = performance.now();
    const file = state.files[metadata.index];
    if (!file || Number(metadata.size) !== Number(file.size)) throw new Error('File metadata did not match the transfer request.');
    state.currentFile = {
      index: metadata.index, name: metadata.name, size: metadata.size,
      expectedHash: metadata.sha256, hash: new SHA256(), received: 0, chunks: [], writer: null, outputName: metadata.name
    };
    if (state.verified.has(metadata.index)) return;
    if (state.directory) {
      const output = await uniqueFileHandle(state.directory, metadata.name);
      state.currentFile.outputName = output.name;
      state.currentFile.handle = output.handle;
      state.currentFile.writer = await output.handle.createWritable();
    }
  }

  async function finishReceivingFile(state, index) {
    const current = state.currentFile;
    if (!current || current.index !== index) throw new Error('File transfer sequence is invalid.');
    const digest = current.hash.digest();
    if (digest !== current.expectedHash || current.received !== current.size) {
      if (current.writer) await current.writer.abort().catch(() => { });
      if (current.handle && state.directory) await state.directory.removeEntry(current.outputName).catch(() => { });
      state.currentFile = null;
      throw new Error('Integrity check failed for ' + current.name + '. The file was discarded.');
    }
    if (current.writer) await current.writer.close();
    else downloadBlob(new Blob(current.chunks, { type: 'application/octet-stream' }), current.outputName);
    state.verified.add(index);
    state.currentFile = null;
  }

  async function receiveRelay(state, relayFiles) {
    state.mode = 'fallback';
    state.status = 'Downloading through the laptop relay…';
    if (!state.transferStarted) state.transferStarted = performance.now();
    renderTransfers();
    const totalSize = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    let receivedAll = 0;
    try {
      for (let index = 0; index < state.files.length; index++) {
        if (state.verified.has(index)) { receivedAll += Number(state.files[index].size || 0); continue; }
        const item = relayFiles[index];
        if (!item || item.sha256 !== (state.files[index].sha256 || item.sha256)) throw new Error('The relay sent unexpected file information.');
        const response = await fetch('/api/relay/' + encodeURIComponent(state.id) + '/' + index, {
          headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId }
        });
        if (!response.ok || !response.body) throw new Error('Could not download ' + state.files[index].name + ' from the laptop relay.');
        const output = await openOutput(state, state.files[index].name);
        const reader = response.body.getReader();
        const hash = new SHA256();
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          if (output.writer) await output.writer.write(value); else output.chunks.push(value);
          received += value.byteLength;
          state.status = 'Receiving through laptop · ' + prettyBytes(receivedAll + received) + ' of ' + prettyBytes(totalSize) + ' · ' + measuredRate(receivedAll + received, state.transferStarted);
          state.progress = totalSize ? (receivedAll + received) / totalSize * 100 : 100;
          renderTransfers();
        }
        const expected = item.sha256 || response.headers.get('X-Content-SHA256');
        if (received !== Number(state.files[index].size) || hash.digest() !== expected) {
          if (output.writer) await output.writer.abort().catch(() => { });
          if (output.handle && state.directory) await state.directory.removeEntry(output.name).catch(() => { });
          throw new Error('Integrity check failed for ' + state.files[index].name + '.');
        }
        if (output.writer) await output.writer.close();
        else downloadBlob(new Blob(output.chunks, { type: 'application/octet-stream' }), output.name);
        state.verified.add(index);
        receivedAll += received;
      }
      state.status = 'Completed · integrity verified'; state.progress = 100; state.done = true;
      sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok: true });
      renderTransfers(); expireTransfer(state);
    } catch (error) { throw error; }
  }

  async function openOutput(state, requestedName) {
    if (state.directory) {
      const output = await uniqueFileHandle(state.directory, requestedName);
      return { handle: output.handle, writer: await output.handle.createWritable(), chunks: [], name: output.name };
    }
    return { handle: null, writer: null, chunks: [], name: requestedName };
  }

  async function uniqueFileHandle(directory, requestedName) {
    const names = new Set();
    try { for await (const entry of directory.values()) names.add(entry.name.toLocaleLowerCase()); } catch (_) { }
    const dot = requestedName.lastIndexOf('.');
    const stem = dot > 0 ? requestedName.slice(0, dot) : requestedName;
    const extension = dot > 0 ? requestedName.slice(dot) : '';
    let outputName = requestedName;
    let counter = 1;
    while (names.has(outputName.toLocaleLowerCase())) outputName = stem + ' (' + counter++ + ')' + extension;
    const handle = await directory.getFileHandle(outputName, { create: true });
    return { handle, name: outputName };
  }

  async function abortPartialReceive(state, waitForQueue = false) {
    if (waitForQueue && state.receiveQueue) await state.receiveQueue.catch(() => { });
    const current = state.currentFile;
    if (current && !state.verified.has(current.index)) {
      if (current.writer) await current.writer.abort().catch(() => { });
      if (current.handle && state.directory) await state.directory.removeEntry(current.outputName).catch(() => { });
    }
    state.currentFile = null;
    state.receiveQueue = Promise.resolve();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.style.display = 'none';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function hashFile(file) {
    const hash = new SHA256();
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      hash.update(new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 1024 * 1024)).arrayBuffer()));
    }
    return hash.digest();
  }

  function failTransfer(state, message) {
    state.status = message || 'Transfer failed'; state.done = true;
    abortPartialReceive(state).catch(() => { });
    closePeer(state);
    try { sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok: false, message: state.status }); } catch (_) { }
    renderTransfers();
    toast(state.status, 'error');
    expireTransfer(state);
  }

  function closePeer(state) {
    if (state.channel) { try { state.channel.close(); } catch (_) { } }
    if (state.pc) { try { state.pc.close(); } catch (_) { } }
  }

  function cancelTransfer(state) {
    state.status = 'Cancelled'; state.done = true;
    abortPartialReceive(state).catch(() => { });
    closePeer(state);
    try { sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok: false, message: 'Transfer cancelled.' }); } catch (_) { }
    renderTransfers();
    expireTransfer(state);
  }

  function expireTransfer(state, delay = 12000) {
    setTimeout(() => {
      if (transfers.get(state.id) === state && state.done) {
        transfers.delete(state.id);
        renderTransfers();
      }
    }, delay);
  }

  function SHA256() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer = new Uint8Array(0); this.bytes = 0;
  }
  SHA256.K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  SHA256.prototype.update = function (input) {
    const data = new Uint8Array(this.buffer.length + input.length);
    data.set(this.buffer); data.set(input, this.buffer.length); this.bytes += input.length;
    const blocks = data.length - (data.length % 64);
    const w = new Uint32Array(64);
    const rotate = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < blocks; offset += 64) {
      for (let i = 0; i < 16; i++) { const p = offset + i * 4; w[i] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0; }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
        const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a=this.h[0],b=this.h[1],c=this.h[2],d=this.h[3],e=this.h[4],f=this.h[5],g=this.h[6],h=this.h[7];
      for (let i = 0; i < 64; i++) {
        const s1 = rotate(e,6)^rotate(e,11)^rotate(e,25), ch=(e&f)^(~e&g);
        const t1=(h+s1+ch+SHA256.K[i]+w[i])>>>0;
        const s0=rotate(a,2)^rotate(a,13)^rotate(a,22), maj=(a&b)^(a&c)^(b&c);
        const t2=(s0+maj)>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      this.h[0]=(this.h[0]+a)>>>0;this.h[1]=(this.h[1]+b)>>>0;this.h[2]=(this.h[2]+c)>>>0;this.h[3]=(this.h[3]+d)>>>0;
      this.h[4]=(this.h[4]+e)>>>0;this.h[5]=(this.h[5]+f)>>>0;this.h[6]=(this.h[6]+g)>>>0;this.h[7]=(this.h[7]+h)>>>0;
    }
    this.buffer = data.slice(blocks); return this;
  };
  SHA256.prototype.digest = function () {
    const bitLength = this.bytes * 8;
    const zeros = (56 - ((this.buffer.length + 1) % 64) + 64) % 64;
    const padding = new Uint8Array(1 + zeros + 8); padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padding.length - 4, bitLength >>> 0);
    this.update(padding);
    return Array.from(this.h, (value) => value.toString(16).padStart(8, '0')).join('');
  };

  async function loadSharedFiles() {
    if (!access) return;
    try {
      const data = await api('/api/files');
      sharedFiles = data.files || [];
      maxFileMb = data.max_file_mb || maxFileMb;
      byId('max-size-label').textContent = maxFileMb + ' MB per file';
      if (isHost) byId('max-file-mb').value = maxFileMb;
      renderSharedFiles();
    } catch (error) { if (error.message) setServerStatus(false, 'Server unavailable'); }
  }

  function renderSharedFiles() {
    const host = byId('shared-files-list'); host.replaceChildren();
    byId('shared-count').textContent = String(sharedFiles.length);
    byId('tab-file-count').textContent = String(sharedFiles.length);
    byId('shared-path').textContent = isHost ? byId('shared-path').textContent : 'Shared with everyone in this room';
    if (!sharedFiles.length) host.append(makeText('div', 'empty-state', 'No shared files yet. Upload something to get started.'));
    for (const file of sharedFiles) {
      const row = document.createElement('div'); row.className = 'shared-file';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedServerFiles.has(file.id); checkbox.setAttribute('aria-label', 'Select ' + file.name);
      checkbox.addEventListener('change', () => { checkbox.checked ? selectedServerFiles.add(file.id) : selectedServerFiles.delete(file.id); updateZipButton(); });
      const icon = makeText('span', 'file-icon', '▤');
      const details = document.createElement('div'); details.className = 'shared-file-info';
      details.append(makeText('strong', '', file.name), makeText('small', '', prettyBytes(file.size)));
      const link = document.createElement('a'); link.className = 'download-link'; link.textContent = 'Download';
      link.href = '/api/files/' + encodeURIComponent(file.id) + '/download';
      row.append(checkbox, icon, details, link);
      if (isHost) {
        const remove = makeText('button', 'button danger compact delete-file', 'Delete');
        remove.setAttribute('aria-label', 'Delete ' + file.name + ' from the host laptop');
        remove.addEventListener('click', () => deleteOneFile(file));
        row.append(remove);
      }
      host.append(row);
    }
    selectedServerFiles = new Set(Array.from(selectedServerFiles).filter((id) => sharedFiles.some((file) => file.id === id)));
    updateZipButton();
  }

  function updateZipButton() {
    const count = selectedServerFiles.size;
    byId('selected-count').textContent = String(count);
    byId('download-zip').disabled = count === 0;
    byId('delete-selected').disabled = !isHost || count === 0;
    byId('delete-selected').textContent = 'Delete selected (' + count + ')';
  }

  function deleteOneFile(file) {
    if (!window.confirm('Permanently delete "' + file.name + '" from this laptop?')) return;
    deleteSelectedFiles([file.id]);
  }

  function deleteCheckedFiles() {
    const ids = Array.from(selectedServerFiles);
    if (!ids.length) return;
    if (!window.confirm('Permanently delete ' + ids.length + ' selected file' + (ids.length === 1 ? '' : 's') + ' from this laptop?')) return;
    deleteSelectedFiles(ids);
  }

  async function deleteSelectedFiles(fileIds) {
    const button = byId('delete-selected');
    button.disabled = true;
    try {
      const result = await api('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: fileIds })
      });
      const removed = new Set((result.deleted || []).map((file) => file.id));
      for (const id of removed) selectedServerFiles.delete(id);
      const failures = result.errors || [];
      if (failures.length) {
        const prefix = result.deleted_count ? 'Deleted ' + result.deleted_count + ' file(s). ' : '';
        toast(prefix + failures.length + ' could not be deleted: ' + failures[0].error, 'error');
      } else if (result.deleted_count) {
        toast('Deleted ' + result.deleted_count + ' file' + (result.deleted_count === 1 ? '' : 's') + ' from the host laptop.');
      }
      await loadSharedFiles();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      updateZipButton();
    }
  }

  function uploadServerFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    const form = new FormData();
    for (const file of selected) form.append('files', file, file.name);
    const row = document.createElement('div'); row.className = 'progress-row';
    const uploadStarted = performance.now();
    const label = document.createElement('div'); label.className = 'progress-label';
    const name = makeText('span', '', selected.length === 1 ? selected[0].name : selected.length + ' selected files');
    const percent = makeText('span', '', '0%'); label.append(name, percent);
    const track = document.createElement('div'); track.className = 'progress-track'; const fill = document.createElement('span'); track.append(fill); row.append(label, track); byId('upload-progress-list').append(row);
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/files'); xhr.setRequestHeader('X-Room-Token', access);
    const cancel = makeText('button', 'button secondary compact upload-cancel', 'Cancel');
    cancel.addEventListener('click', () => { cancel.disabled = true; xhr.abort(); });
    row.append(cancel);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) { const value = Math.round(event.loaded / event.total * 100); fill.style.width = value + '%'; percent.textContent = value + '% · ' + measuredRate(event.loaded, uploadStarted); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { }
      if (xhr.status >= 200 && xhr.status < 300) {
        const failures = (data.results || []).filter((item) => !item.ok);
        if (failures.length) toast(failures.map((item) => item.name + ': ' + item.error).join(' · '), 'error');
        else toast('Upload complete. Files are now shared with the room.');
        fill.style.width = '100%'; percent.textContent = failures.length ? 'Finished with errors' : 'Complete';
        loadSharedFiles();
      } else {
        percent.textContent = 'Failed'; toast((data.detail || 'Upload failed. Check the connection and available disk space.'), 'error');
      }
      setTimeout(() => row.remove(), 12000);
    };
    xhr.onerror = () => { percent.textContent = 'Failed'; toast('Upload connection failed. Check that the host is still running.', 'error'); };
    xhr.onabort = () => { percent.textContent = 'Cancelled'; toast('Upload cancelled.'); setTimeout(() => row.remove(), 5000); };
    xhr.send(form);
  }

  function downloadSelectedZip() {
    if (!selectedServerFiles.size) return;
    const form = document.createElement('form');
    form.method = 'POST'; form.action = '/api/files/zip-download'; form.style.display = 'none';
    for (const id of selectedServerFiles) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'file_ids'; input.value = id; form.append(input);
    }
    document.body.append(form); form.submit(); form.remove();
  }

  function initTabs() {
    document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active-view', view.id === button.dataset.view));
      if (button.dataset.view === 'shared-view') loadSharedFiles();
      if (button.dataset.view === 'notes-view') {
        unreadNotes = 0;
        renderNotes();
      }
    }));
  }

  function installDrop(inputId, zoneId, onFiles) {
    const input = byId(inputId), zone = byId(zoneId);
    input.addEventListener('change', () => { onFiles(input.files); input.value = ''; });
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('dragging'); onFiles(event.dataTransfer.files); });
  }

  function setView(viewId) {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active-view', view.id === viewId));
    if (viewId === 'notes-view') { unreadNotes = 0; renderNotes(); }
  }

  function initEvents() {
    initTabs();
    byId('note-text').addEventListener('input', updateNoteCharacterCount);
    byId('note-recipient').addEventListener('change', updateNoteSendButton);
    byId('paste-note').addEventListener('click', pasteNote);
    byId('send-note').addEventListener('click', sendNote);
    installDrop('peer-files', 'peer-drop-zone', updatePeerSelection);
    installDrop('server-files', 'server-drop-zone', uploadServerFiles);
    byId('send-files').addEventListener('click', requestSend);
    byId('refresh-devices').addEventListener('click', refreshBootstrap);
    byId('refresh-network').addEventListener('click', refreshBootstrap);
    byId('network-interface').addEventListener('change', async () => {
      try {
        await api('/api/network/interface', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: byId('network-interface').value }) });
        await refreshBootstrap();
        toast('Room QR updated to use the selected interface.');
      } catch (error) { toast(error.message, 'error'); }
    });
    byId('use-wifi').addEventListener('click', () => hotspotRequest('wifi'));
    byId('copy-link').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(connectionUrl); toast('Room link copied.'); }
      catch (_) { byId('connection-url').select(); document.execCommand('copy'); toast('Room link copied.'); }
    });
    byId('save-name').addEventListener('click', () => {
      const name = byId('device-name').value.trim().slice(0, 64);
      if (!name) return toast('Enter a device name first.', 'error');
      myName = name; localStorage.setItem('quickdrop-device-name', myName);
      byId('identity-name').textContent = myName;
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      toast('Device name updated.');
    });
    byId('select-all').addEventListener('click', () => { selectedServerFiles = new Set(sharedFiles.map((file) => file.id)); renderSharedFiles(); });
    byId('deselect-all').addEventListener('click', () => { selectedServerFiles.clear(); renderSharedFiles(); });
    byId('download-zip').addEventListener('click', downloadSelectedZip);
    byId('delete-selected').addEventListener('click', deleteCheckedFiles);
    byId('theme-toggle').addEventListener('click', () => {
      const dark = !document.body.classList.contains('dark');
      document.body.classList.toggle('dark', dark); localStorage.setItem('quickdrop-theme', dark ? 'dark' : 'light');
    });
    byId('save-limit').addEventListener('click', async () => {
      const value = Number(byId('max-file-mb').value);
      try {
        const result = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_file_mb: value }) });
        maxFileMb = result.max_file_mb; byId('max-size-label').textContent = maxFileMb + ' MB per file'; toast('File size limit saved.');
      } catch (error) { toast(error.message, 'error'); }
    });
    byId('start-hotspot').addEventListener('click', async () => {
      await hotspotRequest('start');
    });
    byId('manual-hotspot').addEventListener('click', async () => {
      const result = await hotspotRequest('manual');
      if (result && result.open_settings) location.href = result.open_settings;
    });
    byId('save-turn').addEventListener('click', () => {
      localStorage.setItem('quickdrop-turn-url', JSON.stringify(turnConfiguration()));
      toast('Optional ICE server settings saved on this device.');
    });
  }

  async function hotspotRequest(action) {
    const password = byId('hotspot-password').value;
    const ssid = byId('hotspot-name').value.trim();
    try {
      const result = await api('/api/hotspot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ssid, password }) });
      const notice = byId('hotspot-message');
      notice.textContent = result.message;
      notice.className = 'notice ' + (result.ok ? 'success' : 'warning');
      if (result.wifi_qr) showWifiQr(result.wifi_qr);
      if (result.network) updateNetworkUi(result.network, result);
      if (!result.ok) toast(result.message, 'error'); else toast(result.message);
      setTimeout(refreshBootstrap, 2000);
      return result;
    } catch (error) { toast(error.message, 'error'); return null; }
  }

  function turnConfiguration() {
    const url = byId('turn-url').value.trim();
    if (!url) return { iceServers: [] };
    const urls = url.split(',').map((item) => item.trim()).filter(Boolean);
    const server = { urls: urls.length > 1 ? urls : urls[0] };
    if (byId('turn-user').value) server.username = byId('turn-user').value;
    if (byId('turn-password').value) server.credential = byId('turn-password').value;
    return { iceServers: [server] };
  }

  function loadTurnSettings() {
    try {
      const value = JSON.parse(localStorage.getItem('quickdrop-turn-url') || '{"iceServers":[]}');
      const server = value.iceServers && value.iceServers[0];
      if (server) {
        byId('turn-url').value = Array.isArray(server.urls) ? server.urls.join(', ') : (server.urls || '');
        byId('turn-user').value = server.username || '';
        byId('turn-password').value = server.credential || '';
      }
    } catch (_) { }
  }

  initEvents();
  initialize();
})();
