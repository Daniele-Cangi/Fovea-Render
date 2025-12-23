export type OneEuroOptions = {
  minCutoff?: number; // Hz
  beta?: number;      // responsiveness
  dCutoff?: number;   // Hz
};

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  private y = 0;
  private initialized = false;
  filter(x: number, a: number) {
    if (!this.initialized) { this.initialized = true; this.y = x; return x; }
    this.y = a * x + (1 - a) * this.y;
    return this.y;
  }
  get value() { return this.y; }
  reset(x: number) { this.initialized = true; this.y = x; }
}

export class OneEuroFilter {
  private opts: Required<OneEuroOptions>;
  private xLP = new LowPass();
  private dxLP = new LowPass();
  private lastT = 0;
  private hasT = false;

  constructor(opts: OneEuroOptions = {}) {
    this.opts = {
      minCutoff: opts.minCutoff ?? 1.2,
      beta: opts.beta ?? 0.015,
      dCutoff: opts.dCutoff ?? 1.0
    };
  }

  setOptions(opts: OneEuroOptions) {
    this.opts = {
      minCutoff: opts.minCutoff ?? this.opts.minCutoff,
      beta: opts.beta ?? this.opts.beta,
      dCutoff: opts.dCutoff ?? this.opts.dCutoff
    };
  }

  reset(x: number, tMs: number) {
    this.xLP.reset(x);
    this.dxLP.reset(0);
    this.lastT = tMs;
    this.hasT = true;
  }

  filter(x: number, tMs: number) {
    if (!this.hasT) { this.reset(x, tMs); return x; }
    const dt = clamp((tMs - this.lastT) / 1000, 1 / 240, 1 / 10); // 4ms..100ms
    this.lastT = tMs;

    const dx = (x - this.xLP.value) / dt;
    const aD = alpha(this.opts.dCutoff, dt);
    const edx = this.dxLP.filter(dx, aD);

    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(edx);
    const aX = alpha(cutoff, dt);
    return this.xLP.filter(x, aX);
  }
}

