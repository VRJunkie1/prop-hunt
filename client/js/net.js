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

// ICE servers for NAT traversal. Public STUN covers the easy/moderate cases for
// free. A TURN relay would be needed for strict/symmetric NATs where a direct
// peer link can't form — that's a paid, ongoing cost and is currently a NO-GO
// (see plan step 6 / project-state). To enable one later, add a turn: entry:
//   { urls: 'turn:host:3478', username: 'user', credential: 'pass' }
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export class Session {
  // config: the content-as-data bundle main.js already fetched ({maps,props,rules}),
  // needed to build the Referee if we become host.
  constructor(config) {
    this.config = config;
    this.onMessage = () => {}; // referee -> client game messages (S2C)
    this.onStatus = () => {}; // ('connecting'|'error'|'closed', detail?) for UI

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
    // We are the host: mark the loopback player so the referee knows which single
    // player may pick the map / start. This is the ONE place that knows for sure
    // (guests only ever arrive over data channels). See referee.addPlayer.
    this.referee.addPlayer({ id, name: this.name, host: true, send: (obj) => this.onMessage(obj) });
  }

  // A guest is inbound. Create its peer connection + data channel and offer.
  async _hostInvite(guestId, name) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // ordered:true with no maxRetransmits/maxPacketLifeTime = reliable+ordered.
    // WebRTC channels are neither by default; the match-start message ordering
    // depends on this, so it's set explicitly (plan step 4).
    const channel = pc.createDataChannel('game', { ordered: true });
    const peer = { pc, channel, name, remoteReady: false, pendingIce: [] };
    this.peers.set(guestId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sig({ t: SIG.RELAY, to: guestId, payload: { ice: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._hostDropPeer(guestId);
    };

    channel.onopen = () => {
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

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sig({ t: SIG.RELAY, to: hostId, payload: { ice: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.onStatus('error', "Couldn't connect to the host. The network may be too strict (a relay is needed).");
      } else if (pc.connectionState === 'closed' && !this.ready) {
        this.onStatus('closed', 'Connection to the host was lost.');
      }
    };
    // The host creates the channel, so we receive it.
    pc.ondatachannel = (e) => this._bindGuestChannel(e.channel);
  }

  _bindGuestChannel(channel) {
    this.channel = channel;
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

  // ---- teardown -----------------------------------------------------------
  _teardown() {
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
