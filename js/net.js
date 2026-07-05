// Network layer — PeerJS edition.
//
// Before the static-Pages fix this file spoke to a Node "matchmaker": a
// WebSocket for signaling plus hand-rolled RTCPeerConnection/ICE plumbing. That
// matchmaker can't run on Cloudflare Pages (static files only), so signaling now
// rides PeerJS's free public broker instead. PeerJS owns the browser-to-browser
// handshake; we keep everything above it (the referee, the loopback, the
// direct/relayed badge) and simply re-map our pieces onto PeerJS's connection.
//
// This file still does three jobs behind ONE interface main.js can't see through:
//
//   1. Signaling — a PeerJS `Peer` talks to the public broker only to find the
//      other browser. No gameplay ever crosses the broker.
//   2. Host mode — build the in-browser Referee, add ourselves to it through a
//      LOOPBACK link (a plain function call that behaves exactly like the wire),
//      and bridge each guest's PeerJS DataConnection into the referee.
//   3. Guest mode — open one reliable DataConnection to the host; that connection
//      IS the game link. We speak the same C2S/S2C protocol we always did.
//
// main.js only ever touches: create(), join(), send(), ready, onMessage,
// onStatus. It is identical code whether we turn out to be host or guest — the
// host's own inputs take the same round-trip-free path a guest's would over the
// network. See memory/notes/netcode.md.
//
// PeerJS is pulled as ESM from jsDelivr's `/+esm` endpoint (a CDN-cached bundle).
// It is loaded LAZILY (dynamic import, not a top-level one) the first time a
// player actually creates or joins a room — never at page load. A bare landing
// page therefore makes ZERO external requests, so the headless load check can't
// trip on a CDN fetch (net::ERR_FAILED) in a sandbox with no outbound network.
// Same "CDN import, no build step"; the download just happens on demand.
import { Referee } from '/shared/referee.js';

// Cached PeerJS `Peer` constructor. `loadPeer()` fetches the CDN bundle once on
// the first create()/join() and reuses it thereafter.
let _PeerCtor = null;
async function loadPeer() {
  if (!_PeerCtor) {
    const mod = await import('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm');
    _PeerCtor = mod.Peer;
  }
  return _PeerCtor;
}

// ICE servers for NAT traversal, injected into every PeerJS connection via the
// Peer `config` option.
//
// STUN (free, no account) discovers a peer's public address and gets a direct
// link through most home NATs. STRICT/SYMMETRIC NATs can't form a direct link at
// all — those players need a TURN *relay* that forwards the traffic. Without one
// they simply can't join.
//
// TURN is configured with OpenRelay's free public relay so strict-NAT friends
// can connect. It's a shared community relay (a few GB/month) — fine for a 2–8
// person friend group. For your own dedicated quota, sign up for a free
// Metered/OpenRelay account and replace the three `turn:` entries below with the
// credentials it gives you (same shape). NOTE: for a backend-less browser game
// the relay password is necessarily visible in this client code — acceptable
// here; the only risk is a stranger draining the free quota (see project-state).
//
// PeerJS leaves iceTransportPolicy at its default ('all'), so the browser's ICE
// agent gathers host/STUN/TURN candidates together and prefers a cheaper direct
// pair, only falling back to the relay when direct fails. Adding TURN does NOT
// route everyone through the relay — direct stays the first choice for free. See
// _reportLink() for how we confirm this per peer.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// How long a connecting player waits before giving up. WebRTC's own failure
// signalling can take much longer (or stall), leaving a guest on an infinite
// "Connecting…" spinner — this bounds it.
const CONNECT_TIMEOUT_MS = 10000;

// Room codes are short and human-typeable, but PeerJS ids live in ONE global
// namespace on the shared public broker. Prefixing keeps our 4-char codes from
// colliding with unrelated PeerJS apps (and each other, mostly). The user only
// ever sees/type the 4-char code; the broker id is PEER_PREFIX + code.
const PEER_PREFIX = 'prophunt-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const peerIdFor = (code) => PEER_PREFIX + code;

