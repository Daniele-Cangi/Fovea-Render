# FoveaRender Recovery Plan

This document defines a future engineering path for turning the current FoveaRender research repository into a coherent, measurable, end-to-end gaze-guided dual-stream rendering experiment.

The plan does not assume that every current component should survive unchanged. The goal is to preserve the strongest technical work while removing duplicated control loops, separating experiments, and rebuilding one system whose output can be explained and measured.

## Target outcome

The first serious FoveaRender release should demonstrate the following path:

```text
single source scene
      |
      +--> low-resolution complete frame
      |
      +--> high-resolution gaze-centered crop
                       |
                       v
             separate WebRTC tracks
                       +
              versioned metadata stream
                       |
                       v
              independent receiver
                       |
                       v
          synchronized visual composite
                       |
                       v
       reproducible performance report
```

The release should answer a narrow question:

> Under defined rendering and network conditions, does gaze-guided dual-stream transport reduce bandwidth or rendering cost while preserving better visual quality near the gaze point than a comparable single-stream baseline?

It should not claim production readiness, enterprise reliability, medical-grade eye tracking, or general bandwidth savings before the benchmark supports those claims.

## Primary architectural decision

FoveaRender will be organized as three independently testable laboratories and one integration application.

```text
Gaze Lab
  webcam estimation, calibration, filtering, validation

Render Lab
  same-scene LOW and PATCH generation, local reference composite

Transport Lab
  WebRTC tracks, metadata, receiver, network impairment, statistics

Integration App
  combines only validated versions of the three laboratories
```

The circular reading lens remains useful as a visual and gaze-control demonstration, but it is not the product architecture and should live as a separate example.

## Non-negotiable engineering rules

1. LOW and PATCH must derive from the same source scene for end-to-end rendering claims.
2. The displayed integrated result must use received video tracks and received metadata.
3. Every adaptive controller must expose its input, output, update cadence, and state.
4. No new smoothing stage, threshold, or predictor is added without a benchmark that can show its effect.
5. Calibration accuracy must be evaluated on held-out targets not used for fitting.
6. Synthetic or local-loopback success is not presented as network validation.
7. Browser statistics are labelled according to what they actually measure.
8. Performance claims include hardware, browser, resolution, codec, configuration, and measurement method.
9. Graceful fallback is designed explicitly rather than emerging from chained heuristics.
10. `main.ts` coordinates modules; it does not contain independent implementations of their algorithms.

---

# Milestone 0 — Freeze and reproduce the current baseline

**Priority:** P0  
**Goal:** ensure the present repository can be installed, built, and observed before restructuring it.

## Work

- [ ] Pin the supported Node.js and pnpm versions.
- [ ] Add an `.nvmrc` or `.node-version` file.
- [ ] Add the `packageManager` field to the root `package.json`.
- [ ] Add root scripts for:
  - `build`;
  - `typecheck`;
  - `test`;
  - `lint`;
  - `format:check`.
- [ ] Align `three` and `@types/three` versions.
- [ ] Add TypeScript configuration shared across workspaces.
- [ ] Add a minimal GitHub Actions workflow for install, type-check, test, and build.
- [ ] Record a baseline browser matrix:
  - Chrome/Chromium;
  - Edge;
  - Firefox where supported;
  - Safari where supported.
- [ ] Record which features are unavailable in each browser:
  - timer queries;
  - `availableOutgoingBitrate`;
  - sender bitrate readback;
  - Canvas Capture Stream;
  - webcam and MediaPipe behavior.
- [ ] Save one short baseline telemetry session for each current demo.
- [ ] Add screenshots or recordings of the current local renderer and final lens demo.
- [ ] Tag the frozen state before major restructuring.

## Acceptance criteria

- A clean clone installs with one documented command.
- The full monorepo build succeeds in CI.
- TypeScript errors fail CI.
- At least one unit test runs in every package that contains algorithms.
- The current behavior can be compared with later versions using saved configurations and telemetry.

---

# Milestone 1 — Separate the four applications

**Priority:** P0  
**Goal:** prevent one experiment from silently substituting for another.

## Proposed applications

```text
apps/
  gaze-lab/
    calibration and held-out gaze evaluation

  render-lab/
    local same-scene LOW/PATCH generation and reference composite

  transport-lab/
    controlled two-track WebRTC sender and receiver

  integrated-demo/
    final gaze-driven dual-stream experiment

  lens-demo/
    optional reading-lens visual demonstration
```

