# FoveaRender

> Browser-based research prototype for webcam gaze estimation, gaze-adaptive rendering experiments, and dual-stream WebRTC transport.

FoveaRender explores a specific systems question:

> Can a low-resolution base frame and a gaze-centered high-resolution region be transported separately, synchronized with compact metadata, and recomposed while adapting to rendering cost and network conditions?

The repository contains substantial experimental implementations for gaze estimation, calibration, rendering, WebRTC transport, adaptive bitrate control, GPU timing, and telemetry. It is **not a production-ready renderer**, a validated eye tracker, or an enterprise SDK.

The project evolved through several connected experiments. The next engineering phase is to separate those experiments, validate them independently, and then rebuild one coherent end-to-end path.

See [`RECOVERY_PLAN.md`](RECOVERY_PLAN.md) for the proposed restructuring and validation plan.

## Project status

**Stage:** advanced research prototype

**Primary long-term direction:** gaze-guided dual-stream remote rendering

| Area | Current state | Notes |
|---|---|---|
| Local foveated renderer | Prototype implemented | Available in `packages/fovea-core` and used by `apps/demo-three`. |
| Webcam gaze estimation | Substantial prototype | MediaPipe iris landmarks, confidence heuristics, filtering, and calibration are implemented. Accuracy has not been validated against an independent ground-truth dataset. |
| Calibration workflow | Experimental | The current application uses a 5×5 routine and can fit affine or second-order models. Reported calibration errors are currently measured on calibration samples, not held-out targets. |
| Dual WebRTC transport | Prototype implemented | Two canvas tracks, a metadata DataChannel, local loopback peers, RTP statistics, and bitrate cap application are present. |
| Remote receiver composite | Experimental | Shader-based LOW + PATCH recomposition exists, but it is not the default visible output in the current application. |
| Final lens demonstration | Active default demo | The visible default mode renders a direct Canvas 2D reading-lens effect. It demonstrates gaze-driven interaction but bypasses the dual-stream receiver compositor. |
| Bandwidth governor | Substantial prototype | Uses browser WebRTC statistics, target/applied bitrate state, profile limits, and local allocation logic. It has not been validated under controlled network impairment or a real remote peer. |
| GPU governor | Experimental | Timing and throttle logic exist, but the default visible path is not fully covered by GPU measurements. |
| Telemetry | Implemented for experimentation | JSONL samples and event markers cover gaze, rendering state, bitrate state, network statistics, and analysis sessions. |
| Automated tests and CI | Not implemented | The repository currently has build scripts but no supported automated test suite or CI gate. |

## The central project thesis

The target architecture is not the current circular lens effect. The intended end-to-end system is:

```text
one source scene
      |
      +--> LOW: complete frame at reduced quality
      |
      +--> PATCH: high-resolution crop of the same scene
                       |
                       v
              two WebRTC video tracks
                       +
              compact gaze/rect metadata
                       |
                       v
              remote receiver composite
                       |
                       v
        measured quality, latency, and bandwidth
```

For this architecture to be credible, LOW and PATCH must represent the same source content, the receiver must use the transported streams rather than a local visual substitute, and all quality claims must come from reproducible measurements.

## Current experiments

### 1. Local renderer

`apps/demo-three` uses `packages/fovea-core` to render a Three.js scene into a low-resolution render target and a high-resolution target, then blend them around a gaze coordinate.

This is the smallest demonstration of the original rendering idea. It currently uses mouse input as the gaze source.

### 2. Gaze estimation and calibration

`packages/gaze-mediapipe` provides webcam-based gaze estimation using MediaPipe Face Mesh with refined iris landmarks.

The current implementation includes:

- bilateral iris fusion;
- in-plane roll compensation;
- eye openness and geometry heuristics;
- confidence estimation;
- optional eye-only or head-assisted input;
- One-Euro filtering;
- affine and second-order calibration models;
- local calibration persistence.

The application adds further gaze-control logic, including confidence hysteresis, fallback behavior, fixation/saccade modes, Kalman filtering, predictive lead, deadbands, quantization, and edge handling.

This should be described as **webcam gaze estimation**, not as a replacement for calibrated eye-tracking hardware.

### 3. WebRTC dual-stream laboratory

`apps/webrtc-dual` creates two canvas capture streams and transports them through a local WebRTC loopback connection.

It includes:

