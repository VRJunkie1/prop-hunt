// Network layer — peer-to-peer over WebRTC via PeerJS's free public broker.
//
// The referee lives in the HOST's browser; players connect peer-to-peer. This
// file does two jobs behind ONE interface the rest of the client (main.js)
// can't see through:
//
//   1. Host mode — build the in-browser Referee, add ourselves to it through a
//      LOOPBACK link (a plain function call that behaves exactly like the wire),
//      and bridge each guest's DataConnection into the referee.
//   2. Guest mode — open one DataConnection to the host; that connection IS the
//      game link. We speak the same C2S/S2C protocol we always did.
//
// PeerJS does the introduction the old always-on Node matchmaker used to do: its
// free public broker (0.peerjs.com) mints/pairs peers by id and relays the
// WebRTC handshake (SDP + ICE) for us. We never run a server. A room's peer id
// is `prophunt-<CODE>`; the 4-char CODE is what players paste to each other
// (e.g. in Discord). Once two browsers have shaken hands, all gameplay flows
// peer-to-peer and never touches the broker again.
//
// main.js only ever touches: create(), join(), send(), ready, onMessage,
// onStatus. It is identical code whether we turn out to be host or guest — the
// host's own inputs take the same round-trip-free path a guest's would over the
// network. See memory/notes/netcode.md.
import { Referee } from '/shared/referee.js';

// PeerJS is loaded as a self-contained UMD global by a <script> tag in
// index.html (a single request, no chained sub-requests). The previous
// `import { Peer } from 'https://esm.sh/peerjs@1.5.4'` was a two-request esm.sh
// wrapper chain that failed the headless load check (net::ERR_FAILED) — the same
// failure mode three.js hit. The classic script runs before this deferred
// module, so `window.Peer` is defined by the time this evaluates. See index.html.
const Peer = window.Peer;

// Namespace our room ids on the SHARED public broker so a 4-char code can't
// collide with unrelated PeerJS apps. Players only ever see the bare CODE.
const ROOM_PREFIX = 'prophunt-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

