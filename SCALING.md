# Scaling: mesh vs SFU — the decision, with numbers

Pico's media plane is a **peer-to-peer mesh**: every participant sends one
stream per peer and receives one per peer. This document pins down where
that stops working, what the honest limits are, and what an SFU migration
would actually touch. It exists so the decision is made from arithmetic,
not vibes.

## The mesh math

Upload is the binding constraint (download is symmetric in a mesh but home
uplinks are the narrow end). Each participant sends, per connected peer:

| Sending at | Per-peer video | Per-peer audio | With N−1 peers |
| --- | --- | --- | --- |
| sharp (L3) | 1 100 kbps | 24 kbps | (N−1) × 1 124 kbps |
| balanced (L2) | 600 kbps | 24 kbps | (N−1) × 624 kbps |
| saver (L1) | 220 kbps | 24 kbps | (N−1) × 244 kbps |
| L0 (weak link) | 50–200 kbps | 16 kbps | (N−1) × ≤216 kbps |

(The per-profile caps live in `src/lib/call/types.ts` `QUALITY_PROFILES`;
audio targets in `engine.ts` — `AUDIO_SENDER_BITRATE` 24 kbps, weak-link
16 kbps. The engine additionally splits the measured uplink BWE into
per-peer budgets, so a 2 Mbps uplink does not try to feed 5 peers at sharp.)

Worst-case upload by room size, sending at balanced:

| Participants | Upload each | Verdict on a 5 Mbps uplink |
| --- | --- | --- |
| 2 | 624 kbps | trivial |
| 4 | 1.9 Mbps | fine |
| 5 | 2.5 Mbps | fine |
| 8 | 4.4 Mbps | at the edge — auto profiles will drop people to saver |
| 10 | 5.6 Mbps | over budget → floors, stutter |
| 15+ | 8.4 Mbps | broken; SFU territory |

Practical reading: **1:1 through ~5-6 participants work well** on ordinary
connections, and the engine's budget-splitting + lite mode keep quality
degrading gracefully past that (it degrades instead of breaking). Beyond
~8 active video senders, mesh stops being a bandwidth question and becomes
a CPU question too — every participant encodes N−1 streams.

## What an SFU changes

An SFU (Selective Forwarding Unit) receives ONE stream per participant and
re-sends it to everyone else. Upload per participant drops from
(N−1)×bitrate to ~1×bitrate, at the cost of running a server in the media
path (media flows through it — still DTLS-SRTP end-to-end encrypted hop by
hop, but the server sees the packets).

Options, honestly compared:

- **LiveKit** — batteries included (rooms, tokens, TURN, web/mobile SDKs),
  self-hostable or cloud. Fastest migration; bigger operational footprint.
- **mediasoup** — a Node.js library, not a product: you write the room
  logic. Maximum control, most work; fits this codebase's zero-framework
  style.
- **Janus / Jitsi (jitsi-videobridge)** — mature, heavier, their own
  signaling conventions.

## What Pico would actually have to change

The signaling shape survives almost intact — the engine already routes
everything through typed socket events (`rtc:offer/answer/ice`) that treat
"the peer" as an opaque endpoint. An SFU swap touches:

1. **Engine media plane** — replace per-peer `RTCPeerConnection`s with one
   uplink PC + N downlink PCs toward the SFU (or the SFU's SDK client).
   `sendersMap`/`links` bookkeeping and the budget-splitter collapse into
   one sender (the mesh's weakest-link BWE logic becomes mostly moot —
   simulcast/SVC replaces it).
2. **Adaptation ladder** — instead of shrinking bitrate per peer, the
   client publishes simulcast layers (saver/balanced/sharp map cleanly
   onto 3 SVC layers) and the SFU picks per receiver. The CPU ladder and
   lite mode stay client-side and keep working unchanged.
3. **Server-side** — the SFU is one more compose service (LiveKit also
   wants its own TURN/UDP range; plan ports, host networking and firewall
   lines like coturn's).
4. **/info probe, passcode/lock, chat, presence** — untouched (they are
   signaling-plane, not media-plane).

A hybrid is also viable and cheaper: keep the mesh for ≤5-participant
rooms (zero server media cost, best privacy story) and only spin the SFU
path when a room exceeds a threshold — the engine's peer-connection
factory is the single choke point to branch.

## Recommendation

- Stay mesh for the launch and any product whose core promise is small
  private calls — it is the architecture's strength (no media server sees
  anything, one box serves everything).
- The trigger to revisit: **rooms of 8+ active video participants, or a
  product direction toward webinars/large meetings.** Then go LiveKit if
  speed matters, mediasoup if control matters.
- Revisit earlier if field telemetry (`/api/quality`) shows a profile
  permanently pinned to saver in typical room sizes — that is the mesh
  budget telling you its honest ceiling.