## Work

- [ ] Move the current final Canvas 2D reading lens into `apps/lens-demo`.
- [ ] Move calibration and gaze diagnostics into `apps/gaze-lab`.
- [ ] Move generic WebRTC sender/receiver and statistics tools into `apps/transport-lab` or reusable packages.
- [ ] Create `apps/render-lab` with no webcam and no WebRTC dependency.
- [ ] Keep `apps/integrated-demo` empty until the three laboratories pass their initial acceptance criteria.
- [ ] Remove `FINAL_SINGLE_DEMO` and other compile-time mode switches from the integrated path.
- [ ] Replace mode-dependent hidden branches with separate entry points.
- [ ] Ensure each application has its own README describing exactly what it demonstrates.

## Acceptance criteria

- Running one application cannot silently execute or display another experiment's output.
- The dual-stream transport laboratory always displays received tracks.
- The lens demo contains no claim that it is the receiver output.
- Each application can build independently.

---

# Milestone 2 — Extract reusable packages and remove duplication

**Priority:** P0  
**Goal:** establish real module boundaries before further feature work.

## Proposed package structure

```text
packages/
  gaze-core/
    gaze samples, confidence state, filters, calibration models

  gaze-mediapipe/
    MediaPipe adapter only

  fovea-render-core/
    LOW/PATCH render planning and same-scene render passes

  fovea-composite/
    local and receiver compositing algorithms

  fovea-protocol/
    metadata schema, encoder, decoder, sequence handling

  webrtc-transport/
    sender, receiver, track mapping, bitrate parameters

  telemetry/
    stable event and sample schemas

  benchmark-core/
    scenario definitions, metrics, result serialization
```

## Work

- [ ] Keep browser/library adapters separate from pure algorithms.
- [ ] Move all GPU timer logic into one package.
- [ ] Move bandwidth profiles and state transitions into pure testable functions.
- [ ] Move gaze state transitions into one explicit controller.
- [ ] Remove governor implementations duplicated between `fovea-core` and `webrtc-dual`.
- [ ] Define immutable configuration objects for each subsystem.
- [ ] Define explicit input/output types at every boundary.
- [ ] Prevent packages from accessing application DOM elements or global telemetry objects.
- [ ] Remove `any` from protocol, statistics, and calibration boundaries where practical.

## Acceptance criteria

- No independent copies of `GpuTimer`, fovea geometry, or bitrate-state logic remain.
- Pure algorithm packages can be tested without a DOM, camera, or WebRTC peer.
- Applications compose packages instead of duplicating their code.

---

# Milestone 3 — Build a valid Gaze Lab

**Priority:** P0  
**Goal:** determine what the webcam estimator can reliably provide before tuning rendering around it.

## Measurement model

The Gaze Lab must distinguish:

```text
calibration fit set
validation target set
free-viewing diagnostic session
```

The calibration fit set estimates model parameters. It is not used to report final accuracy.

## Work

- [ ] Preserve raw per-eye measurements before filtering.
- [ ] Define one timestamped `GazeObservation` schema.
- [ ] Separate these stages explicitly:
  - landmark extraction;
  - per-eye normalization;
  - eye fusion;
  - calibration projection;
  - temporal filtering;
  - control prediction.
- [ ] Add a held-out validation sequence after calibration.
- [ ] Randomize or pseudo-randomize validation target order.
- [ ] Include targets between calibration grid positions.
- [ ] Measure error in normalized coordinates and visual degrees when screen geometry is known.
- [ ] Record calibration duration, accepted frames, rejected frames, and model complexity.
- [ ] Compare affine and polynomial models using held-out error, not fit error.
- [ ] Add cross-validation or complexity penalties before selecting a polynomial model.
- [ ] Create deterministic unit tests for calibration solvers.
- [ ] Create replay tests from recorded landmark-derived input, without requiring a webcam.
- [ ] Test mirroring and coordinate conventions independently.
- [ ] Measure drift over time after calibration.
- [ ] Measure sensitivity to:
  - head translation;
  - head rotation;
  - lighting;
  - glasses;
  - camera position;
  - blink and partial occlusion.

