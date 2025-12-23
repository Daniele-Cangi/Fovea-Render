# FoveaRender

**Enterprise-grade foveated rendering system** with WebRTC dual-stream architecture, real-time eye tracking, adaptive quality governors, and comprehensive telemetry.

## 🎯 Overview

FoveaRender is a monorepo implementing a production-ready foveated rendering pipeline that:
- Renders high-quality content only where the user is looking (fovea)
- Uses dual WebRTC streams (low-res base + high-res patch) for bandwidth efficiency
- Adapts quality in real-time based on GPU performance and network conditions
- Tracks gaze using MediaPipe face mesh with calibration
- Provides comprehensive telemetry for performance analysis

## 📦 Project Structure

```
fovea-render/
├── packages/
│   ├── fovea-core/          # Core foveated rendering logic
│   │   ├── FoveatedRenderer.ts
│   │   ├── Governor.ts
│   │   └── GpuTimer.ts
│   └── gaze-mediapipe/      # MediaPipe-based eye tracking
│       ├── MediapipeGazeProvider.ts
│       └── OneEuro.ts       # One-Euro filter for smooth gaze
├── apps/
│   ├── demo-three/          # Simple Three.js demo
│   └── webrtc-dual/         # Full WebRTC dual-stream demo ⭐
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+

### Installation

```bash
# Install dependencies
pnpm install

# Build packages
pnpm -C packages/fovea-core build
pnpm -C packages/gaze-mediapipe build

# Run demo
pnpm dev:demo          # Simple Three.js demo
pnpm dev:webrtc       # Full WebRTC dual-stream demo
```

### WebRTC Dual-Stream Demo

```bash
cd apps/webrtc-dual
pnpm dev
# Open http://localhost:5174
```

**Requirements:**
- Webcam for eye tracking (falls back to mouse)
- Modern browser with WebGL2 and WebRTC support

## 🎮 Controls

### Eye Tracking & Calibration
- **C** - Start 3×3 calibration (follow the dot, don't move head)
- **ESC** - Abort calibration
- Calibration auto-saves to localStorage

### GPU Governor
- **G** - Toggle GPU governor ON/OFF
- **+** / **=** - Increase GPU target (+0.5ms, max 20ms)
- **-** / **_** - Decrease GPU target (-0.5ms, min 4ms)

### Bandwidth Governor
- **B** - Toggle bandwidth governor ON/OFF
- **1** - Mobile profile (1200 kbps)
- **2** - Balanced profile (3000 kbps) - default
- **3** - LAN profile (8000 kbps)
- **[** - Decrease cap (-200 kbps)
- **]** - Increase cap (+200 kbps)

### LOD & Telemetry
- **L** - Toggle Level of Detail (LOD) ON/OFF
- **T** - Toggle telemetry recording ON/OFF
- **D** - Download telemetry JSONL file
- **X** - Clear telemetry buffer

## 🏗️ Architecture

### Dual-Stream Rendering

The system renders two streams simultaneously:

1. **LOW Stream** (1280×720 → 538×303)
   - Full frame at reduced resolution
   - Aggressive LOD in periphery
   - ~70% of bandwidth budget

2. **PATCH Stream** (640×640)
   - High-quality crop centered on gaze
   - Conservative LOD
   - ~30% of bandwidth budget

3. **Receiver Composite**
   - Blends LOW + PATCH streams
   - Radial mask centered on gaze
   - Smooth transitions with feathering

### Multi-Draw LOD System

**Enterprise-grade Level of Detail:**

- **NEAR Cloud**: Full density (120k points), rendered only inside fovea
- **FAR Cloud**: 25% density (30k points), rendered only outside fovea
- **Deterministic**: No runtime decimation overhead
- **GPU Throttling**: Runtime `uKeepProb` uniform reduces FAR rendering when overloaded

### Rendering Pipeline

```
┌─────────────────┐
│  Scene (120k)   │
│  NEAR + FAR     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼────┐
│  LOW  │ │ PATCH │
│  Pass │ │ Pass  │
└───┬───┘ └──┬────┘
    │        │
    │  ┌─────▼─────┐
    └──►  WebRTC   │
         │  Streams│
         └────┬────┘
              │
         ┌────▼────┐
         │ Receiver │
         │ Composite│
         └──────────┘
