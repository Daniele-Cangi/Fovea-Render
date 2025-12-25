import * as THREE from "three";

export function makeSchrodingerScene(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.02);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
  camera.position.z = 30;

  // Big additive point cloud (simile al tuo)
  const N = 90000;
  const pos = new Float32Array(N * 3);
  const rnd = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * Math.PI * 2;
    const p = 2, q = 3;
    const radius = 8 + (Math.random() - 0.5) * 3;
    const r = radius * (2 + Math.sin(q * u));

    pos[i * 3 + 0] = r * Math.cos(p * u) + (Math.random() - 0.5);
    pos[i * 3 + 1] = r * Math.sin(p * u) + (Math.random() - 0.5);
    pos[i * 3 + 2] = radius * Math.cos(q * u) + (Math.random() - 0.5);
    rnd[i] = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    size: 2.0,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: 0x00f3ff
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  const gazeNDC = new THREE.Vector2(0, 0);

  function update(t: number) {
    points.rotation.y = t * 0.00015;
    points.rotation.z = t * 0.00008;
  }

  return { scene, camera, update, gazeNDC };
}




