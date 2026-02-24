import { FaceMesh } from "@mediapipe/face_mesh";
import { Camera } from "@mediapipe/camera_utils";
import { OneEuroFilter } from "./OneEuro";

export type GazeSample = { rawX: number; rawY: number; t: number; conf: number };
export type CalibMatrix = {
  ax: number; bx: number; cx: number;
  ay: number; by: number; cy: number;
  // Optional second-order terms for asymmetric/nonlinear calibration.
  // x += pxy*rx*ry + pxx*rx^2 + pyy*ry^2
  // y += qxy*rx*ry + qxx*rx^2 + qyy*ry^2
  pxy?: number; pxx?: number; pyy?: number;
  qxy?: number; qxx?: number; qyy?: number;
  model?: "affine" | "poly2";
};

export type GazeFrame = {
  gazeX: number; gazeY: number;     // NDC (-1..1)
  rawX: number; rawY: number;       // uncalibrated
  conf: number;                     // 0..1
  hasIris: boolean;
};

export type MediapipeGazeOptions = {
  mirrorX?: boolean;
  smoothAlpha?: number;             // EMA
  locateFileBase?: string;          // where to load wasm/assets from
  video?: HTMLVideoElement;         // optional
  eyeOnlyMode?: boolean;            // true: gaze driven only by iris/eyes
};

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseCalibrationMatrix(raw: unknown): CalibMatrix | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (
    !isFiniteNumber(obj.ax) || !isFiniteNumber(obj.bx) || !isFiniteNumber(obj.cx) ||
    !isFiniteNumber(obj.ay) || !isFiniteNumber(obj.by) || !isFiniteNumber(obj.cy)
  ) {
    return null;
  }

  const m: CalibMatrix = {
    ax: obj.ax,
    bx: obj.bx,
    cx: obj.cx,
    ay: obj.ay,
    by: obj.by,
    cy: obj.cy
  };

  if (obj.pxy != null && !isFiniteNumber(obj.pxy)) return null;
  if (obj.pxx != null && !isFiniteNumber(obj.pxx)) return null;
  if (obj.pyy != null && !isFiniteNumber(obj.pyy)) return null;
  if (obj.qxy != null && !isFiniteNumber(obj.qxy)) return null;
  if (obj.qxx != null && !isFiniteNumber(obj.qxx)) return null;
  if (obj.qyy != null && !isFiniteNumber(obj.qyy)) return null;
  if (obj.model != null && obj.model !== "affine" && obj.model !== "poly2") return null;

  if (isFiniteNumber(obj.pxy)) m.pxy = obj.pxy;
  if (isFiniteNumber(obj.pxx)) m.pxx = obj.pxx;
  if (isFiniteNumber(obj.pyy)) m.pyy = obj.pyy;
  if (isFiniteNumber(obj.qxy)) m.qxy = obj.qxy;
  if (isFiniteNumber(obj.qxx)) m.qxx = obj.qxx;
  if (isFiniteNumber(obj.qyy)) m.qyy = obj.qyy;
  if (obj.model === "affine" || obj.model === "poly2") m.model = obj.model;

  return m;
}

function avg5(landmarks: any[], i0: number) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 5; i++) { x += landmarks[i0 + i].x; y += landmarks[i0 + i].y; z += (landmarks[i0 + i].z ?? 0); }
  return { x: x / 5, y: y / 5, z: z / 5 };
}

function dist2(a: any, b: any) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

type CalibFitSample = {
  rx: number;
  ry: number;
  x: number;
  y: number;
  w?: number;
};

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  if (n === 0 || b.length !== n) return null;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }

    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row) => row[n]);
}

function projectCalib(m: CalibMatrix, rx: number, ry: number) {
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const rxy = rx * ry;
  const x =
    m.ax + m.bx * rx + m.cx * ry +
    (m.pxy ?? 0) * rxy + (m.pxx ?? 0) * rx2 + (m.pyy ?? 0) * ry2;
  const y =
    m.ay + m.by * rx + m.cy * ry +
    (m.qxy ?? 0) * rxy + (m.qxx ?? 0) * rx2 + (m.qyy ?? 0) * ry2;
  return { x, y };
}

