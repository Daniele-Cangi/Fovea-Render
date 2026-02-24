export type BwProfileName = "mobile" | "balanced" | "lan";

export const BW_PROFILES: Record<BwProfileName, {
  totalKbps: number;
  minTotalKbps: number;
  maxTotalKbps: number;
  splitLow: number;
  floorLowKbps: number;
  floorPatchKbps: number;
}> = {
  mobile: { totalKbps: 1200, minTotalKbps: 700, maxTotalKbps: 2500, splitLow: 0.70, floorLowKbps: 350, floorPatchKbps: 150 },
  balanced: { totalKbps: 3000, minTotalKbps: 1200, maxTotalKbps: 6000, splitLow: 0.67, floorLowKbps: 500, floorPatchKbps: 200 },
  lan: { totalKbps: 8000, minTotalKbps: 3000, maxTotalKbps: 12000, splitLow: 0.62, floorLowKbps: 1000, floorPatchKbps: 500 }
};

export type BandwidthState = {
  enabled: boolean;
  profile: BwProfileName;
  totalCapKbps: number;
  targetLowKbps: number;
  targetPatchKbps: number;
  appliedLowKbps: number;
  appliedPatchKbps: number;
  lastTargetLowKbps: number;
  lastTargetPatchKbps: number;
  lastApplyAttemptMs: number;
  stableBadMs: number;
  stableGoodMs: number;
  lastAdjustMs: number;
  rttMs: number | null;
  lossPct: number | null;
  aobKbps: number | null;
  iceRttMs: number | null;
  alloc: {
    enabled: boolean;
    biasKbps: number;
    lowUnderMs: number;
    lowWellMs: number;
    lowHighDemandMs: number;
    patchHungryMs: number;
    patchUnderMs: number;
    eyeWeakMs: number;
    cooldownMs: number;
  };
};

export function bwClamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function createBandwidthState(profile: BwProfileName = "balanced"): BandwidthState {
  return {
    enabled: true,
    profile,
    totalCapKbps: BW_PROFILES[profile].totalKbps,
    targetLowKbps: 0,
    targetPatchKbps: 0,
    appliedLowKbps: 0,
    appliedPatchKbps: 0,
    lastTargetLowKbps: 0,
    lastTargetPatchKbps: 0,
    lastApplyAttemptMs: 0,
    stableBadMs: 0,
    stableGoodMs: 0,
    lastAdjustMs: 0,
    rttMs: null,
    lossPct: null,
    aobKbps: null,
    iceRttMs: null,
    alloc: {
      enabled: true,
      biasKbps: 0,
      lowUnderMs: 0,
      lowWellMs: 0,
      lowHighDemandMs: 0,
      patchHungryMs: 0,
      patchUnderMs: 0,
      eyeWeakMs: 0,
      cooldownMs: 0
    }
  };
}

export function computeCaps(totalKbps: number, profile: BwProfileName) {
  const p = BW_PROFILES[profile];
  totalKbps = bwClamp(totalKbps, p.minTotalKbps, p.maxTotalKbps);

  let low = Math.round(totalKbps * p.splitLow);
  let patch = totalKbps - low;

  if (low < p.floorLowKbps) low = p.floorLowKbps;
  patch = totalKbps - low;

  if (patch < p.floorPatchKbps) {
    patch = p.floorPatchKbps;
    low = totalKbps - patch;
  }

  if (low < p.floorLowKbps) {
    low = p.floorLowKbps;
    patch = Math.max(0, totalKbps - low);
  }

  return { totalKbps, lowKbps: Math.max(0, low), patchKbps: Math.max(0, patch) };
}
