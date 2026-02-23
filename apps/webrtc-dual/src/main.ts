import * as THREE from "three";
import { createLoopback } from "./loopback";
import { MediapipeGazeProvider, type GazeSample } from "@fovea-render/gaze-mediapipe";

class GpuTimer {
  private gl: WebGL2RenderingContext | null;
  private ext: any | null;
  private q: WebGLQuery | null = null;
  private lastMs: number | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    this.gl = (gl instanceof WebGL2RenderingContext) ? gl : null;
    this.ext = this.gl ? this.gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
  }

  get supported() { return !!this.ext; }

  begin() {
    if (!this.gl || !this.ext) return;
    if (!this.q) this.q = this.gl.createQuery();
    if (!this.q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.q);
  }

  end() {
    if (!this.gl || !this.ext || !this.q) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  poll() {
    // returns latest available, or last known
    if (!this.gl || !this.ext || !this.q) return this.lastMs;
    const available = this.gl.getQueryParameter(this.q, this.gl.QUERY_RESULT_AVAILABLE);
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (!available || disjoint) return this.lastMs;
    const ns = this.gl.getQueryParameter(this.q, this.gl.QUERY_RESULT) as number;
    this.lastMs = ns / 1e6;
    return this.lastMs;
  }
}

// ---------- CONFIG (enterprise-ish defaults) ----------
const FPS = 30;

// fixed "product" render size (stable streams)
const FULL_W = 1280;
const FULL_H = 720;

// stream sizes
const LOW_SCALE = 0.42; // bandwidth saver
const LOW_W = Math.floor(FULL_W * LOW_SCALE);
const LOW_H = Math.floor(FULL_H * LOW_SCALE);

// patch is fixed-size to avoid renegotiation headaches
const PATCH_SIZE = 640; // square patch
const PATCH_W = PATCH_SIZE;
const PATCH_H = PATCH_SIZE;

// composite mask (receiver)
const BASE_FOVEA_R = 0.22;
const BASE_FEATHER = 0.08;

let FOVEA_R = BASE_FOVEA_R;
let FEATHER = BASE_FEATHER;

// Multi-draw LOD
const FAR_DENSITY = 0.25; // 25% points fuori fovea

// ---------- GOVERNOR (GPU-first) ----------
const GOV = {
  enabled: true,
  throttle: 0.0,      // 0..1
  targetGpuMs: 10.0,  // budget totale (low+patch+recv)
  emaGpuMs: 0.0
};

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

// ------------------- TELEMETRY (10Hz JSONL) -------------------
const TEL = {
  enabled: true,
  hz: 10,
  maxLines: 20000,        // ~20000/10Hz = 33 min
  lines: [] as string[],
  lastT: 0,
  seq: 0,
  // optional external metrics (if you have them)
  kbpsLow: null as number | null,  // backward compat: equals payload
  kbpsPatch: null as number | null,  // backward compat: equals payload
  kbpsLowWire: null as number | null,
  kbpsPatchWire: null as number | null,
  kbpsLowPayload: null as number | null,
  kbpsPatchPayload: null as number | null,
  kbpsLowEma: null as number | null,  // EMA of payload
  kbpsPatchEma: null as number | null,  // EMA of payload
  rttMs: null as number | null,
  lossPct: null as number | null,
  targetLowKbps: null as number | null,
  targetPatchKbps: null as number | null,
  bwProfile: "balanced" as "mobile" | "balanced" | "lan",
  bwEnabled: true,
  aobKbps: null as number | null,
  iceRttMs: null as number | null,
  lossTxPct: null as number | null,
  lossRxPct: null as number | null,
  appliedLowKbps: null as number | null,
  appliedPatchKbps: null as number | null,
  allocBiasKbps: null as number | null,
  utilLow: null as number | null,
  utilPatch: null as number | null,
  hungryPatch: null as boolean | null,
  useEye: null as boolean | null,
  gazeConf: null as number | null,
  gazeMode: null as GazeFilterMode | null
};

function telNowMs() { return performance.now(); }

function telPush(obj: any) {
  // keep JSON stable and small
  const line = JSON.stringify(obj);
  TEL.lines.push(line);
  if (TEL.lines.length > TEL.maxLines) {
    TEL.lines.splice(0, TEL.lines.length - TEL.maxLines);
  }
}

function telEvent(name: string, data: Record<string, any> = {}) {
  if (!TEL.enabled) return; // così non riempi buffer quando la telemetria è off
  telPush({
    t_ms: Math.round(performance.now()),
    event: name,
    ...data
  });
}

function makeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function downloadTextFile(fileName: string, text: string, mimeType = "text/plain") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function telDownload() {
  const stamp = makeStamp();
  downloadTextFile(`telemetry_${stamp}.jsonl`, TEL.lines.join("\n") + "\n", "application/jsonl");
}

function telClear() {
  TEL.lines.length = 0;
  TEL.seq = 0;
}

type CalibrationStats = {
  rmse: number;
  maxErr: number;
  leftRmse: number | null;
  rightRmse: number | null;
  points: number;
  tier?: "strict" | "provisional";
};

type CalibrationRunResult = {
  ok: boolean;
  aborted: boolean;
  qualityRejected: boolean;
  stats: CalibrationStats | null;
  appliedStats: CalibrationStats | null;
};

type GazeFilterMode = "fallback" | "fixation" | "saccade";

const CALIB_STORAGE_KEY = "fovea.calib.v2";
const CALIB_STATS_STORAGE_KEY = "fovea.calib.stats.v1";
const CALIB_RMSE_ACCEPT_MAX = 0.33;
const CALIB_RMSE_PROVISIONAL_MAX = 0.52;
const CALIB_AUTO_MAX_ATTEMPTS = 3;
const CALIB_STRICT_REFINEMENT_ATTEMPTS = 1;
const CALIB_SIDE_RATIO_MAX = 1.55;
const CALIB_SIDE_RMSE_MAX = 0.42;
const CALIB_SIDE_RATIO_PROVISIONAL_MAX = 1.85;
const CALIB_SIDE_RMSE_PROVISIONAL_MAX = 0.58;
const CALIB_MAXERR_PROVISIONAL_MAX = 1.10;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeCalibrationStats(raw: unknown): CalibrationStats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rmse = r.rmse;
  const maxErr = r.maxErr;
  const points = r.points;
  if (!isFiniteNum(rmse) || !isFiniteNum(maxErr) || !isFiniteNum(points)) return null;
  const leftRmse = isFiniteNum(r.leftRmse) ? r.leftRmse : null;
  const rightRmse = isFiniteNum(r.rightRmse) ? r.rightRmse : null;
  const tierRaw = r.tier;
  const tier = tierRaw === "strict" || tierRaw === "provisional" ? tierRaw : undefined;
  return {
    rmse,
    maxErr,
    leftRmse,
    rightRmse,
    points: Math.max(0, Math.round(points)),
    tier
  };
}

function loadCalibrationStatsFromStorage(): CalibrationStats | null {
  try {
    const raw = localStorage.getItem(CALIB_STATS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeCalibrationStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveCalibrationStatsToStorage(stats: CalibrationStats | null) {
  try {
    if (!stats) {
      localStorage.removeItem(CALIB_STATS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CALIB_STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage failures.
  }
}

type ReadingAnalysisSample = {
  t_ms: number;
  use_eye: boolean;
  conf: number;
  raw_x: number;
  raw_y: number;
  eye_x: number;
  eye_y: number;
  ctrl_x: number;
  ctrl_y: number;
  filt_x: number;
  filt_y: number;
  est_x: number;
  est_y: number;
  filter_mode: GazeFilterMode;
  patch_cx: number;
  patch_cy: number;
};

type ReadingAnalysisStopReason = "manual" | "timeout" | "aborted";

const ANALYSIS = {
  running: false,
  auto: false,
  autoPipeline: false,
  startedAtMs: 0,
  stopAtMs: 0,
  overlay: null as HTMLDivElement | null,
  statusEl: null as HTMLDivElement | null,
  samples: [] as ReadingAnalysisSample[],
  calibration: null as CalibrationStats | null,
  calibrationAttempted: null as CalibrationStats | null,
  lastSummary: null as Record<string, unknown> | null
};

// ------------------- BANDWIDTH GOVERNOR -------------------
type BwProfileName = "mobile" | "balanced" | "lan";

const BW_PROFILES: Record<BwProfileName, {
  totalKbps: number;
  minTotalKbps: number;
  maxTotalKbps: number;
  splitLow: number;        // portion for LOW
  floorLowKbps: number;
  floorPatchKbps: number;
}> = {
  mobile:   { totalKbps: 1200, minTotalKbps: 700,  maxTotalKbps: 2500, splitLow: 0.70, floorLowKbps: 350, floorPatchKbps: 150 },
  balanced: { totalKbps: 3000, minTotalKbps: 1200, maxTotalKbps: 6000, splitLow: 0.67, floorLowKbps: 500, floorPatchKbps: 200 },
  lan:      { totalKbps: 8000, minTotalKbps: 3000, maxTotalKbps: 12000, splitLow: 0.62, floorLowKbps: 1000, floorPatchKbps: 500 }
};

const BW = {
  enabled: true,
  profile: "balanced" as BwProfileName,

  totalCapKbps: BW_PROFILES.balanced.totalKbps,

  // computed + applied
  targetLowKbps: 0,
  targetPatchKbps: 0,
  appliedLowKbps: 0,
  appliedPatchKbps: 0,
  lastTargetLowKbps: 0,  // track previous target to detect changes
  lastTargetPatchKbps: 0,  // track previous target to detect changes
  lastApplyAttemptMs: 0,  // throttle to avoid spam on failures

  // stability timers
  stableBadMs: 0,
  stableGoodMs: 0,
  lastAdjustMs: 0,

  // last measured quality
  rttMs: null as number | null,
  lossPct: null as number | null,
  aobKbps: null as number | null,
  iceRttMs: null as number | null,

  // budget allocator
  alloc: {
    enabled: true,
    biasKbps: 0,  // positive means extra budget moved to PATCH from LOW
    lowUnderMs: 0,
    lowWellMs: 0,  // timer for LOW well utilized condition
    lowHighDemandMs: 0,  // timer for fast-release: LOW high demand
    patchHungryMs: 0,
    patchUnderMs: 0,  // separate timer for PATCH underutilized condition
    eyeWeakMs: 0,  // timer for fast-release: eye-tracking weak
    cooldownMs: 0
  }
};

function bwClamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

function bwSetProfile(name: BwProfileName) {
  BW.profile = name;
  const p = BW_PROFILES[name];
  BW.totalCapKbps = p.totalKbps;
  BW.stableBadMs = 0;
  BW.stableGoodMs = 0;
  BW.lastAdjustMs = 0;
  telEvent("profile_change", {
    profile: name,
    total_cap_kbps: BW.totalCapKbps,
    applied_low_kbps: BW.appliedLowKbps,
    applied_patch_kbps: BW.appliedPatchKbps
  });
}

// Apply bitrate caps (bps) to sender (encoding[0])
async function applyMaxBitrateKbps(sender: RTCRtpSender, kbps: number): Promise<{ ok: boolean; err?: string; readbackBps?: number | null }> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{} as any];
    const bps = Math.max(1000, Math.round(kbps * 1000));
    params.encodings[0].maxBitrate = bps;

    await sender.setParameters(params);

    // readback verification
    const rb = sender.getParameters();
    const rbBps = rb.encodings && rb.encodings[0] && typeof rb.encodings[0].maxBitrate === "number"
      ? rb.encodings[0].maxBitrate
      : null;

    return { ok: true, readbackBps: rbBps };
  } catch (e: any) {
    return { ok: false, err: String(e?.name || e) + (e?.message ? (": " + e.message) : "") };
  }
}

function computeCaps(totalKbps: number) {
  const p = BW_PROFILES[BW.profile];
  totalKbps = bwClamp(totalKbps, p.minTotalKbps, p.maxTotalKbps);

  // PATCH-first throttling: LOW gets priority continuity
  let low = Math.round(totalKbps * p.splitLow);
  let patch = totalKbps - low;

  // floors
  if (low < p.floorLowKbps) low = p.floorLowKbps;
  patch = totalKbps - low;

  if (patch < p.floorPatchKbps) {
    patch = p.floorPatchKbps;
    low = totalKbps - patch;
  }

  // if impossible to satisfy both floors (very low total), clamp patch to >=0
  if (low < p.floorLowKbps) {
    low = p.floorLowKbps;
    patch = Math.max(0, totalKbps - low);
  }

  return { totalKbps, lowKbps: Math.max(0, low), patchKbps: Math.max(0, patch) };
}

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "g") GOV.enabled = !GOV.enabled;
  if (k === "=" || k === "+") GOV.targetGpuMs = clamp(GOV.targetGpuMs + 0.5, 4, 20);
  if (k === "-" || k === "_") GOV.targetGpuMs = clamp(GOV.targetGpuMs - 0.5, 4, 20);
  if (k === "l") LOD_ON = !LOD_ON;
  if (k === "m") {
    patchMode = (patchMode + 1) % PATCH_MODE_COUNT;
    telEvent("workload_mode", { patchMode });
  }
  if (k === "c") {
    if (e.shiftKey) void calibrate3x3();
    else void runCalibrationThenReadingAnalysis();
  }
  if (k === "r") {
    if (ANALYSIS.running) stopReadingAnalysis("manual");
    else {
      const c = loadCalibrationStatsFromStorage();
      startReadingAnalysis({ durationMs: 22000, auto: false, calibration: c, calibrationAttempted: c });
    }
  }
  if (k === "a") void runCalibrationThenReadingAnalysis();
  if (k === "t") TEL.enabled = !TEL.enabled; // toggle
  if (k === "d") telDownload();
  if (k === "x") telClear();
  if (k === "b") BW.enabled = !BW.enabled;
  if (k === "1") bwSetProfile("mobile");
  if (k === "2") bwSetProfile("balanced");
  if (k === "3") bwSetProfile("lan");
  if (k === "[") BW.totalCapKbps = bwClamp(BW.totalCapKbps - 200, BW_PROFILES[BW.profile].minTotalKbps, BW_PROFILES[BW.profile].maxTotalKbps);
  if (k === "]") BW.totalCapKbps = bwClamp(BW.totalCapKbps + 200, BW_PROFILES[BW.profile].minTotalKbps, BW_PROFILES[BW.profile].maxTotalKbps);
});

// ------------------- WEBRTC BITRATE (2Hz) -------------------
type SenderBitrateState = {
  lastBytesSent: number;
  lastRtxBytesSent: number;
  lastTs: number;
  kbpsWire: number | null;
  kbpsPayload: number | null;
};

type OutboundKbpsResult = {
  wire: number | null;
  payload: number | null;
};