function solveAffineWeighted(samples: CalibFitSample[]): CalibMatrix | null {
  if (samples.length < 6) return null;

  // Weighted normal equations for:
  // x = ax + bx*rx + cx*ry
  // y = ay + by*rx + cy*ry
  let s00=0,s01=0,s02=0,s11=0,s12=0,s22=0;
  let bx0=0,bx1=0,bx2=0;
  let by0=0,by1=0,by2=0;

  for (const p of samples) {
    const w = clamp(typeof p.w === "number" ? p.w : 1, 0.05, 4.0);
    const a0 = 1, a1 = p.rx, a2 = p.ry;
    s00 += w*a0*a0; s01 += w*a0*a1; s02 += w*a0*a2;
    s11 += w*a1*a1; s12 += w*a1*a2; s22 += w*a2*a2;
    bx0 += w*a0*p.x; bx1 += w*a1*p.x; bx2 += w*a2*p.x;
    by0 += w*a0*p.y; by1 += w*a1*p.y; by2 += w*a2*p.y;
  }

  const A00=s00,A01=s01,A02=s02,A10=s01,A11=s11,A12=s12,A20=s02,A21=s12,A22=s22;
  const det =
    A00*(A11*A22 - A12*A21) -
    A01*(A10*A22 - A12*A20) +
    A02*(A10*A21 - A11*A20);
  if (Math.abs(det) < 1e-9) return null;

  const inv00 =  (A11*A22 - A12*A21)/det;
  const inv01 = -(A01*A22 - A02*A21)/det;
  const inv02 =  (A01*A12 - A02*A11)/det;
  const inv10 = -(A10*A22 - A12*A20)/det;
  const inv11 =  (A00*A22 - A02*A20)/det;
  const inv12 = -(A00*A12 - A02*A10)/det;
  const inv20 =  (A10*A21 - A11*A20)/det;
  const inv21 = -(A00*A21 - A01*A20)/det;
  const inv22 =  (A00*A11 - A01*A10)/det;

  const ax = inv00*bx0 + inv01*bx1 + inv02*bx2;
  const bx = inv10*bx0 + inv11*bx1 + inv12*bx2;
  const cx = inv20*bx0 + inv21*bx1 + inv22*bx2;
  const ay = inv00*by0 + inv01*by1 + inv02*by2;
  const by_ = inv10*by0 + inv11*by1 + inv12*by2;
  const cy = inv20*by0 + inv21*by1 + inv22*by2;
  return { ax, bx, cx, ay, by: by_, cy, model: "affine" };
}

function solvePoly2Weighted(samples: CalibFitSample[]): CalibMatrix | null {
  if (samples.length < 10) return null;
  const n = 6;
  const S: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const bx = Array(n).fill(0);
  const by = Array(n).fill(0);

  for (const p of samples) {
    const w = clamp(typeof p.w === "number" ? p.w : 1, 0.05, 4.0);
    const phi = [1, p.rx, p.ry, p.rx * p.ry, p.rx * p.rx, p.ry * p.ry];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) S[i][j] += w * phi[i] * phi[j];
      bx[i] += w * phi[i] * p.x;
      by[i] += w * phi[i] * p.y;
    }
  }

  const tx = solveLinearSystem(S, bx);
  const ty = solveLinearSystem(S, by);
  if (!tx || !ty) return null;

  return {
    ax: tx[0], bx: tx[1], cx: tx[2], pxy: tx[3], pxx: tx[4], pyy: tx[5],
    ay: ty[0], by: ty[1], cy: ty[2], qxy: ty[3], qxx: ty[4], qyy: ty[5],
    model: "poly2"
  };
}

function fitResidual(p: CalibFitSample, m: CalibMatrix) {
  const pr = projectCalib(m, p.rx, p.ry);
  const px = pr.x;
  const py = pr.y;
  const dx = px - p.x;
  const dy = py - p.y;
  return Math.sqrt(dx*dx + dy*dy);
}

function fitStats(samples: CalibFitSample[], m: CalibMatrix) {
  if (samples.length === 0) return { rmse: Infinity, maxErr: Infinity };
  let se = 0;
  let maxErr = 0;
  for (const p of samples) {
    const e = fitResidual(p, m);
    se += e * e;
    if (e > maxErr) maxErr = e;
  }
  return { rmse: Math.sqrt(se / samples.length), maxErr };
}

function chooseModel(samples: CalibFitSample[]) {
  const affine = solveAffineWeighted(samples);
  const poly = solvePoly2Weighted(samples);
  if (!affine && !poly) return null;
  if (!affine) return { model: poly!, kind: "poly2" as const };
  if (!poly) return { model: affine, kind: "affine" as const };

  const a = fitStats(samples, affine);
  const p = fitStats(samples, poly);
  const polyBetterRmse = p.rmse <= a.rmse * 0.93;
  const polyNotWorseTail = p.maxErr <= a.maxErr * 1.02;
  if (polyBetterRmse && polyNotWorseTail) return { model: poly, kind: "poly2" as const };
  return { model: affine, kind: "affine" as const };
}

