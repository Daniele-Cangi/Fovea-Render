import { FaceMesh } from "@mediapipe/face_mesh";
import { Camera } from "@mediapipe/camera_utils";
import { OneEuroFilter } from "./OneEuro";

export type GazeSample = { rawX: number; rawY: number; t: number; conf: number };
export type CalibMatrix = { ax: number; bx: number; cx: number; ay: number; by: number; cy: number }; // x=ax+bx*rawX+cx*rawY

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
};

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function avg5(landmarks: any[], i0: number) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 5; i++) { x += landmarks[i0 + i].x; y += landmarks[i0 + i].y; z += (landmarks[i0 + i].z ?? 0); }
  return { x: x / 5, y: y / 5, z: z / 5 };
}

function dist2(a: any, b: any) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

// Solve affine least squares: x = ax + bx*rx + cx*ry, y = ay + by*rx + cy*ry
function fitAffine(samples: { rx: number; ry: number; x: number; y: number }[]): CalibMatrix | null {
  if (samples.length < 6) return null;

  // A = [1 rx ry], theta = (A^T A)^-1 A^T b for x and y separately
  let s00=0,s01=0,s02=0,s11=0,s12=0,s22=0;
  let bx0=0,bx1=0,bx2=0;
  let by0=0,by1=0,by2=0;

  for (const p of samples) {
    const a0 = 1, a1 = p.rx, a2 = p.ry;
    s00 += a0*a0; s01 += a0*a1; s02 += a0*a2;
    s11 += a1*a1; s12 += a1*a2; s22 += a2*a2;
    bx0 += a0*p.x; bx1 += a1*p.x; bx2 += a2*p.x;
    by0 += a0*p.y; by1 += a1*p.y; by2 += a2*p.y;
  }

  // Symmetric 3x3:
  // [s00 s01 s02]
  // [s01 s11 s12]
  // [s02 s12 s22]
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

  return { ax, bx, cx, ay, by: by_, cy };
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

  private fx = new OneEuroFilter({ minCutoff: 1.2, beta: 0.020, dCutoff: 1.0 });
  private fy = new OneEuroFilter({ minCutoff: 1.2, beta: 0.020, dCutoff: 1.0 });

  constructor(opts: MediapipeGazeOptions = {}) {
    this.opts = {
      mirrorX: opts.mirrorX ?? true,
      smoothAlpha: opts.smoothAlpha ?? 0.18,
      locateFileBase: opts.locateFileBase ?? "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/",
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

  loadCalibrationFromStorage(key = "fovea.calib.v1") {
    try {
      const s = localStorage.getItem(key);
      if (!s) return false;
      const obj = JSON.parse(s);
      if (obj && typeof obj.ax === "number") { this._calib = obj; return true; }
      return false;
    } catch { return false; }
  }

  saveCalibrationToStorage(key = "fovea.calib.v1") {
    if (!this._calib) return false;
    localStorage.setItem(key, JSON.stringify(this._calib));
    return true;
  }

  clearCalibration(key = "fovea.calib.v1") {
    this._calib = null;
    localStorage.removeItem(key);
  }

  setCalibration(m: CalibMatrix | null) { this._calib = m; }

  fitAndSetCalibration(samples: { rx: number; ry: number; x: number; y: number }[]) {
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
    const alpha = this.opts.smoothAlpha;

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      // drop confidence smoothly
      this._conf = lerp(this._conf, 0, 0.15);
      return;
    }

    const lm = results.multiFaceLandmarks[0];

    // --- HEAD proxy (robust) ---
    const nose = lm[1]; // nose tip
    let headX = (nose.x - 0.5) * 2.2;
    let headY = (nose.y - 0.5) * 2.2;

    // --- IRIS proxy (refineLandmarks gives 10 extra points) ---
    let irisX = 0, irisY = 0;
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

      irisX = (lx + rx) * 0.9;   // gain
      irisY = (ly + ry) * 0.9;
    }

    this._hasIris = hasIris;

    // --- RAW mix (head + iris) ---
    let rawX = headX + (hasIris ? irisX * 0.9 : 0);
    let rawY = headY + (hasIris ? irisY * 0.9 : 0);

    // Store unmirrored for calibration
    this._rawXUnmirrored = rawX;
    this._rawYUnmirrored = rawY;

    // confidence heuristic
    // face size proxy (cheekbones)
    const cheekL = lm[234], cheekR = lm[454];
    const faceW = dist2(cheekL, cheekR);           // ~0..1
    const sizeConf = clamp((faceW - 0.12) / 0.20, 0, 1);

    // eye openness proxy -> if blinking, confidence dips (optional)
    const lu = lm[159], ll = lm[145], ru = lm[386], rl = lm[374];
    const openL = Math.abs(ll.y - lu.y);
    const openR = Math.abs(rl.y - ru.y);
    const open = (openL + openR) * 0.5;
    const openConf = clamp((open - 0.008) / 0.018, 0, 1);

    let conf = 0.55 * sizeConf + 0.35 * openConf + (hasIris ? 0.10 : 0.0);
    conf = clamp(conf, 0, 1);

    // apply calibration BEFORE mirroring (calibration is done on non-mirrored raw values)
    let gx = rawX, gy = rawY;
    if (this._calib) {
      gx = this._calib.ax + this._calib.bx * rawX + this._calib.cx * rawY;
      gy = this._calib.ay + this._calib.by * rawX + this._calib.cy * rawY;
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

    // raw (lascialo "quasi raw", leggero smoothing se vuoi)
    this._rawX = lerp(this._rawX, rawX, 0.22);
    this._rawY = lerp(this._rawY, rawY, 0.22);

    // gaze One-Euro (vero)
    if (this._conf < 0.05) {
      // se era "morto", re-inizializza per evitare scatti quando torna
      this.fx.reset(gx, tMs);
      this.fy.reset(gy, tMs);
      this._gazeX = gx;
      this._gazeY = gy;
    } else {
      this._gazeX = this.fx.filter(gx, tMs);
      this._gazeY = this.fy.filter(gy, tMs);
    }

    this._conf = lerp(this._conf, conf, 0.22);
  }
}
