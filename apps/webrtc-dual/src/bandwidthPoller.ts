import { BW_PROFILES, bwClamp, computeCaps, type BandwidthState } from "./bandwidthState";
import {
  applyMaxBitrateKbps,
  readIceBudget,
  readOutboundKbps,
  readReceiverLossWorst,
  readRemoteQuality,
  type RemoteQualityState,
  type RxLossState,
  type SenderBitrateState
} from "./webrtcStats";

type TelemetryState = {
  [key: string]: any;
};

export function startBitratePoller(opts: {
  lowSender: RTCRtpSender;
  patchSender: RTCRtpSender;
  pcSend?: RTCPeerConnection;
  pcRecv?: RTCPeerConnection;
  intervalMs?: number;
  bw: BandwidthState;
  tel: TelemetryState;
  onEvent: (name: string, data?: Record<string, any>) => void;
}) {
  const intervalMs = opts.intervalMs ?? 500;
  const BW = opts.bw;
  const TEL = opts.tel;

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

      TEL.kbpsLowWire = kLow.wire;
      TEL.kbpsPatchWire = kPatch.wire;
      TEL.kbpsLowPayload = kLow.payload;
      TEL.kbpsPatchPayload = kPatch.payload;
      TEL.kbpsLow = kLow.payload;
      TEL.kbpsPatch = kPatch.payload;

      if (kLow.payload != null) {
        kbpsLowEma = kbpsLowEma == null ? kLow.payload : kbpsLowEma + kbpsAlpha * (kLow.payload - kbpsLowEma);
        TEL.kbpsLowEma = kbpsLowEma;
      }
      if (kPatch.payload != null) {
        kbpsPatchEma = kbpsPatchEma == null ? kPatch.payload : kbpsPatchEma + kbpsAlpha * (kPatch.payload - kbpsPatchEma);
        TEL.kbpsPatchEma = kbpsPatchEma;
      }

      const [qqL, qqP] = await Promise.all([
        readRemoteQuality(opts.lowSender, qLow),
        readRemoteQuality(opts.patchSender, qPatch)
      ]);

      const rtt = Math.max(qqL.rttMs ?? 0, qqP.rttMs ?? 0) || null;
      const lossTx = Math.max(qqL.lossPct ?? 0, qqP.lossPct ?? 0) || null;

      let lossRx: number | null = null;
      if (opts.pcRecv) {
        lossRx = await readReceiverLossWorst(opts.pcRecv, rxState);
      }
      TEL.lossRxPct = lossRx;
      TEL.lossTxPct = lossTx;

      const lossWorst =
        (lossTx == null && lossRx == null) ? null :
        Math.max(lossTx ?? 0, lossRx ?? 0);

      BW.rttMs = rtt;
      BW.lossPct = lossWorst;
      TEL.rttMs = rtt;
      TEL.lossPct = lossWorst;

      if (!lossRxSeen && lossRx != null) {
        lossRxSeen = true;
        opts.onEvent("loss_rx_active", { loss_rx_pct: lossRx });
      }

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

      const now = performance.now();
      const p = BW_PROFILES[BW.profile];

      TEL.bwProfile = BW.profile;
      TEL.bwEnabled = BW.enabled;

      if (BW.enabled && aobKbps != null && aobKbps > 0) {
        const hardCap = bwClamp(Math.round(aobKbps * 0.88), p.minTotalKbps, p.maxTotalKbps);
        if (hardCap < BW.totalCapKbps && (BW.totalCapKbps - hardCap) >= Math.max(150, BW.totalCapKbps * 0.10)) {
          const from = BW.totalCapKbps;
          BW.totalCapKbps = hardCap;
          opts.onEvent("bw_budget_clamp", {
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
          opts.onEvent("bw_down", {
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
          opts.onEvent("bw_up", {
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

      const caps = computeCaps(BW.totalCapKbps, BW.profile);
      BW.totalCapKbps = caps.totalKbps;

      let finalLowKbps = caps.lowKbps;
      let finalPatchKbps = caps.patchKbps;

      if (BW.enabled && BW.alloc.enabled &&
          (lossWorst == null || lossWorst < 1.0) &&
          (rtt == null || rtt < 160)) {
        const p = BW_PROFILES[BW.profile];

        const appliedLow = BW.appliedLowKbps || caps.lowKbps;
        const appliedPatch = BW.appliedPatchKbps || caps.patchKbps;
        const utilLow = (TEL.kbpsLowEma != null && appliedLow > 0) ? TEL.kbpsLowEma / appliedLow : null;
        const utilPatch = (TEL.kbpsPatchEma != null && appliedPatch > 0) ? TEL.kbpsPatchEma / appliedPatch : null;

        TEL.utilLow = utilLow;
        TEL.utilPatch = utilPatch;

        const hungryPatch = (utilPatch != null && utilPatch > 0.70);
        TEL.hungryPatch = hungryPatch;

        BW.alloc.cooldownMs = Math.max(0, BW.alloc.cooldownMs - intervalMs);

        if (utilLow != null && utilLow < 0.35) BW.alloc.lowUnderMs += intervalMs;
        else BW.alloc.lowUnderMs = 0;

        if (utilLow != null && utilLow > 0.75) BW.alloc.lowWellMs += intervalMs;
        else BW.alloc.lowWellMs = 0;

        if (utilLow != null && utilLow > 0.60) BW.alloc.lowHighDemandMs += intervalMs;
        else BW.alloc.lowHighDemandMs = 0;

        if (hungryPatch) BW.alloc.patchHungryMs += intervalMs;
        else BW.alloc.patchHungryMs = 0;

        if (utilPatch != null && utilPatch < 0.50) BW.alloc.patchUnderMs += intervalMs;
        else BW.alloc.patchUnderMs = 0;

        const useEye = TEL.useEye === true;
        const gazeConf = TEL.gazeConf ?? 0;
        if (!useEye || gazeConf < 0.45) BW.alloc.eyeWeakMs += intervalMs;
        else BW.alloc.eyeWeakMs = 0;

        if (BW.alloc.cooldownMs === 0) {
          let biasChanged = false;
          let biasBlocked = false;
          const oldBias = BW.alloc.biasKbps;
          const maxBias = Math.max(0, caps.lowKbps - p.floorLowKbps);
          const minLowKbps = caps.totalKbps * 0.25;
          const safeMaxBias = Math.max(0, caps.lowKbps - Math.max(p.floorLowKbps, minLowKbps));
          const effectiveMaxBias = Math.min(maxBias, safeMaxBias);

          if (BW.alloc.lowHighDemandMs >= 500) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 400);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          } else if (BW.alloc.eyeWeakMs >= 1000) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          } else if (BW.alloc.lowUnderMs >= 3000 && BW.alloc.patchHungryMs >= 2000) {
            BW.alloc.biasKbps = Math.min(effectiveMaxBias, BW.alloc.biasKbps + 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          } else if (BW.alloc.lowUnderMs >= 3000 && !hungryPatch) {
            biasBlocked = true;
            opts.onEvent("bw_rebalance_blocked", {
              util_low: utilLow,
              util_patch: utilPatch,
              hungry_patch: hungryPatch,
              bias_kbps: BW.alloc.biasKbps
            });
          } else if (BW.alloc.lowWellMs >= 3000) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          } else if (BW.alloc.patchUnderMs >= 5000) {
            BW.alloc.biasKbps = Math.max(0, BW.alloc.biasKbps - 200);
            BW.alloc.cooldownMs = 1500;
            biasChanged = true;
          }

          BW.alloc.biasKbps = Math.max(0, Math.min(effectiveMaxBias, BW.alloc.biasKbps));

          finalLowKbps = caps.lowKbps - BW.alloc.biasKbps;
          finalPatchKbps = caps.patchKbps + BW.alloc.biasKbps;

          if (finalLowKbps < p.floorLowKbps) {
            finalLowKbps = p.floorLowKbps;
            finalPatchKbps = caps.totalKbps - finalLowKbps;
            BW.alloc.biasKbps = caps.lowKbps - finalLowKbps;
          }
          if (finalPatchKbps < p.floorPatchKbps) {
            finalPatchKbps = p.floorPatchKbps;
            finalLowKbps = caps.totalKbps - finalPatchKbps;
            BW.alloc.biasKbps = caps.lowKbps - finalLowKbps;
          }

          if (biasChanged && BW.alloc.biasKbps !== oldBias) {
            opts.onEvent("bw_rebalance", {
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
          finalLowKbps = caps.lowKbps - BW.alloc.biasKbps;
          finalPatchKbps = caps.patchKbps + BW.alloc.biasKbps;

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

      const targetChanged =
        (BW.targetLowKbps !== BW.lastTargetLowKbps) ||
        (BW.targetPatchKbps !== BW.lastTargetPatchKbps);

      const ready = !opts.pcSend || opts.pcSend.connectionState === "connected" || opts.pcSend.iceConnectionState === "connected";
      const throttleMs = 200;
      const canApply = (now - BW.lastApplyAttemptMs) >= throttleMs;

      if (BW.enabled && ready && canApply) {
        const needsLow = targetChanged || !BW.appliedLowKbps || BW.targetLowKbps !== BW.appliedLowKbps;
        if (needsLow) {
          BW.lastApplyAttemptMs = now;
          const res = await applyMaxBitrateKbps(opts.lowSender, BW.targetLowKbps);
          if (res.ok) {
            const expectedBps = Math.round(BW.targetLowKbps * 1000);
            BW.appliedLowKbps = BW.targetLowKbps;
            if (res.readbackBps != null && Math.abs(res.readbackBps - expectedBps) > expectedBps * 0.15) {
              opts.onEvent("bw_apply_mismatch", {
                lane: "low",
                target_kbps: BW.targetLowKbps,
                applied_kbps: BW.appliedLowKbps,
                readback_bps: res.readbackBps
              });
            } else {
              opts.onEvent("bw_apply_ok", {
                lane: "low",
                target_kbps: BW.targetLowKbps,
                applied_kbps: BW.appliedLowKbps,
                readback_bps: res.readbackBps ?? null
              });
            }
          } else {
            opts.onEvent("bw_apply_fail", {
              lane: "low",
              target_kbps: BW.targetLowKbps,
              applied_kbps: BW.appliedLowKbps,
              err: res.err,
              pcState: {
                cs: opts.pcSend?.connectionState,
                ice: opts.pcSend?.iceConnectionState
              }
            });
          }
        }

        const needsPatch = targetChanged || !BW.appliedPatchKbps || BW.targetPatchKbps !== BW.appliedPatchKbps;
        if (needsPatch) {
          BW.lastApplyAttemptMs = now;
          const res = await applyMaxBitrateKbps(opts.patchSender, BW.targetPatchKbps);
          if (res.ok) {
            const expectedBps = Math.round(BW.targetPatchKbps * 1000);
            BW.appliedPatchKbps = BW.targetPatchKbps;
            if (res.readbackBps != null && Math.abs(res.readbackBps - expectedBps) > expectedBps * 0.15) {
              opts.onEvent("bw_apply_mismatch", {
                lane: "patch",
                target_kbps: BW.targetPatchKbps,
                applied_kbps: BW.appliedPatchKbps,
                readback_bps: res.readbackBps
              });
            } else {
              opts.onEvent("bw_apply_ok", {
                lane: "patch",
                target_kbps: BW.targetPatchKbps,
                applied_kbps: BW.appliedPatchKbps,
                readback_bps: res.readbackBps ?? null
              });
            }
          } else {
            opts.onEvent("bw_apply_fail", {
              lane: "patch",
              target_kbps: BW.targetPatchKbps,
              applied_kbps: BW.appliedPatchKbps,
              err: res.err,
              pcState: {
                cs: opts.pcSend?.connectionState,
                ice: opts.pcSend?.iceConnectionState
              }
            });
          }
        }
      }

      BW.lastTargetLowKbps = BW.targetLowKbps;
      BW.lastTargetPatchKbps = BW.targetPatchKbps;
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