```

## 🎯 Key Features

### 1. Eye Tracking (MediaPipe)

- **Face Mesh Detection**: Real-time face landmarks
- **Iris Tracking**: Uses refined landmarks (468→478 points)
- **Head Proxy**: Robust fallback using nose position
- **One-Euro Filter**: Smooth, responsive gaze smoothing
- **3×3 Calibration**: Affine transformation mapping
- **Confidence Hysteresis**: Stable eye↔mouse switching

**Calibration Process:**
1. Press **C** to start
2. Follow 9 dots in 3×3 grid
3. Keep gaze steady, don't move head
4. Auto-saves to localStorage

### 2. GPU Governor

**Adaptive quality based on GPU performance:**

- Monitors total GPU time (LOW + PATCH + RECEIVER)
- EMA smoothing for stability
- Adjusts fovea radius and feather dynamically
- Throttles FAR cloud rendering via `uKeepProb`
- Target: 10ms default (adjustable 4-20ms)

**Behavior:**
- **Overloaded**: Shrinks fovea radius, increases feather, reduces FAR keep probability
- **Underloaded**: Expands fovea radius, decreases feather, increases FAR keep probability

### 3. Bandwidth Governor

**Adaptive bitrate based on network quality:**

- Monitors RTT and packet loss from WebRTC stats (TX and RX separately, worst-case)
- Monitors ICE transport budget (`availableOutgoingBitrate`)
- Three profiles: Mobile (1200), Balanced (3000), LAN (8000) kbps
- Automatic adjustment:
  - **Bad** (loss > 2% or RTT > 180ms): Reduce cap 15% after 2s stable
  - **Good** (loss < 0.5% and RTT < 120ms): Increase cap 5% after 5s stable
- **Hard clamp**: Respects ICE transport budget (88% headroom) to prevent overshoot
- Split strategy: LOW gets priority (67%), PATCH throttled first
- Floor protection: Minimums for both streams
- **Reliable cap application**: 
  - Verifies `setParameters` success with readback
  - Retries on failure (doesn't mark as applied until confirmed)
  - Immediate application on `bw_up/down/clamp` events (via `forceReapply` flag)
  - Threshold-based reapply: max(5% OR 100 kbps) delta
- **Event markers**: All adjustments logged to telemetry (`bw_up`, `bw_down`, `bw_budget_clamp`, `bw_apply_ok`, `bw_apply_fail`, `bw_apply_mismatch`)
- **Target vs Applied semantics**: 
  - `target_*_kbps`: Desired caps (computed from profile)
  - `applied_*_kbps`: Actually enforced caps (confirmed via readback)
  - HUD shows applied as primary, target as reference

**Profiles:**

| Profile  | Total | Min  | Max  | LOW Split | LOW Floor | PATCH Floor |
|----------|-------|------|------|-----------|-----------|-------------|
| Mobile   | 1200  | 700  | 2500 | 70%       | 350       | 150         |
| Balanced | 3000  | 1200 | 6000 | 67%       | 500       | 200         |
| LAN      | 8000  | 3000 | 12000| 62%       | 1000      | 500         |

### 4. Telemetry System

**10Hz JSONL logging for post-analysis:**

**Recorded Metrics:**
- Gaze position (x, y, use_eye, conf)
- Patch rectangle (normalized)
- Fovea parameters (radius, feather, LOD)
- GPU governor state (enabled, target, EMA, throttle)
- GPU timing (low, patch, receiver)
- Bandwidth:
  - Raw bitrate: `kbps_low`, `kbps_patch`
  - EMA smoothed: `kbps_low_ema`, `kbps_patch_ema` (for stable display)
  - Target caps: `target_low_kbps`, `target_patch_kbps` (desired)
  - Applied caps: `applied_low_kbps`, `applied_patch_kbps` (enforced)
- Network quality: RTT, loss TX/RX (separate), loss worst-case
- Bandwidth governor state (profile, enabled)
- ICE transport (availableOutgoingBitrate, ICE RTT)
- Event markers (profile_change, bw_up, bw_down, bw_budget_clamp, bw_apply_ok, bw_apply_fail, bw_apply_mismatch, sender_map, loss_rx_active)

**Usage:**
- Press **T** to toggle recording
- Press **D** to download `telemetry_YYYY-MM-DDTHH-MM-SS.jsonl`
- Press **X** to clear buffer
- Max 20,000 lines (~33 minutes at 10Hz)

**Event Markers:**
Special events are logged with `event` field:
- `profile_change`: When bandwidth profile changes (1/2/3 keys)
- `bw_down`: When bandwidth governor reduces cap due to bad quality
- `bw_up`: When bandwidth governor increases cap due to good quality
- `bw_budget_clamp`: When hard clamp to ICE budget is applied
- `bw_apply_ok`: When `setParameters` succeeds (includes target/applied/readback)
- `bw_apply_fail`: When `setParameters` fails (includes error and connection state)
- `bw_apply_mismatch`: When readback differs significantly from expected (>15%)
- `sender_map`: When sender mapping by track.id is established
- `loss_rx_active`: When RX loss tracking becomes available

**Sample JSONL line:**
```json
{"t_ms":1234567,"seq":42,"gaze_x":0.1234,"gaze_y":-0.5678,"use_eye":true,"conf":0.85,"rect":[0.1,0.2,0.5,0.5],"fovea_r":0.22,"feather":0.08,"lod":true,"gov_on":true,"gov_tgt_ms":10.0,"gov_ema_ms":9.5,"gov_thr":0.15,"gpu_low_ms":3.2,"gpu_patch_ms":4.1,"gpu_recv_ms":2.3,"kbps_low":850,"kbps_patch":420,"kbps_low_ema":845.2,"kbps_patch_ema":418.5,"rtt_ms":45,"loss_pct":0.1,"loss_tx_pct":0.05,"loss_rx_pct":0.08,"target_low_kbps":2010,"target_patch_kbps":990,"applied_low_kbps":2010,"applied_patch_kbps":990,"bw_prof":"balanced","bw_on":true,"aob_kbps":3500,"ice_rtt_ms":42}
```

**Event Markers:**
Events are logged with `event` field instead of `seq`:
```json
{"t_ms":1234567,"event":"profile_change","profile":"balanced","total_cap_kbps":3000,"applied_low_kbps":2010,"applied_patch_kbps":990}
{"t_ms":1234568,"event":"bw_down","from_kbps":3000,"to_kbps":2550,"applied_low_kbps":2010,"applied_patch_kbps":990,"rtt_ms":180,"loss_tx_pct":2.1,"loss_rx_pct":2.5,"loss_pct":2.5,"aob_kbps":3500,"ice_rtt_ms":42}
{"t_ms":1234569,"event":"bw_up","from_kbps":2550,"to_kbps":2677,"applied_low_kbps":1708,"applied_patch_kbps":842,"rtt_ms":100,"loss_tx_pct":0.1,"loss_rx_pct":0.2,"loss_pct":0.2,"aob_kbps":3500,"ice_rtt_ms":42}
{"t_ms":1234570,"event":"bw_budget_clamp","from_kbps":3000,"to_kbps":3080,"applied_low_kbps":2010,"applied_patch_kbps":990,"aob_kbps":3500,"ice_rtt_ms":42}
{"t_ms":1234571,"event":"bw_apply_ok","lane":"low","target_kbps":2010,"applied_kbps":2010,"readback_bps":2010000}
{"t_ms":1234572,"event":"bw_apply_fail","lane":"patch","target_kbps":990,"applied_kbps":850,"err":"InvalidStateError: Connection not ready","connectionState":"connecting","iceConnectionState":"checking"}
{"t_ms":1234573,"event":"sender_map","low_track_id":"abc123","patch_track_id":"def456","sender_track_ids":["abc123","def456"]}
{"t_ms":1234574,"event":"loss_rx_active","loss_rx_pct":0.05}
```

### 5. Patch-Rect Smoothing

- Smooths patch rectangle position to reduce jitter
- Lerp smoothing factor: 0.25
- Prevents visual artifacts at patch boundaries

### 6. Meta Binary Protocol (v2)

**40-byte binary format for low-latency metadata:**

```
[0:1]   u8  type (1 = meta)
[1:2]   u8  version (2)
[2:4]   u16 sequence number
[4:8]   f32 gaze.x (NDC)
[8:12]  f32 gaze.y (NDC)
[12:16] f32 rect.x (normalized)
[16:20] f32 rect.y (normalized)
[20:24] f32 rect.z (width)
[24:28] f32 rect.w (height)
[28:32] f32 confidence
[32:36] f32 foveaR
[36:40] f32 feather
```

**Benefits:**
- 40 bytes vs ~100+ bytes JSON
- Lower latency
- Deterministic parsing
- Backward compatible with v1 (32 bytes)

## 📊 Performance Metrics

### GPU Timing

- **LOW Pass**: ~3-5ms (depends on LOD)
- **PATCH Pass**: ~4-6ms (depends on LOD)
- **RECEIVER Composite**: ~2-3ms
- **Total Target**: 10ms (adjustable)

### Bandwidth Usage

**Balanced Profile (3000 kbps):**
- LOW stream: ~2010 kbps target (67%)
- PATCH stream: ~990 kbps target (33%)

**With Governor Active:**
- Automatically adjusts based on RTT/loss (worst-case TX/RX)
- Can throttle down to 1200 kbps (mobile) or up to 8000 kbps (LAN)
- **Hard clamp**: Never exceeds ICE transport budget (88% of `availableOutgoingBitrate`)
- **Reliable application**: Verifies `setParameters` success, retries on failure
- **EMA smoothing**: kbps values smoothed for stable display (2-3s time constant)
- **Event tracking**: All adjustments and application results logged for post-analysis
- **Target vs Applied**: HUD shows applied caps (enforced) vs target caps (desired)

### Rendering Efficiency

- **Without LOD**: ~120k points rendered everywhere
- **With LOD**: ~30k points in periphery + 120k in fovea
- **Fill-rate savings**: ~75% reduction in periphery
- **Fragment work**: Reduced via alpha and size scaling

## 🔧 Configuration

### Stream Sizes

```typescript
const FULL_W = 1280;
const FULL_H = 720;
const LOW_SCALE = 0.42;  // → 538×303
const PATCH_SIZE = 640;  // → 640×640
```

### Fovea Parameters

```typescript
const BASE_FOVEA_R = 0.22;   // NDC radius
const BASE_FEATHER = 0.08;   // NDC feather
```

### LOD Parameters

```typescript
const FAR_DENSITY = 0.25;  // 25% of points in FAR cloud
```

### Governor Targets

```typescript
// GPU Governor
GOV.targetGpuMs = 10.0;  // Total budget

