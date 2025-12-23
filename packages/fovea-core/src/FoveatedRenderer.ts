import * as THREE from "three";
import { Governor, GovernorConfig } from "./Governor";
import { GpuTimer } from "./GpuTimer";

export type FoveaConfig = {
  lowScale: number;        // 0.25..0.67
  foveaRadius: number;     // NDC radius (0..~0.5)
  feather: number;         // NDC feather
  enableGovernor: boolean;
  governor?: Partial<GovernorConfig>;
};

export type FoveaStats = {
  frameMs: number;
  emaFrameMs: number;
  gpuMs?: number | null;
  lowScale: number;
  foveaRadius: number;
  feather: number;
  rtLow: { w: number; h: number };
};

export class FoveatedRenderer {
  renderer: THREE.WebGLRenderer;
  cfg: FoveaConfig;

  w = 0; h = 0;
  rtLow!: THREE.WebGLRenderTarget;
  rtHigh!: THREE.WebGLRenderTarget;

  fsScene: THREE.Scene;
  fsCam: THREE.OrthographicCamera;
  fsMat: THREE.ShaderMaterial;

  governor: Governor;
  lastT = performance.now();

  gpuTimer?: GpuTimer;

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number, cfg?: Partial<FoveaConfig>) {
    this.renderer = renderer;
    this.cfg = {
      lowScale: 0.45,
      foveaRadius: 0.22,
      feather: 0.08,
      enableGovernor: true,
      ...cfg
    };

    this.fsScene = new THREE.Scene();
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.fsMat = new THREE.ShaderMaterial({
      uniforms: {
        tLow: { value: null },
        tHigh: { value: null },
        uGaze: { value: new THREE.Vector2(0, 0) },
        uRadius: { value: this.cfg.foveaRadius },
        uFeather: { value: this.cfg.feather },
        uAspect: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tLow;
        uniform sampler2D tHigh;
        uniform vec2 uGaze;      // NDC
        uniform float uRadius;
        uniform float uFeather;
        uniform float uAspect;

        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          vec2 d = p - uGaze;
          d.x *= uAspect;
          float dist = length(d);
          float m = smoothstep(uRadius + uFeather, uRadius, dist);
          vec4 low  = texture2D(tLow, vUv);
          vec4 high = texture2D(tHigh, vUv);
          gl_FragColor = mix(low, high, m);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fsMat);
    this.fsScene.add(quad);

    this.governor = new Governor({ enable: this.cfg.enableGovernor, ...(this.cfg.governor ?? {}) });

    this.setSize(width, height);

    // optional GPU timer (only if WebGL2)
    const gl = renderer.getContext();
    if (gl instanceof WebGL2RenderingContext) this.gpuTimer = new GpuTimer(gl);
  }

  setSize(width: number, height: number) {
    this.w = width; this.h = height;

    const lw = Math.max(2, Math.floor(width * this.cfg.lowScale));
    const lh = Math.max(2, Math.floor(height * this.cfg.lowScale));

    this.rtLow?.dispose();
    this.rtHigh?.dispose();

    this.rtLow = new THREE.WebGLRenderTarget(lw, lh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false
    });
    this.rtLow.texture.generateMipmaps = false;

    this.rtHigh = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false
    });
    this.rtHigh.texture.generateMipmaps = false;

    this.fsMat.uniforms.tLow.value = this.rtLow.texture;
    this.fsMat.uniforms.tHigh.value = this.rtHigh.texture;
    this.fsMat.uniforms.uAspect.value = width / height;
  }

  private govern(frameMs: number) {
    this.governor.update(frameMs);
    const { dLowScale, dFoveaRadius } = this.governor.decide();
    if (!dLowScale && !dFoveaRadius) return false;

    // apply with clamps
    const g = this.governor.cfg;
    this.cfg.lowScale = Math.min(g.lowScaleMax, Math.max(g.lowScaleMin, this.cfg.lowScale + dLowScale));
    this.cfg.foveaRadius = Math.min(g.foveaRadiusMax, Math.max(g.foveaRadiusMin, this.cfg.foveaRadius + dFoveaRadius));

    this.setSize(this.w, this.h);
    return true;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, gazeNDC: THREE.Vector2): FoveaStats {
    const now = performance.now();
    const frameMs = now - this.lastT;
    this.lastT = now;

    this.govern(frameMs);

    this.fsMat.uniforms.uGaze.value.copy(gazeNDC);
    this.fsMat.uniforms.uRadius.value = this.cfg.foveaRadius;
    this.fsMat.uniforms.uFeather.value = this.cfg.feather;
    this.fsMat.uniforms.uAspect.value = this.w / this.h;

    const prevRT = this.renderer.getRenderTarget();

    // GPU timer (best effort)
    this.gpuTimer?.begin();

    // 1) LOW pass
    this.renderer.setRenderTarget(this.rtLow);
    this.renderer.setViewport(0, 0, this.rtLow.width, this.rtLow.height);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // 2) HIGH pass (scissor patch)
    const cx = (gazeNDC.x * 0.5 + 0.5) * this.w;
    const cy = (gazeNDC.y * 0.5 + 0.5) * this.h;

    const rNdc = this.cfg.foveaRadius + this.cfg.feather;
    let rY = rNdc * 0.5 * this.h;
    let rX = rY * (this.w / this.h);

    const x0 = Math.max(0, Math.floor(cx - rX));
    const y0 = Math.max(0, Math.floor(cy - rY));
    const x1 = Math.min(this.w, Math.floor(cx + rX));
    const y1 = Math.min(this.h, Math.floor(cy + rY));

    this.renderer.setRenderTarget(this.rtHigh);
    this.renderer.setViewport(0, 0, this.w, this.h);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // 3) Composite
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.w, this.h);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.fsScene, this.fsCam);

    this.gpuTimer?.end();
    const gpuMs = this.gpuTimer?.poll() ?? null;

    this.renderer.setRenderTarget(prevRT);

    return {
      frameMs,
      emaFrameMs: this.governor.emaFrameMs,
      gpuMs,
      lowScale: this.cfg.lowScale,
      foveaRadius: this.cfg.foveaRadius,
      feather: this.cfg.feather,
      rtLow: { w: this.rtLow.width, h: this.rtLow.height }
    };
  }
}