async function readOutboundKbps(sender: RTCRtpSender, st: SenderBitrateState): Promise<OutboundKbpsResult> {
  const report = await sender.getStats();
  let best: any = null;

  report.forEach((r: any) => {
    if (r.type === "outbound-rtp" && r.kind === "video" && !r.isRemote) {
      // Chrome sometimes gives multiple; pick the one with bytesSent
      if (typeof r.bytesSent === "number") best = r;
    }
  });

  if (!best) {
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  const bytesSent = best.bytesSent as number;
  const rtxBytesSent = (typeof best.retransmittedBytesSent === "number") ? best.retransmittedBytesSent : 0;
  const ts = best.timestamp as number; // ms

  if (st.lastTs === 0) {
    st.lastBytesSent = bytesSent;
    st.lastRtxBytesSent = rtxBytesSent;
    st.lastTs = ts;
    st.kbpsWire = 0;
    st.kbpsPayload = 0;
    return { wire: 0, payload: 0 };
  }

  const dt = (ts - st.lastTs) / 1000;
  if (dt <= 0) {
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  // Wire bytes delta (includes RTX)
  const dWireBytes = bytesSent - st.lastBytesSent;
  if (dWireBytes < 0) {
    // counter reset
    st.lastBytesSent = bytesSent;
    st.lastRtxBytesSent = rtxBytesSent;
    st.lastTs = ts;
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  // Payload bytes delta (excludes RTX)
  const lastPayloadBytes = st.lastBytesSent - st.lastRtxBytesSent;
  const currentPayloadBytes = bytesSent - rtxBytesSent;
  const dPayloadBytes = Math.max(0, currentPayloadBytes - lastPayloadBytes); // clamp >= 0

  st.lastBytesSent = bytesSent;
  st.lastRtxBytesSent = rtxBytesSent;
  st.lastTs = ts;

  const kbpsWire = (dWireBytes * 8) / (dt * 1000);
  const kbpsPayload = (dPayloadBytes * 8) / (dt * 1000);

  st.kbpsWire = kbpsWire;
  st.kbpsPayload = kbpsPayload;

  return { wire: kbpsWire, payload: kbpsPayload };
}

type RemoteQualityState = {
  lastLost: number;
  lastRecv: number;
  lastTs: number;
  rttMs: number | null;
  lossPct: number | null;
};

async function readRemoteQuality(sender: RTCRtpSender, st: RemoteQualityState) {
  const report = await sender.getStats();

  let rttMs: number | null = null;
  let lost: number | null = null;
  let recv: number | null = null;
  let ts: number | null = null;

  report.forEach((r: any) => {
    if (r.type === "remote-inbound-rtp" && r.kind === "video") {
      // roundTripTime is usually seconds (spec), convert to ms
      if (typeof r.roundTripTime === "number") rttMs = Math.round(r.roundTripTime * 1000);
      if (typeof r.packetsLost === "number") lost = r.packetsLost;
      if (typeof r.packetsReceived === "number") recv = r.packetsReceived;
      if (typeof r.timestamp === "number") ts = r.timestamp;
    }
  });

  // update RTT (smoothed lightly)
  if (rttMs != null) st.rttMs = st.rttMs == null ? rttMs : Math.round(0.7 * st.rttMs + 0.3 * rttMs);

  // compute loss% from deltas if possible
  if (lost != null && recv != null && ts != null) {
    if (st.lastTs === 0) {
      st.lastLost = lost; st.lastRecv = recv; st.lastTs = ts;
    } else {
      const dLost = lost - st.lastLost;
      const dRecv = recv - st.lastRecv;
      st.lastLost = lost; st.lastRecv = recv; st.lastTs = ts;

      const denom = dLost + dRecv;
      if (denom > 50) { // avoid noise
        const pct = (dLost / denom) * 100;
        st.lossPct = st.lossPct == null ? pct : (0.75 * st.lossPct + 0.25 * pct);
      }
    }
  }

  return { rttMs: st.rttMs, lossPct: st.lossPct };
}

type RxStreamLoss = {
  lastLost: number;
  lastRecv: number;
  lastTs: number;
  lossPct: number | null;
};

type RxLossState = Map<string, RxStreamLoss>;  // key by ssrc or id

async function readReceiverLossWorst(pcRecv: RTCPeerConnection, st: RxLossState): Promise<number | null> {
  try {
    const report = await pcRecv.getStats();
    let worst: number | null = null;

    report.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "video" && !r.isRemote) {
        const ssrc = (typeof r.ssrc === "number") ? String(r.ssrc) : (r.id || "unknown");
        const lost = (typeof r.packetsLost === "number") ? r.packetsLost : null;
        const recv = (typeof r.packetsReceived === "number") ? r.packetsReceived : null;
        const ts = (typeof r.timestamp === "number") ? r.timestamp : null;
        if (lost == null || recv == null || ts == null) return;

        let entry = st.get(ssrc);
        if (!entry) {
          entry = { lastLost: 0, lastRecv: 0, lastTs: 0, lossPct: null };
          st.set(ssrc, entry);
        }

        if (entry.lastTs === 0) {
          entry.lastLost = lost;
          entry.lastRecv = recv;
          entry.lastTs = ts;
          entry.lossPct = 0;
        } else {
          const dLost = lost - entry.lastLost;
          const dRecv = recv - entry.lastRecv;
          entry.lastLost = lost;
          entry.lastRecv = recv;
          entry.lastTs = ts;

          const denom = dLost + dRecv;
          if (denom > 50 && dLost >= 0 && dRecv >= 0) {
            const pct = (dLost / denom) * 100;
            entry.lossPct = entry.lossPct == null ? pct : (0.75 * entry.lossPct + 0.25 * pct);
          }
        }

        if (entry.lossPct != null) {
          worst = (worst == null) ? entry.lossPct : Math.max(worst, entry.lossPct);
        }
      }
    });

    return worst == null ? null : +worst.toFixed(3);
  } catch {
    return null;
  }
}

async function readIceBudget(pc: RTCPeerConnection) {
  try {
    const stats = await pc.getStats();

    let selectedId: string | null = null;
    stats.forEach((r: any) => {
      if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") {
        selectedId = r.selectedCandidatePairId;
      }
    });

    let pair: any = null;

    // If we have selectedId, try direct get (Map-like)
    if (selectedId && (stats as any).get) {
      pair = (stats as any).get(selectedId);
    }

    // Fallback: find nominated/selected succeeded pair
    if (!pair) {
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.state === "succeeded") {
          if (r.nominated === true || r.selected === true) pair = r;
        }
      });
    }

    if (!pair) return { aobKbps: null as number | null, iceRttMs: null as number | null };

    const aobBps = (typeof pair.availableOutgoingBitrate === "number") ? pair.availableOutgoingBitrate : null;
    const rttSec = (typeof pair.currentRoundTripTime === "number") ? pair.currentRoundTripTime : null;

    return {
      aobKbps: aobBps == null ? null : Math.round(aobBps / 1000),
      iceRttMs: rttSec == null ? null : Math.round(rttSec * 1000)
    };
  } catch {
    return { aobKbps: null as number | null, iceRttMs: null as number | null };
  }
}

function startBitratePoller(opts: {
  lowSender: RTCRtpSender;
  patchSender: RTCRtpSender;
  pcSend?: RTCPeerConnection;
  pcRecv?: RTCPeerConnection;
  intervalMs?: number;
}) {
  const intervalMs = opts.intervalMs ?? 500; // 2Hz

  const stLow: SenderBitrateState = {
    lastBytesSent: 0,
    lastRtxBytesSent: 0,
    lastTs: 0,
    kbpsWire: null,
    kbpsPayload: null
  };
  const stPatch: SenderBitrateState = {
    lastBytesSent: 0,
    lastRtxBytesSent: 0,
    lastTs: 0,
    kbpsWire: null,
    kbpsPayload: null
  };

  const qLow: RemoteQualityState = { lastLost: 0, lastRecv: 0, lastTs: 0, rttMs: null, lossPct: null };
  const qPatch: RemoteQualityState = { lastLost: 0, lastRecv: 0, lastTs: 0, rttMs: null, lossPct: null };

  const rxState: RxLossState = new Map();

  let lossRxSeen = false;
  
  // EMA state for kbps smoothing (alpha ~0.2 for 500ms tick = ~2-3s time constant)
  let kbpsLowEma: number | null = null;
  let kbpsPatchEma: number | null = null;
  const kbpsAlpha = 0.2;

  let running = true;
  let inFlight = false;

  const id = window.setInterval(async () => {
    if (!running || inFlight) return;
    inFlight = true;

    try {
      const [kLow, kPatch] = await Promise.all([
        readOutboundKbps(opts.lowSender, stLow),
        readOutboundKbps(opts.patchSender, stPatch)
      ]);

      // Wire (includes RTX)
      TEL.kbpsLowWire = kLow.wire;
      TEL.kbpsPatchWire = kPatch.wire;

      // Payload (excludes RTX) - this is the "clean" metric
      TEL.kbpsLowPayload = kLow.payload;
      TEL.kbpsPatchPayload = kPatch.payload;

      // Backward compatibility: set kbps_low/kbps_patch to payload
      TEL.kbpsLow = kLow.payload;
      TEL.kbpsPatch = kPatch.payload;
      
      // Update EMA for smoothed display (using payload, not wire)
      if (kLow.payload != null) {
        kbpsLowEma = kbpsLowEma == null ? kLow.payload : kbpsLowEma + kbpsAlpha * (kLow.payload - kbpsLowEma);
        TEL.kbpsLowEma = kbpsLowEma;
      }
      if (kPatch.payload != null) {
        kbpsPatchEma = kbpsPatchEma == null ? kPatch.payload : kbpsPatchEma + kbpsAlpha * (kPatch.payload - kbpsPatchEma);
        TEL.kbpsPatchEma = kbpsPatchEma;
      }

      // quality (RTT/loss) from remote-inbound-rtp (take worst case)
      const [qqL, qqP] = await Promise.all([
        readRemoteQuality(opts.lowSender, qLow),
        readRemoteQuality(opts.patchSender, qPatch)
      ]);

      const rtt = Math.max(qqL.rttMs ?? 0, qqP.rttMs ?? 0) || null;
      const lossTx = Math.max(qqL.lossPct ?? 0, qqP.lossPct ?? 0) || null;

      // RX loss from receiver (most reliable) - per-stream worst-case
      let lossRx: number | null = null;
      if (opts.pcRecv) {
        lossRx = await readReceiverLossWorst(opts.pcRecv, rxState);
      }
      TEL.lossRxPct = lossRx;
      TEL.lossTxPct = lossTx;

      // Calculate worst-case loss
      const lossWorst =
        (lossTx == null && lossRx == null) ? null :
        Math.max(lossTx ?? 0, lossRx ?? 0);

      BW.rttMs = rtt;
      BW.lossPct = lossWorst;

      TEL.rttMs = rtt;
      TEL.lossPct = lossWorst;

      // Event marker quando lossRx diventa attivo
      if (!lossRxSeen && lossRx != null) {
        lossRxSeen = true;
        telEvent("loss_rx_active", { loss_rx_pct: lossRx });
      }

      // Read ICE budget (if available)
      let aobKbps: number | null = null;
      let iceRttMs: number | null = null;

      if (opts.pcSend) {
        const b = await readIceBudget(opts.pcSend);
        aobKbps = b.aobKbps;
        iceRttMs = b.iceRttMs;
      }

      BW.aobKbps = aobKbps;
      BW.iceRttMs = iceRttMs;

      TEL.aobKbps = aobKbps;
      TEL.iceRttMs = iceRttMs;

      // --- bandwidth governor ---
      const now = performance.now();
      const p = BW_PROFILES[BW.profile];

      TEL.bwProfile = BW.profile;
      TEL.bwEnabled = BW.enabled;

      // Hard clamp to transport budget (keep some headroom)
      if (BW.enabled && aobKbps != null && aobKbps > 0) {
        const hardCap = bwClamp(Math.round(aobKbps * 0.88), p.minTotalKbps, p.maxTotalKbps);

        // clamp only if meaningfully lower (avoid spam)
        if (hardCap < BW.totalCapKbps && (BW.totalCapKbps - hardCap) >= Math.max(150, BW.totalCapKbps * 0.10)) {
          const from = BW.totalCapKbps;
          BW.totalCapKbps = hardCap;
          telEvent("bw_budget_clamp", {
            from_kbps: from,
            to_kbps: hardCap,
            applied_low_kbps: BW.appliedLowKbps,
            applied_patch_kbps: BW.appliedPatchKbps,
            aob_kbps: aobKbps,
            ice_rtt_ms: iceRttMs
          });
        }
      }

      if (BW.enabled && (rtt != null || lossWorst != null)) {
        const bad = (lossWorst != null && lossWorst > 2.0) || (rtt != null && rtt > 180);
        const good = (lossWorst != null && lossWorst < 0.5) && (rtt != null && rtt < 120);

        if (bad) { BW.stableBadMs += intervalMs; BW.stableGoodMs = 0; }
        else if (good) { BW.stableGoodMs += intervalMs; BW.stableBadMs = 0; }
        else { BW.stableGoodMs = 0; BW.stableBadMs = 0; }

        const cooldownMs = 1500;

        if (BW.stableBadMs >= 2000 && (now - BW.lastAdjustMs) >= cooldownMs) {
          const from = BW.totalCapKbps;
          BW.totalCapKbps = bwClamp(Math.round(BW.totalCapKbps * 0.85), p.minTotalKbps, p.maxTotalKbps);
          BW.lastAdjustMs = now;
          BW.stableBadMs = 0;
          telEvent("bw_down", {
            from_kbps: from,
            to_kbps: BW.totalCapKbps,
            applied_low_kbps: BW.appliedLowKbps,
            applied_patch_kbps: BW.appliedPatchKbps,
            rtt_ms: rtt,
            loss_tx_pct: lossTx,
            loss_rx_pct: lossRx,
            loss_pct: lossWorst,
            aob_kbps: aobKbps,
            ice_rtt_ms: iceRttMs
          });
        }

        if (BW.stableGoodMs >= 5000 && (now - BW.lastAdjustMs) >= cooldownMs) {
          const from = BW.totalCapKbps;
          BW.totalCapKbps = bwClamp(Math.round(BW.totalCapKbps * 1.05), p.minTotalKbps, p.maxTotalKbps);
          BW.lastAdjustMs = now;
          BW.stableGoodMs = 0;
          telEvent("bw_up", {
            from_kbps: from,
            to_kbps: BW.totalCapKbps,
            applied_low_kbps: BW.appliedLowKbps,
            applied_patch_kbps: BW.appliedPatchKbps,
            rtt_ms: rtt,
            loss_tx_pct: lossTx,
            loss_rx_pct: lossRx,
            loss_pct: lossWorst,
            aob_kbps: aobKbps,
            ice_rtt_ms: iceRttMs
          });
        }
      }

      const caps = computeCaps(BW.totalCapKbps);
      BW.totalCapKbps = caps.totalKbps;

      // ---------- BUDGET ALLOCATOR ----------
      // Reallocate budget from LOW to PATCH based on utilization
      let finalLowKbps = caps.lowKbps;
      let finalPatchKbps = caps.patchKbps;

      if (BW.enabled && BW.alloc.enabled && 
          (lossWorst == null || lossWorst < 1.0) && 
          (rtt == null || rtt < 160)) {
        
        const p = BW_PROFILES[BW.profile];
        
        // Calculate utilization (use applied if available, otherwise target)
        const appliedLow = BW.appliedLowKbps || caps.lowKbps;
        const appliedPatch = BW.appliedPatchKbps || caps.patchKbps;
        const utilLow = (TEL.kbpsLowEma != null && appliedLow > 0) ? TEL.kbpsLowEma / appliedLow : null;
        const utilPatch = (TEL.kbpsPatchEma != null && appliedPatch > 0) ? TEL.kbpsPatchEma / appliedPatch : null;

        TEL.utilLow = utilLow;
        TEL.utilPatch = utilPatch;

        // Define hunger signal: PATCH is hungry if utilPatch > 0.70 for >= 2000ms
        const hungryPatch = (utilPatch != null && utilPatch > 0.70);
        TEL.hungryPatch = hungryPatch;

        // Update timers based on conditions
        BW.alloc.cooldownMs = Math.max(0, BW.alloc.cooldownMs - intervalMs);

        // Increment lowUnderMs if LOW is underutilized
        if (utilLow != null && utilLow < 0.35) {
          BW.alloc.lowUnderMs += intervalMs;
        } else {
          BW.alloc.lowUnderMs = 0;
        }

        // Increment lowWellMs if LOW is well utilized
        if (utilLow != null && utilLow > 0.75) {
          BW.alloc.lowWellMs += intervalMs;
        } else {
          BW.alloc.lowWellMs = 0;
        }

        // Increment lowHighDemandMs for fast-release: LOW high demand
        if (utilLow != null && utilLow > 0.60) {
          BW.alloc.lowHighDemandMs += intervalMs;
        } else {
          BW.alloc.lowHighDemandMs = 0;
        }

        // Increment patchHungryMs if PATCH is hungry (utilPatch > 0.70)
        if (hungryPatch) {
          BW.alloc.patchHungryMs += intervalMs;
        } else {
          BW.alloc.patchHungryMs = 0;
        }

        // Increment patchUnderMs if PATCH is underutilized
        if (utilPatch != null && utilPatch < 0.50) {
          BW.alloc.patchUnderMs += intervalMs;
        } else {
          BW.alloc.patchUnderMs = 0;
        }

        // Increment eyeWeakMs for fast-release: eye-tracking weak
        const useEye = TEL.useEye === true;
        const gazeConf = TEL.gazeConf ?? 0;
        if (!useEye || gazeConf < 0.45) {
          BW.alloc.eyeWeakMs += intervalMs;
        } else {
          BW.alloc.eyeWeakMs = 0;
        }

        // Adjust bias if conditions met and cooldown expired
        if (BW.alloc.cooldownMs === 0) {
          let biasChanged = false;
          let biasBlocked = false;
          const oldBias = BW.alloc.biasKbps;
          const maxBias = Math.max(0, caps.lowKbps - p.floorLowKbps);
          // Safety: keep LOW at least 25% of total cap
          const minLowKbps = caps.totalKbps * 0.25;
          const safeMaxBias = Math.max(0, caps.lowKbps - Math.max(p.floorLowKbps, minLowKbps));
          const effectiveMaxBias = Math.min(maxBias, safeMaxBias);

          // FAST RELEASE: HIGH PRIORITY
          // If LOW demand suddenly rises, release bias quickly
          if (BW.alloc.lowHighDemandMs >= 500) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 400);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }
          // If eye-tracking is weak, PATCH is less valuable
          else if (BW.alloc.eyeWeakMs >= 1000) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }
          // INCREASE bias: ONLY if LOW underutilized AND PATCH hungry
          else if (BW.alloc.lowUnderMs >= 3000 && BW.alloc.patchHungryMs >= 2000) {
            BW.alloc.biasKbps = Math.min(effectiveMaxBias, BW.alloc.biasKbps + 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }
          // BLOCKED: LOW underutilized but PATCH not hungry
          else if (BW.alloc.lowUnderMs >= 3000 && !hungryPatch) {
            biasBlocked = true;
            telEvent("bw_rebalance_blocked", {
              util_low: utilLow,
              util_patch: utilPatch,
              hungry_patch: hungryPatch,
              bias_kbps: BW.alloc.biasKbps
            });
          }
          // Decrease bias: LOW well utilized OR PATCH underutilized
          else if (BW.alloc.lowWellMs >= 3000) {
            // LOW is well utilized for long enough, give budget back
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }
          else if (BW.alloc.patchUnderMs >= 5000) {
            // PATCH is underutilized for long enough, give budget back to LOW
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }

          // Clamp bias with safety guard
          BW.alloc.biasKbps = Math.max(0, Math.min(effectiveMaxBias, BW.alloc.biasKbps));

          // Apply bias to caps
          finalLowKbps = caps.lowKbps - BW.alloc.biasKbps;
          finalPatchKbps = caps.patchKbps + BW.alloc.biasKbps;

          // Enforce floors
          if (finalLowKbps < p.floorLowKbps) {
            finalLowKbps = p.floorLowKbps;
            finalPatchKbps = caps.totalKbps - finalLowKbps;
            BW.alloc.biasKbps = caps.lowKbps - finalLowKbps;  // adjust bias to match
          }
          if (finalPatchKbps < p.floorPatchKbps) {
            finalPatchKbps = p.floorPatchKbps;
            finalLowKbps = caps.totalKbps - finalPatchKbps;
            BW.alloc.biasKbps = caps.lowKbps - finalLowKbps;  // adjust bias to match
          }

          // Emit event if bias changed
          if (biasChanged && BW.alloc.biasKbps !== oldBias) {
            telEvent("bw_rebalance", {
              bias_kbps: BW.alloc.biasKbps,
              util_low: utilLow,
              util_patch: utilPatch,
              base_low: caps.lowKbps,
              base_patch: caps.patchKbps,
              new_low: finalLowKbps,
              new_patch: finalPatchKbps
            });
          }
        } else {
          // Apply existing bias even during cooldown
          finalLowKbps = caps.lowKbps - BW.alloc.biasKbps;
          finalPatchKbps = caps.patchKbps + BW.alloc.biasKbps;

          // Enforce floors
          if (finalLowKbps < p.floorLowKbps) {
            finalLowKbps = p.floorLowKbps;
            finalPatchKbps = caps.totalKbps - finalLowKbps;
          }
          if (finalPatchKbps < p.floorPatchKbps) {
            finalPatchKbps = p.floorPatchKbps;
            finalLowKbps = caps.totalKbps - finalPatchKbps;
          }
        }
      }

      BW.targetLowKbps = finalLowKbps;
      BW.targetPatchKbps = finalPatchKbps;

      TEL.targetLowKbps = BW.targetLowKbps;
      TEL.targetPatchKbps = BW.targetPatchKbps;
      TEL.allocBiasKbps = BW.alloc.biasKbps;

      // Detect if target caps changed (force apply regardless of threshold)
      const targetChanged = 
        (BW.targetLowKbps !== BW.lastTargetLowKbps) || 
        (BW.targetPatchKbps !== BW.lastTargetPatchKbps);

      // Apply caps IMMEDIATELY in same tick when connection is ready
      const ready = !opts.pcSend || opts.pcSend.connectionState === "connected" || opts.pcSend.iceConnectionState === "connected";
      const throttleMs = 200;  // minimal throttle to avoid spam on failures
      const canApply = (now - BW.lastApplyAttemptMs) >= throttleMs;

      if (BW.enabled && ready && canApply) {
        // LOW lane: force apply if target changed, otherwise check if applied differs
        const needsLow = targetChanged || !BW.appliedLowKbps || BW.targetLowKbps !== BW.appliedLowKbps;
        if (needsLow) {
          BW.lastApplyAttemptMs = now;
          const res = await applyMaxBitrateKbps(opts.lowSender, BW.targetLowKbps);
          if (res.ok) {
            const expectedBps = Math.round(BW.targetLowKbps * 1000);
            BW.appliedLowKbps = BW.targetLowKbps;  // Update immediately on success
            if (res.readbackBps != null && Math.abs(res.readbackBps - expectedBps) > expectedBps * 0.15) {
              telEvent("bw_apply_mismatch", {
                lane: "low",
                target_kbps: BW.targetLowKbps,
                applied_kbps: BW.appliedLowKbps,
                readback_bps: res.readbackBps
              });
            } else {
              telEvent("bw_apply_ok", {
                lane: "low",
                target_kbps: BW.targetLowKbps,
                applied_kbps: BW.appliedLowKbps,
                readback_bps: res.readbackBps ?? null
              });
            }
          } else {
            telEvent("bw_apply_fail", {
              lane: "low",
              target_kbps: BW.targetLowKbps,
              applied_kbps: BW.appliedLowKbps,
              err: res.err,
              pcState: {
                cs: opts.pcSend?.connectionState,
                ice: opts.pcSend?.iceConnectionState
              }
            });
            // do not update applied -> retry next tick
          }
        }

        // PATCH lane: force apply if target changed, otherwise check if applied differs
        const needsPatch = targetChanged || !BW.appliedPatchKbps || BW.targetPatchKbps !== BW.appliedPatchKbps;
        if (needsPatch) {
          BW.lastApplyAttemptMs = now;
          const res = await applyMaxBitrateKbps(opts.patchSender, BW.targetPatchKbps);
          if (res.ok) {
            const expectedBps = Math.round(BW.targetPatchKbps * 1000);
            BW.appliedPatchKbps = BW.targetPatchKbps;  // Update immediately on success
            if (res.readbackBps != null && Math.abs(res.readbackBps - expectedBps) > expectedBps * 0.15) {
              telEvent("bw_apply_mismatch", {
                lane: "patch",
                target_kbps: BW.targetPatchKbps,
                applied_kbps: BW.appliedPatchKbps,
                readback_bps: res.readbackBps
              });
            } else {
              telEvent("bw_apply_ok", {
                lane: "patch",
                target_kbps: BW.targetPatchKbps,
                applied_kbps: BW.appliedPatchKbps,
                readback_bps: res.readbackBps ?? null
              });
            }
          } else {
            telEvent("bw_apply_fail", {
              lane: "patch",
              target_kbps: BW.targetPatchKbps,
              applied_kbps: BW.appliedPatchKbps,
              err: res.err,
              pcState: {
                cs: opts.pcSend?.connectionState,
                ice: opts.pcSend?.iceConnectionState
              }
            });
            // do not update applied -> retry next tick
          }
        }
      }

      // Update lastTarget* after application attempt (for next tick comparison)
      BW.lastTargetLowKbps = BW.targetLowKbps;
      BW.lastTargetPatchKbps = BW.targetPatchKbps;

      // Update TEL.applied* AFTER application attempt (so telemetry reflects current applied state)
      TEL.appliedLowKbps = BW.appliedLowKbps;
      TEL.appliedPatchKbps = BW.appliedPatchKbps;

    } catch {
      // ignore
    } finally {
      inFlight = false;
    }
  }, intervalMs);

  const stop = () => {
    running = false;
    window.clearInterval(id);
  };

  window.addEventListener("beforeunload", stop);
  return { stop };
}