// Bandwidth Governor
BW_PROFILES.balanced.totalKbps = 3000;
```

## 🧪 Development

### Build All Packages

```bash
pnpm -r build
```

### Run Tests

```bash
# (Add tests as needed)
```

### Type Checking

```bash
pnpm -r typecheck
```

## 📝 Code Structure

### Key Files

**`apps/webrtc-dual/src/main.ts`**
- Main application logic
- Rendering loop
- Governor logic
- Telemetry sampling
- UI updates

**`apps/webrtc-dual/src/loopback.ts`**
- WebRTC loopback implementation
- Sender/Receiver peer connections
- DataChannel setup

**`packages/fovea-core/src/FoveatedRenderer.ts`**
- Core foveated rendering logic
- Scene management
- Camera setup

**`packages/gaze-mediapipe/src/MediapipeGazeProvider.ts`**
- MediaPipe integration
- Eye tracking
- Calibration
- One-Euro filtering

## 🐛 Troubleshooting

### Eye Tracking Not Working

1. Check browser console for MediaPipe errors
2. Ensure webcam permissions granted
3. Try calibration (press **C**)
4. Falls back to mouse if confidence < 0.30

### WebRTC Not Connecting

1. Check browser console for WebRTC errors
2. Verify loopback initialization
3. Check sender/receiver track mapping

### Stats Not Showing

1. Check browser console for JavaScript errors
2. Verify DOM elements exist (`senderStats`, `recvStats`)
3. Check that rendering loop is running

### High GPU Usage

1. Enable GPU governor (press **G**)
2. Reduce target GPU time (press **-**)
3. Enable LOD (press **L** if off)

### High Bandwidth Usage

1. Enable bandwidth governor (press **B**)
2. Switch to mobile profile (press **1**)
3. Manually reduce cap (press **]**)
4. Check ICE budget: if `ice aob` is low, governor will hard clamp automatically

### Bandwidth Governor Not Adjusting

1. Check `rtt/loss` values in HUD (both TX and RX shown separately)
2. Verify `ice aob` is available (may be null in some browsers)
3. Check browser console for `setParameters` errors
4. Ensure governor is enabled (press **B**)
5. Check telemetry events (`bw_apply_ok`/`bw_apply_fail`) to see if caps are being applied
6. Verify connection state: caps only apply when `connectionState === "connected"` or `iceConnectionState === "connected"`
7. Check HUD: `applied` should match `target` after a few seconds (if connection is ready)

## 📚 References

- [WebRTC Specification](https://www.w3.org/TR/webrtc/)
- [MediaPipe Face Mesh](https://google.github.io/mediapipe/solutions/face_mesh)
- [One-Euro Filter](https://cristal.univ-lille.fr/~casiez/1euro/)
- [Three.js Documentation](https://threejs.org/docs/)

## 📄 License

MIT

## 🙏 Acknowledgments

- MediaPipe team for face mesh detection
- Three.js community
- WebRTC working group

---

**Built with ❤️ for high-performance foveated rendering**
