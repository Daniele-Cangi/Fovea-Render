export type GovernorConfig = {
  targetFrameMs: number;
  enable: boolean;

  lowScaleMin: number;
  lowScaleMax: number;

  foveaRadiusMin: number;
  foveaRadiusMax: number;

  // step sizes
  lowScaleDownStep: number;
  lowScaleUpStep: number;
  foveaDownStep: number;
  foveaUpStep: number;

  // hysteresis
  hiMs: number;
  loMs: number;

  // EMA smoothing
  emaAlpha: number;
};

export class Governor {
  cfg: GovernorConfig;
  emaFrameMs: number;

  constructor(cfg?: Partial<GovernorConfig>) {
    this.cfg = {
      targetFrameMs: 16.7,
      enable: true,
      lowScaleMin: 0.25,
      lowScaleMax: 0.67,
      foveaRadiusMin: 0.14,
      foveaRadiusMax: 0.34,
      lowScaleDownStep: 0.03,
      lowScaleUpStep: 0.02,
      foveaDownStep: 0.01,
      foveaUpStep: 0.01,
      hiMs: 18.2,
      loMs: 15.2,
      emaAlpha: 0.1,
      ...cfg
    };
    this.emaFrameMs = this.cfg.targetFrameMs;
  }

  update(frameMs: number) {
    const a = this.cfg.emaAlpha;
    this.emaFrameMs = this.emaFrameMs * (1 - a) + frameMs * a;
    return this.emaFrameMs;
  }

  // returns deltas to apply (or 0s)
  decide() {
    if (!this.cfg.enable) return { dLowScale: 0, dFoveaRadius: 0 };

    if (this.emaFrameMs > this.cfg.hiMs) {
      return { dLowScale: -this.cfg.lowScaleDownStep, dFoveaRadius: -this.cfg.foveaDownStep };
    }
    if (this.emaFrameMs < this.cfg.loMs) {
      return { dLowScale: +this.cfg.lowScaleUpStep, dFoveaRadius: +this.cfg.foveaUpStep };
    }
    return { dLowScale: 0, dFoveaRadius: 0 };
  }
}