## Required metrics

- held-out RMSE;
- median angular or normalized error;
- 90th percentile error;
- left/right-region error;
- calibration rejection rate;
- eye-lock availability ratio;
- dropout frequency and duration;
- raw jitter during fixation;
- latency and overshoot during saccades;
- long-term drift.

## Controller simplification experiment

The current chain includes multiple smoothing and prediction layers. Test these variants independently:

1. calibrated raw gaze;
2. One-Euro only;
3. Kalman only;
4. One-Euro followed by Kalman;
5. each previous variant with predictive lead;
6. each previous variant with deadband/quantization.

Do not choose the most visually pleasing variant manually. Select based on a stated trade-off between fixation jitter, movement latency, and overshoot.

## Acceptance criteria

- Calibration quality is based on held-out targets.
- The selected filter chain is justified by a benchmark table.
- Coordinate transformations are covered by tests.
- A session can be replayed deterministically from stored observations.
- Loss of confidence produces a documented state transition.

---

# Milestone 4 — Rebuild same-scene foveated rendering

**Priority:** P0  
**Goal:** generate LOW and PATCH as two representations of one source scene.

## Reference pipeline

```text
source scene at time T
      |
      +--> full-frame low-resolution render
      |
      +--> high-resolution crop using the same camera state at T
```

The patch must not contain an unrelated workload or independently animated content.

## Work

- [ ] Define a `RenderFrameState` containing:
  - source frame identifier;
  - simulation timestamp;
  - camera transform;
  - viewport;
  - gaze position;
  - patch rectangle;
  - quality configuration.
- [ ] Render LOW and PATCH from one immutable frame state.
- [ ] Use camera view offsets or a mathematically equivalent crop projection for PATCH.
- [ ] Add reference markers to verify spatial alignment.
- [ ] Implement a local reference compositor that does not involve encoding.
- [ ] Add pixel-difference tests for patch placement and UV mapping.
- [ ] Test corners and clipped patch rectangles.
- [ ] Test aspect-ratio differences.
- [ ] Define feathering in screen-space units.
- [ ] Separate foveal image blending from scene LOD policy.
- [ ] Make LOD optional and benchmark it separately.
- [ ] Stop resizing render targets every frame.
- [ ] Add discrete quality levels or a rate-limited allocation strategy.
- [ ] Add explicit resource disposal and resize tests.

## Render-target governor correction

The local renderer must not recreate both render targets on every out-of-band frame.

Use one of these strategies:

- preallocated render targets for discrete quality levels;
- scale changes with a cooldown and minimum persistence period;
- dynamic viewport inside a fixed maximum allocation;
- hysteresis plus an explicit transition state.

## Acceptance criteria

- LOW and PATCH align exactly in a local reference composite.
- The same frame identifier is associated with both outputs.
- Patch movement does not create stale or black regions.
- Render-target allocations remain stable during a steady workload.
- The local reference path has deterministic visual test fixtures.

---

# Milestone 5 — Formalize metadata and synchronization

**Priority:** P0  
**Goal:** make the receiver able to decide which metadata belongs to which video content.

## Current limitation

A sequence number alone does not establish video/metadata synchronization. Video frames can be delayed, dropped, reordered, or decoded at a different cadence from DataChannel messages.

## Work

- [ ] Define a versioned protocol specification in `docs/protocol.md`.
- [ ] Include:
  - protocol magic or message type;
  - version;
  - sender timestamp;
  - source frame identifier;
  - metadata sequence number;
  - patch rectangle;
  - gaze position;
  - confidence;
  - fovea parameters;
  - coordinate-space identifier;
  - optional quality state.
- [ ] Define endianness and validation rules.
- [ ] Reject NaN, infinity, invalid rectangles, and unsupported versions.
- [ ] Track stale, duplicated, and out-of-order messages.
- [ ] Define receiver behavior when metadata is missing.
- [ ] Define receiver behavior when PATCH is missing or delayed.
- [ ] Evaluate available synchronization signals from WebRTC and browser APIs.
- [ ] Add a receiver-side metadata interpolation or hold policy.
- [ ] Log metadata age at display time.
- [ ] Add protocol unit tests and golden binary fixtures.

## Acceptance criteria