// ---------- DOM ----------
const cLow = document.getElementById("cLow") as HTMLCanvasElement;
const cPatch = document.getElementById("cPatch") as HTMLCanvasElement;
const cOut = document.getElementById("cOut") as HTMLCanvasElement;

const senderStats = document.getElementById("senderStats");
const recvStats = document.getElementById("recvStats");

const vLow = document.getElementById("vLow") as HTMLVideoElement;
const vPatch = document.getElementById("vPatch") as HTMLVideoElement;

if (!cLow || !cPatch || !cOut || !senderStats || !recvStats || !vLow || !vPatch) {
  throw new Error("Missing required DOM elements");
}

// size canvases
cLow.width = LOW_W; cLow.height = LOW_H;
cPatch.width = PATCH_W; cPatch.height = PATCH_H;
cOut.width = FULL_W; cOut.height = FULL_H;

console.log("Canvases initialized:", {
  low: { w: LOW_W, h: LOW_H },
  patch: { w: PATCH_W, h: PATCH_H },
  out: { w: FULL_W, h: FULL_H }
});

// show canvases at friendly size
cLow.style.width = "420px"; cLow.style.height = "236px";
cPatch.style.width = "640px"; cPatch.style.height = "640px"; // Larger patch stream for visibility
cOut.style.width = "640px"; cOut.style.height = "360px"; // Smaller receiver

// ---------- GAZE (eye tracking + mouse fallback) ----------
const gazeNDC = new THREE.Vector2(0, 0);
const gazeEstNDC = new THREE.Vector2(0, 0);
const gazeVelNDC = new THREE.Vector2(0, 0);
let gazeEstInit = false;
let gazeEstLastMs = 0;
let gazeFilterMode: GazeFilterMode = "fallback";
let gazeFilterModeSinceMs = 0;
const mouseNDC = new THREE.Vector2(0, 0);
let LOD_ON = true;

// Confidence hysteresis + graceful eye->mouse fallback.
let eyeLock = false;
let eyeEverLocked = false;
let eyeLostAtMs = -1;
const ENTER_CONF = 0.40;
const EXIT_CONF = 0.18;
const EYE_HOLD_MS = 900;
const MOUSE_FOLLOW_FAST = 0.55;
const MOUSE_FOLLOW_SLOW = 0.10;

// Adaptive gaze estimator (measurement -> estimate) before patch controller.
const EST_DEADZONE_X = 0.018;
const EST_DEADZONE_Y = 0.016;
const EST_POS_GAIN_FIX = 0.19;
const EST_POS_GAIN_SAC = 0.56;
const EST_VEL_GAIN_FIX = 0.060;
const EST_VEL_GAIN_SAC = 0.16;
const EST_MAX_STEP_FIX_X = 0.022;
const EST_MAX_STEP_FIX_Y = 0.020;
const EST_MAX_STEP_SAC_X = 0.120;
const EST_MAX_STEP_SAC_Y = 0.100;
const EST_MAX_VEL_X = 2.8;
const EST_MAX_VEL_Y = 2.4;
const EST_VEL_DAMP_FIX = 0.76;
const EST_VEL_DAMP_SAC = 0.84;
const EST_SACCADE_ENTER_SPEED = 1.85;
const EST_SACCADE_EXIT_SPEED = 0.75;
const EST_MODE_HOLD_MS = 62;
const EST_RIGHT_DAMP = 0.90;

// Additional control smoothing dedicated to patch positioning/zoom window.
const gazeFocusNDC = new THREE.Vector2(0, 0);
let gazeFocusInit = false;
const FOCUS_DEADZONE = 0.015;
const FOCUS_DEADZONE_X = 0.017;
const FOCUS_DEADZONE_Y = 0.015;
const FOCUS_SLOW = 0.20;
const FOCUS_FAST = 0.33;
const FOCUS_SUPER_FAST = 0.56;
const FOCUS_MED_DIST = 0.10;
const FOCUS_BIG_DIST = 0.24;
const FOCUS_MAX_STEP = 0.040;
const FOCUS_MAX_STEP_X = 0.033;
const FOCUS_MAX_STEP_Y = 0.035;
const FOCUS_MOUSE_FOLLOW = 0.42;
const PATCH_SENSITIVITY_X = 0.88;
const PATCH_SENSITIVITY_Y = 0.80;
const PATCH_EDGE_SNAP_PX = 3;
const PATCH_DEADBAND_X_PX = 2;
const PATCH_DEADBAND_Y_PX = 1;
const PATCH_QUANT_X_PX = 2;
const PATCH_QUANT_Y_PX = 1;
const PATCH_EDGE_LOCK_X_PX = 6;
const PATCH_EDGE_RELEASE_X_PX = 14;
const PATCH_EDGE_LOCK_Y_PX = 0;
const PATCH_EDGE_RELEASE_Y_PX = 0;
let patchRectAppliedInit = false;
let patchRectAppliedX = 0;
let patchRectAppliedY = 0;

function setGazeFilterMode(next: GazeFilterMode, tMs: number) {
  if (gazeFilterMode === next) return;
  gazeFilterMode = next;
  gazeFilterModeSinceMs = tMs;
}

function updateGazeEstimate(target: THREE.Vector2, useEye: boolean, conf = 0, tMs = performance.now()) {
  if (!gazeEstInit) {
    gazeEstInit = true;
    gazeEstLastMs = tMs;
    gazeEstNDC.copy(target);
    gazeVelNDC.set(0, 0);
    gazeFilterMode = useEye ? "fixation" : "fallback";
    gazeFilterModeSinceMs = tMs;
    return;
  }

  const dt = clamp((tMs - gazeEstLastMs) / 1000, 1 / 240, 0.080);
  gazeEstLastMs = tMs;

  if (!useEye) {
    setGazeFilterMode("fallback", tMs);
    gazeEstNDC.lerp(target, FOCUS_MOUSE_FOLLOW);
    gazeVelNDC.multiplyScalar(0.70);
    return;
  }

  const predX = gazeEstNDC.x + gazeVelNDC.x * dt;
  const predY = gazeEstNDC.y + gazeVelNDC.y * dt;
  let errX = target.x - predX;
  let errY = target.y - predY;

  const innovationSpeed = Math.hypot(errX, errY) / Math.max(dt, 1e-4);
  const modeAgeMs = tMs - gazeFilterModeSinceMs;

  if (gazeFilterMode !== "saccade" && innovationSpeed >= EST_SACCADE_ENTER_SPEED && modeAgeMs >= EST_MODE_HOLD_MS) {
    setGazeFilterMode("saccade", tMs);
  } else if (gazeFilterMode === "saccade" && innovationSpeed <= EST_SACCADE_EXIT_SPEED && modeAgeMs >= EST_MODE_HOLD_MS) {
    setGazeFilterMode("fixation", tMs);
  } else if (gazeFilterMode === "fallback") {
    setGazeFilterMode("fixation", tMs);
  }

  const isSaccade = gazeFilterMode === "saccade";
  const confBoost = clamp((conf - 0.35) / 0.55, 0, 1);

  if (!isSaccade) {
    const dzX = lerp(EST_DEADZONE_X, EST_DEADZONE_X * 0.6, confBoost);
    const dzY = lerp(EST_DEADZONE_Y, EST_DEADZONE_Y * 0.6, confBoost);
    if (Math.abs(errX) < dzX) errX = 0;
    if (Math.abs(errY) < dzY) errY = 0;
  }

  const rightDamp = (target.x > 0 || predX > 0) ? EST_RIGHT_DAMP : 1.0;
  const posGain = isSaccade ? EST_POS_GAIN_SAC : EST_POS_GAIN_FIX;
  const velGain = isSaccade ? EST_VEL_GAIN_SAC : EST_VEL_GAIN_FIX;
  const gainBoost = lerp(0.95, 1.20, confBoost);

  const maxStepX = (isSaccade ? EST_MAX_STEP_SAC_X : EST_MAX_STEP_FIX_X) * rightDamp;
  const maxStepY = isSaccade ? EST_MAX_STEP_SAC_Y : EST_MAX_STEP_FIX_Y;

  const stepX = clamp(errX * posGain * gainBoost, -maxStepX, maxStepX);
  const stepY = clamp(errY * posGain * gainBoost, -maxStepY, maxStepY);

  gazeEstNDC.set(
    clamp(predX + stepX, -1, 1),
    clamp(predY + stepY, -1, 1)
  );

  const velTargetX = clamp((stepX / dt) * velGain, -EST_MAX_VEL_X, EST_MAX_VEL_X);
  const velTargetY = clamp((stepY / dt) * velGain, -EST_MAX_VEL_Y, EST_MAX_VEL_Y);
  const velDamp = isSaccade ? EST_VEL_DAMP_SAC : EST_VEL_DAMP_FIX;
  gazeVelNDC.set(
    clamp(gazeVelNDC.x * velDamp + velTargetX, -EST_MAX_VEL_X, EST_MAX_VEL_X),
    clamp(gazeVelNDC.y * velDamp + velTargetY, -EST_MAX_VEL_Y, EST_MAX_VEL_Y)
  );
}