// WebRTC config PeerJS hands to every RTCPeerConnection. Free public STUN covers
// the easy/moderate NATs. A TURN relay would be needed for strict/symmetric NATs
// where a direct peer link can't form — that's a paid, ongoing cost and is
// currently a NO-GO (see project-state / plan step 7). To enable one later, add
// a turn: entry here (this object replaces the old ICE_SERVERS constant):
//   { urls: 'turn:host:3478', username: 'user', credential: 'pass' }
const PEER_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export class Session {
  // config: the content-as-data bundle main.js already fetched ({maps,props,rules}),
  // needed to build the Referee if we become host.
  constructor(config) {
    this.config = config;
    this.onMessage = () => {}; // referee -> client game messages (S2C)
    this.onStatus = () => {}; // ('connecting'|'error'|'closed', detail?) for UI

    this.peer = null; // PeerJS Peer — our handle on the broker
    this.isHost = false;
    this.selfId = null; // our peer id == our game player id
    this.room = null; // the 4-char room code
    this.name = 'Player'; // our display name, kept so the host can name itself

    // Host-only:
    this.referee = null;
    this.conns = new Map(); // guestId -> DataConnection

    // Guest-only:
    this.conn = null; // our DataConnection to the host
  }

  // ---- public API ---------------------------------------------------------
  create(name) {
    this.name = cleanName(name);
    this._reset();
    this.isHost = true;
    this.onStatus('connecting');
    this._startHost(0);
  }

  join(name, room) {
    this.name = cleanName(name);
    this._reset();
    this.isHost = false;
    this.onStatus('connecting');
    const peer = new Peer({ config: PEER_CONFIG });
    this.peer = peer;
    peer.on('open', (id) => {
      this.selfId = id;
      // Dial the host's room id. reliable:true (+ ordered, PeerJS's default for
      // reliable channels) is what the match-start message ordering depends on
      // (STARTED/ROLE/first SNAPSHOT). json serialization ships plain objects.
      const conn = peer.connect(ROOM_PREFIX + room, {
        reliable: true,
        serialization: 'json',
        metadata: { name: this.name }, // how the host learns our display name
      });
      this._bindGuestConn(conn);
    });
    peer.on('error', (err) => this.onStatus('error', peerErrorMsg(err)));
  }

  // Send a game message (C2S) to the referee. Host: straight into the local
  // referee. Guest: over the data connection. Symmetric on purpose.
  send(obj) {
    if (this.isHost) {
      if (this.referee) this.referee.handleMessage(this.selfId, obj);
    } else if (this.conn && this.conn.open) {
      this.conn.send(obj);
    }
  }

  // Is the game link usable yet? (Host is ready as soon as the referee exists.)
  get ready() {
    if (this.isHost) return !!this.referee;
    return !!this.conn && this.conn.open;
  }

  // ---- host mode ----------------------------------------------------------
  // Claim `prophunt-<CODE>` on the broker. If the code is already taken (someone
  // else has a live room with it), mint another and retry a few times.
  _startHost(attempt) {
    const code = makeCode();
    const peer = new Peer(ROOM_PREFIX + code, { config: PEER_CONFIG });
    this.peer = peer;

    peer.on('open', (id) => {
      this.selfId = id;
      this.room = code;
      this.referee = new Referee(this.config, code);
      // Add ourselves through the loopback: the referee's replies to us are just
      // function calls, with no round trip. That instant reply is what step 5 of
      // the P2P rebuild verified is harmless — the client's reconcile-toward-
      // server nudge (main.js) converges to a no-op because serverSelf tracks our
      // prediction almost exactly. Guests still predict against a real round trip.
      // We are the host: mark the loopback player so the referee knows which
      // single player may pick the map / start (guests only ever arrive over data
      // connections). This is the ONE place that knows for sure. See addPlayer.
      this.referee.addPlayer({ id, name: this.name, host: true, send: (o) => this.onMessage(o) });
    });

    // Each guest that dials our room id lands here.
    peer.on('connection', (conn) => this._hostBindConn(conn));

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && !this.selfId && attempt < 6) {
        // Code collided on the shared broker — pick a new one and retry.
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        this._startHost(attempt + 1);
      } else {
        this.onStatus('error', peerErrorMsg(err));
      }
    });
  }

  _hostBindConn(conn) {
    conn.on('open', () => {
      const guestId = conn.peer;
      const name = cleanName(conn.metadata && conn.metadata.name);
      this.conns.set(guestId, conn);
      // Bridge this connection into the referee as a normal player. The referee
      // talks back to it exactly like any other player (send = a channel write).
      this.referee.addPlayer({
        id: guestId,
        name,
        send: (o) => {
          if (conn.open) conn.send(o);
        },
      });
    });
    conn.on('data', (m) => {
      if (this.referee) this.referee.handleMessage(conn.peer, m);
    });
    // Connection close — not a broker event — is the authoritative "player left".
    conn.on('close', () => this._hostDropPeer(conn.peer));
    conn.on('error', () => this._hostDropPeer(conn.peer));
  }

  _hostDropPeer(guestId) {
    const conn = this.conns.get(guestId);
    if (!conn) return;
    this.conns.delete(guestId);
    try {
      conn.close();
    } catch {
      /* already gone */
    }
    if (this.referee) this.referee.removePlayer(guestId);
  }

  // ---- guest mode ---------------------------------------------------------
  _bindGuestConn(conn) {
    this.conn = conn;
    conn.on('data', (m) => this.onMessage(m));
    conn.on('close', () => {
      // Connection close is the authoritative "host gone" — the match ended.
      this.onStatus('closed', 'Host left — the match ended.');
      this._teardown();
    });
    conn.on('error', () => {
      if (!this.ready) {
        this.onStatus('error', "Couldn't connect to the host. The network may be too strict (a relay is needed).");
      }
    });
  }

  // ---- lifecycle ----------------------------------------------------------
  // Drop any half-built peer from a previous create/join attempt on this Session
  // (e.g. a mistyped room code) so retries don't leak broker connections.
  _reset() {
    this._teardown();
    this.isHost = false;
    this.selfId = null;
    this.room = null;
  }

  _teardown() {
    if (this.referee) {
      this.referee.destroy();
      this.referee = null;
    }
    for (const conn of this.conns.values()) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    if (this.conn) {
      try {
        this.conn.close();
      } catch {
        /* ignore */
      }
      this.conn = null;
    }
    if (this.peer) {
      // Destroying the Peer closes every connection under it and unregisters our
      // id from the broker.
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
      this.peer = null;
    }
  }
}

function cleanName(raw) {
  return String(raw || 'Player').slice(0, 16).trim() || 'Player';
}

function makeCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

// Map a PeerJS error to a player-facing message. Types are PeerJS's own
// (see https://peerjs.com/docs — Peer 'error' event).
function peerErrorMsg(err) {
  switch (err && err.type) {
    case 'peer-unavailable':
      return 'Room not found — check the code.';
    case 'unavailable-id':
      return 'Could not claim a room code — please try again.';
    case 'browser-incompatible':
      return 'This browser does not support WebRTC.';
    case 'ssl-unavailable':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'network':
      return 'Lost connection to the matchmaking broker — try again.';
    default:
      return 'Connection error — please try again.';
  }
}
