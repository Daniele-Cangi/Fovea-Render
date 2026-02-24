export type CalibrationStats = {
  rmse: number;
  maxErr: number;
  leftRmse: number | null;
  rightRmse: number | null;
  points: number;
  tier?: "strict" | "provisional";
};

export type CalibrationRunResult = {
  ok: boolean;
  aborted: boolean;
  qualityRejected: boolean;
  stats: CalibrationStats | null;
  appliedStats: CalibrationStats | null;
};

export const CALIB_STORAGE_KEY = "fovea.calib.eye.v1";
export const CALIB_STATS_STORAGE_KEY = "fovea.calib.eye.stats.v1";
export const CALIB_RMSE_ACCEPT_MAX = 0.33;
export const CALIB_RMSE_PROVISIONAL_MAX = 0.52;
export const CALIB_AUTO_MAX_ATTEMPTS = 3;
export const CALIB_STRICT_REFINEMENT_ATTEMPTS = 1;
export const CALIB_SIDE_RATIO_MAX = 1.55;
export const CALIB_SIDE_RMSE_MAX = 0.42;
export const CALIB_SIDE_RATIO_PROVISIONAL_MAX = 1.85;
export const CALIB_SIDE_RMSE_PROVISIONAL_MAX = 0.58;
export const CALIB_MAXERR_PROVISIONAL_MAX = 1.10;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function normalizeCalibrationStats(raw: unknown): CalibrationStats | null {
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

export function loadCalibrationStatsFromStorage(storage: Storage = localStorage): CalibrationStats | null {
  try {
    const raw = storage.getItem(CALIB_STATS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeCalibrationStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveCalibrationStatsToStorage(
  stats: CalibrationStats | null,
  storage: Storage = localStorage
) {
  try {
    if (!stats) {
      storage.removeItem(CALIB_STATS_STORAGE_KEY);
      return;
    }
    storage.setItem(CALIB_STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage failures.
  }
}