// Solve robust weighted calibration model with complexity guard.
function fitAffine(samples: CalibFitSample[]): CalibMatrix | null {
  if (samples.length < 6) return null;

  let active = samples.slice();
  let picked = chooseModel(active);
  if (!picked) return null;
  let model = picked.model;
  let kind = picked.kind;

  // Robust refinement: remove points with large residuals and refit.
  for (let iter = 0; iter < 2; iter++) {
    const errs = active.map((p) => fitResidual(p, model!)).sort((a, b) => a - b);
    if (errs.length < 6) break;

    const med = errs[Math.floor(errs.length * 0.5)];
    const thr = Math.max(0.06, med * 2.8);
    const filtered = active.filter((p) => fitResidual(p, model!) <= thr);

    if (filtered.length < 6 || filtered.length === active.length) break;

    const nextPicked = kind === "poly2"
      ? (chooseModel(filtered) ?? { model: solveAffineWeighted(filtered), kind: "affine" as const })
      : (chooseModel(filtered) ?? { model: solveAffineWeighted(filtered), kind: "affine" as const });
    const next = nextPicked?.model ?? null;
    if (!next) break;
    active = filtered;
    model = next;
    kind = nextPicked.kind;
  }

  return model;
}

export class MediapipeGazeProvider {
  opts: Required<MediapipeGazeOptions>;
  video: HTMLVideoElement;
  faceMesh!: FaceMesh;
  cam!: Camera;

  private _rawX = 0;
  private _rawY = 0;
  private _rawXUnmirrored = 0;  // Store unmirrored for calibration
  private _rawYUnmirrored = 0;
  private _gazeX = 0;
  private _gazeY = 0;
  private _conf = 0;
  private _hasIris = false;

  private _calib: CalibMatrix | null = null;

  private fx = new OneEuroFilter({ minCutoff: 0.75, beta: 0.045, dCutoff: 1.0 });
  private fy = new OneEuroFilter({ minCutoff: 0.75, beta: 0.045, dCutoff: 1.0 });

  constructor(opts: MediapipeGazeOptions = {}) {
    this.opts = {
      mirrorX: opts.mirrorX ?? true,
      smoothAlpha: opts.smoothAlpha ?? 0.18,
      locateFileBase: opts.locateFileBase ?? "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/",
      eyeOnlyMode: opts.eyeOnlyMode ?? true,
      video: opts.video ?? (() => {
        const v = document.createElement("video");
        v.autoplay = true; v.playsInline = true; v.muted = true;
        v.style.display = "none";
        document.body.appendChild(v);
        return v;
      })()
    };
    this.video = this.opts.video;
  }

  loadCalibrationFromStorage(key = "fovea.calib.v2") {
    try {
      const s = localStorage.getItem(key);
      if (!s) return false;
      const parsed = parseCalibrationMatrix(JSON.parse(s));
      if (parsed) { this._calib = parsed; return true; }
      return false;
    } catch { return false; }
  }

  saveCalibrationToStorage(key = "fovea.calib.v2") {
    if (!this._calib) return false;
    localStorage.setItem(key, JSON.stringify(this._calib));
    return true;
  }

  clearCalibration(key = "fovea.calib.v2") {
    this._calib = null;
    localStorage.removeItem(key);
  }

  setCalibration(m: CalibMatrix | null) { this._calib = m; }

  fitAndSetCalibration(samples: CalibFitSample[]) {
    const m = fitAffine(samples);
    if (m) this._calib = m;
    return m;
  }

  getFrame(): GazeFrame {
    return {
      gazeX: this._gazeX, gazeY: this._gazeY,
      rawX: this._rawX, rawY: this._rawY,  // Note: rawX is already mirror-applied if mirrorX is true
      conf: this._conf,
      hasIris: this._hasIris
    };
  }

  // Get raw values BEFORE mirroring (for calibration)
  getRawUnmirrored(): { rawX: number; rawY: number } {
    return { rawX: this._rawXUnmirrored, rawY: this._rawYUnmirrored };
  }