function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// Inspect a PeerJS connection's underlying RTCPeerConnection and report whether
// the link ended up DIRECT or RELAYED (through TURN). Purely diagnostic: it lets
// a playtest see whether the free relay quota is actually being leaned on.
// Detection lives here (not the UI) on purpose — the UI just paints the label.
async function detectRelayed(pc) {
  if (!pc || !pc.getStats) return false;
  const stats = await pc.getStats();
  let pair = null;
  // Preferred path: the transport names its selected pair directly.
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  // Fallback for browsers that don't expose it on the transport report.
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && (r.state === 'succeeded' || r.selected)) pair = r;
    });
  }
  if (!pair) return false;
  const local = stats.get(pair.localCandidateId);
  // A 'relay' local candidate means our side is going through the TURN server.
  return !!local && local.candidateType === 'relay';
}

export class Session {
  // config: the content-as-data bundle main.js already fetched ({maps,props,rules}),
  // needed to build the Referee if we become host.
  constructor(config) {
    this.config = config;
    this.onMessage = () => {}; // referee -> client game messages (S2C)
    this.onStatus = () => {}; // ('connecting'|'error'|'closed'|'link', detail?) for UI

    this.peer = null; // PeerJS Peer (both roles)
    this.isHost = false;
    this.selfId = null; // our peer id == our game player id
    this.name = 'Player'; // our display name, kept so the host can name itself
    this.room = null; // the 4-char room code

    // Host-only:
    this.referee = null;
    this.conns = new Map(); // guestId -> { conn, timer }
    this._createRetries = 0;

    // Guest-only:
    this.conn = null;
    this._connectTimer = null;
  }

  // ---- public API ---------------------------------------------------------
  create(name) {
    this.name = cleanName(name);
    this._startHost();
  }

