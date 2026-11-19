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
  const DIRECT_CHUNK_SIZE = 64 * 1024;
  const DIRECT_CHECKPOINT_SIZE = 1024 * 1024;
  const DIRECT_ACK_WINDOW_SIZE = 4 * 1024 * 1024;
  const DEFAULT_RELAY_CHUNK_SIZE = 4 * 1024 * 1024;
  const WEBRTC_DIAGNOSTICS_ENABLED = params.get('webrtc-diagnostics') === '1';
  const WEBRTC_DIAGNOSTIC_OUTPUT = ['memory', 'file'].includes(params.get('webrtc-output')) ? params.get('webrtc-output') : 'normal';
  const WEBRTC_DIAGNOSTIC_REPORTS = [];
  const RELAY_BEHAVIOR_PREF = 'quickdrop-relay-behavior';
  const LEGACY_RELAY_STREAM_PREF = 'quickdrop-live-relay';
  let relayBehavior = loadRelayBehaviorPreference();
  let performanceSnapshot = null;
  const CRC32_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    CRC32_TABLE[i] = value >>> 0;
  }

  function getDeviceId() {
    let value = localStorage.getItem('quickdrop-device-id');
    if (!value) {
      value = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replaceAll('-', '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('quickdrop-device-id', value);
    }
    return value;
  }

  function loadRelayBehaviorPreference() {
    const saved = localStorage.getItem(RELAY_BEHAVIOR_PREF);
    if (saved === 'automatic' || saved === 'standard') return saved;
    const previous = localStorage.getItem(LEGACY_RELAY_STREAM_PREF);
    const migrated = previous === 'false' ? 'standard' : 'automatic';
    localStorage.setItem(RELAY_BEHAVIOR_PREF, migrated);
    return migrated;
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

  function prettyRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 MB/s';
    if (bytesPerSecond < 10 * 1024) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSecond / (1024 * 1024)).toFixed(2) + ' MB/s';
  }

  function prettyDuration(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    if (value >= 3600) return Math.floor(value / 3600) + 'h ' + Math.floor((value % 3600) / 60) + 'm';
    if (value >= 60) return Math.floor(value / 60) + 'm ' + (value % 60) + 's';
    return value + ' s';
  }

  function crc32Update(state, bytes) {
    let value = state >>> 0;
    for (let index = 0; index < bytes.length; index++) value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    return value >>> 0;
  }

  function crc32Hex(bytes) {
    return ((crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  function diagnosticAdd(state, key, elapsedMs) {
    const diag = state && state.webrtcDiagnostics;
    if (!diag || !Number.isFinite(elapsedMs)) return;
    diag.timing[key] = (diag.timing[key] || 0) + Math.max(0, elapsedMs);
  }

  function startWebRtcDiagnostics(state, pc) {
    if (!WEBRTC_DIAGNOSTICS_ENABLED || !pc) return;
    if (!state.webrtcDiagnostics) {
      const report = {
        transferId: state.id,
        direction: state.direction === 'out' ? 'sending' : 'receiving',
        peerName: state.peerName,
        outputMode: state.direction === 'in' ? WEBRTC_DIAGNOSTIC_OUTPUT : 'sender',
        files: (state.files || []).map((file) => ({ name: file.name, size: Number(file.size || 0) })),
        startedAt: new Date().toISOString(),
        connections: 0,
        samples: [],
        timingMs: {},
      };
      state.webrtcDiagnostics = {
        report,
        timing: report.timingMs,
        pendingAckTimes: new Map(),
        previous: null,
        lastProgressBytes: 0,
        lastSampleAt: 0,
        sampling: false,
        peakBufferedAmount: 0,
        peakReceiverMemoryBytes: 0,
      };
      WEBRTC_DIAGNOSTIC_REPORTS.push(report);
    }
    const diag = state.webrtcDiagnostics;
    diag.report.connections++;
    diag.previous = null;
    diag.pendingAckTimes.clear();
    if (state.webrtcStatsTimer) clearInterval(state.webrtcStatsTimer);

    const sample = async () => {
      if (diag.sampling || state.pc !== pc || state.done) return;
      diag.sampling = true;
      try {
        const stats = await pc.getStats();
        const values = Array.from(stats.values());
        const byId = new Map(values.map((item) => [item.id, item]));
        const transport = values.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
        let pair = transport && byId.get(transport.selectedCandidatePairId);
        if (!pair) pair = values.find((item) => item.type === 'candidate-pair' && item.selected && item.state === 'succeeded');
        if (!pair) pair = values.find((item) => item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated);
        const local = pair && byId.get(pair.localCandidateId);
        const remote = pair && byId.get(pair.remoteCandidateId);
        const channelStats = values.find((item) => item.type === 'data-channel' && (!item.label || item.label === 'quickdrop-files'));
        const now = performance.now();
        const previous = diag.previous;
        const elapsed = previous ? Math.max(0.001, (now - previous.at) / 1000) : 0;
        const sent = channelStats && Number.isFinite(channelStats.bytesSent) ? channelStats.bytesSent : null;
        const received = channelStats && Number.isFinite(channelStats.bytesReceived) ? channelStats.bytesReceived : null;
        const selectedPairId = pair && pair.id;
        const pairStable = previous && previous.pairId === selectedPairId;
        const sentRate = elapsed && sent != null && previous.sent != null ? Math.max(0, (sent - previous.sent) / elapsed) : null;
        const receivedRate = elapsed && received != null && previous.received != null ? Math.max(0, (received - previous.received) / elapsed) : null;
        const pairSentRate = elapsed && pairStable && Number.isFinite(pair.bytesSent) && previous.pairSent != null ? Math.max(0, (pair.bytesSent - previous.pairSent) / elapsed) : null;
        const pairReceivedRate = elapsed && pairStable && Number.isFinite(pair.bytesReceived) && previous.pairReceived != null ? Math.max(0, (pair.bytesReceived - previous.pairReceived) / elapsed) : null;
        const progressBytes = state.direction === 'in' && state.currentFile
          ? state.files.slice(0, state.currentFile.index).reduce((sum, file) => sum + Number(file.size || 0), 0) + state.currentFile.received
          : Number(state.loaded || 0);
        const appRate = elapsed && previous ? Math.max(0, (progressBytes - previous.progressBytes) / elapsed) : null;
        const sampleRecord = {
          at: new Date().toISOString(),
          elapsedSeconds: Number(((now - (diag.startedAtPerf || now)) / 1000).toFixed(1)),
          progressBytes,
          appThroughputBytesPerSecond: appRate,
          peerConnectionState: pc.connectionState || null,
          iceConnectionState: pc.iceConnectionState || null,
          iceGatheringState: pc.iceGatheringState || null,
          dataChannel: state.channel ? {
            readyState: state.channel.readyState,
            ordered: state.channel.ordered,
            maxRetransmits: state.channel.maxRetransmits,
            maxPacketLifeTime: state.channel.maxPacketLifeTime,
            maxMessageSize: pc.sctp && Number.isFinite(pc.sctp.maxMessageSize) ? pc.sctp.maxMessageSize : null,
          } : null,
          dataChannelBytesSent: sent,
          dataChannelBytesReceived: received,
          dataChannelSendBytesPerSecond: sentRate,
          dataChannelReceiveBytesPerSecond: receivedRate,
          selectedPairSendBytesPerSecond: pairSentRate,
          selectedPairReceiveBytesPerSecond: pairReceivedRate,
          bufferedAmountBytes: state.channel ? state.channel.bufferedAmount : null,
          selectedCandidatePair: pair ? {
            id: pair.id,
            state: pair.state || null,
            nominated: !!pair.nominated,
            selected: !!pair.selected,
            candidatePairType: pair.candidatePairType || null,
            localCandidateType: local && local.candidateType || null,
            remoteCandidateType: remote && remote.candidateType || null,
            localProtocol: local && local.protocol || null,
            remoteProtocol: remote && remote.protocol || null,
            localTcpType: local && local.tcpType || null,
            remoteTcpType: remote && remote.tcpType || null,
            relayProtocol: local && local.relayProtocol || remote && remote.relayProtocol || null,
            currentRoundTripTimeMs: Number.isFinite(pair.currentRoundTripTime) ? Number((pair.currentRoundTripTime * 1000).toFixed(2)) : null,
            packetsLost: Number.isFinite(pair.packetsLost) ? pair.packetsLost : null,
            packetsDiscardedOnSend: Number.isFinite(pair.packetsDiscardedOnSend) ? pair.packetsDiscardedOnSend : null,
            packetsSent: Number.isFinite(pair.packetsSent) ? pair.packetsSent : null,
            packetsReceived: Number.isFinite(pair.packetsReceived) ? pair.packetsReceived : null,
            requestsSent: Number.isFinite(pair.requestsSent) ? pair.requestsSent : null,
            requestsReceived: Number.isFinite(pair.requestsReceived) ? pair.requestsReceived : null,
            bytesSent: Number.isFinite(pair.bytesSent) ? pair.bytesSent : null,
            bytesReceived: Number.isFinite(pair.bytesReceived) ? pair.bytesReceived : null,
            availableOutgoingBitrate: Number.isFinite(pair.availableOutgoingBitrate) ? pair.availableOutgoingBitrate : null,
            availableIncomingBitrate: Number.isFinite(pair.availableIncomingBitrate) ? pair.availableIncomingBitrate : null,
          } : null,
          processing: { ...diag.timing },
          peakBufferedAmountBytes: diag.peakBufferedAmount,
          peakReceiverMemoryBytes: diag.peakReceiverMemoryBytes,
        };
        diag.startedAtPerf ||= now;
        diag.peakBufferedAmount = Math.max(diag.peakBufferedAmount, sampleRecord.bufferedAmountBytes || 0);
        sampleRecord.peakBufferedAmountBytes = diag.peakBufferedAmount;
        diag.report.samples.push(sampleRecord);
        diag.report.latest = sampleRecord;
        diag.previous = {
          at: now, pairId: selectedPairId, sent, received,
          pairSent: pair && Number.isFinite(pair.bytesSent) ? pair.bytesSent : null,
          pairReceived: pair && Number.isFinite(pair.bytesReceived) ? pair.bytesReceived : null,
          progressBytes,
        };
        renderWebRtcDiagnostics();
      } catch (error) {
        diag.report.statsError = error && error.message || String(error);
      } finally {
        diag.sampling = false;
      }
    };
    sample();
    state.webrtcStatsTimer = setInterval(sample, 1000);
  }

  function stopWebRtcDiagnostics(state) {
    if (state && state.webrtcStatsTimer) {
      clearInterval(state.webrtcStatsTimer);
      state.webrtcStatsTimer = null;
    }
    const diag = state && state.webrtcDiagnostics;
    if (diag && !diag.report.endedAt) {
      diag.report.endedAt = new Date().toISOString();
      diag.report.durationSeconds = Number(state.durationSeconds || 0);
      diag.report.status = state.status;
      diag.report.peakBufferedAmountBytes = diag.peakBufferedAmount;
      diag.report.peakReceiverMemoryBytes = diag.peakReceiverMemoryBytes;
      diag.report.timingMs = { ...diag.timing };
      renderWebRtcDiagnostics();
    }
  }

  function renderWebRtcDiagnostics() {
    const card = byId('webrtc-diagnostics-card');
    if (!WEBRTC_DIAGNOSTICS_ENABLED || !card) return;
    card.hidden = false;
    const modeText = WEBRTC_DIAGNOSTIC_OUTPUT === 'memory'
      ? 'Receiver mode: memory-only — data is verified, then discarded without saving.'
      : WEBRTC_DIAGNOSTIC_OUTPUT === 'file'
        ? 'Receiver mode: writes directly to the folder selected when accepting.'
        : 'Receiver mode: QuickDrop default (memory assembly followed by browser download).';
    byId('webrtc-diagnostics-mode').textContent = modeText;
    const reports = WEBRTC_DIAGNOSTIC_REPORTS.slice(-8).map((report) => ({
      transferId: report.transferId,
      direction: report.direction,
      peerName: report.peerName,
      outputMode: report.outputMode,
      files: report.files,
      startedAt: report.startedAt,
      endedAt: report.endedAt || 'in progress',
      durationSeconds: report.durationSeconds || null,
      status: report.status || 'in progress',
      connections: report.connections,
      selectedCandidatePair: report.latest && report.latest.selectedCandidatePair || null,
      intervalSamples: report.samples.slice(-12).map((sample) => ({
        elapsedSeconds: sample.elapsedSeconds,
        appMBps: sample.appThroughputBytesPerSecond == null ? null : Number((sample.appThroughputBytesPerSecond / (1024 * 1024)).toFixed(2)),
        dataChannelSendMBps: sample.dataChannelSendBytesPerSecond == null ? null : Number((sample.dataChannelSendBytesPerSecond / (1024 * 1024)).toFixed(2)),
        dataChannelReceiveMBps: sample.dataChannelReceiveBytesPerSecond == null ? null : Number((sample.dataChannelReceiveBytesPerSecond / (1024 * 1024)).toFixed(2)),
        selectedPairSendMBps: sample.selectedPairSendBytesPerSecond == null ? null : Number((sample.selectedPairSendBytesPerSecond / (1024 * 1024)).toFixed(2)),
        selectedPairReceiveMBps: sample.selectedPairReceiveBytesPerSecond == null ? null : Number((sample.selectedPairReceiveBytesPerSecond / (1024 * 1024)).toFixed(2)),
        bufferedAmountBytes: sample.bufferedAmountBytes,
        rttMs: sample.selectedCandidatePair && sample.selectedCandidatePair.currentRoundTripTimeMs,
        packetsLost: sample.selectedCandidatePair && sample.selectedCandidatePair.packetsLost,
      })),
      peakBufferedAmountBytes: report.peakBufferedAmountBytes || 0,
      peakReceiverMemoryBytes: report.peakReceiverMemoryBytes || 0,
      timingMs: report.timingMs || {},
      averageAckRoundTripMs: report.timingMs && report.timingMs.ackResponses
        ? Number((report.timingMs.dataChannelAckRoundTrip / report.timingMs.ackResponses).toFixed(2))
        : null,
      statsError: report.statsError || null,
    }));
    byId('webrtc-diagnostics-summary').textContent = reports.length
      ? JSON.stringify({ browser: navigator.userAgent, outputMode: WEBRTC_DIAGNOSTIC_OUTPUT, reports }, null, 2)
      : 'Waiting for a WebRTC transfer. Candidate type and protocol will appear only after the browser selects an ICE pair.';
  }

  function initWebRtcDiagnostics() {
    if (!WEBRTC_DIAGNOSTICS_ENABLED) return;
    renderWebRtcDiagnostics();
    byId('download-webrtc-report').addEventListener('click', () => {
      const payload = {
        capturedAt: new Date().toISOString(),
        browser: navigator.userAgent,
        outputMode: WEBRTC_DIAGNOSTIC_OUTPUT,
        reports: WEBRTC_DIAGNOSTIC_REPORTS,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'QuickDrop-WebRTC-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    byId('clear-webrtc-report').addEventListener('click', () => {
      WEBRTC_DIAGNOSTIC_REPORTS.splice(0, WEBRTC_DIAGNOSTIC_REPORTS.length);
      for (const state of transfers.values()) {
        if (state.webrtcDiagnostics) state.webrtcDiagnostics.report.samples.length = 0;
      }
      renderWebRtcDiagnostics();
    });
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

  function displayTransport(value) {
    const route = String(value || '').toLowerCase();
    if (route.includes('relay')) return 'Laptop relay';
    if (route.includes('direct') || route.includes('webrtc')) return 'Direct WebRTC';
    return 'Connecting';
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
    headers.set('X-Device-ID', deviceId);
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
      setInterval(updatePerformanceDashboard, 1500);
      updatePerformanceDashboard();
      window.addEventListener('offline', () => {
        for (const state of transfers.values()) if (!state.done) setTransferConnection(state, false, 'Wi-Fi connection lost · transfer paused');
      });
      window.addEventListener('online', () => {
        for (const state of transfers.values()) if (!state.done) setTransferConnection(state, true, 'Network connection restored.');
        if (!socket || socket.readyState === WebSocket.CLOSED) connectSocket();
      });
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
      for (const state of transfers.values()) {
        if (state.localCompletePending) reportTransferComplete(state, true);
        if (!state.done) {
          state.connectionPaused = false;
          state.paused = !!state.manualPaused;
          try { socket.send(JSON.stringify({ type: 'transfer_health', transfer_id: state.id, connected: true, reason: 'Room connection restored.' })); } catch (_) { }
        }
      }
      renderTransfers();
      updateNoteSendButton();
    };
    socket.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch (_) { toast('A room message could not be read.', 'error'); }
    };
    socket.onerror = () => setServerStatus(false, 'Connection interrupted');
    socket.onclose = () => {
      setServerStatus(false, 'Reconnecting…');
      for (const state of transfers.values()) if (!state.done) setTransferConnection(state, false, 'Room connection interrupted. Transfer paused.');
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
        progress: 0, loaded: 0, rateBps: 0, transport: 'Waiting', manualPaused: false, connectionPaused: false,
        incoming: false, created: Date.now(), verified: new Set(), relayStreamCapable: false,
        uploadedBytes: 0, downloadedBytes: 0, endToEndBytes: 0,
        uploadRateBps: 0, downloadRateBps: 0, endToEndRateBps: 0, durationSeconds: 0,
        directInbox: [], directWaiters: [], directFileIndex: 0, directSending: false
      };
      transfers.set(state.id, state);
      renderTransfers();
    } else if (message.type === 'incoming_transfer') {
      const state = {
        id: message.transfer_id, direction: 'in', peerId: message.sender.id,
        peerName: message.sender.name, files: message.files || [], status: 'Waiting for your approval',
        progress: 0, loaded: 0, rateBps: 0, transport: 'Waiting', manualPaused: false, connectionPaused: false,
        incoming: true, accepted: false, created: Date.now(), verified: new Set(),
        diagnosticOutput: WEBRTC_DIAGNOSTICS_ENABLED ? WEBRTC_DIAGNOSTIC_OUTPUT : 'normal',
        candidates: [], remoteSet: false, receiveQueue: Promise.resolve(), directInbox: [], directWaiters: [], relayParts: new Map(),
        relayMode: 'disk', relayStreamCapable: false, relayDecisionPending: false, relayDecisionSubmitting: false,
        uploadedBytes: 0, downloadedBytes: 0, endToEndBytes: 0,
        uploadRateBps: 0, downloadRateBps: 0, endToEndRateBps: 0, durationSeconds: 0
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
        state.relayStreamCapable = !!message.relay_stream_capable;
        if (!state.transferStarted) state.transferStarted = performance.now();
        state.status = state.directStarted ? 'Reconnecting to recipient…' : 'Connecting directly…';
        renderTransfers();
        if (state.channel && state.channel.readyState === 'open') sendDirect(state).catch((error) => handleDirectFailure(state, error));
        else startDirect(state, !!state.directStarted || Number(state.directFileIndex || 0) > 0);
      }
    } else if (message.type === 'webrtc_signal') {
      handleSignal(message).catch((error) => {
        const state = transfers.get(message.transfer_id);
        if (state) setTransferConnection(state, false, 'Direct connection interrupted · waiting to reconnect');
      });
    } else if (message.type === 'relay_begin') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        state.mode = 'relay'; state.transport = 'Laptop relay';
        state.relayChunkSize = Number(message.chunk_size) || DEFAULT_RELAY_CHUNK_SIZE;
        if (!state.manualPaused && socket && socket.readyState === WebSocket.OPEN) {
          state.connectionPaused = false;
          try { sendSocket({ type: 'transfer_health', transfer_id: state.id, connected: true, reason: 'Using the laptop relay.' }); } catch (_) { }
        }
        if (state.direction === 'in' && message.mode === 'automatic') {
          state.relayMode = 'pending';
          if (supportsLiveRelayFolder()) {
            state.relayDecisionPending = true;
            state.status = 'Choose a folder for Live Relay, or continue with Standard';
            renderTransfers();
          } else {
            state.status = 'This browser uses Standard Relay';
            renderTransfers();
            submitRelayModeDecision(state, 'disk', false).catch((error) => failTransfer(state, error.message));
          }
        } else {
          state.relayMode = message.mode === 'streaming' ? 'streaming' : 'disk';
          state.relayDecisionPending = false;
          if (state.relayMode === 'streaming' && !state.relayFilesReady) {
            state.relayFilesReady = new Promise((resolve) => { state.resolveRelayFiles = resolve; });
          }
          state.status = state.manualPaused ? 'Paused by you' : state.relayMode === 'streaming' ? 'Live Relay · waiting for verified file' : 'Using Standard Relay…';
          renderTransfers();
          if (state.direction === 'in' && state.relayMode === 'streaming') receiveRelay(state, null, true).catch((error) => failTransfer(state, error.message));
        }
      }
    } else if (message.type === 'relay_mode_selected') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        state.relayMode = message.mode === 'streaming' ? 'streaming' : 'disk';
        state.relayStreamCapable = state.relayMode === 'streaming';
        state.relayDecisionPending = false;
        state.relayDecisionSubmitting = false;
        if (state.direction === 'out') {
          state.mode = 'fallbackstarting';
          state.status = state.relayMode === 'streaming' ? 'Live Relay ready · uploading files' : 'Standard Relay ready · uploading files';
          if (state.resolveRelayMode) { state.resolveRelayMode(state.relayMode); state.resolveRelayMode = null; }
        } else if (state.relayMode === 'streaming') {
          if (!state.relayFilesReady) state.relayFilesReady = new Promise((resolve) => { state.resolveRelayFiles = resolve; });
          state.status = 'Live Relay · waiting for verified file';
          receiveRelay(state, null, true).catch((error) => failTransfer(state, error.message));
        } else {
          state.status = 'Standard Relay · waiting for upload to finish';
        }
        renderTransfers();
      }
    } else if (message.type === 'relay_ready') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        state.relayFiles = message.files || [];
        if (state.resolveRelayFiles) { state.resolveRelayFiles(state.relayFiles); state.resolveRelayFiles = null; }
        (state.relayFiles || []).forEach((file, index) => resolveRelayFile(state, index, file));
        if (state.relayMode !== 'streaming') receiveRelay(state, state.relayFiles).catch((error) => failTransfer(state, error.message));
      }
    } else if (message.type === 'relay_file_ready') {
      const state = transfers.get(message.transfer_id);
      if (state && Number.isInteger(Number(message.file_index)) && message.file) {
        if (!state.relayFiles) state.relayFiles = [];
        state.relayFiles[Number(message.file_index)] = message.file;
        resolveRelayFile(state, Number(message.file_index), message.file);
      }
    } else if (message.type === 'transfer_progress') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        state.progress = total ? Math.min(100, (Number(message.loaded || 0) / total) * 100) : 100;
        state.loaded = Number(message.loaded || 0);
        state.transport = displayTransport(message.transport || message.phase);
        state.uploadRateBps = Number(message.upload_rate_bps || state.uploadRateBps || 0);
        state.downloadRateBps = Number(message.download_rate_bps || state.downloadRateBps || 0);
        state.endToEndRateBps = Number(message.end_to_end_rate_bps || state.endToEndRateBps || 0);
        state.durationSeconds = Number(message.duration_seconds || state.durationSeconds || 0);
        state.rateBps = state.endToEndRateBps || Number(message.rate_bps || state.rateBps || 0);
        state.status = (message.phase === 'relay-upload' ? 'Sending to laptop relay' : message.phase === 'relay-download' ? 'Receiving from laptop relay' : 'Transferring') + ' · ' + prettyBytes(message.loaded || 0) + ' of ' + prettyBytes(message.total || total);
        renderTransfers();
      }
    } else if (message.type === 'transfer_control') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        state.manualPaused = message.action === 'pause';
        state.connectionPaused = !!message.paused && !state.manualPaused;
        state.paused = state.manualPaused || state.connectionPaused;
        if (state.manualPaused) {
          state.status = 'Paused by ' + (message.by === deviceId ? 'you' : state.peerName);
          if (state.relayController) state.relayController.abort();
        } else if (!state.connectionPaused) state.status = 'Resuming transfer…';
        renderTransfers();
        if (!state.manualPaused) resumeTransfer(state);
      }
    } else if (message.type === 'transfer_connection' || message.type === 'transfer_paused') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        if (message.type === 'transfer_connection') {
          if (typeof message.manual_paused === 'boolean') state.manualPaused = message.manual_paused;
          state.connectionPaused = !message.connected || (!!message.paused && !state.manualPaused);
        }
        else state.connectionPaused = true;
        if (state.connectionPaused) {
          state.status = message.reason || message.message || 'Connection interrupted · paused';
          if (state.relayController) state.relayController.abort();
        } else if (!state.manualPaused) state.status = 'Connection restored · resuming…';
        renderTransfers();
        if (!state.connectionPaused) resumeTransfer(state);
      }
    } else if (message.type === 'transfer_complete') {
      const state = transfers.get(message.transfer_id);
      if (state) {
        if (state.resolveRelayMode) { state.resolveRelayMode('disk'); state.resolveRelayMode = null; }
        state.durationSeconds = Number(message.duration_seconds || state.durationSeconds || 0);
        state.status = message.ok ? 'Completed · integrity verified · ' + prettyDuration(state.durationSeconds) : (message.message || 'Transfer failed');
        state.progress = message.ok ? 100 : state.progress;
        state.uploadRateBps = Number(message.upload_rate_bps || state.uploadRateBps || 0);
        state.downloadRateBps = Number(message.download_rate_bps || state.downloadRateBps || 0);
        state.endToEndRateBps = Number(message.end_to_end_rate_bps || state.endToEndRateBps || 0);
        state.durationSeconds = Number(message.duration_seconds || state.durationSeconds || 0);
        state.done = true;
        if (!message.ok && state.relayController) state.relayController.abort();
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
      const visibleNames = item.files.slice(0, 2).map((file) => file.name);
      const summary = visibleNames.join(', ') + (item.files.length > 2 ? ' +' + (item.files.length - 2) + ' more' : '');
      const sub = makeText('small', '', item.files.length + ' file' + (item.files.length === 1 ? '' : 's') + ' · ' + summary);
      main.append(title, sub);
      const status = makeText('div', 'transfer-status', item.status);
      const details = document.createElement('div'); details.className = 'transfer-summary';
      const total = item.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
      const loaded = Math.min(total, Number(item.endToEndBytes ?? (item.loaded || total * (item.progress || 0) / 100)));
      const rate = item.manualPaused || item.connectionPaused ? 0 : Number(item.endToEndRateBps || (item.mode === 'direct' ? item.rateBps : 0) || 0);
      const paused = item.manualPaused || item.connectionPaused;
      const remaining = rate > 0 ? Math.max(0, total - loaded) / rate : 0;
      const eta = rate > 0 ? ' · ' + (remaining >= 3600 ? Math.ceil(remaining / 3600) + 'h left' : remaining >= 60 ? Math.ceil(remaining / 60) + 'm left' : Math.ceil(remaining) + 's left') : '';
      const transport = item.transport || (item.mode === 'direct' ? 'Direct WebRTC' : item.mode === 'fallback' ? 'Laptop relay' : 'Connecting');
      const stageRates = transport === 'Laptop relay' ? ' · Up ' + prettyRate(item.uploadRateBps || 0) + ' · Down ' + prettyRate(item.downloadRateBps || 0) : '';
      const metrics = makeText('small', 'transfer-metrics', transport + ' · ' + prettyBytes(loaded) + ' / ' + prettyBytes(total) + ' · ' + (paused ? 'paused' : rate ? 'End-to-end ' + prettyRate(rate) : 'measuring recipient speed') + eta + stageRates);
      details.append(icon, main, status, metrics);
      row.append(details);
      if (item.incoming && item.relayDecisionPending && !item.done) {
        const relayActions = document.createElement('div'); relayActions.className = 'transfer-actions relay-choice-actions';
        const liveRelay = makeText('button', 'button primary compact', item.relayDecisionSubmitting ? 'Preparing…' : 'Choose folder for Live Relay');
        const standardRelay = makeText('button', 'button secondary compact', 'Use Standard');
        liveRelay.disabled = standardRelay.disabled = !!item.relayDecisionSubmitting;
        liveRelay.addEventListener('click', () => chooseLiveRelayFolder(item));
        standardRelay.addEventListener('click', () => submitRelayModeDecision(item, 'disk', false).catch((error) => failTransfer(item, error.message)));
        relayActions.append(liveRelay, standardRelay); row.append(relayActions);
      }
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
        const actions = document.createElement('div'); actions.className = 'transfer-actions transfer-control-buttons';
        if (item.accepted || item.mode) {
          const isPaused = item.manualPaused || item.connectionPaused;
          const pause = makeText('button', 'button secondary compact', isPaused ? 'Resume' : 'Pause');
          pause.setAttribute('aria-label', isPaused ? 'Resume transfer' : 'Pause transfer');
          pause.addEventListener('click', () => toggleTransferPause(item));
          actions.append(pause);
        }
        actions.append(cancel); row.append(actions);
      }
      host.append(row);
    }
    renderPerformanceDashboard();
  }

  function renderPerformanceDashboard() {
    if (!byId('performance-active')) return;
    const active = Array.from(transfers.values()).filter((item) => !item.done);
    const speed = active.reduce((sum, item) => sum + (item.manualPaused || item.connectionPaused ? 0 : Number(item.endToEndRateBps || 0)), 0);
    const uploadSpeed = active.reduce((sum, item) => sum + (item.manualPaused || item.connectionPaused ? 0 : Number(item.uploadRateBps || 0)), 0);
    const downloadSpeed = active.reduce((sum, item) => sum + (item.manualPaused || item.connectionPaused ? 0 : Number(item.downloadRateBps || 0)), 0);
    const moved = active.reduce((sum, item) => sum + Number(item.endToEndBytes || 0), 0);
    const duration = active.reduce((max, item) => Math.max(max, Number(item.durationSeconds || 0)), 0);
    byId('performance-active').textContent = String(active.length);
    byId('performance-speed').textContent = prettyRate(speed);
    byId('performance-data').textContent = prettyBytes(moved);
    byId('performance-upload').textContent = prettyRate(uploadSpeed);
    byId('performance-download').textContent = prettyRate(downloadSpeed);
    byId('performance-duration').textContent = prettyDuration(duration);
    byId('performance-connection').textContent = socket && socket.readyState === WebSocket.OPEN ? 'Room online' : 'Reconnecting…';
    const cpu = performanceSnapshot && performanceSnapshot.host_cpu_percent;
    const memory = performanceSnapshot && performanceSnapshot.host_memory_bytes;
    byId('performance-host-load').textContent = cpu == null || memory == null ? '—' : Number(cpu).toFixed(0) + '% · ' + prettyBytes(memory);
    const routes = new Map();
    for (const item of active) {
      const route = item.transport || 'Connecting';
      routes.set(route, (routes.get(route) || 0) + 1);
    }
    const routeText = routes.size ? Array.from(routes, ([name, count]) => count + ' ' + name).join(' · ') : 'No active transfer route';
    const paused = active.filter((item) => item.manualPaused || item.connectionPaused).length;
    const offline = !socket || socket.readyState !== WebSocket.OPEN;
    byId('performance-hint').textContent = routeText + (paused ? ' · ' + paused + ' paused; progress resumes from the last confirmed block.' : ' · Each transfer shows progress, speed, route, and estimated time remaining.');
    const live = byId('performance-live');
    live.classList.toggle('is-paused', paused > 0 || offline);
    live.lastChild.textContent = paused ? ' Paused' : offline ? ' Reconnecting' : ' Live';
  }

  async function updatePerformanceDashboard() {
    renderPerformanceDashboard();
    if (!access || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      performanceSnapshot = await api('/api/transfers/performance');
      for (const item of performanceSnapshot.active_transfers || []) {
        const state = transfers.get(item.id);
        if (!state) continue;
        state.endToEndBytes = Number(item.end_to_end_bytes || 0);
        state.uploadedBytes = Number(item.uploaded_bytes || 0);
        state.downloadedBytes = Number(item.downloaded_bytes || 0);
        state.uploadRateBps = Number(item.upload_rate_bps || 0);
        state.downloadRateBps = Number(item.download_rate_bps || 0);
        state.endToEndRateBps = Number(item.end_to_end_rate_bps || 0);
        state.durationSeconds = Number(item.duration_seconds || 0);
        state.loaded = Number(item.end_to_end_bytes || 0);
        const transferTotal = Number(item.total || 0);
        state.progress = transferTotal ? state.loaded / transferTotal * 100 : 0;
        state.rateBps = state.endToEndRateBps;
        if (item.transport && (!state.transport || state.transport === 'Waiting')) state.transport = displayTransport(item.transport);
      }
      renderPerformanceDashboard();
    } catch (_) { /* Local transfer measurements remain visible during a short outage. */ }
  }

  function toggleTransferPause(state) {
    const action = state.manualPaused || state.connectionPaused ? 'resume' : 'pause';
    state.manualPaused = action === 'pause';
    state.paused = state.manualPaused || state.connectionPaused;
    state.status = state.manualPaused ? 'Paused by you' : (state.connectionPaused ? 'Waiting for connection…' : 'Resuming transfer…');
    if (state.manualPaused && state.relayController) state.relayController.abort();
    try { sendSocket({ type: 'transfer_control', transfer_id: state.id, action }); }
    catch (error) { if (action === 'pause') toast(error.message, 'error'); }
    renderTransfers();
    if (action === 'resume') resumeTransfer(state);
  }

  function setTransferConnection(state, connected, reason) {
    if (connected) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    state.connectionPaused = !connected;
    state.paused = state.manualPaused || state.connectionPaused;
    if (!connected) {
      state.status = reason || 'Connection interrupted · paused';
      if (state.relayController) state.relayController.abort();
    } else if (!state.manualPaused) state.status = 'Connection restored · resuming…';
    try { sendSocket({ type: 'transfer_health', transfer_id: state.id, connected, reason }); } catch (_) { }
    renderTransfers();
    if (connected) resumeTransfer(state);
  }

  function resumeTransfer(state) {
    if (!state || state.done || state.manualPaused) return;
    if (state.connectionPaused) {
      if (state.direction === 'out' && state.mode === 'direct' && (!state.pc || state.pc.connectionState !== 'connected' || !state.channel || state.channel.readyState !== 'open')) scheduleDirectReconnect(state);
      return;
    }
    if (state.direction === 'out' && state.accepted) {
      if (state.mode === 'fallback' || state.mode === 'fallbackstarting') fallbackRelay(state).catch(() => { });
      else if (state.channel && state.channel.readyState === 'open') sendDirect(state).catch((error) => handleDirectFailure(state, error));
      else startDirect(state, !!state.directStarted || Number(state.directFileIndex || 0) > 0).catch(() => { });
    } else if (state.direction === 'in' && state.mode === 'fallback' && (state.relayFiles || state.relayMode === 'streaming')) {
      receiveRelay(state, state.relayFiles, state.relayMode === 'streaming').catch((error) => failTransfer(state, error.message));
    }
  }

  function waitUntilTransferCanFlow(state) {
    if (state.done) return Promise.reject(new Error('Transfer cancelled.'));
    if (!state.manualPaused && !state.connectionPaused && socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (state.done) { clearInterval(timer); reject(new Error('Transfer cancelled.')); }
        else if (!state.manualPaused && !state.connectionPaused && socket && socket.readyState === WebSocket.OPEN) { clearInterval(timer); resolve(); }
      }, 250);
    });
  }

  async function sendTransferSocket(state, message) {
    while (!state.done) {
      await waitUntilTransferCanFlow(state);
      try { sendSocket(message); return; }
      catch (_) { state.status = 'Room reconnecting · transfer will continue'; renderTransfers(); await sleep(250); }
    }
    throw new Error('Transfer cancelled.');
  }

  function waitDirectResponse(state, type, index, offset) {
    const match = (item) => item.type === type && item.index === index && (offset === undefined || item.offset === offset || (item.complete && item.offset >= offset));
    const buffered = state.directInbox.findIndex(match);
    if (buffered >= 0) return Promise.resolve(state.directInbox.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, index, offset, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const position = state.directWaiters.indexOf(waiter);
        if (position >= 0) state.directWaiters.splice(position, 1);
        reject(new Error('No confirmation arrived · reconnecting from the last saved block.'));
      }, 30000);
      state.directWaiters.push(waiter);
    });
  }

  function receiveDirectResponse(state, item) {
    if (item.type === 'file_ack' && !item.complete && state.webrtcDiagnostics) {
      const ackKey = item.index + ':' + item.offset;
      const sentAt = state.webrtcDiagnostics.pendingAckTimes.get(ackKey);
      if (sentAt != null) {
        diagnosticAdd(state, 'dataChannelAckRoundTrip', performance.now() - sentAt);
        state.webrtcDiagnostics.pendingAckTimes.delete(ackKey);
        state.webrtcDiagnostics.timing.ackResponses = (state.webrtcDiagnostics.timing.ackResponses || 0) + 1;
      }
    }
    if (item.type === 'file_ack' && state.direction === 'out') {
      const prior = state.files.slice(0, item.index).reduce((sum, file) => sum + Number(file.size || 0), 0);
      state.loaded = prior + Number(item.offset || 0);
      const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
      state.progress = total ? state.loaded / total * 100 : 100;
      updateTransferRate(state, state.loaded);
      state.endToEndBytes = state.loaded;
      if (state.mode === 'direct') state.endToEndRateBps = state.rateBps;
      state.status = item.complete ? 'File verified · continuing transfer' : 'Transferring · ' + prettyBytes(state.loaded) + ' of ' + prettyBytes(total);
      try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: state.loaded, total, phase: 'direct', file_index: item.index }); } catch (_) { }
      renderTransferProgress(state, item.complete || item.offset % DIRECT_CHECKPOINT_SIZE === 0);
    }
    if (item.type === 'file_ack') {
      state.directInbox = state.directInbox.filter((saved) => saved.type !== 'file_ack' || saved.index !== item.index || saved.offset > item.offset);
    }
    const index = state.directWaiters.findIndex((waiter) => waiter.type === item.type && waiter.index === item.index && (waiter.offset === undefined || item.offset === waiter.offset || (item.complete && item.offset >= waiter.offset)));
    if (index < 0) state.directInbox.push(item);
    else {
      const waiter = state.directWaiters.splice(index, 1)[0];
      clearTimeout(waiter.timer); waiter.resolve(item);
    }
  }

  function rejectDirectWaiters(state, message) {
    for (const waiter of state.directWaiters || []) { clearTimeout(waiter.timer); waiter.reject(new Error(message || 'Direct connection interrupted.')); }
    state.directWaiters = [];
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
    if (WEBRTC_DIAGNOSTICS_ENABLED && state.diagnosticOutput === 'file') {
      if (!supportsLiveRelayFolder()) {
        toast('File-write diagnostics need a secure browser connection with folder access. Use memory mode on this browser.', 'error');
        return;
      }
      try {
        const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (typeof directory.queryPermission === 'function') {
          let permission = await directory.queryPermission({ mode: 'readwrite' });
          if (permission !== 'granted' && typeof directory.requestPermission === 'function') permission = await directory.requestPermission({ mode: 'readwrite' });
          if (permission !== 'granted') throw new DOMException('Write access was not granted.', 'NotAllowedError');
        }
        state.directory = directory;
      } catch (error) {
        if (error.name !== 'AbortError') toast('Could not open the diagnostic output folder: ' + error.message, 'error');
        return;
      }
    }
    state.accepted = true;
    if (!state.transferStarted) state.transferStarted = performance.now();
    state.status = 'Accepted · preparing connection';
    state.relayStreamCapable = false;
    try { sendSocket({ type: 'transfer_decision', transfer_id: state.id, accepted: true, relay_stream_capable: state.relayStreamCapable }); }
    catch (error) { state.status = error.message; }
    renderTransfers();
  }

  function supportsLiveRelayFolder() {
    const fileHandle = window.FileSystemFileHandle;
    const directoryHandle = window.FileSystemDirectoryHandle;
    return !!(
      window.isSecureContext && typeof window.showDirectoryPicker === 'function' &&
      fileHandle && fileHandle.prototype && typeof fileHandle.prototype.createWritable === 'function' &&
      directoryHandle && directoryHandle.prototype && typeof directoryHandle.prototype.getFileHandle === 'function'
    );
  }

  async function chooseLiveRelayFolder(state) {
    if (!state || state.done || state.relayDecisionSubmitting) return;
    try {
      const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (typeof directory.queryPermission === 'function') {
        let permission = await directory.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted' && typeof directory.requestPermission === 'function') {
          permission = await directory.requestPermission({ mode: 'readwrite' });
        }
        if (permission !== 'granted') throw new DOMException('Write access was not granted.', 'NotAllowedError');
      }
      if (!directory || typeof directory.getFileHandle !== 'function') throw new Error('Folder access is not supported by this browser.');
      state.directory = directory;
      state.relayStreamCapable = true;
      await submitRelayModeDecision(state, 'streaming', true);
    } catch (error) {
      state.directory = null;
      state.relayStreamCapable = false;
      if (error.name !== 'AbortError') toast('Folder access was unavailable. Continuing with Standard Relay.', 'error');
      await submitRelayModeDecision(state, 'disk', false).catch((decisionError) => failTransfer(state, decisionError.message));
    }
  }

  async function submitRelayModeDecision(state, mode, capable) {
    if (!state || state.done || state.relayDecisionSubmitting) return;
    state.relayDecisionSubmitting = true;
    state.status = mode === 'streaming' ? 'Preparing Live Relay…' : 'Switching to Standard Relay…';
    renderTransfers();
    try {
      await sendTransferSocket(state, {
        type: 'relay_mode_decision', transfer_id: state.id,
        mode, capable: !!capable,
      });
    } finally {
      if (!state.done && state.relayDecisionPending) {
        state.relayDecisionSubmitting = false;
        renderTransfers();
      }
    }
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
    const oldChannel = state.channel; state.channel = null;
    const oldPc = state.pc; state.pc = null;
    rejectDirectWaiters(state, 'Direct connection is restarting.');
    if (oldChannel) { try { oldChannel.close(); } catch (_) { } }
    if (oldPc) { try { oldPc.close(); } catch (_) { } }
    if (state.webrtcStatsTimer) { clearInterval(state.webrtcStatsTimer); state.webrtcStatsTimer = null; }
    const pc = new RTCPeerConnection(rtcConfig());
    state.pc = pc;
    startWebRtcDiagnostics(state, pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try { sendSocket({ type: 'webrtc_signal', to: state.peerId, transfer_id: state.id, signal: { type: 'candidate', candidate: event.candidate } }); } catch (_) { }
      }
    };
    pc.onconnectionstatechange = () => {
      if (state.pc !== pc || state.done || state.mode === 'fallback' || state.mode === 'fallbackstarting' || state.mode === 'relay') return;
      if (pc.connectionState === 'connected') {
        clearTimeout(state.reconnectTimer); state.reconnectTimer = null; state.reconnectAttempts = 0;
        state.transport = 'Direct WebRTC';
        state.mode = 'direct';
        if (state.connectionPaused) setTransferConnection(state, true, 'Direct connection restored.');
        else renderTransfers();
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        setTransferConnection(state, false, 'Connection interrupted · transfer paused while reconnecting');
        if (sender && state.directStarted && pc.connectionState !== 'disconnected') scheduleDirectReconnect(state);
        if (sender && pc.connectionState === 'disconnected') {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            if (state.pc === pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) scheduleDirectReconnect(state);
          }, 3500);
        }
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
      if (state.done) return;
      state.mode = 'direct'; state.transport = 'Direct WebRTC';
      if (state.connectionPaused) setTransferConnection(state, true, 'Direct connection restored.');
      if (state.direction === 'out') sendDirect(state).catch((error) => handleDirectFailure(state, error));
      else { state.status = 'Direct connection ready'; renderTransfers(); }
    };
    channel.onmessage = (event) => {
      if (state.channel !== channel) return;
      if (state.receiveQueue && WEBRTC_DIAGNOSTICS_ENABLED) {
        const queuedAt = performance.now();
        state.receiveQueue = state.receiveQueue.then(async () => {
          const processingStarted = performance.now();
          diagnosticAdd(state, 'receiveQueueWait', processingStarted - queuedAt);
          try { await receiveMessage(state, event.data); }
          finally { diagnosticAdd(state, 'receiveQueueProcessingWall', performance.now() - processingStarted); }
        }).catch((error) => { if (!state.done) failTransfer(state, error.message); });
      } else if (state.receiveQueue) state.receiveQueue = state.receiveQueue.then(() => receiveMessage(state, event.data)).catch((error) => { if (!state.done) failTransfer(state, error.message); });
      else receiveMessage(state, event.data).catch((error) => { if (!state.done) handleDirectFailure(state, error); });
    };
    channel.onerror = () => { if (state.channel !== channel) return; rejectDirectWaiters(state, 'Direct connection interrupted.'); if (state.direction === 'out') handleDirectFailure(state, new Error('Direct connection interrupted.')); };
    channel.onclose = () => { if (state.channel !== channel) return; rejectDirectWaiters(state, 'Direct connection interrupted.'); if (state.direction === 'out' && !state.done) handleDirectFailure(state, new Error('Direct connection interrupted.')); };
  }

  async function startDirect(state, reconnect = false) {
    if (!state || state.done || state.manualPaused || state.connectionPaused || state.mode === 'fallback' || state.mode === 'fallbackstarting' || state.directAttempt) return;
    if (!window.RTCPeerConnection) { await fallbackRelay(state); return; }
    state.directAttempt = true;
    try {
      setupPeer(state, true);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      sendSocket({ type: 'webrtc_signal', to: state.peerId, transfer_id: state.id, signal: { type: 'description', description: JSON.parse(JSON.stringify(state.pc.localDescription)) } });
      state.status = reconnect ? 'Reconnecting · transfer paused safely…' : 'Connecting directly…'; state.transport = 'Direct WebRTC'; renderTransfers();
      await waitForChannel(state.channel, state, reconnect ? 10000 : 6000);
    } catch (error) {
      if (!state.directStarted && !reconnect) await fallbackRelay(state, error);
      else scheduleDirectReconnect(state);
    } finally { state.directAttempt = false; }
    }

  function scheduleDirectReconnect(state) {
    if (!state || state.done || state.manualPaused || state.reconnectTimer || state.mode === 'fallback' || state.mode === 'fallbackstarting') return;
    state.connectionPaused = true; state.paused = true;
    const delay = Math.min(10000, 1000 * Math.pow(1.6, Math.min(state.reconnectAttempts || 0, 5)));
    state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
    state.status = 'Connection interrupted · retrying in ' + Math.ceil(delay / 1000) + 's';
    renderTransfers();
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.done && !state.manualPaused && socket && socket.readyState === WebSocket.OPEN) {
        const pathRecovered = state.pc && state.pc.connectionState === 'connected' && state.channel && state.channel.readyState === 'open';
        if (pathRecovered && !state.forceReconnect) {
          state.connectionPaused = false; state.paused = false; state.reconnectAttempts = 0;
          state.status = 'Connection restored · resuming transfer';
          renderTransfers(); resumeTransfer(state); return;
        }
        state.forceReconnect = false;
        state.connectionPaused = false;
        startDirect(state, true).catch(() => scheduleDirectReconnect(state));
      } else if (!state.done) scheduleDirectReconnect(state);
    }, delay);
  }

  function handleDirectFailure(state, error) {
    if (!state || state.done || state.manualPaused) return;
    rejectDirectWaiters(state, error && error.message);
    state.forceReconnect = true;
    setTransferConnection(state, false, 'Connection interrupted · resuming from last confirmed block');
    if (!state.directStarted) fallbackRelay(state, error).catch(() => { });
    else scheduleDirectReconnect(state);
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
      if (!state.pc || state.pc.connectionState === 'failed' || state.pc.connectionState === 'closed' || state.pc.connectionState === 'disconnected' || state.lastOffer !== signal.description.sdp) {
        setupPeer(state, false); state.remoteSet = false; state.candidates = [];
        state.lastOffer = signal.description.sdp;
      }
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
    if (state.directSending || state.done || state.manualPaused || state.connectionPaused) return;
    const channel = state.channel;
    if (!channel || channel.readyState !== 'open') throw new Error('Direct connection is unavailable.');
    state.directSending = true; state.directStarted = true;
    const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
    let loadedBefore = 0;
    try {
      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        if (index < state.directFileIndex) { loadedBefore += file.size; continue; }
        await waitUntilTransferCanFlow(state);
        if (!state.transferStarted) state.transferStarted = performance.now();
        const readyPromise = waitDirectResponse(state, 'resume_ready', index);
        if (channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
        state.status = 'Starting · ' + file.name; renderTransfers();
        channel.send(JSON.stringify({ type: 'file_start', index, name: safeFileName(file.name), size: file.size }));
        const ready = await readyPromise;
        if (ready.complete) {
          loadedBefore += file.size; state.loaded = loadedBefore; state.directFileIndex = index + 1;
          state.progress = totalSize ? state.loaded / totalSize * 100 : 100;
          continue;
        }
        let offset = Math.max(0, Math.min(file.size, Number(ready.offset || 0)));
        state.loaded = loadedBefore + offset;
        while (offset < file.size) {
          await waitUntilTransferCanFlow(state);
          if (!state.channel || state.channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
          const batchEnd = Math.min(file.size, offset + DIRECT_ACK_WINDOW_SIZE);
          const ackPromise = waitDirectResponse(state, 'file_ack', index, batchEnd);
          while (offset < batchEnd) {
            const blockEnd = Math.min(batchEnd, offset + DIRECT_CHECKPOINT_SIZE);
            const readStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
            const block = new Uint8Array(await file.slice(offset, blockEnd).arrayBuffer());
            if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'fileRead', performance.now() - readStarted);
            const crcStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
            const blockCrc = crc32Hex(block);
            if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'senderCrc32', performance.now() - crcStarted);
            const blockMessage = {
              type: 'file_block', index, offset, size: block.byteLength,
              crc32: blockCrc,
            };
            state.channel.send(JSON.stringify(blockMessage));
            for (let position = 0; position < block.byteLength; position += DIRECT_CHUNK_SIZE) {
              await waitForCapacity(state.channel, state);
              const part = block.subarray(position, Math.min(block.byteLength, position + DIRECT_CHUNK_SIZE));
              if (state.webrtcDiagnostics && position + part.byteLength === block.byteLength) {
                state.webrtcDiagnostics.pendingAckTimes.set(index + ':' + blockEnd, performance.now());
              }
              const sendStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
              state.channel.send(part);
              if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'dataChannelSendCall', performance.now() - sendStarted);
              if (state.webrtcDiagnostics) state.webrtcDiagnostics.peakBufferedAmount = Math.max(state.webrtcDiagnostics.peakBufferedAmount, state.channel.bufferedAmount || 0);
            }
            offset = blockEnd;
          }
          const ackStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
          await ackPromise;
          if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'senderAckWait', performance.now() - ackStarted);
          if (state.webrtcDiagnostics) state.webrtcDiagnostics.timing.ackWindows = (state.webrtcDiagnostics.timing.ackWindows || 0) + 1;
          state.loaded = loadedBefore + offset;
          state.progress = totalSize ? state.loaded / totalSize * 100 : 100;
          state.status = 'Transferring · ' + prettyBytes(state.loaded) + ' of ' + prettyBytes(totalSize);
          updateTransferRate(state, state.loaded);
          try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: state.loaded, total: totalSize, phase: 'direct', file_index: index }); } catch (_) { }
          renderTransfers();
        }
        if (state.channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
        const completePromise = waitDirectResponse(state, 'file_ack', index, file.size);
        state.channel.send(JSON.stringify({ type: 'file_end', index }));
        const completeAck = await completePromise;
        if (!completeAck.complete) throw new Error('Recipient did not confirm the completed file.');
        loadedBefore += file.size; state.loaded = loadedBefore; state.directFileIndex = index + 1;
        state.progress = totalSize ? state.loaded / totalSize * 100 : 100;
        try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: state.loaded, total: totalSize, phase: 'direct', file_index: index }); } catch (_) { }
      }
      if (state.channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
      state.channel.send(JSON.stringify({ type: 'all_done' }));
      state.durationSeconds = state.transferStarted ? (performance.now() - state.transferStarted) / 1000 : state.durationSeconds;
      state.status = 'Sent · recipient verified all files · ' + prettyDuration(state.durationSeconds); state.progress = 100; state.loaded = totalSize;
      renderTransfers();
    } finally { state.directSending = false; }
  }

  async function waitForCapacity(channel, state) {
    const waitStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
    await waitUntilTransferCanFlow(state);
    if (channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
    if (channel.bufferedAmount < 8 * 1024 * 1024) {
      if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'bufferedAmountWait', performance.now() - waitStarted);
      return Promise.resolve();
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 800);
      channel.addEventListener('bufferedamountlow', () => { clearTimeout(timer); resolve(); }, { once: true });
      channel.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Direct connection interrupted.')); }, { once: true });
    });
    if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'bufferedAmountWait', performance.now() - waitStarted);
  }

  async function fallbackRelay(state, reason) {
    if (!state || state.done || state.direction !== 'out' || state.relayUploadRunning || state.relayUploadComplete || state.directDone) return;
    state.relayUploadRunning = true;
    state.mode = 'fallbackstarting'; state.transport = 'Laptop relay';
    state.status = reason ? 'Direct link unavailable · switching to laptop relay' : 'Preparing laptop relay…';
    if (!state.manualPaused && socket && socket.readyState === WebSocket.OPEN) {
      state.connectionPaused = false; state.paused = false;
      try { sendSocket({ type: 'transfer_health', transfer_id: state.id, connected: true, reason: 'Switching to the laptop relay.' }); } catch (_) { }
    }
    if (state.pc || state.channel) closePeer(state);
    renderTransfers();
    const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
    let retryDelay = 500;
    try {
      await waitUntilTransferCanFlow(state);
      if (!state.relayPreferenceChoice) state.relayPreferenceChoice = relayBehavior;
      const requestedRelayMode = state.relayPreferenceChoice === 'automatic' ? 'automatic' : 'standard';
      state.relayMode = 'pending';
      state.relayChunkSize = DEFAULT_RELAY_CHUNK_SIZE;
      const relayModeSelected = new Promise((resolve) => { state.resolveRelayMode = resolve; });
      await sendTransferSocket(state, {
        type: 'relay_begin', transfer_id: state.id,
        mode: requestedRelayMode, chunk_size: state.relayChunkSize,
      });
      state.relayMode = await relayModeSelected;
      if (state.done) return;
      if (!state.transferStarted) state.transferStarted = performance.now();
      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        let fileOffset = 0;
        let refreshOffset = true;
        if (file.size === 0) {
          while (true) {
            await waitUntilTransferCanFlow(state);
            try {
              const emptyResponse = await fetch('/api/relay/' + encodeURIComponent(state.id) + '/' + index + '?offset=0', {
                method: 'POST', headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId, 'Content-Type': 'application/octet-stream' }, body: new Blob([])
              });
              if (!emptyResponse.ok) {
                if (emptyResponse.status >= 500) throw new TypeError('Relay server temporarily unavailable.');
                const body = await emptyResponse.json().catch(() => ({})); throw new Error(body.detail || 'The laptop relay could not receive ' + file.name + '.');
              }
              break;
            } catch (error) {
              if (!(error instanceof TypeError) && navigator.onLine && (!socket || socket.readyState === WebSocket.OPEN)) throw error;
              state.status = 'Connection interrupted · retrying empty file'; renderTransfers(); await sleep(retryDelay); retryDelay = Math.min(8000, retryDelay * 1.6);
            }
          }
        }
        while (fileOffset < file.size) {
          await waitUntilTransferCanFlow(state);
          const base = '/api/relay/' + encodeURIComponent(state.id) + '/' + index;
          const controller = new AbortController(); state.relayController = controller;
          let requestTimeout = setTimeout(() => controller.abort(), 30000);
          try {
            if (refreshOffset) {
              const offsetResponse = await fetch(base + '/offset', { headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId }, signal: controller.signal });
              if (!offsetResponse.ok) {
                if (offsetResponse.status >= 500) throw new TypeError('Relay server temporarily unavailable.');
                const body = await offsetResponse.json().catch(() => ({})); throw new Error(body.detail || 'The laptop relay could not resume this file.');
              }
              fileOffset = Number((await offsetResponse.json()).offset || 0);
              refreshOffset = false;
            }
            if (fileOffset >= file.size) break;
            const end = Math.min(file.size, fileOffset + state.relayChunkSize);
            clearTimeout(requestTimeout); requestTimeout = setTimeout(() => controller.abort(), 30000);
            const response = await fetch(base + '?offset=' + fileOffset, {
              method: 'POST',
              headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId, 'Content-Type': 'application/octet-stream' },
              body: file.slice(fileOffset, end), signal: controller.signal
            });
            if (!response.ok) {
              if (response.status === 409 || response.status >= 500) throw new TypeError('Checking the saved relay position…');
              const body = await response.json().catch(() => ({})); throw new Error(body.detail || 'The laptop relay could not receive ' + file.name + '.');
            }
            fileOffset = Number((await response.json()).offset || end);
            retryDelay = 500;
          } catch (error) {
            if (state.done) return;
            if (state.manualPaused || state.connectionPaused) { refreshOffset = true; await waitUntilTransferCanFlow(state); continue; }
            if (error instanceof TypeError || error.name === 'AbortError' || !navigator.onLine || (socket && socket.readyState !== WebSocket.OPEN)) {
              refreshOffset = true;
              state.status = 'Connection interrupted · relay will continue from ' + prettyBytes(fileOffset);
              renderTransfers(); await sleep(retryDelay); retryDelay = Math.min(8000, retryDelay * 1.6); continue;
            }
            throw error;
          } finally { clearTimeout(requestTimeout); if (state.relayController === controller) state.relayController = null; }
          const loaded = state.files.slice(0, index).reduce((sum, item) => sum + item.size, 0) + fileOffset;
          state.loaded = loaded; state.progress = totalSize ? loaded / totalSize * 100 : 100;
          updateTransferRate(state, loaded);
          state.uploadedBytes = loaded;
          state.uploadRateBps = state.rateBps;
          state.status = 'Sending to laptop relay · ' + prettyBytes(loaded) + ' of ' + prettyBytes(totalSize);
          try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded, total: totalSize, phase: 'relay-upload', file_index: index }); } catch (_) { }
          renderTransfers();
        }
        if (state.relayMode === 'streaming') {
          await sendTransferSocket(state, { type: 'relay_file_complete', transfer_id: state.id, file_index: index });
        }
      }
      await waitUntilTransferCanFlow(state);
      state.mode = 'fallback'; state.transport = 'Laptop relay';
      state.status = 'Laptop relay ready · waiting for recipient';
      await sendTransferSocket(state, { type: 'relay_ready', transfer_id: state.id, hashes: [] });
      state.relayUploadComplete = true;
      renderTransfers();
    } catch (error) {
      if (!state.done && error.message !== 'Transfer cancelled.') failTransfer(state, error.message || (reason && reason.message) || 'The laptop relay failed.');
    } finally { state.relayUploadRunning = false; }
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function receiveMessage(state, data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'resume_ready' || message.type === 'file_ack') receiveDirectResponse(state, message);
      else if (message.type === 'file_start') await startReceivingFile(state, message);
      else if (message.type === 'file_block') await startReceivingBlock(state, message);
      else if (message.type === 'file_end') await finishReceivingFile(state, message.index);
      else if (message.type === 'all_done') {
        if (state.verified.size !== state.files.length) throw new Error('The recipient could not verify every file.');
        state.durationSeconds = state.transferStarted ? (performance.now() - state.transferStarted) / 1000 : state.durationSeconds;
        state.status = state.diagnosticOutput === 'memory'
          ? 'Memory benchmark complete · verified · data discarded · ' + prettyDuration(state.durationSeconds)
          : 'Completed · integrity verified · ' + prettyDuration(state.durationSeconds);
        state.progress = 100; state.done = true;
        reportTransferComplete(state, true);
        closePeer(state); renderTransfers(); expireTransfer(state);
      }
      return;
    }
    if (!state.currentFile || !state.currentFile.pendingBlock) throw new Error('Received file data before its block metadata.');
    await waitUntilTransferCanFlow(state);
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    const bytes = new Uint8Array(chunk);
    const current = state.currentFile;
    const block = current.pendingBlock;
    if (block.received + bytes.byteLength > block.size) throw new Error('A received block exceeded its declared size.');
    block.chunks.push(bytes); block.received += bytes.byteLength;
    if (state.webrtcDiagnostics) {
      const priorMemory = state.diagnosticOutput === 'file' ? 0 : current.received;
      state.webrtcDiagnostics.peakReceiverMemoryBytes = Math.max(
        state.webrtcDiagnostics.peakReceiverMemoryBytes,
        priorMemory + block.received * 2,
      );
    }
    if (block.received < block.size) return;
    const assembleStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
    const combined = new Uint8Array(block.size);
    let writeOffset = 0;
    for (const part of block.chunks) { combined.set(part, writeOffset); writeOffset += part.byteLength; }
    if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverReassembly', performance.now() - assembleStarted);
    const crcStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
    const actualCrc = crc32Hex(combined);
    if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverCrc32', performance.now() - crcStarted);
    if (actualCrc !== block.crc32) throw new Error('A file block failed its integrity check.');
    if (current.writer) {
      const writeStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
      await current.writer.write(combined);
      if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverFileWrite', performance.now() - writeStarted);
    } else {
      const appendStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
      current.chunks.push(combined);
      if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverMemoryAppend', performance.now() - appendStarted);
    }
    current.received += block.size; current.pendingBlock = null;
    const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const loadedBefore = state.files.slice(0, current.index).reduce((sum, file) => sum + Number(file.size || 0), 0);
    state.loaded = loadedBefore + current.received;
    state.progress = total ? (state.loaded / total) * 100 : 100;
    updateTransferRate(state, state.loaded);
    state.endToEndBytes = state.loaded;
    state.endToEndRateBps = state.rateBps;
    try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: state.loaded, total, phase: 'direct', file_index: current.index }); } catch (_) { }
    state.status = 'Receiving · ' + prettyBytes(current.received) + ' of ' + prettyBytes(current.size);
    try {
      if (state.channel && state.channel.readyState === 'open') {
        const ackSendStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
        state.channel.send(JSON.stringify({ type: 'file_ack', index: current.index, offset: current.received, complete: false }));
        if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverAckSendCall', performance.now() - ackSendStarted);
      }
    } catch (_) { }
    renderTransferProgress(state, current.received === current.size || current.received % DIRECT_CHECKPOINT_SIZE === 0);
  }

  function updateTransferRate(state, loaded) {
    const now = performance.now();
    if (state.rateSampleAt && now - state.rateSampleAt >= 450) {
      const measured = Math.max(0, (loaded - state.rateSampleLoaded) / ((now - state.rateSampleAt) / 1000));
      state.rateBps = state.rateBps ? state.rateBps * 0.55 + measured * 0.45 : measured;
      state.rateSampleAt = now; state.rateSampleLoaded = loaded;
    } else if (!state.rateSampleAt) { state.rateSampleAt = now; state.rateSampleLoaded = loaded; }
  }

  function renderTransferProgress(state, force = false) {
    const now = performance.now();
    if (force || !state.lastProgressRenderAt || now - state.lastProgressRenderAt >= 200) {
      state.lastProgressRenderAt = now;
      renderTransfers();
    }
  }

  function sendDirectJSON(state, message) {
    if (!state.channel || state.channel.readyState !== 'open') throw new Error('Direct connection interrupted.');
    state.channel.send(JSON.stringify(message));
  }

  async function startReceivingFile(state, metadata) {
    if (!state.transferStarted) state.transferStarted = performance.now();
    const file = state.files[metadata.index];
    if (!file || Number(metadata.size) !== Number(file.size)) throw new Error('File metadata did not match the transfer request.');
    if (state.verified.has(metadata.index)) {
      try { sendDirectJSON(state, { type: 'resume_ready', index: metadata.index, offset: Number(file.size), complete: true }); } catch (_) { }
      return;
    }
    let current = state.currentFile;
    if (current && current.index !== metadata.index) throw new Error('A different file was already in progress.');
    if (!current) {
      current = {
        index: metadata.index, name: metadata.name, size: Number(metadata.size),
        received: 0, chunks: [], writer: null, outputName: metadata.name, pendingBlock: null
      };
      if (state.directory) {
        const fileOpenStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
        const output = await uniqueFileHandle(state.directory, metadata.name);
        current.outputName = output.name;
        current.handle = output.handle;
        current.writer = await output.handle.createWritable();
        if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverFileOpen', performance.now() - fileOpenStarted);
      }
      state.currentFile = current;
    }
    const safeOffset = current.received;
    current.pendingBlock = null;
    if (current.writer) { await current.writer.truncate(safeOffset); await current.writer.seek(safeOffset); }
    else {
      let retained = current.chunks.reduce((sum, part) => sum + part.byteLength, 0);
      while (current.chunks.length && retained > safeOffset) retained -= current.chunks.pop().byteLength;
      if (retained !== safeOffset) throw new Error('The saved receive checkpoint is unavailable.');
    }
    state.loaded = state.files.slice(0, metadata.index).reduce((sum, item) => sum + Number(item.size || 0), 0) + safeOffset;
    const total = state.files.reduce((sum, item) => sum + Number(item.size || 0), 0);
    state.progress = total ? state.loaded / total * 100 : 100;
    state.status = safeOffset ? 'Resuming · checking saved blocks' : 'Connected · preparing first block';
    renderTransfers();
    try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded: state.loaded, total, phase: 'direct', file_index: metadata.index }); } catch (_) { }
    try { sendDirectJSON(state, { type: 'resume_ready', index: metadata.index, offset: safeOffset, complete: false }); } catch (_) { }
  }

  async function startReceivingBlock(state, metadata) {
    const current = state.currentFile;
    const offset = Number(metadata.offset);
    const size = Number(metadata.size);
    const expectedSize = current ? Math.min(DIRECT_CHECKPOINT_SIZE, current.size - current.received) : 0;
    if (!current || current.index !== Number(metadata.index) || current.pendingBlock || offset !== current.received || size !== expectedSize || size <= 0 || !/^[0-9a-f]{8}$/i.test(String(metadata.crc32 || ''))) {
      throw new Error('The received block information is invalid.');
    }
    current.pendingBlock = { size, offset, crc32: String(metadata.crc32).toLowerCase(), received: 0, chunks: [] };
    state.status = 'Receiving · verifying block ' + (Math.floor(offset / DIRECT_CHECKPOINT_SIZE) + 1);
  }

  async function finishReceivingFile(state, index) {
    const current = state.currentFile;
    if (!current || current.index !== index) throw new Error('File transfer sequence is invalid.');
    if (current.pendingBlock || current.received !== current.size) {
      if (current.writer) await current.writer.abort().catch(() => { });
      if (current.handle && state.directory) await state.directory.removeEntry(current.outputName).catch(() => { });
      state.currentFile = null;
      throw new Error('The received file is incomplete and was discarded.');
    }
    if (current.writer) {
      const closeStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
      await current.writer.close();
      if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'receiverFileClose', performance.now() - closeStarted);
    }
    else if (!(WEBRTC_DIAGNOSTICS_ENABLED && state.diagnosticOutput === 'memory')) {
      const blobStarted = WEBRTC_DIAGNOSTICS_ENABLED ? performance.now() : 0;
      downloadBlob(new Blob(current.chunks, { type: 'application/octet-stream' }), current.outputName);
      if (WEBRTC_DIAGNOSTICS_ENABLED) diagnosticAdd(state, 'browserBlobCreateAndDownloadTrigger', performance.now() - blobStarted);
    }
    state.verified.add(index);
    state.loaded = state.files.slice(0, index + 1).reduce((sum, file) => sum + Number(file.size || 0), 0);
    state.currentFile = null;
    try { sendDirectJSON(state, { type: 'file_ack', index, offset: current.size, complete: true }); } catch (_) { }
  }

  async function receiveRelay(state, relayFiles = state.relayFiles, streaming = state.relayMode === 'streaming') {
    if (state.relayReceiveRunning || state.done) return;
    state.relayReceiveRunning = true; state.relayFiles = relayFiles;
    state.mode = 'fallback'; state.transport = 'Laptop relay';
    state.status = streaming ? 'Live relay · receiving saved blocks' : 'Downloading through the laptop relay…';
    if (!state.transferStarted) state.transferStarted = performance.now();
    renderTransfers();
    const totalSize = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    try {
      for (let index = 0; index < state.files.length; index++) {
        if (state.verified.has(index)) continue;
        let item = relayFiles && relayFiles[index];
        if (!streaming && (!item || item.sha256 !== (state.files[index].sha256 || item.sha256))) throw new Error('The relay sent unexpected file information.');
        let part = state.relayParts.get(index);
        if (!part) {
          const output = await openOutput(state, state.files[index].name);
          part = { output, crcState: 0xffffffff, received: 0 };
          state.relayParts.set(index, part);
        }
        let retryDelay = 500;
        let lastProgressBytes = part.received;
        let lastProgressAt = performance.now();
        while (part.received < Number(state.files[index].size)) {
          await waitUntilTransferCanFlow(state);
          const controller = new AbortController(); state.relayController = controller;
          let timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const streamQuery = streaming ? '&stream=1' : '';
            const response = await fetch('/api/relay/' + encodeURIComponent(state.id) + '/' + index + '?offset=' + part.received + streamQuery, {
              headers: { 'X-Room-Token': access, 'X-Device-ID': deviceId }, signal: controller.signal
            });
            if (!response.ok || !response.body) {
              if (response.status === 409 || response.status >= 500) throw new TypeError('Relay connection is temporarily unavailable.');
              throw new Error('Could not download ' + state.files[index].name + ' from the laptop relay.');
            }
            part.expectedCrc = response.headers.get('X-Content-CRC32') || (item && item.crc32) || part.expectedCrc;
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), 30000);
              await waitUntilTransferCanFlow(state);
              if (part.received + value.byteLength > Number(state.files[index].size)) throw new Error('The relay sent more data than the requested file size.');
              if (part.output.writer) await part.output.writer.write(value); else part.output.chunks.push(value);
              part.crcState = crc32Update(part.crcState, value); part.received += value.byteLength;
              const loaded = state.files.slice(0, index).reduce((sum, file) => sum + Number(file.size || 0), 0) + part.received;
              state.loaded = loaded; state.progress = totalSize ? loaded / totalSize * 100 : 100;
              updateTransferRate(state, loaded);
              state.downloadedBytes = loaded;
              state.endToEndBytes = loaded;
              state.downloadRateBps = state.rateBps;
              state.endToEndRateBps = state.rateBps;
              state.status = 'Receiving from laptop relay · ' + prettyBytes(loaded) + ' of ' + prettyBytes(totalSize);
              const progressNow = performance.now();
              if (part.received - lastProgressBytes >= 256 * 1024 || progressNow - lastProgressAt >= 250 || part.received === Number(state.files[index].size)) {
                try { sendSocket({ type: 'transfer_progress', transfer_id: state.id, loaded, total: totalSize, phase: 'relay-download', file_index: index }); } catch (_) { }
                lastProgressBytes = part.received;
                lastProgressAt = progressNow;
              }
              renderTransferProgress(state, part.received === Number(state.files[index].size));
            }
            retryDelay = 500;
          } catch (error) {
            if (state.done) return;
            if (state.manualPaused || state.connectionPaused) {
              state.status = state.manualPaused ? 'Paused by you' : 'Connection interrupted · download paused';
              renderTransfers(); await waitUntilTransferCanFlow(state); continue;
            }
            if (error instanceof TypeError || error.name === 'AbortError' || !navigator.onLine) {
              state.status = 'Connection interrupted · resuming download from ' + prettyBytes(part.received);
              renderTransfers(); await sleep(retryDelay); retryDelay = Math.min(8000, retryDelay * 1.6); continue;
            }
            throw error;
          } finally {
            clearTimeout(timeout);
            if (state.relayController === controller) state.relayController = null;
          }
        }
        if (streaming) {
          item = await waitForRelayFile(state, index);
          relayFiles = state.relayFiles || relayFiles;
          if (!item || item.sha256 !== (state.files[index].sha256 || item.sha256)) throw new Error('The relay sent unexpected file information.');
          part.expectedCrc = item.crc32;
        }
        const actualCrc = ((part.crcState ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
        if (!item || part.received !== Number(state.files[index].size) || actualCrc !== String(part.expectedCrc || item.crc32 || '').toLowerCase()) {
          if (part.output.writer) await part.output.writer.abort().catch(() => { });
          if (part.output.handle && state.directory) await state.directory.removeEntry(part.output.name).catch(() => { });
          state.relayParts.delete(index);
          throw new Error('Integrity check failed for ' + state.files[index].name + '.');
        }
        if (part.output.writer) await part.output.writer.close();
        else downloadBlob(new Blob(part.output.chunks, { type: 'application/octet-stream' }), part.output.name);
        state.verified.add(index);
        state.loaded = state.files.slice(0, index + 1).reduce((sum, file) => sum + Number(file.size || 0), 0);
      }
      state.durationSeconds = state.transferStarted ? (performance.now() - state.transferStarted) / 1000 : state.durationSeconds;
      state.status = 'Completed · integrity verified · ' + prettyDuration(state.durationSeconds); state.progress = 100; state.done = true;
      reportTransferComplete(state, true);
      renderTransfers(); expireTransfer(state);
    } finally { state.relayReceiveRunning = false; }
  }

  function resolveRelayFile(state, index, file) {
    if (!state.relayFileWaiters) state.relayFileWaiters = new Map();
    const waiter = state.relayFileWaiters.get(index);
    if (waiter) {
      state.relayFileWaiters.delete(index);
      waiter(file);
    }
  }

  function waitForRelayFile(state, index) {
    const current = state.relayFiles && state.relayFiles[index];
    if (current) return Promise.resolve(current);
    if (!state.relayFileWaiters) state.relayFileWaiters = new Map();
    return new Promise((resolve) => state.relayFileWaiters.set(index, resolve));
  }

  function reportTransferComplete(state, ok, message = '') {
    try {
      sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok, message });
      state.localCompletePending = false;
    } catch (_) { state.localCompletePending = !!ok; }
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

  function failTransfer(state, message) {
    if (state.resolveRelayMode) { state.resolveRelayMode('disk'); state.resolveRelayMode = null; }
    state.status = message || 'Transfer failed'; state.done = true;
    abortPartialReceive(state).catch(() => { });
    closePeer(state);
    try { sendSocket({ type: 'transfer_complete', transfer_id: state.id, ok: false, message: state.status }); } catch (_) { }
    renderTransfers();
    toast(state.status, 'error');
    expireTransfer(state);
  }

  function closePeer(state) {
    stopWebRtcDiagnostics(state);
    rejectDirectWaiters(state, 'Transfer closed.');
    const channel = state.channel; state.channel = null;
    const pc = state.pc; state.pc = null;
    if (channel) { try { channel.close(); } catch (_) { } }
    if (pc) { try { pc.close(); } catch (_) { } }
  }

  function cancelTransfer(state) {
    if (state.resolveRelayMode) { state.resolveRelayMode('disk'); state.resolveRelayMode = null; }
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
  SHA256.prototype.clone = function () {
    const copy = new SHA256();
    copy.h = this.h.slice(); copy.buffer = this.buffer.slice(); copy.bytes = this.bytes;
    return copy;
  };
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
    initWebRtcDiagnostics();
    const relayBehaviorSelect = byId('relay-behavior');
    relayBehaviorSelect.value = relayBehavior;
    relayBehaviorSelect.addEventListener('change', () => {
      relayBehavior = relayBehaviorSelect.value === 'standard' ? 'standard' : 'automatic';
      localStorage.setItem(RELAY_BEHAVIOR_PREF, relayBehavior);
      toast('Relay download behaviour saved for future transfers.');
    });
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
