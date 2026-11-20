# Local verification

Run the production server before running the meeting tests:

```sh
bun install --frozen-lockfile
bun run build
PORT=3111 HOSTNAME=127.0.0.1 NODE_ENV=production node .next/standalone/server.js
```

In another terminal:

```sh
bun run lint
bun run test:unit
bun run test:signaling
bun run test:meeting
```

The meeting test opens ten isolated Chromium contexts, joins through the real
prejoin UI and the same-origin signaling rewrite, and captures real WebRTC
`getStats()` counters. Chromium supplies fake camera and microphone devices;
no personal camera or microphone is accessed. It checks nine connections per
participant, inbound audio and decoded video, advancing video frame counters,
room overflow rejection, peer removal, console errors, uncaught exceptions,
and HTTP errors. It closes its browser when done.

On macOS, an installed Brave browser is selected automatically. Otherwise run
`bunx playwright install chromium`, or set `CHROMIUM_PATH` to a compatible
Chromium executable. Process measurements currently use macOS `ps` and `lsof`.
`BASE`, `PARTICIPANTS`, and `DURATION_SECONDS` override the default URL, ten
participants, and 120-second sampling loop. The overflow assertion assumes
the participant count equals the configured room capacity (ten).

Evidence is written to `test-results/meeting-load.json` and
`test-results/meeting-10.png` (ignored by Git). CPU uses `ps %cpu`, where 100%
represents one core; RSS sums process resident memory and can double-count
shared pages. Measurements include the test browser process tree and the
server listening on the tested port. They do not measure GPU power, battery
consumption, or isolated single-participant cost. Snapshot collection adds
wall-clock time beyond the requested sampling delay.

## Scope and remaining release gates

This is a local loopback test on one Mac14,2 with eight CPU cores and 16 GiB
RAM. Ten isolated browser contexts are not ten physical devices or ten
independent networks. The fake camera is 480×360 with a target of 15 fps;
results do not establish screen-sharing or high-motion camera capacity.

- Both signaling implementations admit ten participants and reject overflow.
- The regular foreground gallery requests visible video throughout supported
  room sizes. Lite mode and hidden tabs retain receive-side shedding.
- Production build, lint, 96 offline assertions, and 14 signaling assertions
  pass with the updated dependencies.
- Local configuration has no TURN credentials. Cross-NAT connectivity,
  TURN-only media, TLS, and real-device/browser coverage remain unverified.
- The dependency audit was reduced from 106 findings (five critical) to seven
  findings (four high, three moderate). Remaining paths include Prisma's
  deepmerge-ts, MDX editor/ESLint js-yaml, PrismJS, and lint minimatch. These
  require dependency-owner upgrades or separately validated migrations;
  the audit findings are not proof of exploitability in the call runtime.
- `MEDIA_MODE=canvas` exercises the app's optional canvas test source. This
  source stalled video under ten contexts on this machine despite live tracks
  and connected peers. It must not be used as evidence of working video.
  The default test exercises the normal getUserMedia path with fake devices.

A passing local test does not certify error-free production operation.

## Recorded result — 16 November 2026 (Asia/Kolkata)

The final production build passed the ten-participant fake-device run with a
120-second sampling loop (plus join and measurement time). All 90 directed
peer connections remained connected. All 90 incoming audio paths received
data and all 90 video frame counters advanced between the first and final
samples. There were zero captured console errors, page exceptions, or HTTP
responses with status 400 or higher. Overflow rejection and leave cleanup
passed. The test browser was closed afterward; the production app remains
available at http://127.0.0.1:3111.

Across twelve samples, combined test-browser and app-server CPU averaged
584% (5.84 cores of this eight-core machine), ranging from 515% to 649%.
Combined RSS averaged 4,377 MiB, ranging from 3,918 to 4,606 MiB. The app
server alone used 0–1.1% CPU and 77–103 MiB RSS. CPU percentages are process
samples, not an isolated whole-system utilization or power measurement.
These numbers are for all ten clients together; dividing them by ten does
not establish the cost of a real single-participant device.
