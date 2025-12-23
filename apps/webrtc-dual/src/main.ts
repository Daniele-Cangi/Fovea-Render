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
  gazeConf: null as number | null
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

function telDownload() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([TEL.lines.join("\n") + "\n"], { type: "application/jsonl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `telemetry_${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function telClear() {
  TEL.lines.length = 0;
  TEL.seq = 0;
}

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

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "g") GOV.enabled = !GOV.enabled;
  if (k === "=" || k === "+") GOV.targetGpuMs = clamp(GOV.targetGpuMs + 0.5, 4, 20);
  if (k === "-" || k === "_") GOV.targetGpuMs = clamp(GOV.targetGpuMs - 0.5, 4, 20);
  if (k === "l") LOD_ON = !LOD_ON;
  if (k === "t") TEL.enabled = !TEL.enabled; // toggle
  if (k === "d") telDownload();
  if (k === "x") telClear();
});

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
cPatch.style.width = "420px"; cPatch.style.height = "420px";
cOut.style.width = "860px"; cOut.style.height = "484px";

// ---------- GAZE (eye tracking + mouse fallback) ----------
const gazeNDC = new THREE.Vector2(0, 0);
const gazePatchNDC = new THREE.Vector2(0, 0);
const mouseNDC = new THREE.Vector2(0, 0);
let LOD_ON = true;

// Patch-rect smoothing
let patchX0 = 0;
let patchY0 = 0;
let patchInit = false;

// Confidence hysteresis
let eyeLock = false;
const ENTER_CONF = 0.35;
const EXIT_CONF = 0.22;

// ---------- META BINARY ENCODER/DECODER ----------
const META_VER = 1;
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

// toggle per demo enterprise (L = compare)
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "l") LOD_ON = !LOD_ON;
});

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

// ---------- SENDER RENDERERS ----------
const rLow = new THREE.WebGLRenderer({ canvas: cLow, antialias: true, alpha: false, powerPreference: "high-performance" });
rLow.setSize(LOW_W, LOW_H, false);
rLow.setPixelRatio(1);

const rPatch = new THREE.WebGLRenderer({ canvas: cPatch, antialias: true, alpha: false, powerPreference: "high-performance" });
rPatch.setSize(PATCH_W, PATCH_H, false);
rPatch.setPixelRatio(1);

const tLow = new GpuTimer(rLow);
const tPatch = new GpuTimer(rPatch);

// ---------- GAZE PROVIDER (MediaPipe) ----------
const gaze = new MediapipeGazeProvider({ mirrorX: true, smoothAlpha: 0.18 });
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
      <b>Calibration</b> (3×3)<br>
      Keep your gaze on the dot. Don't move your head much.<br>
      Press <b>ESC</b> to abort. It will auto-save when done.
    </div>
    <div id="cal-dot" style="position:absolute;width:14px;height:14px;border-radius:50%;
      background:#0ff; box-shadow:0 0 18px rgba(0,255,255,0.55); transform:translate(-50%,-50%);"></div>
  `;
  document.body.appendChild(o);
  const dot = o.querySelector("#cal-dot") as HTMLDivElement;
  return { overlay: o, dot };
}

const { overlay: calOverlay, dot: calDot } = makeOverlay();

async function calibrate3x3() {
  calOverlay.style.display = "block";

  const grid = [-0.75, 0.0, 0.75];
  const targets: { x: number; y: number }[] = [];
  for (const yy of grid) for (const xx of grid) targets.push({ x: xx, y: yy });

  const samples: { rx: number; ry: number; x: number; y: number }[] = [];

  const abort = { v: false };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") abort.v = true; };
  window.addEventListener("keydown", onKey);

  try {
    for (const t of targets) {
      if (abort.v) break;

      // place dot in screen space from NDC (viewport)
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = ((t.x + 1) * 0.5) * vw;
      const sy = ((-t.y + 1) * 0.5) * vh;
      calDot.style.left = `${sx}px`;
      calDot.style.top = `${sy}px`;

      // settle
      await new Promise(r => setTimeout(r, 250));

      // collect ~30 frames (use unmirrored raw for calibration)
      const acc: GazeSample[] = [];
      for (let i = 0; i < 30; i++) {
        if (abort.v) break;
        const f = gaze.getFrame();
        const rawUnmirrored = gaze.getRawUnmirrored();
        acc.push({ rawX: rawUnmirrored.rawX, rawY: rawUnmirrored.rawY, t: performance.now(), conf: f.conf });
        await new Promise(r => requestAnimationFrame(() => r(null)));
      }

      // robust average: only frames with conf > 0.25
      const good = acc.filter(s => s.conf > 0.25);
      const use = good.length >= 10 ? good : acc;

      const rx = use.reduce((s,p)=>s+p.rawX,0)/use.length;
      const ry = use.reduce((s,p)=>s+p.rawY,0)/use.length;

      samples.push({ rx, ry, x: t.x, y: t.y });
    }

    if (!abort.v && samples.length >= 6) {
      const m = gaze.fitAndSetCalibration(samples);
      if (m) gaze.saveCalibrationToStorage();
      console.log("Calibration matrix:", m);
    }
  } finally {
    window.removeEventListener("keydown", onKey);
    calOverlay.style.display = "none";
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "c") calibrate3x3();
});

// patch camera uses viewOffset (true crop of the frustum)
const patchCam = camera.clone();

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

// ---------- SENDER META + PATCH VIEWOFFSET ----------
function computePatchRectTopLeft(gaze: THREE.Vector2) {
  const cx = (gaze.x * 0.5 + 0.5) * FULL_W;
  const cy = (-gaze.y * 0.5 + 0.5) * FULL_H; // top-left origin

  const dx = Math.floor(clamp(cx - PATCH_W / 2, 0, FULL_W - PATCH_W));
  const dy = Math.floor(clamp(cy - PATCH_H / 2, 0, FULL_H - PATCH_H));

  if (!patchInit) {
    patchInit = true;
    patchX0 = dx;
    patchY0 = dy;
  } else {
    // smoothing (tune 0.18..0.35)
    patchX0 = lerp(patchX0, dx, 0.25);
    patchY0 = lerp(patchY0, dy, 0.25);
  }

  patchX0 = clamp(patchX0, 0, FULL_W - PATCH_W);
  patchY0 = clamp(patchY0, 0, FULL_H - PATCH_H);

  const x0 = Math.round(patchX0);
  const y0 = Math.round(patchY0);

  patchRectN.set(
    x0 / FULL_W,
    y0 / FULL_H,
    PATCH_W / FULL_W,
    PATCH_H / FULL_H
  );

  patchCam.clearViewOffset();
  patchCam.setViewOffset(FULL_W, FULL_H, x0, y0, PATCH_W, PATCH_H);
  patchCam.updateProjectionMatrix();
}

function computeGazePatchNDC(gaze: THREE.Vector2, rectN: THREE.Vector4) {
  // gaze NDC -> uv bottom-left
  const u = (gaze.x + 1) * 0.5;
  const vBL = (gaze.y + 1) * 0.5;

  // convert to top-left for rect math
  const vTL = 1.0 - vBL;

  // local uv inside rect (top-left origin)
  const pu = (u - rectN.x) / rectN.z;
  const pv = (vTL - rectN.y) / rectN.w;

  // uv -> patch NDC (y up)
  const nx = pu * 2 - 1;
  const ny = 1 - pv * 2;

  gazePatchNDC.set(
    THREE.MathUtils.clamp(nx, -1, 1),
    THREE.MathUtils.clamp(ny, -1, 1)
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
gazeNDC:    ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}
mask:       r=${FOVEA_R.toFixed(2)} f=${FEATHER.toFixed(2)}`;
  }
}