  async start() {
    this.faceMesh = new FaceMesh({
      locateFile: (file) => `${this.opts.locateFileBase}${file}`
    });

    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    this.faceMesh.onResults((results: any) => this.onResults(results));

    this.cam = new Camera(this.video, {
      onFrame: async () => {
        await this.faceMesh.send({ image: this.video });
      },
      width: 640,
      height: 480
    });

    await this.cam.start();
  }

  private onResults(results: any) {
    const alpha = clamp(this.opts.smoothAlpha, 0.05, 0.40);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      // drop confidence smoothly
      this._conf = lerp(this._conf, 0, Math.max(0.08, alpha * 0.65));
      return;
    }

    const lm = results.multiFaceLandmarks[0];

    // --- IRIS proxy (refineLandmarks gives 10 extra points) ---
    let irisX = 0, irisY = 0;
    let irisConsistency = 0;
    let openConf = 0;
    let eyeGeomConf = 0;
    let hasIris = lm.length >= 478;

    if (hasIris) {
      // groups of 5: 468..472 and 473..477 (assign by x)
      const cA = avg5(lm, 468);
      const cB = avg5(lm, 473);
      const leftIris = (cA.x < cB.x) ? cA : cB;
      const rightIris = (cA.x < cB.x) ? cB : cA;

      // eye corners
      const l0 = lm[33], l1 = lm[133];
      const r0 = lm[362], r1 = lm[263];

      const lw = Math.max(1e-6, Math.abs(l1.x - l0.x));
      const rw = Math.max(1e-6, Math.abs(r1.x - r0.x));

      const lmidX = (l0.x + l1.x) * 0.5;
      const rmidX = (r0.x + r1.x) * 0.5;

      // eyelids for y normalization
      const lu = lm[159], ll = lm[145];
      const ru = lm[386], rl = lm[374];

      const lh = Math.max(1e-6, Math.abs(ll.y - lu.y));
      const rh = Math.max(1e-6, Math.abs(rl.y - ru.y));

      const lmidY = (lu.y + ll.y) * 0.5;
      const rmidY = (ru.y + rl.y) * 0.5;

      const lx = (leftIris.x - lmidX) / lw;   // ~[-0.5..0.5]
      const rx = (rightIris.x - rmidX) / rw;

      const ly = (leftIris.y - lmidY) / lh;
      const ry = (rightIris.y - rmidY) / rh;
      // Compensate in-plane roll per eye, then fuse robustly.
      const lTheta = Math.atan2(l1.y - l0.y, l1.x - l0.x);
      const rTheta = Math.atan2(r1.y - r0.y, r1.x - r0.x);
      const lCos = Math.cos(lTheta), lSin = Math.sin(lTheta);
      const rCos = Math.cos(rTheta), rSin = Math.sin(rTheta);
      const lxr = lx * lCos + ly * lSin;
      const lyr = -lx * lSin + ly * lCos;
      const rxr = rx * rCos + ry * rSin;
      const ryr = -rx * rSin + ry * rCos;

      const xAgree = 1.0 - clamp(Math.abs(lxr - rxr) / 0.32, 0, 1);
      const yAgree = 1.0 - clamp(Math.abs(lyr - ryr) / 0.36, 0, 1);
      irisConsistency = clamp(0.68 * xAgree + 0.32 * yAgree, 0, 1);

      const lOpenConf = clamp((lh - 0.010) / 0.022, 0, 1);
      const rOpenConf = clamp((rh - 0.010) / 0.022, 0, 1);
      openConf = (lOpenConf + rOpenConf) * 0.5;

      const lGeom = clamp((lw - 0.030) / 0.050, 0, 1);
      const rGeom = clamp((rw - 0.030) / 0.050, 0, 1);
      eyeGeomConf = (lGeom + rGeom) * 0.5;

      let wl = Math.max(0.05, lOpenConf * lGeom);
      let wr = Math.max(0.05, rOpenConf * rGeom);
      if (Math.abs(lxr - rxr) > 0.34 || Math.abs(lyr - ryr) > 0.40) {
        if (wl > wr * 1.20) wr *= 0.35;
        else if (wr > wl * 1.20) wl *= 0.35;
      }
      const wsum = Math.max(1e-6, wl + wr);
      const bx = (lxr * wl + rxr * wr) / wsum;
      const by = (lyr * wl + ryr * wr) / wsum;

      // Gains chosen for eye-only drive. Keep Y a bit more conservative.
      irisX = clamp(bx * 1.05, -1.35, 1.35);
      irisY = clamp(by * 0.98, -1.35, 1.35);
    }