- The receiver never applies arbitrary old metadata without detecting its age.
- Malformed messages are rejected safely.
- Protocol v1/v2 compatibility is explicit rather than inferred from message size alone.
- Metadata-to-display age is included in benchmark reports.

---

# Milestone 6 — Build a real Transport Lab

**Priority:** P0  
**Goal:** validate dual-stream behavior independently of gaze quality and scene complexity.

## Work

- [ ] Use deterministic synthetic video sources with embedded frame counters and timestamps.
- [ ] Support separate sender and receiver pages.
- [ ] Support two browser contexts on one machine.
- [ ] Support two machines on a LAN.
- [ ] Add optional signaling for remote testing.
- [ ] Keep local loopback as the fastest smoke test.
- [ ] Add controllable network impairment outside the browser:
  - bandwidth cap;
  - base delay;
  - jitter;
  - packet loss;
  - burst loss;
  - packet reordering.
- [ ] Document the impairment tool and exact scenario configuration.
- [ ] Measure each track separately.
- [ ] Correct telemetry terminology:
  - RTP media payload;
  - retransmitted payload;
  - header bytes when available;
  - estimated transport budget;
  - not generic “wire bitrate” unless measured below RTP.
- [ ] Test codec selection and record the negotiated codec.
- [ ] Test keyframe behavior after patch movement or loss.
- [ ] Test track replacement, reconnect, and ICE restart.
- [ ] Test metadata channel loss independently from video loss.

## Baseline scenarios

1. no impairment;
2. stable 8 Mbps;
3. stable 3 Mbps;
4. stable 1.2 Mbps;
5. step-down bandwidth;
6. step-up bandwidth;
7. 100 ms latency with jitter;
8. random 1% loss;
9. random 3% loss;
10. burst loss;
11. delayed PATCH relative to LOW;
12. metadata dropout.

## Acceptance criteria

- Tests run between distinct sender and receiver contexts.
- Results identify browser, codec, resolution, frame rate, and impairment profile.
- Receiver behavior under missing PATCH and metadata is deterministic.
- Local loopback results are labelled separately from impaired and remote results.

---

# Milestone 7 — Replace ad hoc GPU timing with a measurement subsystem

**Priority:** P1  
**Goal:** measure actual stages without corrupting the workload being measured.

## Work

- [ ] Implement one queued WebGL timer-query manager.
- [ ] Support multiple pending queries.
- [ ] Never reuse a query before its result has been collected or discarded.
- [ ] Handle disjoint events explicitly.
- [ ] Associate each timing result with frame and stage identifiers.
- [ ] Measure:
  - LOW render;
  - PATCH render;
  - receiver composite;
  - local reference composite;
  - CPU frame duration;
  - long tasks;
  - dropped animation frames.
- [ ] Treat Canvas 2D and browser encoder cost separately from WebGL GPU timing.
- [ ] Record unsupported or unavailable metrics as unavailable, not zero.
- [ ] Add a fallback CPU timing path with explicit semantics.
- [ ] Validate timer behavior with synthetic GPU workloads.

## Acceptance criteria

- Timer results are associated with the correct earlier frame.
- Unsupported timing never appears as `0 ms`.
- The GPU governor consumes a declared metric with known coverage.
- Timing instrumentation does not cause repeated allocation or query errors.

---

# Milestone 8 — Rebuild the adaptive controllers as explicit state machines

**Priority:** P1  
**Goal:** prevent several independent feedback loops from fighting each other.

## Controller hierarchy

The first integrated version should have three controllers with clear authority:

```text
Gaze confidence controller
  decides eye / hold / fallback state

Render budget controller
  selects one discrete rendering-quality configuration

Transport budget controller
  selects total bitrate and LOW/PATCH allocation
```

The controllers may exchange state, but they must not mutate each other's internal variables directly.

## Work

- [ ] Define state-transition diagrams.
- [ ] Define update cadences separately.
- [ ] Define cooldown and minimum-state-duration rules.
- [ ] Use discrete render quality profiles before continuous multi-parameter control.
- [ ] Use a fixed list of transport profiles before dynamic allocation.
- [ ] Add replayable controller simulations.
- [ ] Test step response, oscillation, recovery time, and overshoot.
- [ ] Log every state transition with reason and input values.
- [ ] Define behavior when a metric is unavailable.
- [ ] Define priority rules under combined GPU and network pressure.
- [ ] Remove visual tuning constants from application orchestration.

