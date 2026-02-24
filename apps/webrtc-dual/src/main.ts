import * as THREE from "three";
import { createLoopback } from "./loopback";
import { MediapipeGazeProvider } from "@fovea-render/gaze-mediapipe";
import {
  CALIB_AUTO_MAX_ATTEMPTS,
  CALIB_RMSE_ACCEPT_MAX,
  CALIB_STORAGE_KEY,
  CALIB_STRICT_REFINEMENT_ATTEMPTS,
  loadCalibrationStatsFromStorage,
  type CalibrationRunResult,
  type CalibrationStats
} from "./calibrationStorage";
import { createCalibrationRunner } from "./calibrationFlow";
import {
  BW_PROFILES,
  bwClamp,
  createBandwidthState,
  type BwProfileName
} from "./bandwidthState";
import { startBitratePoller } from "./bandwidthPoller";
import { createReceiverComposite } from "./receiverComposite";
import { drawReadingDemoPage } from "./readingDemo";
import {
  buildReadingAnalysisSummary,
  hideReadingAnalysisStatus,
  setReadingAnalysisStatus,
  type GazeFilterMode,
  type ReadingAnalysisOverlayState,
  type ReadingAnalysisSample,
  type ReadingAnalysisStopReason
} from "./readingAnalysis";

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
const FINAL_SINGLE_DEMO = true;
const FINAL_PATCH_MODE = 4;
const FINAL_LENS_MIN_RADIUS_PX = 102;
const FINAL_LENS_MAX_RADIUS_PX = 146;
const FINAL_LENS_MAX_SPEED = 4200;
const FINAL_LENS_MAX_ACCEL = 42000;
const FINAL_LENS_OMEGA_FIX = 18.0;
const FINAL_LENS_OMEGA_SAC = 31.0;
const FINAL_LENS_OMEGA_FALLBACK = 14.5;
const FINAL_LENS_LEAD_FIX_SEC = 0.020;
const FINAL_LENS_LEAD_SAC_SEC = 0.042;
const FINAL_LENS_LEAD_FALLBACK_SEC = 0.012;

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

const ANALYSIS_OVERLAY: ReadingAnalysisOverlayState = {
  overlay: null,
  statusEl: null
};

const ANALYSIS = {
  running: false,
  auto: false,
  autoPipeline: false,
  startedAtMs: 0,
  stopAtMs: 0,
  samples: [] as ReadingAnalysisSample[],
  calibration: null as CalibrationStats | null,
  calibrationAttempted: null as CalibrationStats | null,
  lastSummary: null as Record<string, unknown> | null
};

function setAnalysisStatus(msg: string, visible = true) {
  setReadingAnalysisStatus(ANALYSIS_OVERLAY, msg, visible);
}

function hideAnalysisStatus(delayMs = 0) {
  hideReadingAnalysisStatus(ANALYSIS_OVERLAY, ANALYSIS.running, delayMs);
}