// ---------- MAIN LOOP ----------
let frame = 0;
function tick(t: number) {
  requestAnimationFrame(tick);
  frame++;

  // Choose gaze source: eye tracking with hysteresis
  const gf = gaze.getFrame();

  // hysteresis
  if (!eyeLock && gf.conf >= ENTER_CONF) eyeLock = true;
  else if (eyeLock && gf.conf <= EXIT_CONF) eyeLock = false;

  const useEye = eyeLock;

  if (useEye) {
    gazeNDC.set(gf.gazeX, gf.gazeY);
  } else {
    gazeNDC.copy(mouseNDC);
  }

  update(t);

  computePatchRectTopLeft(gazeNDC);
  computeGazePatchNDC(gazeNDC, patchRectN);

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

  // ---- LOW PASS ----
  setPass(gazeNDC, LOW_W / LOW_H, FOVEA_R, FEATHER, "low");
  if (tLow.supported) tLow.begin();
  rLow.render(scene, camera);
  if (tLow.supported) tLow.end();
  const lowGpu = tLow.poll();

  // ---- PATCH PASS ----
  // convert fovea radius to patch NDC scale: r_patch ≈ r_full / rectWidth
  const rPatchNDC = Math.min(0.95, FOVEA_R / patchRectN.z);
  const fPatch = Math.min(0.35, FEATHER / patchRectN.z);

  setPass(gazePatchNDC, PATCH_W / PATCH_H, rPatchNDC, fPatch, "patch");
  if (tPatch.supported) tPatch.begin();
  rPatch.render(scene, patchCam);
  if (tPatch.supported) tPatch.end();
  const patchGpu = tPatch.poll();
  
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
    const meta = encodeMetaBinary(gazeNDC, patchRectN, useEye ? gf.conf : 0, FOVEA_R, FEATHER);
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

      telPush({
        t_ms: Math.round(t),
        seq: (TEL.seq++),

        // gaze
        gaze_x: +gazeNDC.x.toFixed(4),
        gaze_y: +gazeNDC.y.toFixed(4),
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
gpu patch:  ${tPatch.supported ? (patchGpu ?? 0).toFixed(2) : "…"} ms
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
keys:       B toggle | 1 mobile | 2 balanced | 3 lan | [ ] adjust cap | T tele | D download | X clear
eye conf:   ${gf.conf.toFixed(2)} ${gf.hasIris ? "iris" : "head"}
gazeNDC:    ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}`;
    } catch (err) {
      console.error("Error updating sender stats:", err);
      senderStats.textContent = `Error: ${err}`;
    }
  }

  // recv bitrate update
  updateBitrate(recvGpu).catch(()=>{});
}

requestAnimationFrame(tick);