## Example render profiles

```text
R0 quality-first
  large patch, high LOW scale, full peripheral LOD

R1 balanced
  medium patch, medium LOW scale, reduced peripheral work

R2 constrained
  smaller patch, lower LOW scale, aggressive peripheral reduction

R3 fallback
  LOW-only or conservative fixed patch
```

## Acceptance criteria

- Controller output is deterministic for a recorded metric sequence.
- No controller changes resource size every frame.
- Oscillation tests pass for defined workload and network steps.
- All transitions appear in telemetry with causal data.

---

# Milestone 9 — Establish the benchmark suite

**Priority:** P0 before any public performance claim  
**Goal:** compare FoveaRender against meaningful baselines.

## Required configurations

### Transport baselines

- [ ] one full-resolution WebRTC stream;
- [ ] one reduced-resolution stream;
- [ ] LOW + fixed PATCH;
- [ ] LOW + mouse-driven PATCH;
- [ ] LOW + recorded-gaze PATCH;
- [ ] LOW + live webcam-gaze PATCH.

### Controller variants

- [ ] all governors disabled;
- [ ] transport governor only;
- [ ] render governor only;
- [ ] both governors enabled.

### Gaze variants

- [ ] perfect synthetic gaze;
- [ ] delayed synthetic gaze;
- [ ] noisy synthetic gaze;
- [ ] recorded webcam gaze;
- [ ] live webcam gaze;
- [ ] loss-of-confidence fallback.

## Metrics

### Visual quality

- full-frame PSNR/SSIM where meaningful;
- gaze-weighted image quality;
- patch alignment error;
- seam visibility;
- patch age;
- time spent with gaze outside high-quality coverage.

### Performance

- source-to-display latency;
- encode and decode delay;
- frames per second;
- dropped and frozen frames;
- CPU time;
- GPU time by measured stage;
- memory and render-target allocation behavior.

### Network

- media payload bitrate;
- retransmission cost;
- header bytes when exposed;
- packet loss;
- RTT;
- jitter;
- available outgoing bitrate when exposed;
- target versus applied bitrate.

### Gaze control

- held-out gaze error;
- gaze-to-patch-center error;
- fixation jitter;
- saccade latency;
- overshoot;
- dropout duration;
- fallback recovery.

## Report format

Each benchmark run should save:

```text
run metadata
hardware and operating system
browser and version
codec and negotiated parameters
screen and render dimensions
scene and seed
network impairment profile
gaze source and filter configuration
controller configuration
raw telemetry references
summary metrics
warnings and unavailable measurements
```

## Acceptance criteria

- A benchmark run can be reproduced from its saved configuration.
- Results include baselines and failures.
- Claims are tied to a specific scenario rather than generalized from one machine.
- Raw telemetry and summary calculations can be audited.

---

# Milestone 10 — Build the integrated end-to-end demo

**Priority:** P1 after laboratory validation  
**Goal:** recombine only validated components.

## Work

- [ ] Use the same-scene renderer from Render Lab.
- [ ] Use the versioned protocol from the protocol package.
- [ ] Use distinct sender and receiver contexts.
- [ ] Display received LOW and PATCH streams only.
- [ ] Provide a visible diagnostic mode showing:
  - LOW track;
  - PATCH track;
  - final composite;
  - patch rectangle;
  - metadata age;
  - gaze state;
  - controller states.
- [ ] Provide a clean presentation mode without hidden local substitution.
- [ ] Allow recorded gaze playback for reproducible demos.
- [ ] Allow mouse gaze for debugging.
- [ ] Add explicit fallback modes:
  - metadata hold;
  - patch freeze;
  - patch fade-out;
  - LOW-only;
  - fixed central patch.
- [ ] Export one benchmark report directly from the application.

## Acceptance criteria

- Disconnecting the receiver's PATCH track visibly triggers the documented fallback.
- Disconnecting metadata visibly triggers the documented fallback.
- The final composite can be traced to received frames and metadata.
- Recorded-gaze playback produces repeatable output.
- The clean demo and diagnostic demo use the same underlying transport path.

---

# Milestone 11 — Documentation, release, and project positioning

**Priority:** P1  
**Goal:** make the repository understandable without inflating its maturity.