  join(name, room) {
    this.name = cleanName(name);
    this._startGuest(String(room || '').toUpperCase().trim());
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
  async _startHost() {
    this.isHost = true;
    this.onStatus('connecting');
    let Peer;
    try {
      Peer = await loadPeer();
    } catch {
      this.onStatus('error', "Couldn't load the networking library — check your connection and try again.");
      return;
    }
    const code = makeCode();
    // The broker assigns us the id we ask for; if it's taken we get an
    // 'unavailable-id' error and retry with a fresh code (see the error handler).
    const peer = new Peer(peerIdFor(code), { config: { iceServers: ICE_SERVERS } });
    this.peer = peer;
    this._pendingCode = code;

    peer.on('open', (id) => {
      this.selfId = id;
      this.room = this._pendingCode;
      this.referee = new Referee(this.config, this.room);
      // Add ourselves through the loopback: the referee's replies to us are just
      // function calls, with no round trip. The client's reconcile-toward-server
      // nudge (main.js) converges to a no-op because serverSelf tracks our
      // prediction almost exactly. Guests still predict against a real round trip.
      this.referee.addPlayer({ id, name: this.name, send: (obj) => this.onMessage(obj) });
    });

    // Each guest that connects to us arrives here.
    peer.on('connection', (conn) => this._hostAccept(conn));

    peer.on('error', (err) => {
      if (err && err.type === 'unavailable-id') {
        // Rare 4-char collision on the shared broker: pick a new code and retry.
        if (this._createRetries++ < 5) {
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          this._startHost();
        } else {
          this.onStatus('error', 'Could not create a room — please try again.');
        }
        return;
      }
      // Other errors (network, browser) only matter before a match is live; once
      // guests are connected the broker is no longer needed.
      if (!this.ready) this.onStatus('error', peerErrorMessage(err));
    });
  }

  // A guest connected. Bridge its DataConnection into the referee as a normal
  // player once it opens; the referee talks back to it exactly like any other.
  _hostAccept(conn) {
    const guestId = conn.peer;
    const rec = { conn, timer: null };
    this.conns.set(guestId, rec);

    // Give up on a guest that never finishes connecting so it doesn't linger as a
    // ghost peer (its own tab shows the failure via the guest-side timer).
    rec.timer = setTimeout(() => {
      if (!conn.open) this._hostDropPeer(guestId);
    }, CONNECT_TIMEOUT_MS);

    conn.on('open', () => {
      clearTimeout(rec.timer);
      // Diagnostic: report how this guest reached us (direct vs relayed).
      this._reportLink(conn.peerConnection, guestId);
      this.referee.addPlayer({
        id: guestId,
        name: cleanName(conn.metadata && conn.metadata.name),
        send: (obj) => {
          if (conn.open) conn.send(obj);
        },
      });
    });
    conn.on('data', (m) => {
      if (m && typeof m === 'object') this.referee.handleMessage(guestId, m);
    });
    // Connection close is the authoritative "player left" signal (replaces the
    // old matchmaker's PEER_LEFT notice).
    conn.on('close', () => this._hostDropPeer(guestId));
    conn.on('error', () => this._hostDropPeer(guestId));
  }

  _hostDropPeer(guestId) {
    const rec = this.conns.get(guestId);
    if (!rec) return;
    this.conns.delete(guestId);
    clearTimeout(rec.timer);
    try {
      rec.conn.close();
    } catch {
      /* already gone */
    }
    if (this.referee) this.referee.removePlayer(guestId);
  }

  // ---- guest mode ---------------------------------------------------------
  async _startGuest(room) {
    this.isHost = false;
    this.room = room;
    this.onStatus('connecting');
    let Peer;
    try {
      Peer = await loadPeer();
    } catch {
      this.onStatus('error', "Couldn't load the networking library — check your connection and try again.");
      return;
    }
    const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
    this.peer = peer;

    // Bounded give-up: if the link isn't open in ~10s, stop spinning and tell the
    // player plainly instead of waiting on WebRTC's own (much slower) failure.
    this._connectTimer = setTimeout(() => {
      if (!this.ready) {
        this.onStatus('error', "Couldn't connect — check the room code, or ask the host to make sure the room's still open.");
        this._teardown();
      }
    }, CONNECT_TIMEOUT_MS);

    peer.on('open', () => {
      this.selfId = peer.id;
      // reliable:true keeps the channel reliable + ordered (PeerJS defaults to
      // unreliable). The match-start ordering (STARTED/ROLE/first SNAPSHOT)
      // depends on this. Our name rides along as metadata so the host can label
      // us in the lobby (replaces the old matchmaker PEER_JOIN name).
      const conn = peer.connect(peerIdFor(room), { reliable: true, metadata: { name: this.name } });
      this._bindGuestConn(conn);
    });

    peer.on('error', (err) => {
      // 'peer-unavailable' == no host is registered under that room code.
      if (err && err.type === 'peer-unavailable') {
        clearTimeout(this._connectTimer);
        if (!this.ready) {
          this.onStatus('error', `Room "${room}" not found — double-check the code.`);
          this._teardown();
        }
        return;
      }
      if (!this.ready) {
        clearTimeout(this._connectTimer);
        this.onStatus('error', peerErrorMessage(err));
        this._teardown();
      }
    });
  }

  _bindGuestConn(conn) {
    this.conn = conn;
    conn.on('open', () => {
      clearTimeout(this._connectTimer);
      // Diagnostic: report how we reached the host (direct vs relayed).
      this._reportLink(conn.peerConnection, this.selfId);
    });
    conn.on('data', (m) => {
      if (m && typeof m === 'object') this.onMessage(m);
    });
    // The host closing the connection (or leaving) ends the match for us — this
    // replaces the old matchmaker's HOST_LEFT notice.
    conn.on('close', () => {
      this.onStatus('closed', 'Host left — the match ended.');
      this._teardown();
    });
    conn.on('error', () => {
      if (!this.ready) {
        clearTimeout(this._connectTimer);
        this.onStatus('error', "Couldn't connect — tell the host. Double-check the room code and try again.");
        this._teardown();
      }
    });
  }

  // Report how a peer link resolved (direct vs relayed) up to the UI. Best
  // effort — if getStats() is unavailable we just skip the label.
  async _reportLink(pc, id) {
    try {
      const relayed = await detectRelayed(pc);
      this.onStatus('link', { id, relayed });
    } catch {
      /* stats unavailable — diagnostic label is optional */
    }
  }

  // ---- teardown -----------------------------------------------------------
  _teardown() {
    clearTimeout(this._connectTimer);
    if (this.referee) {
      this.referee.destroy();
      this.referee = null;
    }
    for (const { conn } of this.conns.values()) {
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

// Turn a PeerJS error into something a player can act on.
function peerErrorMessage(err) {
  const type = err && err.type;
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return "Couldn't reach the matchmaking service — check your connection and try again.";
  }
  if (type === 'browser-incompatible') {
    return 'This browser does not support the WebRTC features Prop Hunt needs.';
  }
  return 'Connection error — please try again.';
}
