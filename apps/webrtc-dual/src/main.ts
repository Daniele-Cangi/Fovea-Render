import * as THREE from "three";
import { createLoopback } from "./loopback";

// ---------- CONFIG (enterprise-ish defaults) ----------
const FPS = 30;

// fixed "product" render size (stable streams)
const FULL_W = 1280;
const FULL_H = 720;

// stream sizes
const LOW_SCALE = 0.42; // bandwidth saver
const LOW_W = Math.floor(FULL_W * LOW_SCALE);
const LOW_H = Math.floor(FULL_H * LOW_SCALE);

// patch is fixed-size to avoid renegotiation headaches
const PATCH_SIZE = 640; // square patch
const PATCH_W = PATCH_SIZE;
const PATCH_H = PATCH_SIZE;

// composite mask (receiver)
let FOVEA_R = 0.22;     // NDC
let FEATHER = 0.08;     // NDC

// ---------- DOM ----------
const cLow = document.getElementById("cLow") as HTMLCanvasElement;
const cPatch = document.getElementById("cPatch") as HTMLCanvasElement;
const cOut = document.getElementById("cOut") as HTMLCanvasElement;

const senderStats = document.getElementById("senderStats")!;
const recvStats = document.getElementById("recvStats")!;

const vLow = document.getElementById("vLow") as HTMLVideoElement;
const vPatch = document.getElementById("vPatch") as HTMLVideoElement;

// size canvases
cLow.width = LOW_W; cLow.height = LOW_H;
cPatch.width = PATCH_W; cPatch.height = PATCH_H;
cOut.width = FULL_W; cOut.height = FULL_H;

// show canvases at friendly size
cLow.style.width = "420px"; cLow.style.height = "236px";
cPatch.style.width = "420px"; cPatch.style.height = "420px";
cOut.style.width = "860px"; cOut.style.height = "484px";

// ---------- GAZE (mouse -> NDC) ----------
const gazeNDC = new THREE.Vector2(0, 0);
window.addEventListener("mousemove", (e) => {
  // map within receiver composite area when possible
  const rect = cOut.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const nx = x * 2 - 1;
  const ny = -(y * 2 - 1);
  gazeNDC.set(
    THREE.MathUtils.clamp(nx, -1, 1),
    THREE.MathUtils.clamp(ny, -1, 1)
  );
});

// ---------- SCENE (fill-rate heavy points additive) ----------
function makeScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.02);

  const camera = new THREE.PerspectiveCamera(75, FULL_W / FULL_H, 0.1, 1000);
  camera.position.z = 30;

  const N = 120000; // stress
  const pos = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const p = 2, q = 3;
    const radius = 8 + (Math.random() - 0.5) * 3;
    const r = radius * (2 + Math.sin(q * u));

    pos[i * 3 + 0] = r * Math.cos(p * u) + (Math.random() - 0.5) * 1.5;
    pos[i * 3 + 1] = r * Math.sin(p * u) + (Math.random() - 0.5) * 1.5;
    pos[i * 3 + 2] = radius * Math.cos(q * u) + (Math.random() - 0.5) * 1.5;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    size: 2.2,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: 0x00f3ff
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  function update(t: number) {
    points.rotation.y = t * 0.00012;
    points.rotation.z = t * 0.00007;
  }

  return { scene, camera, update };
}

const { scene, camera, update } = makeScene();

// ---------- SENDER RENDERERS ----------
const rLow = new THREE.WebGLRenderer({ canvas: cLow, antialias: true, alpha: false, powerPreference: "high-performance" });
rLow.setSize(LOW_W, LOW_H, false);
rLow.setPixelRatio(1);

const rPatch = new THREE.WebGLRenderer({ canvas: cPatch, antialias: true, alpha: false, powerPreference: "high-performance" });
rPatch.setSize(PATCH_W, PATCH_H, false);
rPatch.setPixelRatio(1);

// patch camera uses viewOffset (true crop of the frustum)
const patchCam = camera.clone();

// rect normalized (0..1) of patch in full frame (sender -> receiver)
const patchRectN = new THREE.Vector4(0, 0, PATCH_W / FULL_W, PATCH_H / FULL_H);

// ---------- CAPTURE STREAMS ----------
const lowStream = cLow.captureStream(FPS);
const patchStream = cPatch.captureStream(FPS);

const lowTrack = lowStream.getVideoTracks()[0];
const patchTrack = patchStream.getVideoTracks()[0];

lowTrack.contentHint = "motion";
patchTrack.contentHint = "detail";