function updatePatchFocus(target: THREE.Vector2, useEye: boolean, conf = 0, mode: GazeFilterMode = "fallback") {
  if (!gazeFocusInit) {
    gazeFocusInit = true;
    gazeFocusNDC.copy(target);
    return;
  }

  if (!useEye) {
    // Mouse fallback should stay responsive.
    gazeFocusNDC.lerp(target, FOCUS_MOUSE_FOLLOW);
    return;
  }

  const leadSec = mode === "saccade" ? 0.060 : 0.034;
  const tx = clamp(target.x + gazeVelNDC.x * leadSec, -1, 1);
  const ty = clamp(target.y + gazeVelNDC.y * leadSec, -1, 1);
  const dx = tx - gazeFocusNDC.x;
  const dy = ty - gazeFocusNDC.y;
  const confBoost = clamp((conf - 0.45) / 0.45, 0, 1);
  const dzX = lerp(FOCUS_DEADZONE_X, FOCUS_DEADZONE_X * 0.65, confBoost);
  const dzY = lerp(FOCUS_DEADZONE_Y, FOCUS_DEADZONE_Y * 0.65, confBoost);
  const effDx = Math.abs(dx) < dzX ? 0 : dx;
  const effDy = Math.abs(dy) < dzY ? 0 : dy;
  if (effDx === 0 && effDy === 0) return;

  const dist = Math.sqrt(effDx * effDx + effDy * effDy);
  if (dist < FOCUS_DEADZONE) return;

  let follow = FOCUS_SLOW;
  if (dist > FOCUS_BIG_DIST) follow = FOCUS_SUPER_FAST;
  else if (dist > FOCUS_MED_DIST) follow = FOCUS_FAST;
  if (mode === "fixation") follow *= 0.96;
  else if (mode === "saccade") follow *= 1.30;
  follow *= lerp(1.0, 1.25, confBoost);

  const modeStepScale = mode === "saccade" ? 1.32 : (mode === "fixation" ? 0.98 : 1.0);
  const maxStep = dist > 0.35 ? (FOCUS_MAX_STEP * 1.35 * modeStepScale) : (FOCUS_MAX_STEP * modeStepScale);
  const maxStepGain = lerp(1.0, 1.22, confBoost);
  const maxStepX = Math.min(maxStep * maxStepGain, FOCUS_MAX_STEP_X * 1.25);
  const maxStepY = Math.min(maxStep * maxStepGain, FOCUS_MAX_STEP_Y * 1.25);
  const stepX = clamp(effDx * follow, -maxStepX, maxStepX);
  const stepY = clamp(effDy * follow, -maxStepY, maxStepY);

  gazeFocusNDC.set(
    clamp(gazeFocusNDC.x + stepX, -1, 1),
    clamp(gazeFocusNDC.y + stepY, -1, 1)
  );
}

// ---------- WORKLOAD ENCODER STATE ----------
const PATCH_MODE_COUNT = 5;
const PATCH_MODE_LABELS = ["minimal", "text-scroll", "checker", "noise", "reading-zoom"];
let patchMode = 4; // default to reading demo
const ROI_SCALE = 0.78; // Bigger focus box for easier visual validation
const ROI_W = Math.floor(PATCH_W * ROI_SCALE);
const ROI_H = Math.floor(PATCH_H * ROI_SCALE);

const READING_SUPERSAMPLE = 2;
const readingCanvas = document.createElement("canvas");
readingCanvas.width = PATCH_W * READING_SUPERSAMPLE;
readingCanvas.height = PATCH_H * READING_SUPERSAMPLE;
const readingCtx = readingCanvas.getContext("2d", { alpha: false });
if (!readingCtx) throw new Error("Failed to create reading demo canvas");

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(" ");
  let line = "";
  let yy = y;

  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      yy += lineHeight;
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) {
    ctx.fillText(line, x, yy);
    yy += lineHeight;
  }
  return yy;
}

function drawReadingDemoPage(ctx: CanvasRenderingContext2D, _tSec: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, readingCanvas.width, readingCanvas.height);
  ctx.setTransform(READING_SUPERSAMPLE, 0, 0, READING_SUPERSAMPLE, 0, 0);

  ctx.fillStyle = "#f6f2e8";
  ctx.fillRect(0, 0, PATCH_W, PATCH_H);

  ctx.fillStyle = "#1d1d1d";
  ctx.font = "bold 30px Georgia, serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Foveated Reading Demo", 28, 18);

  ctx.fillStyle = "#4a4a4a";
  ctx.font = "17px Georgia, serif";
  ctx.fillText("Leggi il testo: il riquadro zoom deve seguire il tuo sguardo.", 28, 58);

  const paragraphs = [
    "La resa foveata mostra piu dettaglio nella zona osservata e riduce il costo nella periferia.",
    "Quando il tracking e calibrato bene, il testo resta nitido vicino al punto in cui stai guardando.",
    "Se noti jitter o salti, ripeti la calibrazione in luce uniforme e mantieni la testa piu stabile.",
    "Sposta lo sguardo tra sinistra, centro e destra: il riquadro dovrebbe seguire in modo fluido."
  ];

  ctx.fillStyle = "#292929";
  ctx.font = "22px Georgia, serif";
  let y = 118;
  for (const p of paragraphs) {
    y = drawWrappedText(ctx, p, 34, y, PATCH_W - 68, 30) + 10;
  }

  const markerY = 474;
  ctx.fillStyle = "rgba(255, 188, 88, 0.24)";
  ctx.fillRect(28, markerY, PATCH_W - 56, 38);
  ctx.strokeStyle = "rgba(200, 120, 30, 0.72)";
  ctx.lineWidth = 1.7;
  ctx.strokeRect(28, markerY, PATCH_W - 56, 38);

  ctx.fillStyle = "#373737";
  ctx.font = "19px Georgia, serif";
  ctx.fillText("Riga guida: prova a fissare questa frase per 2 secondi.", 36, markerY + 8);

  // Page frame
  ctx.strokeStyle = "rgba(0,0,0,0.24)";
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 12, PATCH_W - 32, PATCH_H - 24);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function ensureAnalysisOverlay() {
  if (ANALYSIS.overlay && ANALYSIS.statusEl) return;
  const o = document.createElement("div");
  o.style.position = "fixed";
  o.style.left = "14px";
  o.style.bottom = "14px";
  o.style.maxWidth = "560px";
  o.style.padding = "10px 12px";
  o.style.background = "rgba(8,12,18,0.72)";
  o.style.border = "1px solid rgba(150, 205, 255, 0.45)";
  o.style.borderRadius = "8px";
  o.style.color = "#d7ebff";
  o.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
  o.style.fontSize = "12px";
  o.style.lineHeight = "1.4";
  o.style.zIndex = "9998";
  o.style.pointerEvents = "none";
  o.style.display = "none";
  o.innerHTML = `
    <div><b>Reading Analysis</b> (auto-record)</div>
    <div id="analysis-status" style="margin-top:4px;opacity:0.95;">Idle</div>
  `;
  document.body.appendChild(o);
  ANALYSIS.overlay = o;
  ANALYSIS.statusEl = o.querySelector("#analysis-status") as HTMLDivElement;
}

function setAnalysisStatus(msg: string, visible = true) {
  ensureAnalysisOverlay();
  if (ANALYSIS.statusEl) ANALYSIS.statusEl.textContent = msg;
  if (ANALYSIS.overlay) ANALYSIS.overlay.style.display = visible ? "block" : "none";
}

function hideAnalysisStatus(delayMs = 0) {
  ensureAnalysisOverlay();
  if (delayMs <= 0) {
    if (!ANALYSIS.running && ANALYSIS.overlay) ANALYSIS.overlay.style.display = "none";
    return;
  }
  window.setTimeout(() => {
    if (!ANALYSIS.running && ANALYSIS.overlay) ANALYSIS.overlay.style.display = "none";
  }, delayMs);
}

function percentile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[idx];
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function rmsStep(
  samples: ReadingAnalysisSample[],
  include: (_prev: ReadingAnalysisSample, _cur: ReadingAnalysisSample) => boolean
) {
  let se = 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!include(prev, cur)) continue;
    const dx = cur.filt_x - prev.filt_x;
    const dy = cur.filt_y - prev.filt_y;
    se += dx * dx + dy * dy;
    n++;
  }
  return n > 0 ? Math.sqrt(se / n) : 0;
}

function countEyeDropouts(samples: ReadingAnalysisSample[]) {
  let cnt = 0;
  let inDrop = false;
  for (const s of samples) {
    if (!s.use_eye) {
      if (!inDrop) {
        cnt++;
        inDrop = true;
      }
    } else {
      inDrop = false;
    }
  }
  return cnt;
}

function gazeToPatchCenterNorm(gazeX: number, gazeY: number) {
  const gx = clamp(gazeX * PATCH_SENSITIVITY_X, -1, 1);
  const gy = clamp(gazeY * PATCH_SENSITIVITY_Y, -1, 1);
  const minCx = (PATCH_W * 0.5) / FULL_W;
  const maxCx = 1 - minCx;
  const minCy = (PATCH_H * 0.5) / FULL_H;
  const maxCy = 1 - minCy;
  const cx = clamp(gx * 0.5 + 0.5, minCx, maxCx);
  const cy = clamp((-gy) * 0.5 + 0.5, minCy, maxCy);
  return { cx, cy };
}

function buildReadingAnalysisSummary(
  reason: ReadingAnalysisStopReason,
  samples: ReadingAnalysisSample[],
  durationMs: number,
  calibration: CalibrationStats | null,
  calibrationAttempted: CalibrationStats | null
) {
  const confVals = samples.map((s) => s.conf);
  const eyeSamples = samples.filter((s) => s.use_eye);
  const eyeConfVals = eyeSamples.map((s) => s.conf);
  const eyeUsageRatio = samples.length > 0 ? eyeSamples.length / samples.length : 0;
  const jitterAll = rmsStep(samples, () => true);
  const jitterLeft = rmsStep(samples, (_p, c) => c.filt_x < 0);
  const jitterRight = rmsStep(samples, (_p, c) => c.filt_x >= 0);
  const rightLeftRatio = jitterLeft > 1e-6 ? (jitterRight / jitterLeft) : null;
  const ctrlVsFilt = mean(samples.map((s) => Math.hypot(s.ctrl_x - s.filt_x, s.ctrl_y - s.filt_y)));
  const estVsFilt = mean(samples.map((s) => Math.hypot(s.est_x - s.filt_x, s.est_y - s.filt_y)));
  const patchTrackErrRaw = mean(samples.map((s) => {
    const nx = (s.filt_x + 1) * 0.5;
    const ny = (-s.filt_y + 1) * 0.5;
    return Math.hypot(nx - s.patch_cx, ny - s.patch_cy);
  }));
  const patchTrackErr = mean(samples.map((s) => {
    const expected = gazeToPatchCenterNorm(s.filt_x, s.filt_y);
    return Math.hypot(expected.cx - s.patch_cx, expected.cy - s.patch_cy);
  }));
  const dropouts = countEyeDropouts(samples);

  const notes: string[] = [];
  if (eyeUsageRatio < 0.70) notes.push("Eye lock debole: troppi fallback o perdita confidenza.");
  if (rightLeftRatio != null && rightLeftRatio > 1.20) notes.push("Instabilita maggiore a destra rispetto a sinistra.");
  if (estVsFilt > 0.038) notes.push("Filtro troppo conservativo: si percepisce ritardo durante i movimenti.");
  if (patchTrackErr > 0.040) notes.push("Lag/mismatch visibile tra gaze filtrato e centro patch.");
  if (percentile(confVals, 0.10) < 0.25) notes.push("Confidenza spesso bassa: migliorare luce e posizione camera.");
  if (!calibration) notes.push("Calibrazione attiva non disponibile nel report: run considerato diagnostico.");
  if (calibration?.tier === "provisional") notes.push("Calibrazione provvisoria in uso: ripetere calibrazione per una baseline piu robusta.");
  if (calibration && calibration.rmse > CALIB_RMSE_ACCEPT_MAX) notes.push("Calibrazione in uso debole: ripetere calibrazione prima del tuning fine.");
  if (notes.length === 0) notes.push("Sessione abbastanza stabile; resta da rifinire tuning fine.");

  return {
    version: 1,
    created_at_iso: new Date().toISOString(),
    reason,
    duration_ms: Math.round(durationMs),
    samples: samples.length,
    calibration,
    calibration_attempted: calibrationAttempted,
    metrics: {
      eye_usage_ratio: +eyeUsageRatio.toFixed(4),
      conf_mean: +mean(confVals).toFixed(4),
      conf_p10: +percentile(confVals, 0.10).toFixed(4),
      conf_p90: +percentile(confVals, 0.90).toFixed(4),
      conf_mean_when_eye: +mean(eyeConfVals).toFixed(4),
      jitter_rms_step_all: +jitterAll.toFixed(6),
      jitter_rms_step_left: +jitterLeft.toFixed(6),
      jitter_rms_step_right: +jitterRight.toFixed(6),
      jitter_right_left_ratio: rightLeftRatio == null ? null : +rightLeftRatio.toFixed(4),
      ctrl_vs_filt_mean_dist: +ctrlVsFilt.toFixed(6),
      est_vs_filt_mean_dist: +estVsFilt.toFixed(6),
      patch_track_error_mean: +patchTrackErr.toFixed(6),
      patch_track_error_raw_mean: +patchTrackErrRaw.toFixed(6),
      eye_dropouts: dropouts
    },
    notes
  };
}

function startReadingAnalysis(opts: {
  durationMs?: number;
  auto: boolean;
  calibration: CalibrationStats | null;
  calibrationAttempted?: CalibrationStats | null;
}) {
  if (ANALYSIS.running) return false;
  const durationMs = opts.durationMs ?? 22000;
  ANALYSIS.running = true;
  ANALYSIS.auto = opts.auto;
  ANALYSIS.startedAtMs = performance.now();
  ANALYSIS.stopAtMs = ANALYSIS.startedAtMs + durationMs;
  ANALYSIS.samples.length = 0;
  ANALYSIS.calibration = opts.calibration;
  ANALYSIS.calibrationAttempted = opts.calibrationAttempted ?? opts.calibration;
  patchMode = 4;
  setAnalysisStatus(
    `Analisi ${opts.auto ? "AUTO" : "MANUALE"} in corso: leggi il testo nel riquadro (${Math.ceil(durationMs / 1000)}s).`,
    true
  );
  telEvent("reading_analysis_start", { auto: opts.auto, duration_ms: durationMs });
  return true;
}

function stopReadingAnalysis(reason: ReadingAnalysisStopReason) {
  if (!ANALYSIS.running) return;
  ANALYSIS.running = false;
  const endedAtMs = performance.now();
  const durationMs = Math.max(0, endedAtMs - ANALYSIS.startedAtMs);
  const summary = buildReadingAnalysisSummary(
    reason,
    ANALYSIS.samples,
    durationMs,
    ANALYSIS.calibration,
    ANALYSIS.calibrationAttempted
  );
  ANALYSIS.lastSummary = summary as Record<string, unknown>;

  const stamp = makeStamp();
  const rawJsonl = ANALYSIS.samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
  const summaryJson = JSON.stringify(summary, null, 2) + "\n";
  downloadTextFile(`reading_analysis_raw_${stamp}.jsonl`, rawJsonl, "application/jsonl");
  downloadTextFile(`reading_analysis_summary_${stamp}.json`, summaryJson, "application/json");
  try {
    localStorage.setItem("fovea.readingAnalysis.lastSummary", summaryJson);
  } catch {
    // Ignore storage failures (quota/private mode) and keep downloaded files as source of truth.
  }

  const ratio = summary.metrics.jitter_right_left_ratio;
  setAnalysisStatus(
    `Analisi salvata (${summary.samples} campioni). jitterR/L=${ratio == null ? "n/a" : ratio.toFixed(2)} conf=${summary.metrics.conf_mean.toFixed(2)}`,
    true
  );
  hideAnalysisStatus(3500);
  telEvent("reading_analysis_done", {
    reason,
    samples: summary.samples,
    eye_usage_ratio: summary.metrics.eye_usage_ratio,
    conf_mean: summary.metrics.conf_mean,
    jitter_right_left_ratio: summary.metrics.jitter_right_left_ratio
  });
}

function captureReadingAnalysisSample(
  tMs: number,
  gf: ReturnType<MediapipeGazeProvider["getFrame"]>,
  useEye: boolean,
  gazeCtrl: THREE.Vector2,
  gazeFilt: THREE.Vector2,
  gazeEst: THREE.Vector2,
  filterMode: GazeFilterMode
) {
  if (!ANALYSIS.running) return;
  const patchCx = patchRectN.x + patchRectN.z * 0.5;
  const patchCy = patchRectN.y + patchRectN.w * 0.5;
  ANALYSIS.samples.push({
    t_ms: Math.round(tMs),
    use_eye: useEye,
    conf: +gf.conf.toFixed(6),
    raw_x: +gf.rawX.toFixed(6),
    raw_y: +gf.rawY.toFixed(6),
    eye_x: +gf.gazeX.toFixed(6),
    eye_y: +gf.gazeY.toFixed(6),
    ctrl_x: +gazeCtrl.x.toFixed(6),
    ctrl_y: +gazeCtrl.y.toFixed(6),
    filt_x: +gazeFilt.x.toFixed(6),
    filt_y: +gazeFilt.y.toFixed(6),
    est_x: +gazeEst.x.toFixed(6),
    est_y: +gazeEst.y.toFixed(6),
    filter_mode: filterMode,
    patch_cx: +patchCx.toFixed(6),
    patch_cy: +patchCy.toFixed(6)
  });

  const nowMs = performance.now();
  const remainMs = Math.max(0, ANALYSIS.stopAtMs - nowMs);
  setAnalysisStatus(
    `Analisi ${ANALYSIS.auto ? "AUTO" : "MANUALE"}: ${Math.ceil(remainMs / 1000)}s | conf ${gf.conf.toFixed(2)} | samples ${ANALYSIS.samples.length}`,
    true
  );
  if (nowMs >= ANALYSIS.stopAtMs || tMs >= ANALYSIS.stopAtMs) stopReadingAnalysis("timeout");
}

