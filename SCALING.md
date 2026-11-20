# Media capacity and room limits

Pico uses a peer-to-peer mesh. Every participant has one WebRTC connection to
every other participant. Ten participants create 45 bidirectional peer
connections, represented by 90 browser-side RTCPeerConnection objects.
Signaling carries setup messages, chat, and presence; it does not carry media.
TURN can relay encrypted media when a direct connection cannot be established.

Both signaling implementations admit at most ten participants. This is an
admission limit, not a universal device, network, or battery guarantee.

## Current camera budgets

`src/lib/call/types.ts` defines the authoritative camera profiles:

- Data Saver: 256×144 at 10 fps, video capped at 90 kbps per peer.
- Balanced: 480×360 at 15 fps, video capped at 200 kbps per peer.
- Sharp: 640×480 at 24 fps, video capped at 550 kbps per peer.

Audio targets 24 kbps per peer (16 kbps under severe congestion). For ten
participants, each client has nine peers. Its nominal media upload ceilings
are approximately 1.03 Mbps in Data Saver, 2.02 Mbps in Balanced, and 5.17 Mbps
in Sharp, before transport overhead. Actual rates depend on scene complexity,
codec, CPU and network adaptation, interest subscriptions, and silence.
Screen-sharing has separate budgets in `SCREEN_SHARE`.

The engine splits the estimated upload budget among peers, reduces camera
resolution/frame rate under pressure, and preserves audio. Lite mode and
background tabs shed receive-side video. A regular foreground gallery keeps
visible tiles subscribed through the supported ten-person room size.

## Local evidence and deployment scope

See `LOCAL-VERIFICATION.md` and generated `test-results/meeting-load.json`.
Synthetic loopback tests establish that the tested code can connect and move
media on this machine. They do not establish independent-network behavior,
low-end mobile performance, high-motion scene quality, thermal stability,
battery consumption, or long-session reliability.

Encoding and decoding costs grow with peer count. An SFU architecture would
reduce the number of outgoing media streams per client, while adding a media
server to operate. The current code does not implement an SFU. Capacity claims
must remain scoped to measured room sizes, devices, networks, and call modes.