// ---------- RECEIVER COMPOSITOR (shader) ----------
type ReceiverComposite = {
  setLowVideo: (v: HTMLVideoElement) => void;
  setPatchVideo: (v: HTMLVideoElement) => void;
  setMeta: (gaze: THREE.Vector2, rectN: THREE.Vector4) => void;
  render: () => void;
};

function createReceiverComposite(canvas: HTMLCanvasElement): ReceiverComposite {
  const rr = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  rr.setSize(FULL_W, FULL_H, false);
  rr.setPixelRatio(1);

  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    tLow: { value: null as THREE.Texture | null },
    tPatch: { value: null as THREE.Texture | null },
    uGaze: { value: new THREE.Vector2(0, 0) },      // NDC
    uRect: { value: new THREE.Vector4(0, 0, 0.5, 0.5) }, // normalized xywh
    uRadius: { value: FOVEA_R },
    uFeather: { value: FEATHER },
    uAspect: { value: FULL_W / FULL_H }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLow;
      uniform sampler2D tPatch;
      uniform vec2 uGaze;      // NDC
      uniform vec4 uRect;      // xywh in 0..1 (top-left origin)
      uniform float uRadius;
      uniform float uFeather;
      uniform float uAspect;

      float insideRect(vec2 uv, vec4 r){
        // r.xy is top-left in 0..1, uv origin is bottom-left
        // convert rect top-left to bottom-left
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        vec2 p = (uv - rBL) / r.zw;
        return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
      }

      vec2 rectUV(vec2 uv, vec4 r){
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        return (uv - rBL) / r.zw;
      }

      void main(){
        vec4 low = texture2D(tLow, vUv);

        float inR = insideRect(vUv, uRect);
        vec2 puv = rectUV(vUv, uRect);
        vec4 patch = texture2D(tPatch, puv);

        // radial mask (aspect-correct) centered on gaze
        vec2 p = vUv * 2.0 - 1.0;
        vec2 d = p - uGaze;
        d.x *= uAspect;
        float dist = length(d);
        float m = smoothstep(uRadius + uFeather, uRadius, dist);

        float blend = m * inR;
        gl_FragColor = mix(low, patch, blend);
      }
    `,
    depthTest: false,
    depthWrite: false
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  fsScene.add(quad);

  let lowTex: THREE.VideoTexture | null = null;
  let patchTex: THREE.VideoTexture | null = null;

  return {
    setLowVideo(v) {
      lowTex = new THREE.VideoTexture(v);
      lowTex.minFilter = THREE.LinearFilter;
      lowTex.magFilter = THREE.LinearFilter;
      lowTex.generateMipmaps = false;
      uniforms.tLow.value = lowTex;
    },
    setPatchVideo(v) {
      patchTex = new THREE.VideoTexture(v);
      patchTex.minFilter = THREE.LinearFilter;
      patchTex.magFilter = THREE.LinearFilter;
      patchTex.generateMipmaps = false;
      uniforms.tPatch.value = patchTex;
    },
    setMeta(g, rectN) {
      uniforms.uGaze.value.copy(g);
      uniforms.uRect.value.copy(rectN);
      uniforms.uRadius.value = FOVEA_R;
      uniforms.uFeather.value = FEATHER;
    },
    render() {
      rr.render(fsScene, fsCam);
    }
  };
}

const receiverComposite = createReceiverComposite(cOut);

// ---------- LOOPBACK WEBRTC ----------
const remoteTracks: Record<string, MediaStreamTrack> = {};
let trackMap: { low?: string; patch?: string } = {};
let dcRecv: RTCDataChannel | null = null;

const loop = await createLoopback({
  tracks: [lowTrack, patchTrack],
  onRemoteTrack: (track) => {
    remoteTracks[track.id] = track;
  },
  onDataChannel: (dc) => {
    dcRecv = dc;
    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "tracks") {
          trackMap = { low: msg.low, patch: msg.patch };
          attachVideosIfReady();
        } else if (msg.type === "meta") {
          // gazeNDC + rectN
          const g = msg.gaze as [number, number];
          const r = msg.rect as [number, number, number, number];
          receiverComposite.setMeta(new THREE.Vector2(g[0], g[1]), new THREE.Vector4(r[0], r[1], r[2], r[3]));
        }
      } catch {}
    };
  }
});

// sender data channel: announce track ids immediately
loop.dcSend.onopen = () => {
  loop.dcSend.send(JSON.stringify({ type: "tracks", low: lowTrack.id, patch: patchTrack.id }));
};

// Attach remote tracks to hidden videos when mapping is known
function attachVideosIfReady() {
  if (!trackMap.low || !trackMap.patch) return;
  const tLowR = remoteTracks[trackMap.low];
  const tPatchR = remoteTracks[trackMap.patch];
  if (!tLowR || !tPatchR) return;

  const s1 = new MediaStream([tLowR]);
  const s2 = new MediaStream([tPatchR]);

  vLow.srcObject = s1;
  vPatch.srcObject = s2;

  // autoplay
  vLow.play().catch(()=>{});
  vPatch.play().catch(()=>{});

  receiverComposite.setLowVideo(vLow);
  receiverComposite.setPatchVideo(vPatch);
}

// ---------- SENDER META + PATCH VIEWOFFSET ----------
function computePatchRectTopLeft(gaze: THREE.Vector2) {
  const cx = (gaze.x * 0.5 + 0.5) * FULL_W;
  const cy = (-gaze.y * 0.5 + 0.5) * FULL_H; // top-left origin

  // clamp so patch stays within frame
  const x0 = Math.floor(THREE.MathUtils.clamp(cx - PATCH_W / 2, 0, FULL_W - PATCH_W));
  const y0 = Math.floor(THREE.MathUtils.clamp(cy - PATCH_H / 2, 0, FULL_H - PATCH_H));

  // normalized rect (top-left)
  patchRectN.set(
    x0 / FULL_W,
    y0 / FULL_H,
    PATCH_W / FULL_W,
    PATCH_H / FULL_H
  );

  // setViewOffset expects top-left origin in pixels
  patchCam.clearViewOffset();
  patchCam.setViewOffset(FULL_W, FULL_H, x0, y0, PATCH_W, PATCH_H);
  patchCam.updateProjectionMatrix();
}

// ---------- STATS (bitrate per track) ----------
let lastStatsT = performance.now();
let lastBytes: { low?: number; patch?: number } = {};

async function updateBitrate() {
  const now = performance.now();
  if (now - lastStatsT < 1000) return;

  const stats = await loop.pcRecv.getStats();
  let lowB: number | undefined;
  let patchB: number | undefined;

  stats.forEach((r) => {
    if (r.type !== "inbound-rtp" || r.kind !== "video") return;
    // r.trackIdentifier not always present; use r.trackId -> then lookup track stats
    const bytes = (r as any).bytesReceived as number | undefined;
    const trackId = (r as any).trackId as string | undefined;
    if (!bytes || !trackId) return;

    const tr = stats.get(trackId) as any;
    const tid = tr?.trackIdentifier as string | undefined; // may match MediaStreamTrack.id
    if (!tid) return;

    if (trackMap.low && tid === trackMap.low) lowB = bytes;
    if (trackMap.patch && tid === trackMap.patch) patchB = bytes;
  });

  const dt = (now - lastStatsT) / 1000;
  lastStatsT = now;

  function kbps(cur?: number, prev?: number) {
    if (cur == null || prev == null) return "…";
    return (((cur - prev) * 8) / 1000 / dt).toFixed(1);
  }

  const lowK = kbps(lowB, lastBytes.low);
  const patchK = kbps(patchB, lastBytes.patch);
  lastBytes.low = lowB;
  lastBytes.patch = patchB;

  recvStats.textContent =
`RECV
low kbps:   ${lowK}
patch kbps: ${patchK}
rectN:      ${patchRectN.toArray().map(v=>v.toFixed(3)).join(", ")}
gazeNDC:    ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}
mask:       r=${FOVEA_R.toFixed(2)} f=${FEATHER.toFixed(2)}`;
}

// ---------- MAIN LOOP ----------
let frame = 0;
function tick(t: number) {
  requestAnimationFrame(tick);
  frame++;

  update(t);
  computePatchRectTopLeft(gazeNDC);

  // sender renders
  rLow.render(scene, camera);
  rPatch.render(scene, patchCam);

  // sender meta @ ~30Hz
  if (loop.dcSend.readyState === "open" && frame % 1 === 0) {
    loop.dcSend.send(JSON.stringify({
      type: "meta",
      gaze: [gazeNDC.x, gazeNDC.y],
      rect: [patchRectN.x, patchRectN.y, patchRectN.z, patchRectN.w]
    }));
  }

  // receiver composite (when videos ready)
  receiverComposite.render();

  // sender stats
  senderStats.textContent =
`SEND
full:       ${FULL_W}x${FULL_H}
low:        ${LOW_W}x${LOW_H}  (scale ${LOW_SCALE})
patch:      ${PATCH_W}x${PATCH_H}
rectN:      ${patchRectN.toArray().map(v=>v.toFixed(3)).join(", ")}
gazeNDC:    ${gazeNDC.x.toFixed(3)}, ${gazeNDC.y.toFixed(3)}
NOTE: two tracks + datachannel metadata`;

  // recv bitrate update
  updateBitrate().catch(()=>{});
}

requestAnimationFrame(tick);
