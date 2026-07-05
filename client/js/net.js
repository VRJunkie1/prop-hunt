// Dual-mode network layer.
//
// Before the rebuild this was a thin WebSocket to an authoritative server. Now
// the referee lives in the host's browser and players connect peer-to-peer, so
// this file does three jobs behind ONE interface that the rest of the client
// (main.js) can't see through:
//
//   1. Signaling — a WebSocket to the matchmaker, used only to mint/join a room
//      and relay the WebRTC handshake. No gameplay ever crosses it.
//   2. Host mode — build the in-browser Referee, add ourselves to it through a
//      LOOPBACK link (a plain function call that behaves exactly like the wire),
//      and bridge each guest's RTCDataChannel into the referee.
//   3. Guest mode — open one RTCDataChannel to the host; that channel IS the game
//      link. We speak the same C2S/S2C protocol we always did.
//
// main.js only ever touches: create(), join(), send(), ready, onMessage,
// onStatus. It is identical code whether we turn out to be host or guest — the
// host's own inputs take the same round-trip-free path a guest's would over the
// network. See memory/notes/netcode.md.
import { SIG } from '/shared/protocol.js';
import { Referee } from '/shared/referee.js';

// ICE servers for NAT traversal.
//
// STUN (free, no account) discovers a peer's public address and gets a direct
// link through most home NATs. STRICT/SYMMETRIC NATs can't form a direct link at
// all — those players need a TURN *relay* that forwards the traffic. Without one
// they simply can't join; that was the long-standing "TURN: NO-GO" gap.
//
// TURN is now configured with OpenRelay's free public relay so strict-NAT
// friends can connect. It's a shared community relay (a few GB/month) — fine for
// a 2–8 person friend group. For your own dedicated quota, sign up for a free
// Metered/OpenRelay account and replace the three `turn:` entries below with the
// credentials it gives you (same shape). NOTE: for a backend-less browser game
// the relay password is necessarily visible in this client code — acceptable
// here; the only risk is a stranger draining the free quota (see project-state).
//
// iceTransportPolicy is deliberately left at its default ('all'), NOT 'relay':
// the browser's ICE agent gathers host/STUN/TURN candidates together and always
// prefers a cheaper direct pair, only falling back to the relay when direct
// fails. So adding TURN does NOT route everyone through the relay — direct stays
// the first choice for free. See _reportLink() for how we confirm this per peer.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// How long a connecting player waits before giving up. WebRTC's own 'failed'
// state can take much longer (or stall in 'checking'), leaving a guest on an
// infinite "Connecting…" spinner — this bounds it (plan step 5).
const CONNECT_TIMEOUT_MS = 10000;