- two video tracks;
- sender/receiver peer connections;
- an unordered, non-retransmitted metadata DataChannel;
- track mapping by `MediaStreamTrack.id`;
- sender bitrate caps through `RTCRtpSender.setParameters()`;
- cap readback;
- RTT, packet loss, and ICE statistics;
- JSONL telemetry and event markers.

The current loopback is useful for testing browser APIs and data flow. It is not evidence of behavior across a real network.

### 4. Reading-lens demonstration

The current default application mode uses a gaze-driven circular lens over a blurred reading page. It provides a clear visual demonstration of calibration, gaze smoothing, predictive motion, and reading analysis.

This mode renders directly to the final canvas. It should not be presented as the result of dual-stream WebRTC recomposition.

## Important architectural distinction

The repository currently contains two different rendering paths:

```text
packages/fovea-core
  local Three.js foveated renderer

apps/webrtc-dual
  independent experimental application containing its own
  rendering, timing, governor, transport, calibration, and UI logic
```

`apps/webrtc-dual` does not currently use `packages/fovea-core`. Part of the recovery plan is to replace duplicated concepts with explicit interfaces and decide which modules are reusable libraries versus experiment-specific code.

## Repository structure

```text
packages/
  fovea-core/
    Local Three.js foveated rendering prototype

  gaze-mediapipe/
    Webcam gaze estimation, filtering, and calibration model

apps/
  demo-three/
    Minimal local foveated-rendering demo

  webrtc-dual/
    Gaze, calibration, reading analysis, WebRTC loopback,
    bitrate control, telemetry, and receiver-composite experiments
```

Important files in `apps/webrtc-dual/src/` include:

```text
main.ts                 Application orchestration and remaining experiment logic
loopback.ts             Local WebRTC peer connection setup
receiverComposite.ts    Shader-based LOW + PATCH receiver compositor
bandwidthState.ts       Profiles and bandwidth state
bandwidthPoller.ts      WebRTC statistics and adaptive bitrate logic
webrtcStats.ts          RTP/ICE statistics and bitrate parameter helpers
calibrationFlow.ts      Calibration collection and acceptance flow
calibrationStorage.ts   Calibration quality state and persistence
readingAnalysis.ts      Experimental session metrics and reports
readingDemo.ts          Reading-page visual workload
```

## Requirements

- Node.js 20.19+ or a compatible newer release
- pnpm 9+
- a modern browser with WebGL2, WebRTC, Canvas Capture Stream, and webcam support
- HTTPS or localhost for webcam access in most browsers

MediaPipe runtime assets are loaded from a CDN by default. The project processes webcam frames locally in the browser, but its dependency-loading and privacy behavior should be reviewed before any deployment.

## Installation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The repository currently defines build scripts but does not yet provide a supported automated test or type-check command.

## Running the experiments

### Local Three.js renderer

```bash
pnpm dev:demo
```

This starts the minimal local foveated-rendering experiment.

### WebRTC and gaze laboratory

```bash
pnpm dev:webrtc
```

Vite will print the local development address. Webcam permission is optional because the application can fall back to mouse input.

## Current controls

The active controls in `apps/webrtc-dual` include:

| Key | Action |
|---|---|
| `C` | Run calibration followed by reading analysis |
| `Shift+C` | Run calibration only |
| `A` | Run the automatic calibration and analysis routine |
| `R` | Start or stop reading analysis |
| `F` | Toggle fullscreen |
| `H` | Toggle diagnostic HUD |
| `G` | Toggle the GPU governor |
| `+` / `-` | Adjust the GPU target |
| `B` | Toggle the bandwidth governor |
| `1` / `2` / `3` | Select mobile, balanced, or LAN bandwidth profile |
| `[` / `]` | Adjust the total bandwidth cap |
| `L` | Toggle experimental LOD |
| `T` | Toggle telemetry recording |
| `D` | Download telemetry JSONL |
| `X` | Clear the telemetry buffer |

Some controls affect experimental paths that are not visible while the final single-lens mode is enabled.

## Metadata protocol

The current DataChannel metadata protocol uses a 40-byte binary message:

```text
byte 0      message type
byte 1      protocol version
bytes 2-3   sequence number
bytes 4-11  gaze x/y
bytes 12-27 patch rectangle x/y/width/height
bytes 28-31 gaze confidence
bytes 32-35 fovea radius
bytes 36-39 feather width
```

The protocol is a useful prototype boundary, but it still needs formal versioning rules, timestamp semantics, validation, and receiver-side stale/out-of-order handling.

