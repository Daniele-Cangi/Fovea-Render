import * as THREE from "three";
import { FoveatedRenderer } from "@fovea-render/fovea-core";
import { makeSchrodingerScene } from "./schrodingerScene";

const hud = document.getElementById("hud")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const { scene, camera, update, gazeNDC } = makeSchrodingerScene(renderer);

const fovea = new FoveatedRenderer(renderer, window.innerWidth, window.innerHeight, {
  lowScale: 0.45,
  foveaRadius: 0.22,
  feather: 0.08,
  enableGovernor: true
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  fovea.setSize(window.innerWidth, window.innerHeight);
});

// fallback gaze: mouse
window.addEventListener("mousemove", (e) => {
  const x = (e.clientX / window.innerWidth) * 2 - 1;
  const y = -(e.clientY / window.innerHeight) * 2 + 1;
  gazeNDC.set(x, y);
});

function loop(t: number) {
  requestAnimationFrame(loop);
  update(t);
  const stats = fovea.render(scene, camera, gazeNDC);
  hud.textContent =
    `emaMs=${stats.emaFrameMs.toFixed(1)} gpuMs=${(stats.gpuMs ?? 0).toFixed(1)} ` +
    `lowScale=${stats.lowScale.toFixed(2)} foveaR=${stats.foveaRadius.toFixed(2)} ` +
    `rtLow=${stats.rtLow.w}x${stats.rtLow.h}`;
}
requestAnimationFrame(loop);

