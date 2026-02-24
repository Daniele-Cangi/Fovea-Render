import * as THREE from "three";

class GpuTimer {
  private gl: WebGL2RenderingContext | null;
  private ext: any | null;
  private q: WebGLQuery | null = null;
  private lastMs: number | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    this.gl = (gl instanceof WebGL2RenderingContext) ? gl : null;
    this.ext = this.gl ? this.gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
  }

  get supported() { return !!this.ext; }

  begin() {
    if (!this.gl || !this.ext) return;
    if (!this.q) this.q = this.gl.createQuery();
    if (!this.q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.q);
  }

  end() {
    if (!this.gl || !this.ext || !this.q) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  poll() {
    if (!this.gl || !this.ext || !this.q) return this.lastMs;
    const available = this.gl.getQueryParameter(this.q, this.gl.QUERY_RESULT_AVAILABLE);
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (!available || disjoint) return this.lastMs;
    const ns = this.gl.getQueryParameter(this.q, this.gl.QUERY_RESULT) as number;
    this.lastMs = ns / 1e6;
    return this.lastMs;
  }
}

export type ReceiverComposite = {
  setLowVideo: (v: HTMLVideoElement) => void;
  setPatchVideo: (v: HTMLVideoElement) => void;
  setMeta: (gaze: THREE.Vector2, rectN: THREE.Vector4, foveaR?: number, feather?: number) => void;
  render: () => number | null;
  getGpuMs: () => number | null;
};

type ReceiverCompositeOptions = {
  width: number;
  height: number;
  initialFoveaR: number;
  initialFeather: number;
};

export function createReceiverComposite(
  canvas: HTMLCanvasElement,
  options: ReceiverCompositeOptions
): ReceiverComposite {
  const rr = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  rr.setSize(options.width, options.height, false);
  rr.setPixelRatio(1);

  const tRecv = new GpuTimer(rr);
  let lastGpuMs: number | null = null;

  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const dummyCanvas = document.createElement("canvas");
  dummyCanvas.width = 2;
  dummyCanvas.height = 2;
  const dummyCtx = dummyCanvas.getContext("2d");
  if (dummyCtx) {
    dummyCtx.fillStyle = "#000000";
    dummyCtx.fillRect(0, 0, 2, 2);
  }
  const dummyTex = new THREE.CanvasTexture(dummyCanvas);
  dummyTex.needsUpdate = true;
  dummyTex.minFilter = THREE.LinearFilter;
  dummyTex.magFilter = THREE.LinearFilter;
  dummyTex.wrapS = THREE.ClampToEdgeWrapping;
  dummyTex.wrapT = THREE.ClampToEdgeWrapping;
  dummyTex.flipY = false;

  const uniforms = {
    tLow: { value: dummyTex },
    tPatch: { value: dummyTex },
    uGaze: { value: new THREE.Vector2(0, 0) },
    uRect: { value: new THREE.Vector4(0, 0, 0.5, 0.5) },
    uRadius: { value: options.initialFoveaR },
    uFeather: { value: options.initialFeather },
    uAspect: { value: options.width / options.height }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLow;
      uniform sampler2D tPatch;
      uniform vec2 uGaze;
      uniform vec4 uRect;
      uniform float uRadius;
      uniform float uFeather;
      uniform float uAspect;

      float insideRect(vec2 uv, vec4 r) {
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        vec2 p = (uv - rBL) / r.zw;
        return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
      }

      vec2 rectUV(vec2 uv, vec4 r) {
        vec2 rBL = vec2(r.x, 1.0 - (r.y + r.w));
        return (uv - rBL) / r.zw;
      }

      void main() {
        vec4 low = texture2D(tLow, vUv);
        float inR = insideRect(vUv, uRect);
        vec2 puv = rectUV(vUv, uRect);
        vec4 patch = texture2D(tPatch, puv);
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
    setMeta(g, rectN, foveaR, feather) {
      uniforms.uGaze.value.copy(g);
      uniforms.uRect.value.copy(rectN);
      if (typeof foveaR === "number") uniforms.uRadius.value = foveaR;
      if (typeof feather === "number") uniforms.uFeather.value = feather;
    },
    render() {
      if (!lowTex || !patchTex) return lastGpuMs;
      if (tRecv.supported) tRecv.begin();
      try {
        rr.render(fsScene, fsCam);
      } catch (e) {
        console.error("Receiver composite render error:", e);
      }
      if (tRecv.supported) tRecv.end();
      lastGpuMs = tRecv.poll();
      return lastGpuMs;
    },
    getGpuMs() {
      return lastGpuMs;
    }
  };
}