    this._hasIris = hasIris;

    // --- RAW gaze ---
    // Eye-only mode: no head contribution in gaze signal.
    let rawX = irisX;
    let rawY = irisY;
    if (!this.opts.eyeOnlyMode) {
      const nose = lm[1]; // nose tip
      const headX = (nose.x - 0.5) * 2.2;
      const headY = (nose.y - 0.5) * 2.2;
      const headW = hasIris ? 0.28 : 0.95;
      const irisW = hasIris ? (1.20 + 0.20 * irisConsistency) : 0.0;
      rawX = headX * headW + irisX * irisW;
      rawY = headY * (headW * 1.15) + irisY * (irisW * 0.95);
    }

    // Store unmirrored for calibration
    this._rawXUnmirrored = rawX;
    this._rawYUnmirrored = rawY;

    // confidence heuristic
    // face size proxy (cheekbones)
    const cheekL = lm[234], cheekR = lm[454];
    const faceW = dist2(cheekL, cheekR);           // ~0..1
    const sizeConf = clamp((faceW - 0.12) / 0.20, 0, 1);

    if (!hasIris) openConf = 0;

    let conf = this.opts.eyeOnlyMode
      ? (0.22 * sizeConf + 0.33 * openConf + 0.30 * irisConsistency + 0.15 * eyeGeomConf)
      : (0.45 * sizeConf + 0.25 * openConf + (hasIris ? (0.20 + 0.10 * irisConsistency) : 0.0));
    if (this.opts.eyeOnlyMode && !hasIris) conf *= 0.10;
    if (this.opts.eyeOnlyMode && hasIris) {
      const quality = clamp(0.58 * irisConsistency + 0.42 * openConf, 0, 1);
      conf = (0.06 + conf * 1.14) * lerp(0.80, 1.02, quality);
    }
    conf = clamp(conf, 0, 1);

    // apply calibration BEFORE mirroring (calibration is done on non-mirrored raw values)
    let gx = rawX, gy = rawY;
    if (this._calib) {
      const p = projectCalib(this._calib, rawX, rawY);
      gx = p.x;
      gy = p.y;
    }

    // mirror feel (like webcam preview) - apply AFTER calibration
    if (this.opts.mirrorX) gx = -gx;

    // NOTE: Y axis NOT inverted here - conversion to screen coords happens later in main.ts
    // MediaPipe Y: 0 (top) to 1 (bottom) → normalized to -1.1 (top) to +1.1 (bottom)
    // This matches the conversion logic in computePatchRectTopLeft() which does: cy = (-gaze.y * 0.5 + 0.5) * FULL_H

    // clamp to NDC-ish
    gx = clamp(gx, -1, 1);
    gy = clamp(gy, -1, 1);

    const tMs = performance.now();

    // raw (light smoothing for calibration/debug channels)
    this._rawX = lerp(this._rawX, rawX, alpha);
    this._rawY = lerp(this._rawY, rawY, alpha);

    // gaze One-Euro (vero)
    if (this._conf < 0.05) {
      // se era "morto", re-inizializza per evitare scatti quando torna
      this.fx.reset(gx, tMs);
      this.fy.reset(gy, tMs);
      this._gazeX = gx;
      this._gazeY = gy;
    } else {
      const nextX = this.fx.filter(gx, tMs);
      const nextY = this.fy.filter(gy, tMs);

      // Suppress tiny micro-jitter while keeping responsiveness on real saccades.
      const dx = nextX - this._gazeX;
      const dy = nextY - this._gazeY;
      const speed = Math.sqrt(dx * dx + dy * dy);
      const jitterEps = hasIris ? 0.009 : 0.013;
      const confBoost = clamp((conf - 0.2) / 0.8, 0, 1);
      const microFollow = lerp(0.12, 0.24, confBoost);
      const fullFollowAt = jitterEps * 2.4;
      const softBand = Math.max(1e-6, fullFollowAt - jitterEps * 0.55);
      let follow = 1.0;
      if (speed < jitterEps * 0.55) {
        follow = microFollow;
      } else if (speed < fullFollowAt) {
        const t = clamp((speed - jitterEps * 0.55) / softBand, 0, 1);
        follow = lerp(microFollow, 1.0, t);
      }

      this._gazeX = lerp(this._gazeX, nextX, follow);
      this._gazeY = lerp(this._gazeY, nextY, follow);
    }

    this._conf = lerp(this._conf, conf, alpha);
  }
}