// Inspect a completed RTCPeerConnection's selected candidate pair and report
// whether the link ended up DIRECT or RELAYED (through TURN). Purely diagnostic:
// it lets a playtest see whether the free relay quota is actually being leaned
// on. Detection lives here (not the UI) on purpose — the UI just paints the
// label the network layer hands it (plan step 4).
async function detectRelayed(pc) {
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

    this.sig = null; // signaling WebSocket
    this.isHost = false;
    this.selfId = null; // our peer id == our game player id
    this.hostId = null; // guest: the host's peer id
    this.name = 'Player'; // our display name, kept so the host can name itself

    // Host-only:
    this.referee = null;
    this.peers = new Map(); // guestId -> { pc, channel, remoteReady, pendingIce[] }

    // Guest-only:
    this.pc = null;
    this.channel = null;
    this.remoteReady = false;
    this.pendingIce = [];
  }

  // ---- public API ---------------------------------------------------------
  create(name) {
    this.name = cleanName(name);
    this._openSignaling(() => this._sig({ t: SIG.CREATE, name: this.name }));
  }

  join(name, room) {
    this.name = cleanName(name);
    this._openSignaling(() => this._sig({ t: SIG.JOIN, name: this.name, room }));
  }

  // Send a game message (C2S) to the referee. Host: straight into the local
  // referee. Guest: over the data channel. Symmetric on purpose.
  send(obj) {
    if (this.isHost) {
      if (this.referee) this.referee.handleMessage(this.selfId, obj);
    } else if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(obj));
    }
  }

  // Is the game link usable yet? (Host is ready as soon as the referee exists.)
  get ready() {
    if (this.isHost) return !!this.referee;
    return !!this.channel && this.channel.readyState === 'open';
  }

  // ---- signaling ----------------------------------------------------------
  _openSignaling(onOpen) {
    this.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.sig = new WebSocket(`${proto}://${location.host}`);
    this.sig.addEventListener('open', onOpen);
    this.sig.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onSignal(msg);
    });
    this.sig.addEventListener('close', () => {
      // The signaling drop only ends the game if we never got a P2P link up
      // (e.g. couldn't reach the matchmaker). Once a match is live, the P2P
      // channel is what matters and this is harmless.
      if (!this.ready) this.onStatus('error', 'Lost connection to the matchmaker.');
    });
  }

  _sig(obj) {
    if (this.sig && this.sig.readyState === WebSocket.OPEN) this.sig.send(JSON.stringify(obj));
  }

  _onSignal(msg) {
    switch (msg.t) {
      case SIG.CREATED:
        this._becomeHost(msg.room, msg.id);
        break;
      case SIG.JOINED:
        this._becomeGuest(msg.room, msg.id, msg.hostId);
        break;
      case SIG.PEER_JOIN: // host: a new guest wants in — we initiate the offer
        this._hostInvite(msg.id, msg.name);
        break;
      case SIG.RELAY:
        this._onHandshake(msg.from, msg.payload);
        break;
      case SIG.PEER_LEFT: // host: a guest's signaling dropped (channel close is authoritative)
        this._hostDropPeer(msg.id);
        break;
      case SIG.HOST_LEFT: // guest: the host/referee is gone
        this.onStatus('closed', 'Host left — the match ended.');
        this._teardown();
        break;
      case SIG.ERROR:
        this.onStatus('error', msg.msg);
        break;
      default:
        break;
    }
  }

  // ---- host mode ----------------------------------------------------------
  _becomeHost(room, id) {
    this.isHost = true;
    this.selfId = id;
    this.referee = new Referee(this.config, room);
    // Add ourselves through the loopback: the referee's replies to us are just
    // function calls, with no round trip. That instant reply is what step 5 of
    // the plan asks us to verify is harmless — the client's reconcile-toward-
    // server nudge (main.js) converges to a no-op because serverSelf tracks our
    // prediction almost exactly. Guests still predict against a real round trip.
    this.referee.addPlayer({ id, name: this.name, send: (obj) => this.onMessage(obj) });
  }

  // A guest is inbound. Create its peer connection + data channel and offer.
  async _hostInvite(guestId, name) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // ordered:true with no maxRetransmits/maxPacketLifeTime = reliable+ordered.
    // WebRTC channels are neither by default; the match-start message ordering
    // depends on this, so it's set explicitly (plan step 4).
    const channel = pc.createDataChannel('game', { ordered: true });
    const peer = { pc, channel, name, remoteReady: false, pendingIce: [], timer: null };
    this.peers.set(guestId, peer);

    // Give up on a guest that never finishes connecting so it doesn't linger as
    // a ghost peer (its own tab shows the failure via the guest-side timer).
    peer.timer = setTimeout(() => {
      if (channel.readyState !== 'open') this._hostDropPeer(guestId);
    }, CONNECT_TIMEOUT_MS);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sig({ t: SIG.RELAY, to: guestId, payload: { ice: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._hostDropPeer(guestId);
    };

    channel.onopen = () => {
      clearTimeout(peer.timer);
      // Diagnostic: report how this guest reached us (direct vs relayed).
      this._reportLink(pc, guestId);
      // Bridge this channel into the referee as a normal player. The referee
      // talks back to it exactly like any other player.
      this.referee.addPlayer({
        id: guestId,
        name,
        send: (obj) => {
          if (channel.readyState === 'open') channel.send(JSON.stringify(obj));
        },
      });
    };
    channel.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.referee.handleMessage(guestId, m);
    };
    channel.onclose = () => this._hostDropPeer(guestId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._sig({ t: SIG.RELAY, to: guestId, payload: { sdp: pc.localDescription } });
  }

  _hostDropPeer(guestId) {
    const peer = this.peers.get(guestId);
    if (!peer) return;
    this.peers.delete(guestId);
    clearTimeout(peer.timer);
    try {
      peer.pc.close();
    } catch {
      /* already gone */
    }
    if (this.referee) this.referee.removePlayer(guestId);
  }

  // ---- guest mode ---------------------------------------------------------
  _becomeGuest(room, id, hostId) {
    this.isHost = false;
    this.selfId = id;
    this.hostId = hostId;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    // Bounded give-up: if the link isn't open in ~10s, stop spinning and tell the
    // player plainly instead of waiting on WebRTC's own (much slower) 'failed'.
    this._connectTimer = setTimeout(() => {
      if (!this.ready) {
        this.onStatus('error', "Couldn't connect — check the room code, or ask the host to make sure the room's still open.");
        this._teardown();
      }
    }, CONNECT_TIMEOUT_MS);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sig({ t: SIG.RELAY, to: hostId, payload: { ice: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // With TURN configured a 'failed' means even the relay couldn't carry it
        // (network fully blocked, or the relay was unreachable) — give up now
        // rather than let the timer run out.
        clearTimeout(this._connectTimer);
        if (!this.ready) {
          this.onStatus('error', "Couldn't connect — tell the host. Double-check the room code and try again.");
          this._teardown();
        }
      } else if (pc.connectionState === 'closed' && !this.ready) {
        this.onStatus('closed', 'Connection to the host was lost.');
      }
    };
    // The host creates the channel, so we receive it.
    pc.ondatachannel = (e) => this._bindGuestChannel(e.channel);
  }

  _bindGuestChannel(channel) {
    this.channel = channel;
    channel.onopen = () => {
      clearTimeout(this._connectTimer);
      // Diagnostic: report how we reached the host (direct vs relayed).
      this._reportLink(this.pc, this.selfId);
    };
    channel.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    channel.onclose = () => {
      this.onStatus('closed', 'Host left — the match ended.');
      this._teardown();
    };
  }

  // ---- WebRTC handshake relay (both roles) --------------------------------
  async _onHandshake(fromId, payload) {
    const pc = this.isHost ? this.peers.get(fromId)?.pc : this.pc;
    if (!pc) return;
    const store = this.isHost ? this.peers.get(fromId) : this;

    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      store.remoteReady = true;
      // Flush any ICE candidates that arrived before the description was set.
      for (const c of store.pendingIce) {
        try {
          await pc.addIceCandidate(c);
        } catch {
          /* stale candidate */
        }
      }
      store.pendingIce = [];
      // Guest answers the host's offer.
      if (payload.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._sig({ t: SIG.RELAY, to: fromId, payload: { sdp: pc.localDescription } });
      }
    } else if (payload.ice) {
      // Candidates can outrun the SDP; buffer until the remote description lands.
      if (store.remoteReady) {
        try {
          await pc.addIceCandidate(payload.ice);
        } catch {
          /* stale candidate */
        }
      } else {
        store.pendingIce.push(payload.ice);
      }
    }
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
    for (const { pc } of this.peers.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.channel = null;
    if (this.sig) {
      try {
        this.sig.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function cleanName(raw) {
  return String(raw || 'Player').slice(0, 16).trim() || 'Player';
}