async function runCalibrationThenReadingAnalysis() {
  if (ANALYSIS.autoPipeline || ANALYSIS.running || calibrating) return;
  ANALYSIS.autoPipeline = true;
  setAnalysisStatus("Routine auto: calibrazione in corso...", true);
  try {
    let cal: CalibrationRunResult | null = null;
    for (let attempt = 1; attempt <= CALIB_AUTO_MAX_ATTEMPTS; attempt++) {
      setAnalysisStatus(`Routine auto: calibrazione in corso (${attempt}/${CALIB_AUTO_MAX_ATTEMPTS})...`, true);
      cal = await calibrate3x3();
      if (cal.ok || cal.aborted) break;
      if (cal.qualityRejected && attempt < CALIB_AUTO_MAX_ATTEMPTS) {
        const rmseTxt = cal.stats ? cal.stats.rmse.toFixed(3) : "n/a";
        setAnalysisStatus(
          `Calibrazione scartata (RMSE ${rmseTxt} > ${CALIB_RMSE_ACCEPT_MAX.toFixed(2)}), nuovo tentativo...`,
          true
        );
        await new Promise((r) => setTimeout(r, 420));
        continue;
      }
      break;
    }

    if (!cal || cal.aborted) {
      setAnalysisStatus("Routine auto annullata: calibrazione interrotta.", true);
      hideAnalysisStatus(2400);
      return;
    }

    let finalCal = cal;
    if (cal.ok && cal.appliedStats?.tier === "provisional") {
      for (let refine = 1; refine <= CALIB_STRICT_REFINEMENT_ATTEMPTS; refine++) {
        const pRmse = cal.appliedStats.rmse.toFixed(3);
        setAnalysisStatus(
          `Calibrazione provvisoria (RMSE ${pRmse}); tentativo affinamento strict (${refine}/${CALIB_STRICT_REFINEMENT_ATTEMPTS})...`,
          true
        );
        const refined = await calibrate3x3();
        if (refined.aborted) {
          setAnalysisStatus("Routine auto annullata: affinamento calibrazione interrotto.", true);
          hideAnalysisStatus(2400);
          return;
        }
        if (refined.ok && refined.appliedStats?.tier === "strict") {
          finalCal = refined;
          setAnalysisStatus(
            `Calibrazione strict ottenuta (RMSE ${refined.appliedStats.rmse.toFixed(3)}), avvio analisi...`,
            true
          );
          await new Promise((r) => setTimeout(r, 320));
          break;
        }
        const activeTxt = refined.appliedStats ? refined.appliedStats.rmse.toFixed(3) : "n/a";
        setAnalysisStatus(
          `Affinamento non strict (calibrazione attiva RMSE ${activeTxt}), continuo con provvisoria...`,
          true
        );
        await new Promise((r) => setTimeout(r, 320));
      }
    }

    if (!finalCal.ok && finalCal.qualityRejected) {
      // Continue analysis with previous calibration so reports are always generated.
      const rmseTxt = finalCal.stats ? finalCal.stats.rmse.toFixed(3) : "n/a";
      const activeTxt = finalCal.appliedStats ? finalCal.appliedStats.rmse.toFixed(3) : "n/a";
      setAnalysisStatus(
        `Calibrazione nuova scartata (RMSE ${rmseTxt}); avvio analisi con calibrazione attiva (RMSE ${activeTxt})...`,
        true
      );
      await new Promise((r) => setTimeout(r, 420));
      startReadingAnalysis({
        durationMs: 22000,
        auto: true,
        calibration: finalCal.appliedStats,
        calibrationAttempted: finalCal.stats
      });
      return;
    }

    if (!finalCal.ok) {
      // Still run analysis to capture diagnostics when calibration cannot complete.
      setAnalysisStatus("Calibrazione non valida; avvio analisi diagnostica comunque...", true);
      await new Promise((r) => setTimeout(r, 420));
      startReadingAnalysis({
        durationMs: 22000,
        auto: true,
        calibration: finalCal.appliedStats,
        calibrationAttempted: finalCal.stats
      });
      return;
    }

    startReadingAnalysis({
      durationMs: 22000,
      auto: true,
      calibration: finalCal.appliedStats,
      calibrationAttempted: finalCal.stats
    });
  } finally {
    ANALYSIS.autoPipeline = false;
  }
}

// ---------- META BINARY ENCODER/DECODER ----------
const META_VER = 2;
let metaSeq = 0;

function encodeMetaBinary(gaze: THREE.Vector2, rect: THREE.Vector4, conf: number, foveaR: number, feather: number) {
  // 40 bytes: u8 type, u8 ver, u16 seq, 9x f32
  // type=1 meta
  const buf = new ArrayBuffer(40);
  const dv = new DataView(buf);
  dv.setUint8(0, 1);
  dv.setUint8(1, META_VER);
  dv.setUint16(2, (metaSeq++ & 0xffff), true);

  let o = 4;
  dv.setFloat32(o, gaze.x, true); o += 4;
  dv.setFloat32(o, gaze.y, true); o += 4;

  dv.setFloat32(o, rect.x, true); o += 4;
  dv.setFloat32(o, rect.y, true); o += 4;
  dv.setFloat32(o, rect.z, true); o += 4;
  dv.setFloat32(o, rect.w, true); o += 4;

  dv.setFloat32(o, conf, true); o += 4;
  dv.setFloat32(o, foveaR, true); o += 4;
  dv.setFloat32(o, feather, true); o += 4;

  return buf;
}

function tryDecodeMetaBinary(data: any) {
  if (!(data instanceof ArrayBuffer)) return null;

  // v1 = 32 bytes, v2 = 40 bytes
  if (data.byteLength !== 32 && data.byteLength !== 40) return null;

  const dv = new DataView(data);
  const type = dv.getUint8(0);
  const ver = dv.getUint8(1);
  if (type !== 1) return null;

  let o = 4;
  const gx = dv.getFloat32(o, true); o += 4;
  const gy = dv.getFloat32(o, true); o += 4;

  const rx = dv.getFloat32(o, true); o += 4;
  const ry = dv.getFloat32(o, true); o += 4;
  const rw = dv.getFloat32(o, true); o += 4;
  const rh = dv.getFloat32(o, true); o += 4;

  const conf = dv.getFloat32(o, true); o += 4;

  let foveaR = BASE_FOVEA_R;
  let feather = BASE_FEATHER;

  if (ver === 2 && data.byteLength === 40) {
    foveaR = dv.getFloat32(o, true); o += 4;
    feather = dv.getFloat32(o, true); o += 4;
  } else if (ver !== 1 && ver !== 2) {
    return null;
  }

  return {
    gaze: new THREE.Vector2(gx, gy),
    rect: new THREE.Vector4(rx, ry, rw, rh),
    conf,
    foveaR,
    feather
  };
}

window.addEventListener("mousemove", (e) => {
  // map within receiver composite area when possible
  const rect = cOut.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const nx = x * 2 - 1;
  const ny = -(y * 2 - 1);
  mouseNDC.set(
    THREE.MathUtils.clamp(nx, -1, 1),
    THREE.MathUtils.clamp(ny, -1, 1)
  );
});

// ---------- SCENE (fill-rate heavy points additive) ----------
function makeScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.02);

  const camera = new THREE.PerspectiveCamera(75, FULL_W / FULL_H, 0.1, 1000);
  camera.position.z = 30;

  const N = 120000; // stress
  const pos = new Float32Array(N * 3);
  const rand = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const p = 2, q = 3;
    const radius = 8 + (Math.random() - 0.5) * 3;
    const r = radius * (2 + Math.sin(q * u));

    pos[i * 3 + 0] = r * Math.cos(p * u) + (Math.random() - 0.5) * 1.5;
    pos[i * 3 + 1] = r * Math.sin(p * u) + (Math.random() - 0.5) * 1.5;
    pos[i * 3 + 2] = radius * Math.cos(q * u) + (Math.random() - 0.5) * 1.5;

    rand[i] = Math.random();
  }

  // Build FAR subset deterministically
  let farCount = 0;
  for (let i = 0; i < N; i++) if (rand[i] < FAR_DENSITY) farCount++;

  const posFar = new Float32Array(farCount * 3);
  const randFar = new Float32Array(farCount);

  for (let i = 0, j = 0; i < N; i++) {
    if (rand[i] >= FAR_DENSITY) continue;
    posFar[j * 3 + 0] = pos[i * 3 + 0];
    posFar[j * 3 + 1] = pos[i * 3 + 1];
    posFar[j * 3 + 2] = pos[i * 3 + 2];
    randFar[j] = rand[i];
    j++;
  }

  const geoNear = new THREE.BufferGeometry();
  geoNear.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geoNear.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));

  const geoFar = new THREE.BufferGeometry();
  geoFar.setAttribute("position", new THREE.BufferAttribute(posFar, 3));
  geoFar.setAttribute("aRand", new THREE.BufferAttribute(randFar, 1));

  const VERT = `
    uniform float uTime;
    uniform vec2  uGaze;
    uniform float uAspect;

    uniform float uNearR;
    uniform float uFeather;
    uniform float uLayer;       // 0 = NEAR, 1 = FAR

    uniform float uAlpha;
    uniform float uSize;
    uniform float uKeepProb;    // extra far throttling (optional)

    attribute float aRand;

    varying float vAlpha;
    varying vec3  vColor;

    void main() {
      vec4 mv   = modelViewMatrix * vec4(position, 1.0);
      vec4 clip = projectionMatrix * mv;
      vec2 ndc  = clip.xy / clip.w;

      // aspect-correct distance
      vec2 d = ndc - uGaze;
      d.x *= uAspect;
      float dist = length(d);

      // inside fovea = 1, outside = 0
      float inside = 1.0 - smoothstep(uNearR, uNearR + uFeather, dist);

      // layer mask: NEAR draws only inside, FAR draws only outside
      float mask = mix(inside, 1.0 - inside, uLayer);

      // optional extra throttle for FAR only (uKeepProb < 1)
      float keep = mix(1.0, step(aRand, uKeepProb), uLayer);

      gl_PointSize = (uSize * keep) * (30.0 / -mv.z);

      vAlpha = uAlpha * mask * keep;

      // color: near bright, far dim
      vColor = mix(vec3(0.0, 1.0, 1.0), vec3(0.02, 0.08, 0.12), uLayer);

      gl_Position = clip;
    }
  `;

  const FRAG = `
    precision highp float;
    varying float vAlpha;
    varying vec3  vColor;

    void main() {
      if (vAlpha < 0.01) discard;

      vec2 c = gl_PointCoord - vec2(0.5);
      float dist = length(c);
      if (dist > 0.5) discard;

      float glow = 1.0 - (dist * 2.0);
      glow = pow(glow, 1.5);

      gl_FragColor = vec4(vColor, vAlpha * glow);
    }
  `;

  function makeMat(layer: 0 | 1) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uGaze: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: FULL_W / FULL_H },
        uNearR: { value: FOVEA_R },
        uFeather: { value: FEATHER },
        uLayer: { value: layer },

        uAlpha: { value: layer === 0 ? 0.95 : 0.14 },
        uSize: { value: layer === 0 ? 2.4 : 0.65 },
        uKeepProb: { value: 1.0 } // FAR-only (you can drop it later)
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
  }

  const matNear = makeMat(0);
  const matFar  = makeMat(1);

  const pointsFar = new THREE.Points(geoFar, matFar);
  const pointsNear = new THREE.Points(geoNear, matNear);

  scene.add(pointsFar);
  scene.add(pointsNear);

  function update(t: number) {
    pointsFar.rotation.y = pointsNear.rotation.y = t * 0.00012;
    pointsFar.rotation.z = pointsNear.rotation.z = t * 0.00007;
  }

  return { scene, camera, update, matNear, matFar, pointsNear, pointsFar, farCount, N };
}

const { scene, camera, update, matNear, matFar, pointsFar, farCount, N } = makeScene();

console.log("Scene created:", { farCount, N, totalPoints: N });

// Add LARGE visual corner markers for testing (visible in 3D scene)
// These are HUGE so they're visible even in the small LOW stream
const markerGeometry = new THREE.SphereGeometry(0.8, 32, 32); // Much bigger!
const testMarkers = [
  { color: 0xff0000, position: [-5, 4, 2], name: "TOP-LEFT" },      // Red - closer to camera
  { color: 0x00ff00, position: [5, 4, 2], name: "TOP-RIGHT" },      // Green
  { color: 0x0000ff, position: [-5, -4, 2], name: "BOTTOM-LEFT" },  // Blue
  { color: 0xffff00, position: [5, -4, 2], name: "BOTTOM-RIGHT" }   // Yellow
];

testMarkers.forEach(m => {
  // Main sphere
  const material = new THREE.MeshBasicMaterial({
    color: m.color,
    transparent: false,
    depthTest: true
  });
  const marker = new THREE.Mesh(markerGeometry, material);
  marker.position.set(m.position[0], m.position[1], m.position[2]);
  marker.name = m.name;
  scene.add(marker);

  // Add a glowing ring around it for better visibility
  const ringGeometry = new THREE.RingGeometry(0.9, 1.1, 32);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: m.color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.position.set(m.position[0], m.position[1], m.position[2]);
  ring.lookAt(0, 0, 10); // Face the camera
  scene.add(ring);
});

// ---------- SENDER RENDERERS ----------
const rLow = new THREE.WebGLRenderer({ canvas: cLow, antialias: true, alpha: false, powerPreference: "high-performance" });
rLow.setSize(LOW_W, LOW_H, false);
rLow.setPixelRatio(1);

// PATCH: Use 2D canvas for workload encoder (replaces WebGL)
const ctxPatch = cPatch.getContext("2d", { alpha: false })!;
if (!ctxPatch) throw new Error("Failed to get 2D context for cPatch");

const tLow = new GpuTimer(rLow);
// Note: tPatch not used for 2D canvas (no GPU timing available)

// ---------- GAZE PROVIDER (MediaPipe) ----------
const gaze = new MediapipeGazeProvider({ mirrorX: false, smoothAlpha: 0.20 });
gaze.loadCalibrationFromStorage(); // se c'è, parte già calibrato
gaze.start().catch(err => {
  console.warn("Gaze provider failed, using mouse only:", err);
});

// ---------- CALIBRATION OVERLAY ----------
function makeOverlay() {
  const o = document.createElement("div");
  o.style.position = "fixed";
  o.style.inset = "0";
  o.style.background = "rgba(0,0,0,0.75)";
  o.style.zIndex = "9999";
  o.style.display = "none";
  o.style.pointerEvents = "auto";
  o.style.color = "#0ff";
  o.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
  o.style.fontSize = "13px";
  o.innerHTML = `
    <div style="position:absolute;top:14px;left:14px;max-width:520px;line-height:1.35;">
      <b>Calibration</b> (5x5 precision mode)<br>
      Keep your gaze on the dot. Keep your head stable.<br>
      Press <b>ESC</b> to abort. It will auto-save when done.
    </div>
    <div id="cal-status" style="position:absolute;top:84px;left:14px;color:#9ff;opacity:0.95;">Preparing…</div>
    <div id="cal-dot" style="position:absolute;width:14px;height:14px;border-radius:50%;
      background:#0ff; box-shadow:0 0 18px rgba(0,255,255,0.55); transform:translate(-50%,-50%);"></div>
  `;
  document.body.appendChild(o);
  const dot = o.querySelector("#cal-dot") as HTMLDivElement;
  const status = o.querySelector("#cal-status") as HTMLDivElement;
  return { overlay: o, dot, status };
}

const { overlay: calOverlay, dot: calDot, status: calStatus } = makeOverlay();
let calibrating = false;

