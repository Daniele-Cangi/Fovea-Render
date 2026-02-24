import type { CalibrationStats } from "./calibrationStorage";

export type GazeFilterMode = "fallback" | "fixation" | "saccade";

export type ReadingAnalysisSample = {
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

export type ReadingAnalysisStopReason = "manual" | "timeout" | "aborted";

export type ReadingAnalysisOverlayState = {
  overlay: HTMLDivElement | null;
  statusEl: HTMLDivElement | null;
};

type ReadingAnalysisSummaryMetrics = {
  eye_usage_ratio: number;
  conf_mean: number;
  conf_p10: number;
  conf_p90: number;
  conf_mean_when_eye: number;
  jitter_rms_step_all: number;
  jitter_rms_step_left: number;
  jitter_rms_step_right: number;
  jitter_right_left_ratio: number | null;
  ctrl_vs_filt_mean_dist: number;
  est_vs_filt_mean_dist: number;
  ctrl_minus_filt_dx_mean: number;
  ctrl_minus_filt_dy_mean: number;
  est_minus_filt_dx_mean: number;
  est_minus_filt_dy_mean: number;
  patch_track_error_mean: number;
  patch_track_error_raw_mean: number;
  patch_bias_dx_mean: number;
  patch_bias_dy_mean: number;
  eye_dropouts: number;
};

export type ReadingAnalysisSummary = {
  version: number;
  created_at_iso: string;
  reason: ReadingAnalysisStopReason;
  duration_ms: number;
  samples: number;
  calibration: CalibrationStats | null;
  calibration_attempted: CalibrationStats | null;
  metrics: ReadingAnalysisSummaryMetrics;
  notes: string[];
};

type ReadingAnalysisSummaryConfig = {
  fullW: number;
  fullH: number;
  patchW: number;
  patchH: number;
  patchSensitivityX: number;
  patchSensitivityY: number;
  analysisSurface?: "patch" | "lens";
  calibRmseAcceptMax: number;
};

type BuildReadingAnalysisSummaryArgs = {
  reason: ReadingAnalysisStopReason;
  samples: ReadingAnalysisSample[];
  durationMs: number;
  calibration: CalibrationStats | null;
  calibrationAttempted: CalibrationStats | null;
  config: ReadingAnalysisSummaryConfig;
};

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function ensureReadingAnalysisOverlay(state: ReadingAnalysisOverlayState) {
  if (state.overlay && state.statusEl) return;
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
  state.overlay = o;
  state.statusEl = o.querySelector("#analysis-status") as HTMLDivElement;
}

export function setReadingAnalysisStatus(
  state: ReadingAnalysisOverlayState,
  msg: string,
  visible = true
) {
  ensureReadingAnalysisOverlay(state);
  if (state.statusEl) state.statusEl.textContent = msg;
  if (state.overlay) state.overlay.style.display = visible ? "block" : "none";
}

export function hideReadingAnalysisStatus(
  state: ReadingAnalysisOverlayState,
  isRunning: boolean,
  delayMs = 0
) {
  ensureReadingAnalysisOverlay(state);
  if (delayMs <= 0) {
    if (!isRunning && state.overlay) state.overlay.style.display = "none";
    return;
  }
  window.setTimeout(() => {
    if (!isRunning && state.overlay) state.overlay.style.display = "none";
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

function gazeToPatchCenterNorm(
  config: ReadingAnalysisSummaryConfig,
  gazeX: number,
  gazeY: number
) {
  const gx = clamp(gazeX * config.patchSensitivityX, -1, 1);
  const gy = clamp(gazeY * config.patchSensitivityY, -1, 1);
  const minCx = (config.patchW * 0.5) / config.fullW;
  const maxCx = 1 - minCx;
  const minCy = (config.patchH * 0.5) / config.fullH;
  const maxCy = 1 - minCy;
  const cx = clamp(gx * 0.5 + 0.5, minCx, maxCx);
  const cy = clamp((-gy) * 0.5 + 0.5, minCy, maxCy);
  return { cx, cy };
}

export function buildReadingAnalysisSummary(
  args: BuildReadingAnalysisSummaryArgs
): ReadingAnalysisSummary {
  const { reason, samples, durationMs, calibration, calibrationAttempted, config } = args;
  const useLensSurface = config.analysisSurface === "lens";
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
  const ctrlMinusFiltDx = mean(samples.map((s) => s.ctrl_x - s.filt_x));
  const ctrlMinusFiltDy = mean(samples.map((s) => s.ctrl_y - s.filt_y));
  const estMinusFiltDx = mean(samples.map((s) => s.est_x - s.filt_x));
  const estMinusFiltDy = mean(samples.map((s) => s.est_y - s.filt_y));
  const patchTrackErrRaw = mean(samples.map((s) => {
    const nx = (s.filt_x + 1) * 0.5;
    const ny = (-s.filt_y + 1) * 0.5;
    return Math.hypot(nx - s.patch_cx, ny - s.patch_cy);
  }));
  const patchTrackErr = useLensSurface
    ? patchTrackErrRaw
    : mean(samples.map((s) => {
      const expected = gazeToPatchCenterNorm(config, s.filt_x, s.filt_y);
      return Math.hypot(expected.cx - s.patch_cx, expected.cy - s.patch_cy);
    }));
  const patchBiasDx = mean(samples.map((s) => {
    const expected = useLensSurface
      ? { cx: (s.filt_x + 1) * 0.5, cy: (-s.filt_y + 1) * 0.5 }
      : gazeToPatchCenterNorm(config, s.filt_x, s.filt_y);
    return expected.cx - s.patch_cx;
  }));
  const patchBiasDy = mean(samples.map((s) => {
    const expected = useLensSurface
      ? { cx: (s.filt_x + 1) * 0.5, cy: (-s.filt_y + 1) * 0.5 }
      : gazeToPatchCenterNorm(config, s.filt_x, s.filt_y);
    return expected.cy - s.patch_cy;
  }));
  const dropouts = countEyeDropouts(samples);

  const notes: string[] = [];
  if (eyeUsageRatio < 0.70) notes.push("Eye lock debole: troppi fallback o perdita confidenza.");
  if (rightLeftRatio != null && rightLeftRatio > 1.20) notes.push("Instabilita maggiore a destra rispetto a sinistra.");
  if (estVsFilt > 0.038) notes.push("Filtro troppo conservativo: si percepisce ritardo durante i movimenti.");
  const trackErrForNotes = useLensSurface ? patchTrackErrRaw : patchTrackErr;
  if (trackErrForNotes > (useLensSurface ? 0.045 : 0.040)) {
    notes.push("Lag/mismatch visibile tra gaze filtrato e centro patch.");
  }
  if (Math.abs(ctrlMinusFiltDy) > 0.010) {
    notes.push(`Bias direzionale verticale: filtrato mediamente verso ${ctrlMinusFiltDy > 0 ? "l'alto" : "il basso"}.`);
  }
  if (Math.abs(ctrlMinusFiltDx) > 0.010) {
    notes.push(`Bias direzionale orizzontale: filtrato mediamente verso ${ctrlMinusFiltDx > 0 ? "destra" : "sinistra"}.`);
  }
  if (percentile(confVals, 0.10) < 0.25) notes.push("Confidenza spesso bassa: migliorare luce e posizione camera.");
  if (!calibration) notes.push("Calibrazione attiva non disponibile nel report: run considerato diagnostico.");
  if (calibration?.tier === "provisional") notes.push("Calibrazione provvisoria in uso: ripetere calibrazione per una baseline piu robusta.");
  if (calibration && calibration.rmse > config.calibRmseAcceptMax) notes.push("Calibrazione in uso debole: ripetere calibrazione prima del tuning fine.");
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
      ctrl_minus_filt_dx_mean: +ctrlMinusFiltDx.toFixed(6),
      ctrl_minus_filt_dy_mean: +ctrlMinusFiltDy.toFixed(6),
      est_minus_filt_dx_mean: +estMinusFiltDx.toFixed(6),
      est_minus_filt_dy_mean: +estMinusFiltDy.toFixed(6),
      patch_track_error_mean: +patchTrackErr.toFixed(6),
      patch_track_error_raw_mean: +patchTrackErrRaw.toFixed(6),
      patch_bias_dx_mean: +patchBiasDx.toFixed(6),
      patch_bias_dy_mean: +patchBiasDy.toFixed(6),
      eye_dropouts: dropouts
    },
    notes
  };
}