## Work

- [ ] Add a real license file after choosing the intended terms.
- [ ] Add architecture decision records for major choices.
- [ ] Document browser support and feature degradation.
- [ ] Document webcam privacy and CDN dependencies.
- [ ] Add diagrams generated from current code boundaries.
- [ ] Add a benchmark methodology document.
- [ ] Add a results directory with machine-readable and human-readable reports.
- [ ] Add a changelog.
- [ ] Add contribution guidelines.
- [ ] Define semantic versioning rules.
- [ ] Distinguish:
  - implemented;
  - tested;
  - benchmarked;
  - experimental;
  - planned.

## Release gates

### `0.1.0` — Reproducible laboratories

- repository installs, type-checks, tests, and builds in CI;
- gaze, rendering, and transport applications are separated;
- current lens demo remains available as a distinct example.

### `0.2.0` — Validated components

- held-out gaze validation exists;
- same-scene LOW/PATCH alignment tests pass;
- transport impairment tests produce reports;
- protocol and GPU timing tests pass.

### `0.3.0` — Integrated research demo

- distinct sender and receiver contexts;
- received tracks drive the final composite;
- recorded-gaze benchmark is reproducible;
- failure modes are implemented.

### `1.0.0` — Only after evidence supports it

A `1.0.0` release should require:

- stable public interfaces;
- documented browser support;
- reproducible benchmarks on multiple systems;
- no known silent local substitution path;
- validated controller stability;
- a complete license and documentation set.

---

# Proposed repository shape

```text
fovea-render/
  apps/
    gaze-lab/
    render-lab/
    transport-lab/
    integrated-demo/
    lens-demo/

  packages/
    gaze-core/
    gaze-mediapipe/
    fovea-render-core/
    fovea-composite/
    fovea-protocol/
    webrtc-transport/
    telemetry/
    benchmark-core/

  tests/
    fixtures/
    browser/
    visual/
    protocol/

  benchmarks/
    scenarios/
    configs/
    results/

  docs/
    architecture/
    protocol.md
    benchmark-methodology.md
    browser-support.md
    privacy.md

  README.md
  RECOVERY_PLAN.md
  CHANGELOG.md
  LICENSE
```

---

# First recovery sprint

The first sprint should not change the gaze model or add rendering features.

## Scope

1. establish Node/pnpm versions;
2. add type-check, test, lint, and CI;
3. align Three.js runtime and type versions;
4. move the reading lens to `apps/lens-demo`;
5. create empty `gaze-lab`, `render-lab`, and `transport-lab` entry points;
6. move the WebRTC loopback into `transport-lab` without changing behavior;
7. preserve baseline telemetry and screenshots;
8. add one unit test each for:
   - One-Euro filtering;
   - affine calibration fitting;
   - bandwidth cap computation;
   - binary metadata encoding/decoding.

## Sprint acceptance criteria

- CI is green.
- All existing demos still run through explicit entry points.
- There is no `FINAL_SINGLE_DEMO` switch controlling two different architectures inside one application.
- No algorithmic tuning constants are changed during the restructuring sprint.
- A tag or commit identifies the pre-restructure baseline.

---

# Work that should wait

Do not prioritize these until the benchmark and module boundaries exist:

- machine-learned gaze prediction;
- more calibration polynomial terms;
- more confidence thresholds;
- more patch-motion smoothing layers;
- a cloud signaling service;
- multi-user sessions;
- production authentication;
- native VR/AR integrations;
- codec-specific optimization;
- visual redesign of the final application;
- claims of enterprise or production readiness.

---

# Definition of a successful recovery

The recovery is successful when a new contributor can answer all of these questions from code, documentation, and reports:

1. What exact source content generated LOW and PATCH?
2. Which received frames were used for the displayed composite?
3. How old was the metadata when the composite was displayed?
4. Which gaze-processing stages were active?
5. What was the held-out gaze error?
6. Which controller changed quality, when, and why?
7. What bandwidth was requested, applied, and measured?
8. Which network impairment scenario was active?
9. How did the result compare with a single-stream baseline?
10. What happened when gaze, PATCH, or metadata failed?

If those questions have reproducible answers, FoveaRender will no longer be a collection of impressive interacting experiments. It will be a serious browser systems research project with a defensible technical result.
