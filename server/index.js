// Entry point: a single Node process that serves the browser client over HTTP
// and runs a tiny WebRTC *matchmaker* over WebSockets on the same port.
//
// Since the P2P rebuild this process holds NO game logic and NO game state. Its
// whole job is:
//   1. serve the static client + shared modules + assets;
//   2. mint room codes and pair peers (create / join);
//   3. relay WebRTC handshake blobs (SDP offers/answers + ICE) between a host
//      and each guest so their browsers can open a direct connection.
//
// Once two browsers have shaken hands, all gameplay flows peer-to-peer over an
// RTCDataChannel and never touches this server again. A browser still needs a
// rendezvous point to find its peers — that's this. It stays cheap: it moves a
// handful of tiny handshake messages per join and nothing during a match.
//
// Deploy this one process to any cloud host (see README). Locally: `npm start`
// then open http://localhost:3000.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { SIG } from '../shared/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PORT = process.env.PORT || 3000;

// Directories the client is allowed to fetch static files from.
const STATIC_ROOTS = { '/': join(ROOT, 'client'), '/shared/': join(ROOT, 'shared'), '/assets/': join(ROOT, 'assets') };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  let baseDir = STATIC_ROOTS['/'];
  let rel = urlPath;
  for (const prefix of ['/shared/', '/assets/']) {
    if (urlPath.startsWith(prefix)) {
      baseDir = STATIC_ROOTS[prefix];
      rel = urlPath.slice(prefix.length);
      break;
    }
  }

  // Prevent path traversal outside the served directory.
  const filePath = normalize(join(baseDir, rel));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

// ---- matchmaker -----------------------------------------------------------
// A room is just a rendezvous group: the host's peer id + every connected
// signaling socket keyed by peer id (the host is in here too). No game state.
const rooms = new Map(); // code -> { code, hostId, sockets: Map<peerId, socket> }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

let nextPeerId = 1;

wss.on('connection', (socket) => {
  // Per-connection signaling identity. `peerId` doubles as the player's game id
  // once the peer-to-peer link is up, so the same id threads through both layers.
  socket.peerId = null;
  socket.roomCode = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.t) {
      case SIG.CREATE: {
        if (socket.roomCode) return; // already in a room
        const name = cleanName(msg.name);
        const code = makeCode();
        socket.peerId = `p${nextPeerId++}`;
        socket.roomCode = code;
        socket.name = name;
        rooms.set(code, { code, hostId: socket.peerId, sockets: new Map([[socket.peerId, socket]]) });
        send(socket, { t: SIG.CREATED, room: code, id: socket.peerId });
        break;
      }

      case SIG.JOIN: {
        if (socket.roomCode) return;
        const code = String(msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          send(socket, { t: SIG.ERROR, msg: `Room "${code}" not found.` });
          return;
        }
        const name = cleanName(msg.name);
        socket.peerId = `p${nextPeerId++}`;
        socket.roomCode = code;
        socket.name = name;
        room.sockets.set(socket.peerId, socket);
        // Tell the joiner who to hand-shake with...
        send(socket, { t: SIG.JOINED, room: code, id: socket.peerId, hostId: room.hostId });
        // ...and tell the host a new peer is inbound so it kicks off the offer.
        const host = room.sockets.get(room.hostId);
        if (host) send(host, { t: SIG.PEER_JOIN, id: socket.peerId, name });
        break;
      }

      case SIG.RELAY: {
        // Pass a WebRTC handshake blob straight through to the named peer in the
        // same room. The matchmaker never inspects the payload.
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        const target = room.sockets.get(msg.to);
        if (target) send(target, { t: SIG.RELAY, from: socket.peerId, payload: msg.payload });
        break;
      }

      default:
        break;
    }
  });

  const cleanup = () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.sockets.delete(socket.peerId);

    if (room.hostId === socket.peerId) {
      // Host is the referee. When it drops, the match is over: tell everyone and
      // discard the room. (Host migration is deliberately out of scope.)
      for (const s of room.sockets.values()) send(s, { t: SIG.HOST_LEFT });
      rooms.delete(room.code);
    } else {
      // A guest dropped its signaling socket. Note the P2P game link may still be
      // alive; the host treats channel close as the real "player left" signal.
      const host = room.sockets.get(room.hostId);
      if (host) send(host, { t: SIG.PEER_LEFT, id: socket.peerId });
      if (room.sockets.size === 0) rooms.delete(room.code);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function cleanName(raw) {
  return String(raw || 'Player').slice(0, 16).trim() || 'Player';
}

function send(socket, obj) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

server.listen(PORT, () => {
  console.log(`Prop Hunt matchmaker listening on http://localhost:${PORT}`);
});
