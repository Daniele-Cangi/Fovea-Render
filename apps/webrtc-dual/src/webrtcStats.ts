export type SenderBitrateState = {
  lastBytesSent: number;
  lastRtxBytesSent: number;
  lastTs: number;
  kbpsWire: number | null;
  kbpsPayload: number | null;
};

export type OutboundKbpsResult = {
  wire: number | null;
  payload: number | null;
};

export async function applyMaxBitrateKbps(
  sender: RTCRtpSender,
  kbps: number
): Promise<{ ok: boolean; err?: string; readbackBps?: number | null }> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{} as any];
    const bps = Math.max(1000, Math.round(kbps * 1000));
    params.encodings[0].maxBitrate = bps;

    await sender.setParameters(params);

    const rb = sender.getParameters();
    const rbBps = rb.encodings && rb.encodings[0] && typeof rb.encodings[0].maxBitrate === "number"
      ? rb.encodings[0].maxBitrate
      : null;

    return { ok: true, readbackBps: rbBps };
  } catch (e: any) {
    return { ok: false, err: String(e?.name || e) + (e?.message ? (": " + e.message) : "") };
  }
}

export async function readOutboundKbps(sender: RTCRtpSender, st: SenderBitrateState): Promise<OutboundKbpsResult> {
  const report = await sender.getStats();
  let best: any = null;

  report.forEach((r: any) => {
    if (r.type === "outbound-rtp" && r.kind === "video" && !r.isRemote) {
      if (typeof r.bytesSent === "number") best = r;
    }
  });

  if (!best) {
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  const bytesSent = best.bytesSent as number;
  const rtxBytesSent = (typeof best.retransmittedBytesSent === "number") ? best.retransmittedBytesSent : 0;
  const ts = best.timestamp as number;

  if (st.lastTs === 0) {
    st.lastBytesSent = bytesSent;
    st.lastRtxBytesSent = rtxBytesSent;
    st.lastTs = ts;
    st.kbpsWire = 0;
    st.kbpsPayload = 0;
    return { wire: 0, payload: 0 };
  }

  const dt = (ts - st.lastTs) / 1000;
  if (dt <= 0) {
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  const dWireBytes = bytesSent - st.lastBytesSent;
  if (dWireBytes < 0) {
    st.lastBytesSent = bytesSent;
    st.lastRtxBytesSent = rtxBytesSent;
    st.lastTs = ts;
    return { wire: st.kbpsWire, payload: st.kbpsPayload };
  }

  const lastPayloadBytes = st.lastBytesSent - st.lastRtxBytesSent;
  const currentPayloadBytes = bytesSent - rtxBytesSent;
  const dPayloadBytes = Math.max(0, currentPayloadBytes - lastPayloadBytes);

  st.lastBytesSent = bytesSent;
  st.lastRtxBytesSent = rtxBytesSent;
  st.lastTs = ts;

  const kbpsWire = (dWireBytes * 8) / (dt * 1000);
  const kbpsPayload = (dPayloadBytes * 8) / (dt * 1000);

  st.kbpsWire = kbpsWire;
  st.kbpsPayload = kbpsPayload;

  return { wire: kbpsWire, payload: kbpsPayload };
}

export type RemoteQualityState = {
  lastLost: number;
  lastRecv: number;
  lastTs: number;
  rttMs: number | null;
  lossPct: number | null;
};

export async function readRemoteQuality(sender: RTCRtpSender, st: RemoteQualityState) {
  const report = await sender.getStats();

  let rttMs: number | null = null;
  let lost: number | null = null;
  let recv: number | null = null;
  let ts: number | null = null;

  report.forEach((r: any) => {
    if (r.type === "remote-inbound-rtp" && r.kind === "video") {
      if (typeof r.roundTripTime === "number") rttMs = Math.round(r.roundTripTime * 1000);
      if (typeof r.packetsLost === "number") lost = r.packetsLost;
      if (typeof r.packetsReceived === "number") recv = r.packetsReceived;
      if (typeof r.timestamp === "number") ts = r.timestamp;
    }
  });

  if (rttMs != null) st.rttMs = st.rttMs == null ? rttMs : Math.round(0.7 * st.rttMs + 0.3 * rttMs);

  if (lost != null && recv != null && ts != null) {
    if (st.lastTs === 0) {
      st.lastLost = lost;
      st.lastRecv = recv;
      st.lastTs = ts;
    } else {
      const dLost = lost - st.lastLost;
      const dRecv = recv - st.lastRecv;
      st.lastLost = lost;
      st.lastRecv = recv;
      st.lastTs = ts;

      const denom = dLost + dRecv;
      if (denom > 50) {
        const pct = (dLost / denom) * 100;
        st.lossPct = st.lossPct == null ? pct : (0.75 * st.lossPct + 0.25 * pct);
      }
    }
  }

  return { rttMs: st.rttMs, lossPct: st.lossPct };
}

export type RxStreamLoss = {
  lastLost: number;
  lastRecv: number;
  lastTs: number;
  lossPct: number | null;
};

export type RxLossState = Map<string, RxStreamLoss>;

export async function readReceiverLossWorst(pcRecv: RTCPeerConnection, st: RxLossState): Promise<number | null> {
  try {
    const report = await pcRecv.getStats();
    let worst: number | null = null;

    report.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "video" && !r.isRemote) {
        const ssrc = (typeof r.ssrc === "number") ? String(r.ssrc) : (r.id || "unknown");
        const lost = (typeof r.packetsLost === "number") ? r.packetsLost : null;
        const recv = (typeof r.packetsReceived === "number") ? r.packetsReceived : null;
        const ts = (typeof r.timestamp === "number") ? r.timestamp : null;
        if (lost == null || recv == null || ts == null) return;

        let entry = st.get(ssrc);
        if (!entry) {
          entry = { lastLost: 0, lastRecv: 0, lastTs: 0, lossPct: null };
          st.set(ssrc, entry);
        }

        if (entry.lastTs === 0) {
          entry.lastLost = lost;
          entry.lastRecv = recv;
          entry.lastTs = ts;
          entry.lossPct = 0;
        } else {
          const dLost = lost - entry.lastLost;
          const dRecv = recv - entry.lastRecv;
          entry.lastLost = lost;
          entry.lastRecv = recv;
          entry.lastTs = ts;

          const denom = dLost + dRecv;
          if (denom > 50 && dLost >= 0 && dRecv >= 0) {
            const pct = (dLost / denom) * 100;
            entry.lossPct = entry.lossPct == null ? pct : (0.75 * entry.lossPct + 0.25 * pct);
          }
        }

        if (entry.lossPct != null) {
          worst = (worst == null) ? entry.lossPct : Math.max(worst, entry.lossPct);
        }
      }
    });

    return worst == null ? null : +worst.toFixed(3);
  } catch {
    return null;
  }
}

export async function readIceBudget(pc: RTCPeerConnection) {
  try {
    const stats = await pc.getStats();

    let selectedId: string | null = null;
    stats.forEach((r: any) => {
      if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") {
        selectedId = r.selectedCandidatePairId;
      }
    });

    let pair: any = null;

    if (selectedId && (stats as any).get) {
      pair = (stats as any).get(selectedId);
    }

    if (!pair) {
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.state === "succeeded") {
          if (r.nominated === true || r.selected === true) pair = r;
        }
      });
    }

    if (!pair) return { aobKbps: null as number | null, iceRttMs: null as number | null };

    const aobBps = (typeof pair.availableOutgoingBitrate === "number") ? pair.availableOutgoingBitrate : null;
    const rttSec = (typeof pair.currentRoundTripTime === "number") ? pair.currentRoundTripTime : null;

    return {
      aobKbps: aobBps == null ? null : Math.round(aobBps / 1000),
      iceRttMs: rttSec == null ? null : Math.round(rttSec * 1000)
    };
  } catch {
    return { aobKbps: null as number | null, iceRttMs: null as number | null };
  }
}