// ------------------- BANDWIDTH GOVERNOR -------------------
const BW = createBandwidthState("balanced");

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

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "f") void toggleFullscreenStage();
  if (k === "h") toggleHudVisibility();
  if (k === "g") GOV.enabled = !GOV.enabled;
  if (k === "=" || k === "+") GOV.targetGpuMs = clamp(GOV.targetGpuMs + 0.5, 4, 20);
  if (k === "-" || k === "_") GOV.targetGpuMs = clamp(GOV.targetGpuMs - 0.5, 4, 20);
  if (k === "l") LOD_ON = !LOD_ON;
  if (k === "m") {
    if (!FINAL_SINGLE_DEMO) {
      patchMode = (patchMode + 1) % PATCH_MODE_COUNT;
      telEvent("workload_mode", { patchMode });
    }
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

// ---------- DOM ----------
const cLow = document.getElementById("cLow") as HTMLCanvasElement;
const cPatch = document.getElementById("cPatch") as HTMLCanvasElement;
const cOut = document.getElementById("cOut") as HTMLCanvasElement;
let finalOutCtx: CanvasRenderingContext2D | null = null;

const senderStats = document.getElementById("senderStats");
const recvStats = document.getElementById("recvStats");

const appRoot = document.getElementById("appRoot") as HTMLDivElement | null;
const gazeReticle = document.getElementById("gazeReticle") as HTMLDivElement | null;
const hudFilterModeEl = document.getElementById("hudFilterMode") as HTMLSpanElement | null;
const hudConfEl = document.getElementById("hudConf") as HTMLSpanElement | null;
const hudCalibRmseEl = document.getElementById("hudCalibRmse") as HTMLSpanElement | null;
const btnFullscreen = document.getElementById("btnFullscreen") as HTMLButtonElement | null;
const btnHud = document.getElementById("btnHud") as HTMLButtonElement | null;

const vLow = document.getElementById("vLow") as HTMLVideoElement;
const vPatch = document.getElementById("vPatch") as HTMLVideoElement;

if (!cLow || !cPatch || !cOut || !senderStats || !recvStats || !vLow || !vPatch) {
  throw new Error("Missing required DOM elements");
}
if (FINAL_SINGLE_DEMO) finalOutCtx = cOut.getContext("2d", { alpha: false });
if (FINAL_SINGLE_DEMO && !finalOutCtx) {
  throw new Error("Failed to get 2D context for final output canvas");
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

let hudHidden = false;
let lastHudCalibrationReadMs = -1;

function updateFullscreenButtonLabel() {
  if (!btnFullscreen) return;
  btnFullscreen.textContent = document.fullscreenElement ? "Exit Fullscreen (F)" : "Go Fullscreen (F)";
}

async function toggleFullscreenStage() {
  try {
    if (!document.fullscreenElement) {
      const host: Element = appRoot ?? document.documentElement;
      await host.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen toggle failed:", err);
  }
}

function setHudVisibility(hidden: boolean) {
  hudHidden = hidden;
  document.body.classList.toggle("hud-minimal", hudHidden);
  if (btnHud) btnHud.textContent = hudHidden ? "Show HUD (H)" : "Hide HUD (H)";
}

function toggleHudVisibility() {
  setHudVisibility(!hudHidden);
}

function updateHudMetrics(conf: number, mode: GazeFilterMode, tMs: number) {
  if (hudConfEl) hudConfEl.textContent = conf.toFixed(2);
  if (hudFilterModeEl) hudFilterModeEl.textContent = mode;
  if (hudCalibRmseEl && (lastHudCalibrationReadMs < 0 || (tMs - lastHudCalibrationReadMs) > 900)) {
    const cal = loadCalibrationStatsFromStorage();
    hudCalibRmseEl.textContent = cal ? `${cal.rmse.toFixed(3)} (${cal.tier ?? "saved"})` : "n/a";
    lastHudCalibrationReadMs = tMs;
  }
}

function updateGazeReticle(gaze: THREE.Vector2, conf: number) {
  if (FINAL_SINGLE_DEMO) return;
  if (!gazeReticle) return;
  const outRect = cOut.getBoundingClientRect();
  const hostRect = cOut.parentElement?.getBoundingClientRect();
  if (!hostRect || outRect.width <= 0 || outRect.height <= 0) return;

  const x = outRect.left - hostRect.left + ((gaze.x + 1) * 0.5) * outRect.width;
  const y = outRect.top - hostRect.top + ((-gaze.y + 1) * 0.5) * outRect.height;
  const confNorm = clamp((conf - 0.25) / 0.55, 0, 1);
  const opacity = lerp(0.28, 1.0, confNorm);
  const scale = lerp(1.28, 0.84, confNorm);

  gazeReticle.style.left = `${x.toFixed(1)}px`;
  gazeReticle.style.top = `${y.toFixed(1)}px`;
  gazeReticle.style.opacity = opacity.toFixed(3);
  gazeReticle.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
}

btnFullscreen?.addEventListener("click", () => { void toggleFullscreenStage(); });
btnHud?.addEventListener("click", () => toggleHudVisibility());
document.addEventListener("fullscreenchange", updateFullscreenButtonLabel);
setHudVisibility(document.body.classList.contains("final-single"));
updateFullscreenButtonLabel();

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

// Adaptive Kalman CV estimator (single filter stage for both precision and stability).
const KALMAN_SACCADE_ENTER_SPEED = 1.55;
const KALMAN_SACCADE_EXIT_SPEED = 0.70;
const KALMAN_MODE_HOLD_MS = 70;
const KALMAN_MEAS_SIGMA_EYE_LOW = 0.060;
const KALMAN_MEAS_SIGMA_EYE_HIGH = 0.013;
const KALMAN_MEAS_SIGMA_FALLBACK = 0.028;
const KALMAN_ACC_SIGMA_FIX_LOW = 5.8;
const KALMAN_ACC_SIGMA_FIX_HIGH = 2.0;
const KALMAN_ACC_SIGMA_SAC_LOW = 17.0;
const KALMAN_ACC_SIGMA_SAC_HIGH = 10.0;
const KALMAN_ACC_SIGMA_FALLBACK = 7.5;
const KALMAN_POS_VAR_INIT = 0.09;
const KALMAN_VEL_VAR_INIT = 7.2;
const KALMAN_VEL_LIMIT = 4.8;

type AxisKalman = {
  pos: number;
  vel: number;
  pPosPos: number;
  pPosVel: number;
  pVelVel: number;
};

const kalmanX: AxisKalman = { pos: 0, vel: 0, pPosPos: KALMAN_POS_VAR_INIT, pPosVel: 0, pVelVel: KALMAN_VEL_VAR_INIT };
const kalmanY: AxisKalman = { pos: 0, vel: 0, pPosPos: KALMAN_POS_VAR_INIT, pPosVel: 0, pVelVel: KALMAN_VEL_VAR_INIT };

// Unified control signal for patch and final lens.
const gazeFocusNDC = new THREE.Vector2(0, 0);
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

function resetAxisKalman(axis: AxisKalman, pos: number, vel = 0) {
  axis.pos = pos;
  axis.vel = vel;
  axis.pPosPos = KALMAN_POS_VAR_INIT;
  axis.pPosVel = 0;
  axis.pVelVel = KALMAN_VEL_VAR_INIT;
}

function predictAxisKalman(axis: AxisKalman, dt: number, sigmaAcc: number) {
  const sigma2 = sigmaAcc * sigmaAcc;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  const q11 = 0.25 * dt4 * sigma2;
  const q12 = 0.5 * dt3 * sigma2;
  const q22 = dt2 * sigma2;

  axis.pos = axis.pos + axis.vel * dt;
  const p00 = axis.pPosPos + 2 * dt * axis.pPosVel + dt2 * axis.pVelVel + q11;
  const p01 = axis.pPosVel + dt * axis.pVelVel + q12;
  const p11 = axis.pVelVel + q22;
  axis.pPosPos = p00;
  axis.pPosVel = p01;
  axis.pVelVel = p11;
}

function correctAxisKalman(axis: AxisKalman, measurement: number, sigmaMeas: number) {
  const r = sigmaMeas * sigmaMeas;
  const innovation = measurement - axis.pos;
  const s = axis.pPosPos + r;
  const safeS = Math.max(s, 1e-9);
  const kPos = axis.pPosPos / safeS;
  const kVel = axis.pPosVel / safeS;

  const p01Prev = axis.pPosVel;
  const p11Prev = axis.pVelVel;
  axis.pos += kPos * innovation;
  axis.vel += kVel * innovation;
  axis.pPosPos = Math.max((1 - kPos) * axis.pPosPos, 1e-8);
  axis.pPosVel = (1 - kPos) * p01Prev;
  axis.pVelVel = Math.max(p11Prev - kVel * p01Prev, 1e-8);
}

function updateGazeEstimate(target: THREE.Vector2, useEye: boolean, conf = 0, tMs = performance.now()) {
  if (!gazeEstInit) {
    gazeEstInit = true;
    gazeEstLastMs = tMs;
    gazeEstNDC.copy(target);
    gazeVelNDC.set(0, 0);
    resetAxisKalman(kalmanX, target.x, 0);
    resetAxisKalman(kalmanY, target.y, 0);
    gazeFocusNDC.copy(target);
    gazeFilterMode = useEye ? "fixation" : "fallback";
    gazeFilterModeSinceMs = tMs;
    return;
  }

  const dt = clamp((tMs - gazeEstLastMs) / 1000, 1 / 240, 0.080);
  gazeEstLastMs = tMs;
  const predX = kalmanX.pos + kalmanX.vel * dt;
  const predY = kalmanY.pos + kalmanY.vel * dt;
  const innovationX = target.x - predX;
  const innovationY = target.y - predY;
  const innovationSpeed = Math.hypot(innovationX, innovationY) / Math.max(dt, 1e-4);
  const modeAgeMs = tMs - gazeFilterModeSinceMs;

  if (!useEye) {
    setGazeFilterMode("fallback", tMs);
  } else if (gazeFilterMode !== "saccade" && innovationSpeed >= KALMAN_SACCADE_ENTER_SPEED && modeAgeMs >= KALMAN_MODE_HOLD_MS) {
    setGazeFilterMode("saccade", tMs);
  } else if (gazeFilterMode === "saccade" && innovationSpeed <= KALMAN_SACCADE_EXIT_SPEED && modeAgeMs >= KALMAN_MODE_HOLD_MS) {
    setGazeFilterMode("fixation", tMs);
  } else if (gazeFilterMode === "fallback") {
    setGazeFilterMode("fixation", tMs);
  }

  const confNorm = useEye ? clamp((conf - 0.30) / 0.55, 0, 1) : 0;
  let sigmaMeas = useEye
    ? lerp(KALMAN_MEAS_SIGMA_EYE_LOW, KALMAN_MEAS_SIGMA_EYE_HIGH, confNorm)
    : KALMAN_MEAS_SIGMA_FALLBACK;
  let sigmaAcc = useEye
    ? (gazeFilterMode === "saccade"
      ? lerp(KALMAN_ACC_SIGMA_SAC_LOW, KALMAN_ACC_SIGMA_SAC_HIGH, confNorm)
      : lerp(KALMAN_ACC_SIGMA_FIX_LOW, KALMAN_ACC_SIGMA_FIX_HIGH, confNorm))
    : KALMAN_ACC_SIGMA_FALLBACK;

  predictAxisKalman(kalmanX, dt, sigmaAcc);
  predictAxisKalman(kalmanY, dt, sigmaAcc);
  correctAxisKalman(kalmanX, target.x, sigmaMeas);
  correctAxisKalman(kalmanY, target.y, sigmaMeas);

  kalmanX.vel = clamp(kalmanX.vel, -KALMAN_VEL_LIMIT, KALMAN_VEL_LIMIT);
  kalmanY.vel = clamp(kalmanY.vel, -KALMAN_VEL_LIMIT, KALMAN_VEL_LIMIT);

  gazeEstNDC.set(
    clamp(kalmanX.pos, -1, 1),
    clamp(kalmanY.pos, -1, 1)
  );
  gazeVelNDC.set(kalmanX.vel, kalmanY.vel);
  gazeFocusNDC.copy(gazeEstNDC);
}

// ---------- WORKLOAD ENCODER STATE ----------
const PATCH_MODE_COUNT = 5;
const PATCH_MODE_LABELS = ["minimal", "text-scroll", "checker", "noise", "reading-zoom"];
let patchMode = 4; // default to reading demo
const ROI_SCALE = 0.78; // Bigger focus box for easier visual validation
const ROI_W = Math.floor(PATCH_W * ROI_SCALE);
const ROI_H = Math.floor(PATCH_H * ROI_SCALE);
const READING_ZOOM_FRAME_STATIC = true;
const READING_ZOOM_SRC_ALPHA = 0.24;
const READING_ZOOM_SRC_ALPHA_LOW_CONF = 0.12;
const READING_ZOOM_SRC_MAX_STEP_PX = 24;
const READING_ZOOM_SRC_DEADBAND_PX = 2;
let readingZoomSrcInit = false;
let readingZoomSrcX = 0;
let readingZoomSrcY = 0;

const READING_SUPERSAMPLE = 2;
const readingCanvas = document.createElement("canvas");
readingCanvas.width = PATCH_W * READING_SUPERSAMPLE;
readingCanvas.height = PATCH_H * READING_SUPERSAMPLE;
const readingCtx = readingCanvas.getContext("2d", { alpha: false });
if (!readingCtx) throw new Error("Failed to create reading demo canvas");

const FINAL_SUPERSAMPLE = 1;
const finalSceneCanvas = document.createElement("canvas");
finalSceneCanvas.width = FULL_W * FINAL_SUPERSAMPLE;
finalSceneCanvas.height = FULL_H * FINAL_SUPERSAMPLE;
const finalSceneCtx = finalSceneCanvas.getContext("2d", { alpha: false });
if (!finalSceneCtx) throw new Error("Failed to create final scene canvas");
let finalLensX = FULL_W * 0.5;
let finalLensY = FULL_H * 0.5;
let finalLensVx = 0;
let finalLensVy = 0;

function stepCriticallyDampedAxis(
  pos: number,
  vel: number,
  target: number,
  omega: number,
  dt: number
) {
  const dx = target - pos;
  let accel = (omega * omega * dx) - (2 * omega * vel);
  accel = clamp(accel, -FINAL_LENS_MAX_ACCEL, FINAL_LENS_MAX_ACCEL);
  vel = clamp(vel + accel * dt, -FINAL_LENS_MAX_SPEED, FINAL_LENS_MAX_SPEED);
  pos = pos + vel * dt;
  if (Math.abs(target - pos) < 0.35 && Math.abs(vel) < 12) {
    pos = target;
    vel = 0;
  }
  return { pos, vel };
}

function renderFinalLensOutput(
  gaze: THREE.Vector2,
  conf: number,
  timeSec: number,
  dtSec: number,
  mode: GazeFilterMode
) {
  if (!finalOutCtx) return;

  drawReadingDemoPage(finalSceneCtx, FULL_W, FULL_H, FINAL_SUPERSAMPLE, timeSec);

  finalOutCtx.save();
  finalOutCtx.filter = "blur(5.2px) saturate(0.88)";
  finalOutCtx.drawImage(
    finalSceneCanvas,
    0, 0, finalSceneCanvas.width, finalSceneCanvas.height,
    0, 0, FULL_W, FULL_H
  );
  finalOutCtx.restore();

  finalOutCtx.save();
  finalOutCtx.globalAlpha = 0.34;
  finalOutCtx.drawImage(
    finalSceneCanvas,
    0, 0, finalSceneCanvas.width, finalSceneCanvas.height,
    0, 0, FULL_W, FULL_H
  );
  finalOutCtx.restore();

  const confNorm = clamp((conf - 0.30) / 0.55, 0, 1);
  const leadSec = mode === "saccade"
    ? FINAL_LENS_LEAD_SAC_SEC
    : (mode === "fixation" ? FINAL_LENS_LEAD_FIX_SEC : FINAL_LENS_LEAD_FALLBACK_SEC);
  const leadXNorm = gazeVelNDC.x * leadSec;
  const leadYNorm = gazeVelNDC.y * leadSec;
  const targetX = clamp(((gaze.x + leadXNorm) + 1) * 0.5, 0, 1) * FULL_W;
  const targetY = clamp(((-(gaze.y + leadYNorm)) + 1) * 0.5, 0, 1) * FULL_H;
  const omegaBase = mode === "saccade"
    ? FINAL_LENS_OMEGA_SAC
    : (mode === "fixation" ? FINAL_LENS_OMEGA_FIX : FINAL_LENS_OMEGA_FALLBACK);
  const distPx = Math.hypot(targetX - finalLensX, targetY - finalLensY);
  const distBoost = clamp((distPx - 28) / 160, 0, 1);
  const omega = omegaBase * lerp(0.95, 1.20, confNorm) * lerp(1.0, 1.26, distBoost);
  const lensStepX = stepCriticallyDampedAxis(finalLensX, finalLensVx, targetX, omega, dtSec);
  const lensStepY = stepCriticallyDampedAxis(finalLensY, finalLensVy, targetY, omega, dtSec);
  finalLensX = lensStepX.pos;
  finalLensY = lensStepY.pos;
  finalLensVx = lensStepX.vel;
  finalLensVy = lensStepY.vel;

  const lensR = lerp(FINAL_LENS_MAX_RADIUS_PX, FINAL_LENS_MIN_RADIUS_PX, confNorm);

  finalOutCtx.save();
  finalOutCtx.beginPath();
  finalOutCtx.arc(finalLensX, finalLensY, lensR, 0, Math.PI * 2);
  finalOutCtx.clip();
  finalOutCtx.drawImage(
    finalSceneCanvas,
    0, 0, finalSceneCanvas.width, finalSceneCanvas.height,
    0, 0, FULL_W, FULL_H
  );
  finalOutCtx.restore();

  // Lens ring: brighter border + subtle glow to communicate the optical focus.
  finalOutCtx.save();
  const halo = finalOutCtx.createRadialGradient(
    finalLensX, finalLensY, lensR * 0.70,
    finalLensX, finalLensY, lensR * 1.12
  );
  halo.addColorStop(0, "rgba(255, 220, 140, 0.00)");
  halo.addColorStop(1, "rgba(255, 208, 120, 0.32)");
  finalOutCtx.fillStyle = halo;
  finalOutCtx.beginPath();
  finalOutCtx.arc(finalLensX, finalLensY, lensR * 1.12, 0, Math.PI * 2);
  finalOutCtx.fill();

  finalOutCtx.shadowColor = "rgba(255, 214, 130, 0.55)";
  finalOutCtx.shadowBlur = 22;
  finalOutCtx.lineWidth = 3.2;
  finalOutCtx.strokeStyle = "rgba(255, 235, 188, 0.96)";
  finalOutCtx.beginPath();
  finalOutCtx.arc(finalLensX, finalLensY, lensR, 0, Math.PI * 2);
  finalOutCtx.stroke();

  finalOutCtx.shadowBlur = 0;
  finalOutCtx.strokeStyle = "rgba(255, 255, 255, 0.62)";
  finalOutCtx.lineWidth = 1.6;
  finalOutCtx.beginPath();
  finalOutCtx.arc(finalLensX - lensR * 0.14, finalLensY - lensR * 0.14, lensR * 0.42, Math.PI * 0.94, Math.PI * 1.74);
  finalOutCtx.stroke();
  finalOutCtx.restore();
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
  const summary = buildReadingAnalysisSummary({
    reason,
    samples: ANALYSIS.samples,
    durationMs,
    calibration: ANALYSIS.calibration,
    calibrationAttempted: ANALYSIS.calibrationAttempted,
    config: {
      fullW: FULL_W,
      fullH: FULL_H,
      patchW: PATCH_W,
      patchH: PATCH_H,
      patchSensitivityX: PATCH_SENSITIVITY_X,
      patchSensitivityY: PATCH_SENSITIVITY_Y,
      analysisSurface: FINAL_SINGLE_DEMO ? "lens" : "patch",
      calibRmseAcceptMax: CALIB_RMSE_ACCEPT_MAX
    }
  });
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
  const patchCx = FINAL_SINGLE_DEMO
    ? clamp(finalLensX / FULL_W, 0, 1)
    : (patchRectN.x + patchRectN.z * 0.5);
  const patchCy = FINAL_SINGLE_DEMO
    ? clamp(finalLensY / FULL_H, 0, 1)
    : (patchRectN.y + patchRectN.w * 0.5);
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
  if (ANALYSIS.autoPipeline || ANALYSIS.running || isCalibrationRunning()) return;
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
const gaze = new MediapipeGazeProvider({ mirrorX: false, smoothAlpha: 0.20, eyeOnlyMode: true });
gaze.loadCalibrationFromStorage(CALIB_STORAGE_KEY); // se c'è, parte già calibrato
gaze.start().catch(err => {
  console.warn("Gaze provider failed, using mouse only:", err);
});

// ---------- CALIBRATION ----------
const calibrationRunner = createCalibrationRunner(gaze);

function isCalibrationRunning() {
  return calibrationRunner.isRunning();
}

async function calibrate3x3(): Promise<CalibrationRunResult> {
  return calibrationRunner.runCalibration();
}

// rect normalized (0..1) of patch in full frame (sender -> receiver)
const patchRectN = new THREE.Vector4(0, 0, PATCH_W / FULL_W, PATCH_H / FULL_H);
if (FINAL_SINGLE_DEMO) {
  patchRectN.set(0, 0, 1, 1);
}

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
const receiverComposite = FINAL_SINGLE_DEMO
  ? null
  : createReceiverComposite(cOut, {
      width: FULL_W,
      height: FULL_H,
      initialFoveaR: FOVEA_R,
      initialFeather: FEATHER
    });

function bindReceiverToLocalStreams(reason: string) {
  try {
    vLow.srcObject = new MediaStream([lowTrack]);
    vPatch.srcObject = new MediaStream([patchTrack]);
    vLow.play().catch(() => {});
    vPatch.play().catch(() => {});
    if (receiverComposite) {
      receiverComposite.setLowVideo(vLow);
      receiverComposite.setPatchVideo(vPatch);
    }
    telEvent("receiver_source_local", { reason });
  } catch (err) {
    console.warn("Local receiver binding failed:", err);
  }
}

// Bootstrap with local streams so FINAL mode is never black, even if loopback is unavailable.
bindReceiverToLocalStreams("bootstrap");

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

          receiverComposite?.setMeta(m.gaze, m.rect, m.foveaR, m.feather);
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
              receiverComposite?.setMeta(new THREE.Vector2(g[0], g[1]), new THREE.Vector4(r[0], r[1], r[2], r[3]));
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
      intervalMs: 500,
      bw: BW,
      tel: TEL,
      onEvent: telEvent
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

  receiverComposite?.setLowVideo(vLow);
  receiverComposite?.setPatchVideo(vPatch);
  telEvent("receiver_source_remote", {
    low_track_id: trackMap.low,
    patch_track_id: trackMap.patch
  });
}

// ---------- SENDER META ----------
function computePatchRectTopLeft(gaze: THREE.Vector2) {
  // Sensitivity shaping: compress patch movement against gaze to reduce perceived over-reactivity.
  const gx = clamp(gaze.x * PATCH_SENSITIVITY_X, -1, 1);
  const gy = clamp(gaze.y * PATCH_SENSITIVITY_Y, -1, 1);
  const cx = (gx * 0.5 + 0.5) * FULL_W;
  const cy = (-gy * 0.5 + 0.5) * FULL_H; // top-left origin (NDC Y+ is up, screen Y+ is down)

  // Keep this path deterministic: gazeForPatch is the Kalman-controlled signal.
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
let tickLastMs = 0;
function tick(t: number) {
  requestAnimationFrame(tick);
  frame++;
  const dtSec = tickLastMs > 0 ? clamp((t - tickLastMs) / 1000, 1 / 240, 0.080) : (1 / FPS);
  tickLastMs = t;

  // Choose gaze source: eye tracking with hysteresis + graceful fallback.
  const gf = gaze.getFrame();

  // Hysteresis on confidence.
  const eyeConf = gf.hasIris ? gf.conf : 0;
  const prevEyeLock = eyeLock;
  if (!eyeLock && eyeConf >= ENTER_CONF) eyeLock = true;
  else if (eyeLock && eyeConf <= EXIT_CONF) eyeLock = false;

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
  updateGazeEstimate(gazeNDC, useEye, eyeConf, t);
  const gazeForPatch = gazeFocusNDC;
  const hudConf = useEye ? eyeConf : 0;
  updateHudMetrics(hudConf, gazeFilterMode, t);
  updateGazeReticle(gazeForPatch, hudConf);

  update(t);

  if (FINAL_SINGLE_DEMO) {
    if (patchMode !== FINAL_PATCH_MODE) patchMode = FINAL_PATCH_MODE;
    patchRectN.set(0, 0, 1, 1);
  } else {
    computePatchRectTopLeft(gazeForPatch);
  }
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
  let roiXClamped = Math.max(0, Math.min(roiX, PATCH_W - roiW));
  let roiYClamped = Math.max(0, Math.min(roiY, PATCH_H - roiH));
  if (patchMode === 4 && READING_ZOOM_FRAME_STATIC) {
    roiXClamped = Math.floor((PATCH_W - roiW) * 0.5);
    roiYClamped = Math.floor((PATCH_H - roiH) * 0.5);
  }
  
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
    drawReadingDemoPage(readingCtx, PATCH_W, PATCH_H, READING_SUPERSAMPLE, timeSec);

    // Base layer: blurred text page in periphery for a clear foveated effect.
    ctxPatch.save();
    ctxPatch.filter = "blur(3.5px) saturate(0.92)";
    ctxPatch.drawImage(
      readingCanvas,
      0, 0, readingCanvas.width, readingCanvas.height,
      0, 0, PATCH_W, PATCH_H
    );
    ctxPatch.restore();
    ctxPatch.save();
    ctxPatch.globalAlpha = 0.36;
    ctxPatch.drawImage(
      readingCanvas,
      0, 0, readingCanvas.width, readingCanvas.height,
      0, 0, PATCH_W, PATCH_H
    );
    ctxPatch.restore();

    // Zoom source around gaze point.
    const srcW = Math.max(140, Math.floor(roiW * 0.68));
    const srcH = Math.max(140, Math.floor(roiH * 0.68));
    const srcXDesired = clamp((patchCursorX * PATCH_W) - srcW / 2, 0, PATCH_W - srcW);
    const srcYDesired = clamp((patchCursorY * PATCH_H) - srcH / 2, 0, PATCH_H - srcH);
    if (!readingZoomSrcInit) {
      readingZoomSrcInit = true;
      readingZoomSrcX = srcXDesired;
      readingZoomSrcY = srcYDesired;
    }
    const zoomConf = clamp((gf.conf - 0.45) / 0.40, 0, 1);
    const srcAlpha = lerp(READING_ZOOM_SRC_ALPHA_LOW_CONF, READING_ZOOM_SRC_ALPHA, zoomConf);
    const srcStepXRaw = srcXDesired - readingZoomSrcX;
    const srcStepYRaw = srcYDesired - readingZoomSrcY;
    const srcStepX = Math.abs(srcStepXRaw) <= READING_ZOOM_SRC_DEADBAND_PX
      ? 0
      : clamp(srcStepXRaw * srcAlpha, -READING_ZOOM_SRC_MAX_STEP_PX, READING_ZOOM_SRC_MAX_STEP_PX);
    const srcStepY = Math.abs(srcStepYRaw) <= READING_ZOOM_SRC_DEADBAND_PX
      ? 0
      : clamp(srcStepYRaw * srcAlpha, -READING_ZOOM_SRC_MAX_STEP_PX, READING_ZOOM_SRC_MAX_STEP_PX);
    readingZoomSrcX = clamp(readingZoomSrcX + srcStepX, 0, PATCH_W - srcW);
    readingZoomSrcY = clamp(readingZoomSrcY + srcStepY, 0, PATCH_H - srcH);
    const srcX = Math.round(readingZoomSrcX);
    const srcY = Math.round(readingZoomSrcY);
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

    ctxPatch.strokeStyle = "rgba(255, 217, 140, 0.82)";
    ctxPatch.lineWidth = 3;
    ctxPatch.strokeRect(roiXClamped, roiYClamped, roiW, roiH);
  }
  
  // Debug: Draw ROI border in all modes to make it visible
  if (patchMode !== 4) {
    ctxPatch.strokeStyle = patchMode === 0 ? "#333333" : "#00ff00";
    ctxPatch.lineWidth = patchMode === 0 ? 1 : 3;
    ctxPatch.strokeRect(roiXClamped, roiYClamped, roiW, roiH);
  }
  
  if (!FINAL_SINGLE_DEMO) {
    // Add mode indicator text in corner
    ctxPatch.save();
    ctxPatch.fillStyle = "#ffffff";
    ctxPatch.font = "bold 20px ui-monospace, monospace";
    ctxPatch.textAlign = "left";
    ctxPatch.textBaseline = "top";
    ctxPatch.fillText(`Mode ${patchMode}: ${PATCH_MODE_LABELS[patchMode] ?? "unknown"}`, 10, 10);
    ctxPatch.restore();
  }
  
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

  // Receiver output:
  // - FINAL_SINGLE_DEMO: render directly to cOut with a circular "lens sphere".
  // - Normal mode: shader composite from low + patch tracks.
  let recvGpu: number | null = null;
  if (FINAL_SINGLE_DEMO) {
    renderFinalLensOutput(gazeForPatch, useEye ? eyeConf : 0, timeSec, dtSec, gazeFilterMode);
  } else if (receiverComposite) {
    recvGpu = receiverComposite.render();
  }
  captureReadingAnalysisSample(t, gf, useEye, gazeNDC, gazeForPatch, gazeEstNDC, gazeFilterMode);

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

  // Keep receiver meta coherent also when DataChannel is unavailable.
  if (!FINAL_SINGLE_DEMO) {
    receiverComposite?.setMeta(gazeForPatch, patchRectN, FOVEA_R, FEATHER);
  }

  // sender meta @ ~30Hz (binary v2)
  if (loop && loop.dcSend.readyState === "open" && frame % 1 === 0) {
    const meta = encodeMetaBinary(gazeForPatch, patchRectN, useEye ? eyeConf : 0, FOVEA_R, FEATHER);
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
      TEL.gazeConf = useEye ? eyeConf : 0;
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
        conf: +(useEye ? eyeConf : 0).toFixed(3),

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
keys:       F fullscreen | H HUD | B toggle | 1 mobile | 2 balanced | 3 lan | [ ] adjust cap | T tele | D download | X clear | M workload | C auto | Shift+C calib-only | R analysis | A auto-calib+analysis
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
