# Contributing to FoveaRender

FoveaRender welcomes contributions that help turn the current research prototype into a coherent, measurable gaze-guided dual-stream rendering experiment.

Before starting substantial work, read:

- [`README.md`](README.md)
- [`RECOVERY_PLAN.md`](RECOVERY_PLAN.md)

The recovery plan defines the current engineering direction. Contributions should strengthen that direction rather than add another parallel experiment inside the existing application.

## Current contribution areas

The project is intentionally being separated into independently testable areas:

- **Gaze Lab** — webcam gaze estimation, calibration, filtering, held-out validation, replayable gaze observations;
- **Render Lab** — same-scene LOW/PATCH generation, local reference compositing, foveal geometry and visual validation;
- **Transport Lab** — WebRTC sender/receiver behavior, metadata synchronization, network impairment and transport telemetry;
- **Measurement infrastructure** — reproducible benchmarks, timing, telemetry schemas, CI and offline tests;
- **Integration App** — only after the underlying labs expose validated interfaces and acceptance evidence.

Small documentation fixes, reproducible bug reports, tests, and isolated tooling improvements do not need a design discussion first. Large architectural changes, new control algorithms, protocol changes, or changes that alter measurement semantics should be discussed in an issue before implementation.

## Core engineering rules

FoveaRender is a research systems project. A contribution should make an experiment easier to explain, reproduce, isolate, or measure.

Please preserve these invariants:

1. LOW and PATCH must derive from the same source scene for end-to-end rendering claims.
2. Integrated receiver output must use transported tracks and received metadata, not a local visual substitute.
3. Gaze accuracy must be evaluated on held-out targets rather than only on calibration-fit samples.
4. Local WebRTC loopback is a development tool, not evidence of behavior over a real or impaired network.
5. New smoothing stages, predictors, thresholds, or adaptive policies need a benchmark that can show their effect.
6. Browser statistics must be named according to what they actually measure.
7. Unsupported or unavailable measurements should be recorded as unavailable, not as zero.
8. Experimental performance claims must include enough environment/configuration information to be reproducible.
9. Prefer explicit state machines and typed interfaces over new hidden mode switches or branches in `main.ts`.
10. Keep pure algorithms separable from DOM, webcam, WebRTC, and application-global state where practical.

## What not to do

Please avoid contributions that:

- add another visual demo without clarifying which research question it answers;
- tune gaze filters against the same samples used for fitting/calibration and report that as final accuracy;
- present local-loopback transport results as remote-network validation;
- add thresholds because they look better in one manual run;
- duplicate timing, governor, protocol, or fovea-geometry logic that should live behind a shared boundary;
- silently change telemetry meaning while keeping the same field name;
- treat a browser API estimate as a lower-layer network measurement it does not provide;
- make the reading-lens demo appear to be the transported receiver composite.

## Development workflow

1. Fork the repository and create a focused branch.
2. Prefer one conceptual change per pull request.
3. Link the relevant recovery-plan milestone or GitHub issue.
4. State which lab or subsystem is affected.
5. Add tests or reproducible evidence appropriate to the change.
6. Document any browser, hardware, webcam, codec, or network assumptions needed to reproduce the result.
7. Keep experimental artifacts small and explain how they were produced.

The repository is still building its automated test and CI baseline. Until that work lands, contributors should at minimum verify that the affected workspace installs and builds with the documented toolchain and describe the commands they ran in the PR.

## Measurement-oriented changes

If a contribution changes an algorithm, controller, filter, synchronization rule, or adaptive policy, include:

- the previous behavior or baseline;
- the new behavior;
- the metric used to compare them;
- the scenario/configuration;
- whether the data was used to tune the change;
- remaining unsupported or unmeasured conditions.

A negative or neutral result is acceptable. The project benefits more from a reproducible boundary than from a broader claim that cannot be measured.

## Protocol changes

Changes to the LOW/PATCH metadata protocol should define explicitly:

- message versioning;
- endianness;
- field validation;
- timestamp/frame identity semantics;
- stale, duplicate, and out-of-order handling;
- receiver behavior when metadata or PATCH data is missing;
- compatibility behavior across versions.

Golden binary fixtures and decoder/validation tests are strongly preferred.

## Gaze-related changes

Gaze contributions should distinguish at least:

- landmark/raw observation;
- calibration projection;
- temporal filtering;
- control prediction;
- confidence/fallback state.

When reporting accuracy, do not use calibration-fit error as held-out accuracy. Replayable landmark-derived or synthetic fixtures are encouraged so algorithm changes can be tested without requiring a webcam in CI.

## Pull request notes

Please include in the PR description:

- problem or research question addressed;
- affected lab/package/application;
- tests or manual reproduction commands run;
- relevant measurements and environment details;
- known limitations;
- whether the change modifies a protocol, metric definition, telemetry schema, or claim boundary.

## License

FoveaRender is licensed under the Apache License 2.0. Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in the project are provided under the same license terms.
