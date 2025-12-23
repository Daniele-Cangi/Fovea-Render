# FoveaRender

Monorepo enterprise-grade per rendering foveato con Three.js, WebRTC e adaptive quality governor.

## 🎯 Overview

FoveaRender implementa **foveated rendering** - una tecnica che riduce il carico computazionale renderizzando ad alta risoluzione solo l'area dove l'utente sta guardando (fovea), mentre il resto della scena viene renderizzato a risoluzione ridotta. Questo consente di mantenere performance stabili anche con scene complesse.

## 📦 Struttura Monorepo

```
fovea-render/
├── packages/
│   ├── fovea-core/          # Core rendering engine
│   └── gaze-mediapipe/      # MediaPipe gaze tracking (placeholder)
└── apps/
    ├── demo-three/          # Demo Three.js con scena stress-test
    └── webrtc-dual/         # WebRTC dual stream foveato
```

## 🚀 Quick Start

### Prerequisiti

- Node.js 18+
- pnpm 9+

### Installazione

```bash
# Clone il repository
git clone https://github.com/Daniele-Cangi/Fovea-Render.git
cd Fovea-Render

# Installa le dipendenze
pnpm install
```

### Avvio Demo

```bash
# Demo Three.js locale
pnpm dev:demo

# Demo WebRTC dual stream
pnpm dev:webrtc
```

- **demo-three**: `http://localhost:5173`
- **webrtc-dual**: `http://localhost:5174`

## 📚 Packages

### `@fovea-render/fovea-core`

Core rendering engine con adaptive governor.

#### Componenti principali:

- **`FoveatedRenderer`**: Renderer principale che gestisce dual-pass rendering (low-res + high-res patch)
- **`Governor`**: Sistema di adaptive quality che regola dinamicamente `lowScale` e `foveaRadius` in base alle performance
- **`GpuTimer`**: Timer GPU per misurare il tempo di rendering (WebGL2)

#### Esempio d'uso:

```typescript
import { FoveatedRenderer } from "@fovea-render/fovea-core";
import * as THREE from "three";

const renderer = new THREE.WebGLRenderer();
const fovea = new FoveatedRenderer(renderer, width, height, {
  lowScale: 0.45,
  foveaRadius: 0.22,
  feather: 0.08,
  enableGovernor: true
});

// Nel render loop
const stats = fovea.render(scene, camera, gazeNDC);
```

#### Configurazione Governor:

```typescript
const fovea = new FoveatedRenderer(renderer, width, height, {
  enableGovernor: true,
  governor: {
    targetFrameMs: 16.7,      // Target 60 FPS
    lowScaleMin: 0.25,         // Min low-res scale
    lowScaleMax: 0.67,         // Max low-res scale
    foveaRadiusMin: 0.14,      // Min fovea radius (NDC)
    foveaRadiusMax: 0.34,      // Max fovea radius (NDC)
    hiMs: 18.2,                // Threshold per ridurre qualità
    loMs: 15.2,                // Threshold per aumentare qualità
    emaAlpha: 0.1              // EMA smoothing factor
  }
});
```

### `@fovea-render/gaze-mediapipe`

Package per integrazione MediaPipe gaze tracking (placeholder - da implementare).

## 🎮 Apps

### `demo-three`

Demo proof-of-concept con scena stress-test (90k punti additive).

**Caratteristiche:**
- Scena Schrodinger con 90k punti
- Governor automatico che mantiene performance stabili
- HUD con statistiche real-time (emaMs, gpuMs, lowScale, foveaRadius)
- Gaze tracking via mouse (fallback)

**Controlli:**
- Muovi il mouse per controllare il gaze
- Il governor regola automaticamente qualità per mantenere ~60 FPS

### `webrtc-dual`

Demo WebRTC con dual stream foveato per streaming remoto.

**Caratteristiche:**
- **Sender**: Genera due stream separati
  - Low-res stream: full frame downscaled (bandwidth saver)
  - Patch stream: fovea crop ad alta risoluzione (640×640px fisso)
- **Receiver**: Ricompone i due stream con shader foveato
- **DataChannel**: Invia metadata (gaze NDC + rect normalizzato) a ~30Hz
- **Stats**: Bitrate real-time per entrambi i track

**Configurazione:**
- Full resolution: 1280×720px
- Low scale: 0.42 (≈538×303px)
- Patch size: 640×640px (fisso per evitare renegotiation)
- Fovea radius: 0.22 NDC
- Feather: 0.08 NDC

**Uso:**
- Muovi il mouse sopra l'area receiver per vedere il rendering foveato
- La qualità alta segue il gaze mentre il resto resta low-res

## 🏗️ Build

```bash
# Build tutti i package
pnpm build

# Build singolo package
pnpm -C packages/fovea-core build
```

## 🧪 Tecnologie

- **Three.js** ^0.160.0 - Rendering 3D
- **TypeScript** - Type safety
- **Vite** - Dev server e build tool
- **tsup** - Build veloce per package
- **pnpm** - Package manager monorepo

## 📊 Performance

Il governor mantiene performance stabili anche con scene complesse:

- **demo-three**: 90k punti additive → ~60 FPS costanti
- **webrtc-dual**: 120k punti → dual stream a 30 FPS

Il sistema adatta automaticamente:
- `lowScale`: 0.25 - 0.67 (risoluzione low-res)
- `foveaRadius`: 0.14 - 0.34 NDC (area high-res)

## 🔧 Sviluppo

### Struttura TypeScript

- `tsconfig.base.json`: Configurazione base condivisa
- Ogni package/app estende la base con `tsconfig.json`

### Workspace pnpm

- `pnpm-workspace.yaml`: Definisce packages e apps
- Dipendenze workspace: `workspace:*`

## 📝 License

MIT

## 🤝 Contribuire

Pull requests sono benvenute! Per cambiamenti importanti, apri prima una issue per discutere cosa vorresti cambiare.

## 📧 Contatti

- GitHub: [@Daniele-Cangi](https://github.com/Daniele-Cangi)
- Repository: https://github.com/Daniele-Cangi/Fovea-Render

---

Made with ❤️ for high-performance foveated rendering