## Telemetry

The application can record JSONL telemetry at approximately 10 Hz. Depending on the active path and browser support, records may include:

- raw, calibrated, controlled, estimated, and filtered gaze coordinates;
- confidence, eye-lock state, and filter mode;
- patch rectangle and fovea parameters;
- LOW, PATCH, and receiver timing values;
- target and applied bitrate caps;
- RTP payload and retransmission-derived rates;
- RTT and packet-loss estimates;
- ICE `availableOutgoingBitrate` when exposed by the browser;
- governor adjustments and cap-application events;
- calibration and reading-analysis summaries.

Telemetry fields should be interpreted as experimental browser measurements. They are not yet normalized across browser engines or validated against an external measurement system.

## Known limitations

- The default visible lens is rendered locally and does not prove dual-stream receiver recomposition.
- The current LOW and PATCH experiments do not always contain two representations of the same source frame.
- WebRTC transport is currently tested with two local peers in one browser context.
- Network adaptation has not been benchmarked under controlled delay, jitter, loss, reordering, or bandwidth constraints.
- The default GPU governor does not measure all work performed by the visible Canvas 2D path or the browser video encoder.
- GPU timer-query handling needs a queued implementation rather than immediate reuse of one query object.
- `packages/fovea-core` and `apps/webrtc-dual` duplicate timing and governor concepts.
- The local renderer may reallocate render targets repeatedly when its governor changes scale.
- Calibration quality is currently evaluated mainly on the samples used to fit the model.
- Reading analysis has no independent ground truth for the user's true gaze point.
- No automated test suite, continuous integration workflow, browser matrix, or reproducible benchmark report is included.
- Performance figures from older documentation should be treated as exploratory observations unless reproduced by the future benchmark harness.

## Development principles going forward

- **One thesis first.** The primary project is gaze-guided dual-stream transport and recomposition.
- **Separate experiments before integration.** Gaze, rendering, transport, and governors must be independently testable.
- **Same content in both streams.** LOW and PATCH must derive from one source scene for end-to-end claims.
- **Transport must be visible.** The final output must use received tracks, not a local substitute.
- **Ground truth before tuning.** New filters and thresholds require a benchmark that can show whether they improve results.
- **Measure before claiming.** Quality, latency, GPU cost, and bandwidth savings require repeatable reports.
- **Prefer explicit state machines.** Avoid adding more interacting thresholds directly to the main render loop.
- **Fallback is a feature.** Loss of gaze confidence must degrade gracefully to a documented rendering policy.

## Contributing and current engineering frontier

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and the milestone boundaries in [`RECOVERY_PLAN.md`](RECOVERY_PLAN.md).

The preferred contribution model is **separate, measurable laboratories before end-to-end integration**. Current work is naturally divided across:

- **Gaze Lab** — held-out calibration evaluation, replayable gaze observations, filtering and confidence-state validation;
- **Render Lab** — same-scene LOW/PATCH generation, alignment, local reference compositing and render-resource behavior;
- **Transport Lab** — versioned metadata, synchronization, receiver behavior and controlled network experiments;
- **Measurement infrastructure** — automated tests, CI, browser capability reporting, GPU timing, telemetry and benchmark tooling.

Please avoid adding new tuning heuristics or integrated-mode branches without an explicit measurement path. A contribution that clarifies a failure, removes an ambiguity, or establishes a reproducible baseline is useful even if it does not improve headline performance.

## Intended future evaluation

A credible benchmark should compare at least:

1. one conventional full-frame WebRTC stream;
2. LOW-only transport;
3. LOW + fixed high-resolution patch;
4. LOW + gaze-driven patch;
5. the same modes with and without network and GPU governors.

The report should measure:

- glass-to-glass or source-to-display latency;
- patch age and metadata-to-video synchronization error;
- bitrate and retransmission cost;
- frame drops and decode delay;
- receiver composite correctness;
- full-frame and foveal image quality;
- gaze-to-patch tracking error;
- failure behavior when gaze or metadata is lost;
- GPU and CPU cost per stage.

## License

FoveaRender is licensed under the [Apache License 2.0](LICENSE).

---

FoveaRender should currently be read as an ambitious browser systems laboratory. Its value is not that every experimental path is already unified, but that it contains working pieces for gaze estimation, rendering, WebRTC transport, adaptive control, and telemetry that can be turned into a serious end-to-end experiment through disciplined separation and validation.
