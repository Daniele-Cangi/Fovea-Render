export type Loopback = {
  pcSend: RTCPeerConnection;
  pcRecv: RTCPeerConnection;
  dcSend: RTCDataChannel;
  senders: RTCRtpSender[];
};

export async function createLoopback(opts: {
  tracks: MediaStreamTrack[];
  onRemoteTrack: (track: MediaStreamTrack) => void;
  onDataChannel: (dc: RTCDataChannel) => void;
}): Promise<Loopback> {
  const pcSend = new RTCPeerConnection();
  const pcRecv = new RTCPeerConnection();

  // ICE exchange (no STUN needed for loopback)
  pcSend.onicecandidate = (e) => { if (e.candidate) pcRecv.addIceCandidate(e.candidate); };
  pcRecv.onicecandidate = (e) => { if (e.candidate) pcSend.addIceCandidate(e.candidate); };

  // tracks - capture senders
  // Using addTrack() - returns RTCRtpSender directly
  // Order is guaranteed: same as opts.tracks array
  const senders: RTCRtpSender[] = [];
  for (const t of opts.tracks) {
    const sender = pcSend.addTrack(t);
    senders.push(sender);
    console.log("Added track via addTrack():", t.id, t.kind);
  }

  // data channel (sender -> receiver)
  const dcSend = pcSend.createDataChannel("meta", { ordered: false, maxRetransmits: 0 });

  pcRecv.ondatachannel = (ev) => {
    const dc = ev.channel;
    opts.onDataChannel(dc);
  };

  pcRecv.ontrack = (ev) => {
    // in loopback you get tracks individually
    opts.onRemoteTrack(ev.track);
  };

  // SDP handshake
  const offer = await pcSend.createOffer();
  await pcSend.setLocalDescription(offer);
  await pcRecv.setRemoteDescription(offer);

  const answer = await pcRecv.createAnswer();
  await pcRecv.setLocalDescription(answer);
  await pcSend.setRemoteDescription(answer);

  return { pcSend, pcRecv, dcSend, senders };
}
