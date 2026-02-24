import type { GazeSample, MediapipeGazeProvider } from "@fovea-render/gaze-mediapipe";
import {
  CALIB_MAXERR_PROVISIONAL_MAX,
  CALIB_RMSE_ACCEPT_MAX,
  CALIB_RMSE_PROVISIONAL_MAX,
  CALIB_SIDE_RATIO_MAX,
  CALIB_SIDE_RATIO_PROVISIONAL_MAX,
  CALIB_SIDE_RMSE_MAX,
  CALIB_SIDE_RMSE_PROVISIONAL_MAX,
  CALIB_STORAGE_KEY,
  loadCalibrationStatsFromStorage,
  saveCalibrationStatsToStorage,
  type CalibrationRunResult,
  type CalibrationStats
} from "./calibrationStorage";

type CalibrationMatrix = {
  ax: number; bx: number; cx: number;
  ay: number; by: number; cy: number;
  pxy?: number; pxx?: number; pyy?: number;
  qxy?: number; qxx?: number; qyy?: number;
};

type CalibrationSample = {
  rx: number;
  ry: number;
  x: number;
  y: number;
  w: number;
};

type CalibrationOverlay = {
  overlay: HTMLDivElement;
  dot: HTMLDivElement;
  status: HTMLDivElement;
};

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function makeCalibrationOverlay(): CalibrationOverlay {
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

function projectCalibration(m: CalibrationMatrix, rx: number, ry: number) {
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const rxy = rx * ry;
  const px = m.ax + m.bx * rx + m.cx * ry + (m.pxy ?? 0) * rxy + (m.pxx ?? 0) * rx2 + (m.pyy ?? 0) * ry2;
  const py = m.ay + m.by * rx + m.cy * ry + (m.qxy ?? 0) * rxy + (m.qxx ?? 0) * rx2 + (m.qyy ?? 0) * ry2;
  return { x: px, y: py };
}

function evalCalibration(samples: CalibrationSample[], m: CalibrationMatrix) {
  let se = 0;
  let maxErr = 0;
  let seLeft = 0;
  let seRight = 0;
  let nLeft = 0;
  let nRight = 0;
  for (const s of samples) {
    const pr = projectCalibration(m, s.rx, s.ry);
    const dx = pr.x - s.x;
    const dy = pr.y - s.y;
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

function makeTargets() {
  const grid = [-0.82, -0.41, 0.0, 0.41, 0.82];
  const targets: { x: number; y: number }[] = [];
  for (let yi = 0; yi < grid.length; yi++) {
    const ys = grid[yi];
    const xs = (yi % 2 === 0) ? grid : [...grid].reverse();
    for (const x of xs) targets.push({ x, y: ys });
  }
  return targets;
}

type CalibrationRunner = {
  isRunning: () => boolean;
  runCalibration: () => Promise<CalibrationRunResult>;
};

export function createCalibrationRunner(gaze: MediapipeGazeProvider): CalibrationRunner {
  const overlay = makeCalibrationOverlay();
  let running = false;

  async function runCalibration(): Promise<CalibrationRunResult> {
    if (running) {
      return {
        ok: false,
        aborted: false,
        qualityRejected: false,
        stats: null,
        appliedStats: loadCalibrationStatsFromStorage()
      };
    }

    running = true;
    overlay.overlay.style.display = "block";
    overlay.status.textContent = "Calibration started…";
    const prevCalibStorage = localStorage.getItem(CALIB_STORAGE_KEY);
    const prevCalibStats = prevCalibStorage != null ? loadCalibrationStatsFromStorage() : null;
    let result: CalibrationRunResult = {
      ok: false,
      aborted: false,
      qualityRejected: false,
      stats: null,
      appliedStats: prevCalibStats
    };

    const waitMs = 460;
    const maxFrames = 140;
    const minGoodFrames = 34;
    const goodConf = 0.40;
    const stableStdTarget = 0.017;
    const stableStdRelaxed = 0.024;

    const targets = makeTargets();
    const samples: CalibrationSample[] = [];
    const abort = { v: false };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") abort.v = true; };
    window.addEventListener("keydown", onKey);

    try {
      for (let idx = 0; idx < targets.length; idx++) {
        const t = targets[idx];
        if (abort.v) break;

        overlay.status.textContent = `Point ${idx + 1}/${targets.length} — keep gaze steady`;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sx = ((t.x + 1) * 0.5) * vw;
        const sy = ((-t.y + 1) * 0.5) * vh;
        overlay.dot.style.left = `${sx}px`;
        overlay.dot.style.top = `${sy}px`;

        await new Promise((r) => setTimeout(r, waitMs));

        let captured = false;
        for (let attempt = 1; attempt <= 2 && !captured && !abort.v; attempt++) {
          const acc: GazeSample[] = [];
          let irisFrames = 0;
          for (let i = 0; i < maxFrames; i++) {
            if (abort.v) break;
            const f = gaze.getFrame();
            if (!f.hasIris) {
              await new Promise((r) => requestAnimationFrame(() => r(null)));
              continue;
            }
            irisFrames++;
            const rawUnmirrored = gaze.getRawUnmirrored();
            acc.push({ rawX: rawUnmirrored.rawX, rawY: rawUnmirrored.rawY, t: performance.now(), conf: f.conf });

            if ((i % 6) === 0) {
              const goodNow = acc.filter((s) => s.conf >= goodConf);
              if (goodNow.length >= minGoodFrames) {
                const sxNow = robustStd(goodNow.map((s) => s.rawX));
                const syNow = robustStd(goodNow.map((s) => s.rawY));
                if (sxNow <= stableStdTarget && syNow <= stableStdTarget) break;
              }
            }
            await new Promise((r) => requestAnimationFrame(() => r(null)));
          }

          const good = acc.filter((s) => s.conf >= goodConf);
          const fallback = acc.filter((s) => s.conf >= 0.30);
          const use = good.length >= minGoodFrames ? good : fallback;
          if (use.length < 12) {
            overlay.status.textContent = `Point ${idx + 1}/${targets.length} low confidence/iris (${irisFrames} iris frames), retry ${attempt}/2`;
            await new Promise((r) => setTimeout(r, 220));
            continue;
          }

          const rx = robustMean(use.map((s) => s.rawX));
          const ry = robustMean(use.map((s) => s.rawY));
          const meanConf = robustMean(use.map((s) => s.conf));
          const sxUse = robustStd(use.map((s) => s.rawX));
          const syUse = robustStd(use.map((s) => s.rawY));
          const stable = Math.max(sxUse, syUse) <= stableStdRelaxed || meanConf >= 0.65;

          if (!stable && attempt < 2) {
            overlay.status.textContent = `Point ${idx + 1}/${targets.length} unstable (${Math.max(sxUse, syUse).toFixed(3)}), retry`;
            await new Promise((r) => setTimeout(r, 220));
            continue;
          }

          const weight = clamp(meanConf * meanConf + 0.15, 0.10, 2.50);
          samples.push({ rx, ry, x: t.x, y: t.y, w: weight });
          overlay.status.textContent = `Point ${idx + 1}/${targets.length} captured (conf ${meanConf.toFixed(2)}, std ${Math.max(sxUse, syUse).toFixed(3)})`;
          captured = true;
        }
      }

      if (abort.v) {
        overlay.status.textContent = "Calibration aborted.";
        result = { ok: false, aborted: true, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
        await new Promise((r) => setTimeout(r, 350));
      } else if (samples.length >= 18) {
        let m = gaze.fitAndSetCalibration(samples);
        if (m) {
          const first = evalCalibration(samples, m);
          const thr = Math.max(0.18, first.rmse * 1.9);
          const inliers = samples.filter((s) => {
            const p = projectCalibration(m!, s.rx, s.ry);
            const dx = p.x - s.x;
            const dy = p.y - s.y;
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
            if (prevCalibStorage != null) {
              localStorage.setItem(CALIB_STORAGE_KEY, prevCalibStorage);
              if (!gaze.loadCalibrationFromStorage(CALIB_STORAGE_KEY)) gaze.clearCalibration(CALIB_STORAGE_KEY);
            } else {
              gaze.clearCalibration(CALIB_STORAGE_KEY);
            }
            saveCalibrationStatsToStorage(prevCalibStats);
            if (rejectByRmse) {
              overlay.status.textContent = `Calibration rejected. RMSE ${stats.rmse.toFixed(3)} > ${CALIB_RMSE_ACCEPT_MAX.toFixed(2)}.`;
            } else {
              overlay.status.textContent = `Calibration rejected. L/R imbalance ${sideRatio.toFixed(2)} (worst ${sideWorst.toFixed(3)}).`;
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
              overlay.status.textContent =
                `Calibration provisional. RMSE ${stats.rmse.toFixed(3)} (<= ${CALIB_RMSE_PROVISIONAL_MAX.toFixed(2)}), L/R ${l}/${r}`;
            } else if (stats.leftRmse != null && stats.rightRmse != null && stats.rightRmse > stats.leftRmse * 1.35) {
              overlay.status.textContent = `Calibration saved. RMSE ${stats.rmse.toFixed(3)} L/R ${l}/${r} (right weaker)`;
            } else {
              overlay.status.textContent = `Calibration saved. RMSE ${stats.rmse.toFixed(3)} L/R ${l}/${r} max ${stats.maxErr.toFixed(3)} points ${samples.length}`;
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
          overlay.status.textContent = "Calibration failed. Retry.";
          result = { ok: false, aborted: false, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
        }
        console.log("Calibration matrix:", m);
        await new Promise((r) => setTimeout(r, 550));
      } else {
        overlay.status.textContent = "Not enough valid samples. Retry with better lighting.";
        result = { ok: false, aborted: false, qualityRejected: false, stats: null, appliedStats: prevCalibStats };
        await new Promise((r) => setTimeout(r, 650));
      }
    } finally {
      window.removeEventListener("keydown", onKey);
      overlay.overlay.style.display = "none";
      running = false;
    }

    return result;
  }

  return {
    isRunning: () => running,
    runCalibration
  };
}
