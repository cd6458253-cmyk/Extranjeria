// CitaBot WebSocket Bridge Server
// Deploy on Railway — connects Extension <-> Mobile App
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── In-memory state ──
let state = {
  botRunning: false,
  activePerson: 0,       // 0=Fahad,1=Tayyab,2=Adnan,3=Waqar
  activeSubTab: 0,
  status: 'idle',
  lastAlert: null,
  logs: [],
  profiles: new Array(32).fill(null),  // 4 persons × 8 sub-profiles
  pktSeconds: [1,3,5,6,12,15,18,22,28,41,47,51,57]
};

const PERSONS = ['Fahad','Tayyab','Adnan','Waqar'];
const MAX_LOGS = 100;

// Connected clients by type
const clients = { extension: new Set(), app: new Set() };

function broadcast(targetSet, msg) {
  const str = JSON.stringify(msg);
  targetSet.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function broadcastAll(msg) {
  broadcast(clients.extension, msg);
  broadcast(clients.app, msg);
}

function addLog(text, color) {
  const entry = { t: Date.now(), text, color: color || '#ffffff' };
  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOGS) state.logs.pop();
  broadcast(clients.app, { type: 'log', entry });
}

// ── WebSocket handler ──
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let clientType = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Handshake ──
    if (msg.type === 'register') {
      clientType = msg.role; // 'extension' or 'app'
      if (clientType === 'extension') clients.extension.add(ws);
      else if (clientType === 'app') clients.app.add(ws);
      // Send full state to newly connected app
      ws.send(JSON.stringify({ type: 'fullState', state }));
      addLog((clientType === 'extension' ? '🔌 Extension' : '📱 App') + ' connected', '#00ff88');
      return;
    }

    // ── Messages FROM Extension → forward to App ──
    if (clientType === 'extension') {
      if (msg.type === 'statusUpdate') {
        state.botRunning = msg.botRunning ?? state.botRunning;
        state.activePerson = msg.activePerson ?? state.activePerson;
        state.activeSubTab = msg.activeSubTab ?? state.activeSubTab;
        state.status = msg.status ?? state.status;
        broadcast(clients.app, { type: 'statusUpdate', ...msg });
      }
      else if (msg.type === 'alert') {
        state.lastAlert = { text: msg.text, ts: Date.now(), level: msg.level || 'info' };
        addLog('🔔 ' + msg.text, msg.level === 'success' ? '#00ff88' : '#ffcc00');
        broadcast(clients.app, { type: 'alert', ...msg });
      }
      else if (msg.type === 'log') {
        addLog(msg.text, msg.color);
      }
      else if (msg.type === 'profilesSync') {
        state.profiles = msg.profiles;
        broadcast(clients.app, { type: 'profilesSync', profiles: msg.profiles });
      }
      else if (msg.type === 'pktSync') {
        state.pktSeconds = msg.pktSeconds;
        broadcast(clients.app, { type: 'pktSync', pktSeconds: msg.pktSeconds });
      }
    }

    // ── Messages FROM App → forward to Extension ──
    else if (clientType === 'app') {
      if (msg.type === 'command') {
        // start, stop, switchPerson, switchSubTab, saveProfile, clearCookies, pktUpdate
        broadcast(clients.extension, { type: 'remoteCommand', ...msg });
        addLog('📱 Command: ' + msg.cmd + (msg.person != null ? ' P'+msg.person : ''), '#88aaff');
      }
      else if (msg.type === 'profileUpdate') {
        // App edited a profile — save to state and forward to extension
        const gi = msg.gi;
        if (gi >= 0 && gi < 32) state.profiles[gi] = msg.data;
        broadcast(clients.extension, { type: 'remoteProfileUpdate', gi: msg.gi, data: msg.data });
        addLog('💾 Profile saved: P' + msg.gi, '#aaffaa');
      }
      else if (msg.type === 'requestState') {
        ws.send(JSON.stringify({ type: 'fullState', state }));
      }
    }
  });

  ws.on('close', () => {
    clients.extension.delete(ws);
    clients.app.delete(ws);
    if (clientType) addLog((clientType==='extension'?'🔌 Extension':'📱 App') + ' disconnected', '#ff8888');
  });

  ws.on('error', () => {
    clients.extension.delete(ws);
    clients.app.delete(ws);
  });
});

// ── HTTP: serve the web app ──
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Status endpoint ──
app.get('/api/status', (req, res) => {
  res.json({
    extensions: clients.extension.size,
    apps: clients.app.size,
    botRunning: state.botRunning,
    status: state.status,
    activePerson: PERSONS[state.activePerson] || 'Unknown'
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('[CitaBot Server] Running on port ' + PORT));