async function calibrate3x3(): Promise<CalibrationRunResult> {
  if (calibrating) {
    return {
      ok: false,
      aborted: false,
      qualityRejected: false,
      stats: null,
      appliedStats: loadCalibrationStatsFromStorage()
    };
  }
  calibrating = true;
  calOverlay.style.display = "block";
  calStatus.textContent = "Calibration started…";
  const prevCalibStorage = localStorage.getItem(CALIB_STORAGE_KEY);
  const prevCalibStats = prevCalibStorage != null ? loadCalibrationStatsFromStorage() : null;
  let result: CalibrationRunResult = {
    ok: false,
    aborted: false,
    qualityRejected: false,
    stats: null,
    appliedStats: prevCalibStats
  };

  function robustMean(values: number[]) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * 0.2);
    const core = (sorted.length - trim * 2) >= 6
      ? sorted.slice(trim, sorted.length - trim)
      : sorted;
    return core.reduce((s, v) => s + v, 0) / core.length;
  }

  function robustStd(values: number[]) {
    if (values.length < 2) return 0;
    const m = robustMean(values);
    let acc = 0;
    for (const v of values) {
      const d = v - m;
      acc += d * d;
    }
    return Math.sqrt(acc / values.length);
  }

  function projectCalibration(
    m: {
      ax: number; bx: number; cx: number;
      ay: number; by: number; cy: number;
      pxy?: number; pxx?: number; pyy?: number;
      qxy?: number; qxx?: number; qyy?: number;
    },
    rx: number,
    ry: number
  ) {
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const rxy = rx * ry;
    const px = m.ax + m.bx * rx + m.cx * ry + (m.pxy ?? 0) * rxy + (m.pxx ?? 0) * rx2 + (m.pyy ?? 0) * ry2;
    const py = m.ay + m.by * rx + m.cy * ry + (m.qxy ?? 0) * rxy + (m.qxx ?? 0) * rx2 + (m.qyy ?? 0) * ry2;
    return { x: px, y: py };
  }

  function evalCalibration(
    samples: { rx: number; ry: number; x: number; y: number }[],
    m: {
      ax: number; bx: number; cx: number;
      ay: number; by: number; cy: number;
      pxy?: number; pxx?: number; pyy?: number;
      qxy?: number; qxx?: number; qyy?: number;
    }
  ) {
    let se = 0;
    let maxErr = 0;
    let seLeft = 0;
    let seRight = 0;
    let nLeft = 0;
    let nRight = 0;
    for (const s of samples) {
      const pr = projectCalibration(m, s.rx, s.ry);
      const px = pr.x;
      const py = pr.y;
      const dx = px - s.x;
      const dy = py - s.y;
      const err = Math.sqrt(dx * dx + dy * dy);
      se += err * err;
      maxErr = Math.max(maxErr, err);
      if (s.x < 0) { seLeft += err * err; nLeft++; }
      else { seRight += err * err; nRight++; }
    }
    const rmse = samples.length > 0 ? Math.sqrt(se / samples.length) : Infinity;
    const leftRmse = nLeft > 0 ? Math.sqrt(seLeft / nLeft) : null;
    const rightRmse = nRight > 0 ? Math.sqrt(seRight / nRight) : null;
    return { rmse, maxErr, leftRmse, rightRmse };
  }

  const waitMs = 420;
  const maxFrames = 110;
  const minGoodFrames = 28;
  const goodConf = 0.34;
  const stableStdTarget = 0.020;
  const stableStdRelaxed = 0.028;

  const grid = [-0.82, -0.41, 0.0, 0.41, 0.82];
  const targets: { x: number; y: number }[] = [];
  for (let yi = 0; yi < grid.length; yi++) {
    const ys = grid[yi];
    const xs = (yi % 2 === 0) ? grid : [...grid].reverse();
    for (const x of xs) targets.push({ x, y: ys });
  }

  const samples: { rx: number; ry: number; x: number; y: number; w: number }[] = [];

  const abort = { v: false };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") abort.v = true; };
  window.addEventListener("keydown", onKey);

  try {
    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx];
      if (abort.v) break;

      calStatus.textContent = `Point ${idx + 1}/${targets.length} — keep gaze steady`;

      // place dot in screen space from NDC (viewport)
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = ((t.x + 1) * 0.5) * vw;
      const sy = ((-t.y + 1) * 0.5) * vh;
      calDot.style.left = `${sx}px`;
      calDot.style.top = `${sy}px`;

      // settle
      await new Promise(r => setTimeout(r, waitMs));

      // collect frames (use unmirrored raw for calibration) with retry on unstable point
      let captured = false;
      for (let attempt = 1; attempt <= 2 && !captured && !abort.v; attempt++) {
        const acc: GazeSample[] = [];
        for (let i = 0; i < maxFrames; i++) {
          if (abort.v) break;
          const f = gaze.getFrame();
          const rawUnmirrored = gaze.getRawUnmirrored();
          acc.push({ rawX: rawUnmirrored.rawX, rawY: rawUnmirrored.rawY, t: performance.now(), conf: f.conf });

          if ((i % 6) === 0) {
            const goodNow = acc.filter(s => s.conf >= goodConf);
            if (goodNow.length >= minGoodFrames) {
              const sxNow = robustStd(goodNow.map(s => s.rawX));
              const syNow = robustStd(goodNow.map(s => s.rawY));
              if (sxNow <= stableStdTarget && syNow <= stableStdTarget) break;
            }
          }
          await new Promise(r => requestAnimationFrame(() => r(null)));
        }

        const good = acc.filter(s => s.conf >= goodConf);
        const fallback = acc.filter(s => s.conf >= 0.24);
        const use = good.length >= minGoodFrames ? good : fallback;
        if (use.length < 12) {
          calStatus.textContent = `Point ${idx + 1}/${targets.length} low confidence, retry ${attempt}/2`;
          await new Promise(r => setTimeout(r, 220));
          continue;
        }

        const rx = robustMean(use.map(s => s.rawX));
        const ry = robustMean(use.map(s => s.rawY));
        const meanConf = robustMean(use.map(s => s.conf));
        const sxUse = robustStd(use.map(s => s.rawX));
        const syUse = robustStd(use.map(s => s.rawY));
        const stable = Math.max(sxUse, syUse) <= stableStdRelaxed || meanConf >= 0.65;

        if (!stable && attempt < 2) {
          calStatus.textContent = `Point ${idx + 1}/${targets.length} unstable (${Math.max(sxUse, syUse).toFixed(3)}), retry`;
          await new Promise(r => setTimeout(r, 220));
          continue;
        }

        const weight = clamp(meanConf * meanConf + 0.15, 0.10, 2.50);
        samples.push({ rx, ry, x: t.x, y: t.y, w: weight });
        calStatus.textContent = `Point ${idx + 1}/${targets.length} captured (conf ${meanConf.toFixed(2)}, std ${Math.max(sxUse, syUse).toFixed(3)})`;
        captured = true;
      }
    }

    if (abort.v) {
      calStatus.textContent = "Calibration aborted.";
      result = { ok: false, aborted: true, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
      await new Promise(r => setTimeout(r, 350));
    } else if (samples.length >= 18) {
      let m = gaze.fitAndSetCalibration(samples);
      if (m) {
        const first = evalCalibration(samples, m);
        const thr = Math.max(0.18, first.rmse * 1.9);
        const inliers = samples.filter((s) => {
          const p = projectCalibration(m!, s.rx, s.ry);
          const px = p.x;
          const py = p.y;
          const dx = px - s.x;
          const dy = py - s.y;
          return Math.sqrt(dx * dx + dy * dy) <= thr;
        });
        if (inliers.length >= Math.max(14, Math.floor(samples.length * 0.65))) {
          const refined = gaze.fitAndSetCalibration(inliers);
          if (refined) m = refined;
        }

        const stats = evalCalibration(samples, m);
        const calStatsBase: CalibrationStats = {
          rmse: stats.rmse,
          maxErr: stats.maxErr,
          leftRmse: stats.leftRmse,
          rightRmse: stats.rightRmse,
          points: samples.length
        };
        const l = stats.leftRmse == null ? "n/a" : stats.leftRmse.toFixed(3);
        const r = stats.rightRmse == null ? "n/a" : stats.rightRmse.toFixed(3);

        const sideWorst = Math.max(stats.leftRmse ?? 0, stats.rightRmse ?? 0);
        const sideBest = Math.max(1e-6, Math.min(stats.leftRmse ?? sideWorst, stats.rightRmse ?? sideWorst));
        const sideRatio = sideWorst / sideBest;
        const sideImbalance = sideWorst > CALIB_SIDE_RMSE_MAX && sideRatio > CALIB_SIDE_RATIO_MAX;
        const rejectByRmse = stats.rmse > CALIB_RMSE_ACCEPT_MAX;
        const hasUsablePreviousStats = prevCalibStats != null;
        const strictAccepted = !rejectByRmse && !sideImbalance;
        const provisionalCandidate =
          !sideImbalance &&
          rejectByRmse &&
          stats.rmse <= CALIB_RMSE_PROVISIONAL_MAX &&
          stats.maxErr <= CALIB_MAXERR_PROVISIONAL_MAX &&
          sideWorst <= CALIB_SIDE_RMSE_PROVISIONAL_MAX &&
          sideRatio <= CALIB_SIDE_RATIO_PROVISIONAL_MAX;
        const provisionalAllowed = provisionalCandidate && !hasUsablePreviousStats;

        if (!strictAccepted && !provisionalAllowed) {
          // Reject poor fits and restore previous calibration state.
          if (prevCalibStorage != null) {
            localStorage.setItem(CALIB_STORAGE_KEY, prevCalibStorage);
            if (!gaze.loadCalibrationFromStorage(CALIB_STORAGE_KEY)) gaze.clearCalibration(CALIB_STORAGE_KEY);
          } else {
            gaze.clearCalibration(CALIB_STORAGE_KEY);
          }
          saveCalibrationStatsToStorage(prevCalibStats);
          if (rejectByRmse) {
            calStatus.textContent = `Calibration rejected. RMSE ${stats.rmse.toFixed(3)} > ${CALIB_RMSE_ACCEPT_MAX.toFixed(2)}.`;
          } else {
            calStatus.textContent = `Calibration rejected. L/R imbalance ${sideRatio.toFixed(2)} (worst ${sideWorst.toFixed(3)}).`;
          }
          result = {
            ok: false,
            aborted: false,
            qualityRejected: true,
            stats: calStatsBase,
            appliedStats: prevCalibStats
          };
        } else {
          const calStats: CalibrationStats = {
            ...calStatsBase,
            tier: provisionalAllowed ? "provisional" : "strict"
          };
          gaze.saveCalibrationToStorage(CALIB_STORAGE_KEY);
          saveCalibrationStatsToStorage(calStats);
          if (provisionalAllowed) {
            calStatus.textContent =
              `Calibration provisional. RMSE ${stats.rmse.toFixed(3)} (<= ${CALIB_RMSE_PROVISIONAL_MAX.toFixed(2)}), L/R ${l}/${r}`;
          } else if (stats.leftRmse != null && stats.rightRmse != null && stats.rightRmse > stats.leftRmse * 1.35) {
            calStatus.textContent = `Calibration saved. RMSE ${stats.rmse.toFixed(3)} L/R ${l}/${r} (right weaker)`;
          } else {
            calStatus.textContent = `Calibration saved. RMSE ${stats.rmse.toFixed(3)} L/R ${l}/${r} max ${stats.maxErr.toFixed(3)} points ${samples.length}`;
          }
          result = {
            ok: true,
            aborted: false,
            qualityRejected: false,
            stats: calStats,
            appliedStats: calStats
          };
        }
      } else {
        calStatus.textContent = "Calibration failed. Retry.";
        result = { ok: false, aborted: false, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
      }
      console.log("Calibration matrix:", m);
      await new Promise(r => setTimeout(r, 550));
    } else {
      calStatus.textContent = "Not enough valid samples. Retry with better lighting.";
      result = { ok: false, aborted: false, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
      await new Promise(r => setTimeout(r, 650));
    }
  } finally {
    window.removeEventListener("keydown", onKey);
    calOverlay.style.display = "none";
    calibrating = false;
  }
  return result;
}

// rect normalized (0..1) of patch in full frame (sender -> receiver)
const patchRectN = new THREE.Vector4(0, 0, PATCH_W / FULL_W, PATCH_H / FULL_H);

// ---------- CAPTURE STREAMS ----------
const lowStream = cLow.captureStream(FPS);
const patchStream = cPatch.captureStream(FPS);

const lowTrack = lowStream.getVideoTracks()[0];
const patchTrack = patchStream.getVideoTracks()[0];

// Mark tracks for deterministic mapping
lowTrack.contentHint = "motion";
patchTrack.contentHint = "detail";

console.log("Tracks:", {
  low: { id: lowTrack.id, hint: lowTrack.contentHint },
  patch: { id: patchTrack.id, hint: patchTrack.contentHint }
});

// ---------- RECEIVER COMPOSITOR (shader) ----------
type ReceiverComposite = {
  setLowVideo: (v: HTMLVideoElement) => void;
  setPatchVideo: (v: HTMLVideoElement) => void;
  setMeta: (gaze: THREE.Vector2, rectN: THREE.Vector4) => void;
  render: () => number | null;
  getGpuMs: () => number | null;
};

function createReceiverComposite(canvas: HTMLCanvasElement): ReceiverComposite {
  const rr = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  rr.setSize(FULL_W, FULL_H, false);
  rr.setPixelRatio(1);

  const tRecv = new GpuTimer(rr);
  let lastGpuMs: number | null = null;

  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Create dummy textures to avoid shader compilation errors
  // Use CanvasTexture instead of DataTexture for better compatibility
  const dummyCanvas = document.createElement("canvas");
  dummyCanvas.width = 2;  // Use 2x2 instead of 1x1 for better compatibility
  dummyCanvas.height = 2;
  const dummyCtx = dummyCanvas.getContext("2d");
  if (dummyCtx) {
    dummyCtx.fillStyle = "#000000";
    dummyCtx.fillRect(0, 0, 2, 2);
  }
  const dummyTex = new THREE.CanvasTexture(dummyCanvas);
  dummyTex.needsUpdate = true;
  dummyTex.minFilter = THREE.LinearFilter;
  dummyTex.magFilter = THREE.LinearFilter;
  dummyTex.wrapS = THREE.ClampToEdgeWrapping;
  dummyTex.wrapT = THREE.ClampToEdgeWrapping;
  dummyTex.flipY = false;  // Video textures don't flip

  const uniforms = {
    tLow: { value: dummyTex },
    tPatch: { value: dummyTex },
    uGaze: { value: new THREE.Vector2(0, 0) },      // NDC
    uRect: { value: new THREE.Vector4(0, 0, 0.5, 0.5) }, // normalized xywh
    uRadius: { value: FOVEA_R },
    uFeather: { value: FEATHER },
    uAspect: { value: FULL_W / FULL_H }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLow;
      uniform sampler2D tPatch;
      uniform vec2 uGaze;
      uniform vec4 uRect;
      uniform float uRadius;
      uniform float uFeather;
      uniform float uAspect;

      float insideRect(vec2 uv, vec4 r) {
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        vec2 p = (uv - rBL) / r.zw;
        return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
      }

      vec2 rectUV(vec2 uv, vec4 r) {
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        return (uv - rBL) / r.zw;
      }

      void main() {
        vec4 low = texture2D(tLow, vUv);
        float inR = insideRect(vUv, uRect);
        vec2 puv = rectUV(vUv, uRect);
        vec4 patch = texture2D(tPatch, puv);
        vec2 p = vUv * 2.0 - 1.0;
        vec2 d = p - uGaze;
        d.x *= uAspect;
        float dist = length(d);
        float m = smoothstep(uRadius + uFeather, uRadius, dist);
        float blend = m * inR;
        gl_FragColor = mix(low, patch, blend);
      }
    `,
    depthTest: false,
    depthWrite: false
  });

  // Log shader compilation errors if any
  mat.onBeforeCompile = (shader) => {
    // Shader will be compiled here, errors will be caught by Three.js
  };

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  fsScene.add(quad);

  let lowTex: THREE.VideoTexture | null = null;
  let patchTex: THREE.VideoTexture | null = null;

  return {
    setLowVideo(v) {
      lowTex = new THREE.VideoTexture(v);
      lowTex.minFilter = THREE.LinearFilter;
      lowTex.magFilter = THREE.LinearFilter;
      lowTex.generateMipmaps = false;
      uniforms.tLow.value = lowTex;
    },
    setPatchVideo(v) {
      patchTex = new THREE.VideoTexture(v);
      patchTex.minFilter = THREE.LinearFilter;
      patchTex.magFilter = THREE.LinearFilter;
      patchTex.generateMipmaps = false;
      uniforms.tPatch.value = patchTex;
    },
    setMeta(g, rectN) {
      uniforms.uGaze.value.copy(g);
      uniforms.uRect.value.copy(rectN);
      uniforms.uRadius.value = FOVEA_R;
      uniforms.uFeather.value = FEATHER;
    },
    render() {
      // Only render if textures are ready (avoid shader errors)
      if (!lowTex || !patchTex) return lastGpuMs;
      
      if (tRecv.supported) tRecv.begin();
      try {
        rr.render(fsScene, fsCam);
      } catch (e) {
        console.error("Receiver composite render error:", e);
      }
      if (tRecv.supported) tRecv.end();
      lastGpuMs = tRecv.poll();
      return lastGpuMs;
    },
    getGpuMs() {
      return lastGpuMs;
    }
  };
}

const receiverComposite = createReceiverComposite(cOut);

// ---------- LOOPBACK WEBRTC ----------
const remoteTracks: Record<string, MediaStreamTrack> = {};
let trackMap: { low?: string; patch?: string } = {};
let dcRecv: RTCDataChannel | null = null;
let loop: Awaited<ReturnType<typeof createLoopback>> | null = null;

try {
  loop = await createLoopback({
    tracks: [lowTrack, patchTrack],
    onRemoteTrack: (track) => {
      remoteTracks[track.id] = track;
    },
    onDataChannel: (dc) => {
      dcRecv = dc;
      dc.onmessage = (ev) => {
        // 1) binary meta
        const m = tryDecodeMetaBinary(ev.data);
        if (m) {
          // sync mask params (important for real distributed receiver)
          FOVEA_R = m.foveaR;
          FEATHER = m.feather;

          receiverComposite.setMeta(m.gaze, m.rect);
          return;
        }

        // 2) JSON (solo handshake track ids)
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "tracks") {
              trackMap = { low: msg.low, patch: msg.patch };
              attachVideosIfReady();
              return;
            }
            if (msg.type === "meta") {
              // legacy
              const g = msg.gaze as [number, number];
              const r = msg.rect as [number, number, number, number];
              receiverComposite.setMeta(new THREE.Vector2(g[0], g[1]), new THREE.Vector4(r[0], r[1], r[2], r[3]));
            }
          } catch {}
        }
      };
    }
  });

  // sender data channel: announce track ids immediately
  loop.dcSend.onopen = () => {
    loop!.dcSend.send(JSON.stringify({ type: "tracks", low: lowTrack.id, patch: patchTrack.id }));
  };

  // Start bitrate polling (2Hz) + bandwidth governor
  // FIX CRITICO: Map by track.id instead of assuming order
  const senderByTrackId = new Map<string, RTCRtpSender>();
  for (const s of loop.senders) {
    if (s.track?.id) senderByTrackId.set(s.track.id, s);
  }

  const lowSender = senderByTrackId.get(lowTrack.id);
  const patchSender = senderByTrackId.get(patchTrack.id);

  if (!lowSender || !patchSender) {
    console.warn("Sender mapping failed", {
      lowTrackId: lowTrack.id,
      patchTrackId: patchTrack.id,
      senders: loop.senders.map(s => s.track?.id)
    });
  } else {
    telEvent("sender_map", {
      low_track_id: lowTrack.id,
      patch_track_id: patchTrack.id,
      sender_track_ids: loop.senders.map(s => s.track?.id)
    });

    console.log("Bitrate poller: mapping", {
      low: { track: lowSender.track?.id, hint: lowSender.track?.contentHint },
      patch: { track: patchSender.track?.id, hint: patchSender.track?.contentHint }
    });

    // init default profile
    bwSetProfile("balanced");

    // Avvia poller + governor (ora con pcSend + pcRecv)
    startBitratePoller({
      lowSender,
      patchSender,
      pcSend: loop.pcSend,
      pcRecv: loop.pcRecv,
      intervalMs: 500
    });
  }
} catch (err) {
  console.error("WebRTC loopback failed:", err);
  console.warn("Continuing without WebRTC - local rendering only");
}

// Attach remote tracks to hidden videos when mapping is known
function attachVideosIfReady() {
  if (!trackMap.low || !trackMap.patch) return;
  const tLowR = remoteTracks[trackMap.low];
  const tPatchR = remoteTracks[trackMap.patch];
  if (!tLowR || !tPatchR) return;

  const s1 = new MediaStream([tLowR]);
  const s2 = new MediaStream([tPatchR]);

  vLow.srcObject = s1;
  vPatch.srcObject = s2;

  // autoplay
  vLow.play().catch(()=>{});
  vPatch.play().catch(()=>{});

  receiverComposite.setLowVideo(vLow);
  receiverComposite.setPatchVideo(vPatch);
}

// ---------- SENDER META ----------
function computePatchRectTopLeft(gaze: THREE.Vector2) {
  // Sensitivity shaping: compress patch movement against gaze to reduce perceived over-reactivity.
  const gx = clamp(gaze.x * PATCH_SENSITIVITY_X, -1, 1);
  const gy = clamp(gaze.y * PATCH_SENSITIVITY_Y, -1, 1);
  const cx = (gx * 0.5 + 0.5) * FULL_W;
  const cy = (-gy * 0.5 + 0.5) * FULL_H; // top-left origin (NDC Y+ is up, screen Y+ is down)

  // Keep this path deterministic: gazeForPatch is already smoothed by updatePatchFocus().
  const maxX = FULL_W - PATCH_W;
  const maxY = FULL_H - PATCH_H;
  const desiredX = Math.round(clamp(cx - PATCH_W / 2, 0, maxX));
  const desiredY = Math.round(clamp(cy - PATCH_H / 2, 0, maxY));

  if (!patchRectAppliedInit) {
    patchRectAppliedInit = true;
    patchRectAppliedX = desiredX;
    patchRectAppliedY = desiredY;
  }

  let x0 = desiredX;
  let y0 = desiredY;

  // Edge hysteresis: avoid chatter when gaze hovers around clamped boundaries.
  if (
    PATCH_EDGE_LOCK_X_PX > 0 &&
    patchRectAppliedX <= PATCH_EDGE_LOCK_X_PX &&
    desiredX <= PATCH_EDGE_RELEASE_X_PX
  ) {
    x0 = 0;
  } else if (
    PATCH_EDGE_LOCK_X_PX > 0 &&
    patchRectAppliedX >= maxX - PATCH_EDGE_LOCK_X_PX &&
    desiredX >= maxX - PATCH_EDGE_RELEASE_X_PX
  ) {
    x0 = maxX;
  }

  if (
    PATCH_EDGE_LOCK_Y_PX > 0 &&
    patchRectAppliedY <= PATCH_EDGE_LOCK_Y_PX &&
    desiredY <= PATCH_EDGE_RELEASE_Y_PX
  ) {
    y0 = 0;
  } else if (
    PATCH_EDGE_LOCK_Y_PX > 0 &&
    patchRectAppliedY >= maxY - PATCH_EDGE_LOCK_Y_PX &&
    desiredY >= maxY - PATCH_EDGE_RELEASE_Y_PX
  ) {
    y0 = maxY;
  }

  // Pixel deadband + quantization to suppress visible micro-wobble.
  if (Math.abs(x0 - patchRectAppliedX) <= PATCH_DEADBAND_X_PX) x0 = patchRectAppliedX;
  if (Math.abs(y0 - patchRectAppliedY) <= PATCH_DEADBAND_Y_PX) y0 = patchRectAppliedY;
  if (PATCH_QUANT_X_PX > 1) x0 = Math.round(x0 / PATCH_QUANT_X_PX) * PATCH_QUANT_X_PX;
  if (PATCH_QUANT_Y_PX > 1) y0 = Math.round(y0 / PATCH_QUANT_Y_PX) * PATCH_QUANT_Y_PX;
  x0 = clamp(x0, 0, maxX);
  y0 = clamp(y0, 0, maxY);

  // Snap near edges to avoid boundary chatter when gaze hovers around limits.
  if (x0 <= PATCH_EDGE_SNAP_PX) x0 = 0;
  else if (x0 >= maxX - PATCH_EDGE_SNAP_PX) x0 = maxX;
  if (y0 <= PATCH_EDGE_SNAP_PX) y0 = 0;
  else if (y0 >= maxY - PATCH_EDGE_SNAP_PX) y0 = maxY;

  patchRectAppliedX = x0;
  patchRectAppliedY = y0;

  patchRectN.set(
    x0 / FULL_W,
    y0 / FULL_H,
    PATCH_W / FULL_W,
    PATCH_H / FULL_H
  );
}

// ---------- STATS (bitrate per track) ----------
let lastStatsT = performance.now();
let lastBytes: { low?: number; patch?: number } = {};

async function updateBitrate(recvGpu: number | null) {
  if (!loop) return;
  
  const now = performance.now();
  if (now - lastStatsT < 1000) return;

  const stats = await loop.pcRecv.getStats();
  let lowB: number | undefined;
  let patchB: number | undefined;

  stats.forEach((r) => {
    if (r.type !== "inbound-rtp" || r.kind !== "video") return;
    // r.trackIdentifier not always present; use r.trackId -> then lookup track stats
    const bytes = (r as any).bytesReceived as number | undefined;
    const trackId = (r as any).trackId as string | undefined;
    if (!bytes || !trackId) return;

    const tr = stats.get(trackId) as any;
    const tid = tr?.trackIdentifier as string | undefined; // may match MediaStreamTrack.id
    if (!tid) return;

    if (trackMap.low && tid === trackMap.low) lowB = bytes;
    if (trackMap.patch && tid === trackMap.patch) patchB = bytes;
  });

  const dt = (now - lastStatsT) / 1000;
  lastStatsT = now;

  function kbps(cur?: number, prev?: number) {
    if (cur == null || prev == null) return "…";
    return (((cur - prev) * 8) / 1000 / dt).toFixed(1);
  }

  const lowK = kbps(lowB, lastBytes.low);
  const patchK = kbps(patchB, lastBytes.patch);
  lastBytes.low = lowB;
  lastBytes.patch = patchB;

  // Wire kbps to telemetry
  TEL.kbpsLow = lowK === "…" ? null : +lowK;
  TEL.kbpsPatch = patchK === "…" ? null : +patchK;

  if (recvStats) {
    recvStats.textContent =
`RECV
low kbps:   ${lowK}
patch kbps: ${patchK}
gpu recv:   ${recvGpu != null ? recvGpu.toFixed(2) : "…"} ms
rectN:      ${patchRectN.toArray().map(v=>v.toFixed(3)).join(", ")}
gaze ctrl:  ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}
gaze est:   ${gazeEstNDC.x.toFixed(3)}, ${gazeEstNDC.y.toFixed(3)}
gaze filt:  ${gazeFocusNDC.x.toFixed(3)}, ${gazeFocusNDC.y.toFixed(3)}
mode:       ${gazeFilterMode}
mask:       r=${FOVEA_R.toFixed(2)} f=${FEATHER.toFixed(2)}`;
  }
}

// ---------- MAIN LOOP ----------
let frame = 0;
function tick(t: number) {
  requestAnimationFrame(tick);
  frame++;

  // Choose gaze source: eye tracking with hysteresis + graceful fallback.
  const gf = gaze.getFrame();

  // Hysteresis on confidence.
  const prevEyeLock = eyeLock;
  if (!eyeLock && gf.conf >= ENTER_CONF) eyeLock = true;
  else if (eyeLock && gf.conf <= EXIT_CONF) eyeLock = false;

  if (eyeLock) {
    eyeEverLocked = true;
    eyeLostAtMs = -1;
  } else if (prevEyeLock) {
    eyeLostAtMs = t;
  }

  // Hold the last eye sample briefly to avoid jumps on transient drops.
  const recentlyLostEye =
    !eyeLock &&
    eyeEverLocked &&
    eyeLostAtMs >= 0 &&
    (t - eyeLostAtMs) < EYE_HOLD_MS;
  const useEye = eyeLock || recentlyLostEye;

  if (eyeLock) {
    gazeNDC.set(gf.gazeX, gf.gazeY);
  } else if (!eyeEverLocked) {
    gazeNDC.lerp(mouseNDC, MOUSE_FOLLOW_FAST);
  } else if (!recentlyLostEye) {
    gazeNDC.lerp(mouseNDC, MOUSE_FOLLOW_SLOW);
  }
  updateGazeEstimate(gazeNDC, useEye, gf.conf, t);
  updatePatchFocus(gazeEstNDC, useEye, gf.conf, gazeFilterMode);
  const gazeForPatch = gazeFocusNDC;

  update(t);

  computePatchRectTopLeft(gazeForPatch);
  captureReadingAnalysisSample(t, gf, useEye, gazeNDC, gazeForPatch, gazeEstNDC, gazeFilterMode);

  const timeSec = t * 0.001;

  // helper per impostare entrambe le material
  function setPass(gaze: THREE.Vector2, aspect: number, nearR: number, feather: number, mode: "low" | "patch") {
    // Common
    matNear.uniforms.uTime.value = timeSec;
    matFar.uniforms.uTime.value  = timeSec;

    matNear.uniforms.uGaze.value.copy(gaze);
    matFar.uniforms.uGaze.value.copy(gaze);

    matNear.uniforms.uAspect.value = aspect;
    matFar.uniforms.uAspect.value  = aspect;

    matNear.uniforms.uNearR.value = nearR;
    matFar.uniforms.uNearR.value  = nearR;

    matNear.uniforms.uFeather.value = feather;
    matFar.uniforms.uFeather.value  = feather;

    // LOD toggle
    pointsFar.visible = LOD_ON;

    if (!LOD_ON) {
      // NEAR renders everywhere when LOD off
      matNear.uniforms.uNearR.value = 2.0;
      matNear.uniforms.uFeather.value = 1.0;
      return;
    }

    // Pass tuning (enterprise knobs)
    if (mode === "low") {
      // LOW stream: aggressively cheap in far
      matNear.uniforms.uAlpha.value = 0.95;
      matNear.uniforms.uSize.value  = 2.4;

      matFar.uniforms.uAlpha.value = 0.12;
      matFar.uniforms.uSize.value  = 0.60;
    } else {
      // PATCH stream: higher quality, but still LOD edges
      matNear.uniforms.uAlpha.value = 0.98;
      matNear.uniforms.uSize.value  = 2.8;

      matFar.uniforms.uAlpha.value = 0.18;
      matFar.uniforms.uSize.value  = 0.90;
    }

    // FAR throttle via uniform (works even if FAR geometry is fixed)
    const keepLow  = clamp(1.0 - GOV.throttle * 0.65, 0.25, 1.0);
    const keepPatch = clamp(1.0 - GOV.throttle * 0.45, 0.45, 1.0);

    if (mode === "low") {
      matFar.uniforms.uKeepProb.value = keepLow;
    } else {
      matFar.uniforms.uKeepProb.value = keepPatch;
    }
  }

  // ---- LOW PASS (Simplified: keep THREE.js but simpler) ----
  // Use simple THREE.js scene (already configured for low bitrate)
  setPass(gazeForPatch, LOW_W / LOW_H, FOVEA_R, FEATHER, "low");
  if (tLow.supported) tLow.begin();
  rLow.render(scene, camera);
  if (tLow.supported) tLow.end();
  const lowGpu = tLow.poll();

  // ---- PATCH PASS (2D Canvas Workload Encoder) ----
  // Clear black background
  ctxPatch.fillStyle = "#000000";
  ctxPatch.fillRect(0, 0, PATCH_W, PATCH_H);
  
  // Calculate ROI position (centered on cursor, scaled to patch canvas)
  // Use gazeNDC converted to patch canvas coordinates (0-1)
  const patchCursorX = (gazeForPatch.x + 1) * 0.5; // Convert NDC (-1..1) to (0..1)
  const patchCursorY = (-gazeForPatch.y + 1) * 0.5; // Flip Y for canvas coordinates
  
  const roiW = ROI_W;
  const roiH = ROI_H;
  const roiX = Math.floor((patchCursorX * PATCH_W) - roiW / 2);
  const roiY = Math.floor((patchCursorY * PATCH_H) - roiH / 2);
  
  // Clamp ROI to canvas bounds
  const roiXClamped = Math.max(0, Math.min(roiX, PATCH_W - roiW));
  const roiYClamped = Math.max(0, Math.min(roiY, PATCH_H - roiH));
  
  // Render based on mode
  if (patchMode === 0) {
    // Mode 0: Dark fill (minimal bitrate) - but make it visible
    ctxPatch.fillStyle = "#222222";
    ctxPatch.fillRect(roiXClamped, roiYClamped, roiW, roiH);
    
    // Add subtle border even in mode 0 for visibility
    ctxPatch.strokeStyle = "#444444";
    ctxPatch.lineWidth = 2;
    ctxPatch.strokeRect(roiXClamped, roiYClamped, roiW, roiH);
    
    // Add text to show it's working
    ctxPatch.fillStyle = "#888888";
    ctxPatch.font = "bold 24px ui-monospace, monospace";
    ctxPatch.textAlign = "center";
    ctxPatch.textBaseline = "middle";
    ctxPatch.fillText("MODE 0: MINIMAL", roiXClamped + roiW / 2, roiYClamped + roiH / 2);
  } else if (patchMode === 1) {
    // Mode 1: Scrolling white text on dark (subpixel edges) - make it brighter
    ctxPatch.save();
    ctxPatch.fillStyle = "#111111";
    ctxPatch.fillRect(roiXClamped, roiYClamped, roiW, roiH);
    
    ctxPatch.fillStyle = "#ffffff";
    ctxPatch.font = "bold 20px ui-monospace, monospace";
    ctxPatch.textAlign = "left";
    ctxPatch.textBaseline = "top";
    
    const scrollY = (timeSec * 50) % (roiH + 60) - 30;
    const text = "The quick brown fox jumps over the lazy dog. 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    ctxPatch.fillText(text, roiXClamped + 10, roiYClamped + scrollY);
    ctxPatch.fillText(text, roiXClamped + 10, roiYClamped + scrollY - 40);
    ctxPatch.fillText(text, roiXClamped + 10, roiYClamped + scrollY - 80);
    
    ctxPatch.restore();
  } else if (patchMode === 2) {
    // Mode 2: Checkerboard + rotating line - make checkerboard more visible
    ctxPatch.save();
    
    // Checkerboard with higher contrast
    const cellSize = 20;
    ctxPatch.fillStyle = "#ffffff";
    for (let y = 0; y < roiH; y += cellSize) {
      for (let x = 0; x < roiW; x += cellSize) {
        const cellX = Math.floor((roiXClamped + x) / cellSize);
        const cellY = Math.floor((roiYClamped + y) / cellSize);
        if ((cellX + cellY) % 2 === 0) {
          ctxPatch.fillRect(roiXClamped + x, roiYClamped + y, cellSize, cellSize);
        }
      }
    }
    
    // Dark background for contrast
    ctxPatch.fillStyle = "#000000";
    for (let y = 0; y < roiH; y += cellSize) {
      for (let x = 0; x < roiW; x += cellSize) {
        const cellX = Math.floor((roiXClamped + x) / cellSize);
        const cellY = Math.floor((roiYClamped + y) / cellSize);
        if ((cellX + cellY) % 2 === 1) {
          ctxPatch.fillRect(roiXClamped + x, roiYClamped + y, cellSize, cellSize);
        }
      }
    }
    
    // Rotating line - thicker and brighter
    const centerX = roiXClamped + roiW / 2;
    const centerY = roiYClamped + roiH / 2;
    const angle = timeSec * 3;
    const radius = Math.min(roiW, roiH) * 0.45;
    ctxPatch.strokeStyle = "#ff0000";
    ctxPatch.lineWidth = 4;
    ctxPatch.beginPath();
    ctxPatch.moveTo(centerX, centerY);
    ctxPatch.lineTo(
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius
    );
    ctxPatch.stroke();
    
    // Add center dot
    ctxPatch.fillStyle = "#ff0000";
    ctxPatch.beginPath();
    ctxPatch.arc(centerX, centerY, 4, 0, Math.PI * 2);
    ctxPatch.fill();
    
    ctxPatch.restore();
  } else if (patchMode === 3) {
    // Mode 3: Temporal noise - make it brighter and more visible
    const imageData = ctxPatch.createImageData(roiW, roiH);
    const data = imageData.data;
    const noise = Math.sin(timeSec * 15) * 0.5 + 0.5;
    
    for (let i = 0; i < data.length; i += 4) {
      const val = Math.floor(Math.random() * 255);
      const brightness = Math.floor(noise * 200 + 55); // 55-255 range
      data[i] = val;     // R
      data[i + 1] = val; // G
      data[i + 2] = val; // B
      data[i + 3] = brightness; // A (use brightness for alpha to create pulsing effect)
    }
    
    ctxPatch.putImageData(imageData, roiXClamped, roiYClamped);
  } else if (patchMode === 4) {
    // Mode 4: Reading demo with magnified region around gaze
    drawReadingDemoPage(readingCtx, timeSec);

    // Base layer: full "document" page, slightly dimmed (periphery).
    ctxPatch.save();
    ctxPatch.globalAlpha = 0.62;
    ctxPatch.drawImage(
      readingCanvas,
      0, 0, readingCanvas.width, readingCanvas.height,
      0, 0, PATCH_W, PATCH_H
    );
    ctxPatch.restore();

    // Zoom source around gaze point.
    const srcW = Math.max(140, Math.floor(roiW * 0.68));
    const srcH = Math.max(140, Math.floor(roiH * 0.68));
    const srcX = Math.floor(clamp((patchCursorX * PATCH_W) - srcW / 2, 0, PATCH_W - srcW));
    const srcY = Math.floor(clamp((patchCursorY * PATCH_H) - srcH / 2, 0, PATCH_H - srcH));
    const srcXHi = srcX * READING_SUPERSAMPLE;
    const srcYHi = srcY * READING_SUPERSAMPLE;
    const srcWHi = srcW * READING_SUPERSAMPLE;
    const srcHHi = srcH * READING_SUPERSAMPLE;

    ctxPatch.imageSmoothingEnabled = true;
    ctxPatch.drawImage(
      readingCanvas,
      srcXHi, srcYHi, srcWHi, srcHHi,
      roiXClamped, roiYClamped, roiW, roiH
    );

    // Visual guide for expected behavior.
    ctxPatch.strokeStyle = "#ffd166";
    ctxPatch.lineWidth = 4;
    ctxPatch.strokeRect(roiXClamped, roiYClamped, roiW, roiH);

    ctxPatch.fillStyle = "rgba(20,20,20,0.75)";
    ctxPatch.fillRect(roiXClamped + 8, roiYClamped + 8, Math.min(420, roiW - 16), 28);
    ctxPatch.fillStyle = "#ffe39a";
    ctxPatch.font = "bold 15px ui-monospace, monospace";
    ctxPatch.textAlign = "left";
    ctxPatch.textBaseline = "top";
    ctxPatch.fillText("Reading demo: lo zoom deve seguire il tuo sguardo", roiXClamped + 14, roiYClamped + 14);
  }
  
  // Debug: Draw ROI border in all modes to make it visible
  ctxPatch.strokeStyle = patchMode === 0 ? "#333333" : (patchMode === 4 ? "#ffd166" : "#00ff00");
  ctxPatch.lineWidth = patchMode === 0 ? 1 : 3;
  ctxPatch.strokeRect(roiXClamped, roiYClamped, roiW, roiH);
  
  // Add mode indicator text in corner
  ctxPatch.save();
  ctxPatch.fillStyle = "#ffffff";
  ctxPatch.font = "bold 20px ui-monospace, monospace";
  ctxPatch.textAlign = "left";
  ctxPatch.textBaseline = "top";
  ctxPatch.fillText(`Mode ${patchMode}: ${PATCH_MODE_LABELS[patchMode] ?? "unknown"}`, 10, 10);
  ctxPatch.restore();
  
  const patchGpu = null; // 2D canvas doesn't have GPU timing
  
  // Debug: log ogni 60 frame
  if (frame % 60 === 0) {
    console.log("Rendering:", {
      frame,
      lod: LOD_ON,
      gazeNDC: { x: gazeNDC.x.toFixed(2), y: gazeNDC.y.toFixed(2) },
      patchRectN: patchRectN.toArray().map(v => v.toFixed(2))
    });
  }

  // receiver composite (when videos ready)
  const recvGpu = receiverComposite.render();

  // ---- GOVERNOR (GPU-first) ----
  const totalGpu = (lowGpu ?? 0) + (patchGpu ?? 0) + (recvGpu ?? 0);
  GOV.emaGpuMs = lerp(GOV.emaGpuMs, totalGpu, 0.08);

  if (GOV.enabled) {
    const err = GOV.emaGpuMs - GOV.targetGpuMs;   // ms over/under
    GOV.throttle = clamp(GOV.throttle + err * 0.015, 0, 1);

    // shrink fovea when overloaded
    FOVEA_R = clamp(BASE_FOVEA_R - GOV.throttle * 0.08, 0.12, BASE_FOVEA_R);
    FEATHER = clamp(BASE_FEATHER - GOV.throttle * 0.03, 0.03, BASE_FEATHER);
  } else {
    GOV.throttle = lerp(GOV.throttle, 0.0, 0.10);
    FOVEA_R = BASE_FOVEA_R;
    FEATHER = BASE_FEATHER;
  }

  // sender meta @ ~30Hz (binary v2)
  if (loop && loop.dcSend.readyState === "open" && frame % 1 === 0) {
    const meta = encodeMetaBinary(gazeForPatch, patchRectN, useEye ? gf.conf : 0, FOVEA_R, FEATHER);
    loop.dcSend.send(meta);
  }

  // ------------------- TELEMETRY SAMPLE (10Hz) -------------------
  if (TEL.enabled) {
    const t = telNowMs();
    const interval = 1000 / TEL.hz;
    if (TEL.lastT === 0) TEL.lastT = t;
    while ((t - TEL.lastT) >= interval) {
      TEL.lastT += interval;

      // Update TEL for allocator access (before telemetry sample)
      TEL.useEye = useEye;
      TEL.gazeConf = useEye ? gf.conf : 0;
      TEL.gazeMode = gazeFilterMode;
      
      // Calculate ROI size for telemetry (same as in PATCH rendering)
      const telRoiW = ROI_W;
      const telRoiH = ROI_H;

      telPush({
        t_ms: Math.round(t),
        seq: (TEL.seq++),

        // gaze
        gaze_x: +gazeNDC.x.toFixed(4),
        gaze_y: +gazeNDC.y.toFixed(4),
        gaze_est_x: +gazeEstNDC.x.toFixed(4),
        gaze_est_y: +gazeEstNDC.y.toFixed(4),
        gaze_filt_x: +gazeForPatch.x.toFixed(4),
        gaze_filt_y: +gazeForPatch.y.toFixed(4),
        gaze_mode: TEL.gazeMode,
        use_eye: !!useEye,
        conf: +(useEye ? gf.conf : 0).toFixed(3),

        // rect
        rect: [
          +patchRectN.x.toFixed(5),
          +patchRectN.y.toFixed(5),
          +patchRectN.z.toFixed(5),
          +patchRectN.w.toFixed(5)
        ],

        // params
        fovea_r: +FOVEA_R.toFixed(4),
        feather: +FEATHER.toFixed(4),
        lod: !!LOD_ON,
        
        // workload encoder
        patch_mode: patchMode,
        roi_w: telRoiW,
        roi_h: telRoiH,

        // governor
        gov_on: !!GOV.enabled,
        gov_tgt_ms: +GOV.targetGpuMs.toFixed(2),
        gov_ema_ms: +GOV.emaGpuMs.toFixed(2),
        gov_thr: +GOV.throttle.toFixed(3),

        // gpu timing (may be null if unsupported)
        gpu_low_ms: lowGpu == null ? null : +lowGpu.toFixed(3),
        gpu_patch_ms: patchGpu == null ? null : +patchGpu.toFixed(3),
        gpu_recv_ms: recvGpu == null ? null : +recvGpu.toFixed(3),

        // optional bandwidth (if you wire it later)
        kbps_low: TEL.kbpsLow,  // backward compat: equals payload
        kbps_patch: TEL.kbpsPatch,  // backward compat: equals payload
        kbps_low_wire: TEL.kbpsLowWire,
        kbps_patch_wire: TEL.kbpsPatchWire,
        kbps_low_payload: TEL.kbpsLowPayload,
        kbps_patch_payload: TEL.kbpsPatchPayload,
        kbps_low_ema: TEL.kbpsLowEma,  // EMA of payload
        kbps_patch_ema: TEL.kbpsPatchEma,  // EMA of payload
        rtt_ms: TEL.rttMs,
        loss_pct: TEL.lossPct,
        loss_tx_pct: TEL.lossTxPct,
        loss_rx_pct: TEL.lossRxPct,
        target_low_kbps: TEL.targetLowKbps,
        target_patch_kbps: TEL.targetPatchKbps,
        applied_low_kbps: TEL.appliedLowKbps,
        applied_patch_kbps: TEL.appliedPatchKbps,
        alloc_bias_kbps: TEL.allocBiasKbps,
        util_low: TEL.utilLow,
        util_patch: TEL.utilPatch,
        hungry_patch: TEL.hungryPatch,
        bw_prof: TEL.bwProfile,
        bw_on: TEL.bwEnabled,
        aob_kbps: TEL.aobKbps,
        ice_rtt_ms: TEL.iceRttMs
      });
      break; // 10Hz: max 1 record per frame (evita burst)
    }
  }

  // sender stats
  if (senderStats) {
    try {
      const gf = gaze.getFrame();
      senderStats.textContent =
`SEND
full:       ${FULL_W}x${FULL_H}
low:        ${LOW_W}x${LOW_H}  (scale ${LOW_SCALE})
patch:      ${PATCH_W}x${PATCH_H}
LOD:        ${LOD_ON ? "ON" : "OFF"}
FAR points: ${farCount}/${N}  (${(farCount/N*100).toFixed(1)}%)
gpu low:    ${tLow.supported ? (lowGpu ?? 0).toFixed(2) : "…"} ms
gpu patch:  ${patchGpu != null ? patchGpu.toFixed(2) : "N/A (2D)"} ms
gov:        ${GOV.enabled ? "ON" : "OFF"}  tgt=${GOV.targetGpuMs.toFixed(1)}ms
gpuΣ(ema):  ${GOV.emaGpuMs.toFixed(2)} ms   thr=${GOV.throttle.toFixed(2)}
fovea:      r=${FOVEA_R.toFixed(3)} f=${FEATHER.toFixed(3)}
kbps low/pt: ${TEL.kbpsLowEma != null ? TEL.kbpsLowEma.toFixed(0) : (TEL.kbpsLowPayload ?? "…")} / ${TEL.kbpsPatchEma != null ? TEL.kbpsPatchEma.toFixed(0) : (TEL.kbpsPatchPayload ?? "…")} kbps${TEL.kbpsLowWire != null && TEL.kbpsLowPayload != null ? ` (wire: ${TEL.kbpsLowWire.toFixed(0)}/${TEL.kbpsPatchWire?.toFixed(0) ?? "…"})` : ""}
bw:         ${BW.enabled ? "ON" : "OFF"} prof=${BW.profile} cap=${BW.totalCapKbps}kbps
applied:    ${TEL.appliedLowKbps ?? "…"} / ${TEL.appliedPatchKbps ?? "…"} kbps (target: ${TEL.targetLowKbps ?? "…"} / ${TEL.targetPatchKbps ?? "…"})
alloc:      bias=${BW.alloc.biasKbps}kbps util=${TEL.utilLow != null ? TEL.utilLow.toFixed(2) : "…"}/${TEL.utilPatch != null ? TEL.utilPatch.toFixed(2) : "…"}${TEL.hungryPatch ? " HUNGRY" : ""}
loss tx/rx:  ${TEL.lossTxPct != null ? TEL.lossTxPct.toFixed(2) : "…"}% / ${TEL.lossRxPct != null ? TEL.lossRxPct.toFixed(2) : "…"}%
loss worst:  ${TEL.lossPct != null ? TEL.lossPct.toFixed(2) : "…"}%
rtt:         ${BW.rttMs ?? "…"} ms
ice aob:     ${TEL.aobKbps ?? "…"} kbps  ice_rtt: ${TEL.iceRttMs ?? "…"} ms
tele:       ${TEL.enabled ? "ON" : "OFF"}  lines=${TEL.lines.length}
keys:       B toggle | 1 mobile | 2 balanced | 3 lan | [ ] adjust cap | T tele | D download | X clear | M workload | C auto | Shift+C calib-only | R analysis | A auto-calib+analysis
workload:   patch mode=${patchMode} (${PATCH_MODE_LABELS[patchMode] ?? "unknown"}) ROI=${Math.min(ROI_W, PATCH_W)}x${Math.min(ROI_H, PATCH_H)}
eye conf:   ${gf.conf.toFixed(2)} ${gf.hasIris ? "iris" : "head"}

🎯 TEST MARKERS: Guarda le 4 sfere colorate (🔴🟢🔵🟡) agli angoli.
   Se il tracking funziona, la sfera DEVE apparire nel PATCH (destra)!
gaze raw:   ${gf.rawX.toFixed(3)}, ${gf.rawY.toFixed(3)}
gaze eye:   ${gf.gazeX.toFixed(3)}, ${gf.gazeY.toFixed(3)}
gaze ctrl:  ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}
gaze est:   ${gazeEstNDC.x.toFixed(3)}, ${gazeEstNDC.y.toFixed(3)}  (${gazeFilterMode})
gaze filt:  ${gazeForPatch.x.toFixed(3)}, ${gazeForPatch.y.toFixed(3)}`;
    } catch (err) {
      console.error("Error updating sender stats:", err);
      senderStats.textContent = `Error: ${err}`;
    }
  }

  // recv bitrate update
  updateBitrate(recvGpu).catch(()=>{});
}

requestAnimationFrame(tick);
