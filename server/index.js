// Entry point: a single Node process that both serves the browser client over
// HTTP and runs the authoritative game over WebSockets on the same port.
//
// Because every player connects *outward* to this server, nobody needs to port
// forward. Deploy this one process to any cloud host (see README) and share the
// URL. Locally, `npm start` then open http://localhost:3000.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { Room } from './Room.js';
import { C2S, S2C } from '../shared/protocol.js';

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

// ---- room manager ---------------------------------------------------------
const rooms = new Map(); // code -> Room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

let nextPlayerId = 1;

wss.on('connection', (socket) => {
  const player = { id: `p${nextPlayerId++}`, name: 'Player', socket, room: null };

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Lobby entry messages are handled by the manager; everything else routes
    // to the room the player is in.
    if (msg.t === C2S.CREATE || msg.t === C2S.JOIN) {
      if (player.room) return; // already in a room
      player.name = String(msg.name || 'Player').slice(0, 16).trim() || 'Player';

      if (msg.t === C2S.CREATE) {
        const code = makeCode();
        const room = new Room(code, (c) => rooms.delete(c));
        rooms.set(code, room);
        room.addPlayer(player);
      } else {
        const code = String(msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          send(socket, { t: S2C.ERROR, msg: `Room "${code}" not found.` });
          return;
        }
        room.addPlayer(player);
      }
      return;
    }

    if (player.room) player.room.handleMessage(player, msg);
  });

  const cleanup = () => {
    if (player.room) player.room.removePlayer(player);
    player.room = null;
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function send(socket, obj) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

server.listen(PORT, () => {
  console.log(`Prop Hunt server listening on http://localhost:${PORT}`);
});
