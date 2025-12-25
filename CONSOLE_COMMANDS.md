# 🖥️ Console Commands - Quick Reference

Apri la console del browser (F12) e copia/incolla questi comandi.

---

## 🗑️ Reset Calibrazione

```javascript
// Cancella calibrazione e ricarica
localStorage.removeItem('fovea.calib.v1');
console.log('✅ Calibrazione cancellata!');
location.reload();
```

---

## 📊 Monitor Gaze in Tempo Reale

```javascript
// Mostra valori gaze ogni secondo
const gazeMonitor = setInterval(() => {
  const stats = document.getElementById('senderStats');
  if (stats) {
    const text = stats.textContent;
    const matchGaze = text.match(/gazeNDC:\s+([\-\d.]+),\s+([\-\d.]+)/);
    const matchUseEye = text.match(/use_eye:\s+(true|false)/);

    if (matchGaze) {
      const x = parseFloat(matchGaze[1]);
      const y = parseFloat(matchGaze[2]);
      const useEye = matchUseEye ? matchUseEye[1] === 'true' : false;

      console.log(`👁️ Gaze (${useEye ? 'EYE' : 'MOUSE'}):`, {
        x: x.toFixed(3),
        y: y.toFixed(3),
        direction: `${x > 0.1 ? 'RIGHT' : x < -0.1 ? 'LEFT' : 'CENTER'} / ${y > 0.1 ? 'UP' : y < -0.1 ? 'DOWN' : 'CENTER'}`
      });
    }
  }
}, 1000);

console.log('✅ Gaze monitor started. Type "clearInterval(gazeMonitor)" to stop.');
```

---

## 🛑 Stop Monitor

```javascript
// Ferma il monitor
clearInterval(gazeMonitor);
console.log('✅ Gaze monitor stopped.');
```

---

## 🔍 Check Calibrazione Esistente

```javascript
// Verifica se c'è calibrazione salvata
const calib = localStorage.getItem('fovea.calib.v1');
if (calib) {
  const data = JSON.parse(calib);
  console.log('📋 Calibrazione trovata:', data);
} else {
  console.log('❌ Nessuna calibrazione salvata');
}
```

---

## 🎯 Test Coordinate Manuale

```javascript
// Test manuale coordinate (muovi mouse e vedi output)
let lastX = 0, lastY = 0;
const coordTest = (e) => {
  const x = (e.clientX / window.innerWidth) * 2 - 1;
  const y = -((e.clientY / window.innerHeight) * 2 - 1);

  if (Math.abs(x - lastX) > 0.05 || Math.abs(y - lastY) > 0.05) {
    lastX = x;
    lastY = y;
    console.log('🖱️ Mouse NDC:', {
      x: x.toFixed(2),
      y: y.toFixed(2),
      screenX: e.clientX,
      screenY: e.clientY
    });
  }
};

document.addEventListener('mousemove', coordTest);
console.log('✅ Coordinate test active. Type "document.removeEventListener(\'mousemove\', coordTest)" to stop.');
```

---

## 🧪 Quick Diagnostic

```javascript
// Diagnostica completa sistema
console.log('🔍 FoveaRender System Diagnostic');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Check calibration
const calib = localStorage.getItem('fovea.calib.v1');
console.log('📋 Calibration:', calib ? '✓ Present' : '✗ Not found');

// Check WebGL2
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2');
console.log('🎨 WebGL2:', gl ? '✓ Supported' : '✗ Not supported');

// Check WebRTC
console.log('📡 WebRTC:', window.RTCPeerConnection ? '✓ Supported' : '✗ Not supported');

// Check MediaDevices
console.log('📷 MediaDevices:', (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? '✓ Supported' : '✗ Not supported');

// Check current stats
const stats = document.getElementById('senderStats');
if (stats) {
  const text = stats.textContent;
  const matchUseEye = text.match(/use_eye:\s+(true|false)/);
  const matchConf = text.match(/conf:\s+([\d.]+)/);
  const matchGaze = text.match(/gazeNDC:\s+([\-\d.]+),\s+([\-\d.]+)/);

  if (matchUseEye) console.log('👁️ Eye Tracking:', matchUseEye[1] === 'true' ? '✓ Active' : '✗ Fallback to mouse');
  if (matchConf) console.log('🎯 Confidence:', parseFloat(matchConf[1]).toFixed(2));
  if (matchGaze) console.log('📍 Current Gaze:', { x: matchGaze[1], y: matchGaze[2] });
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
```

---

## 🔄 Reload Page

```javascript
// Ricarica pagina (utile dopo reset)
location.reload();
```

---

## 🎮 Force Mouse Mode

```javascript
// Forza modalità mouse (disabilita eye tracking temporaneamente)
console.log('⚠️ This would require modifying the live code. Instead, just deny webcam permission when prompted.');
```

---

## 📝 Export Current State

```javascript
// Esporta stato corrente per debug
const state = {
  timestamp: new Date().toISOString(),
  calibration: localStorage.getItem('fovea.calib.v1'),
  userAgent: navigator.userAgent,
  screen: { width: window.innerWidth, height: window.innerHeight }
};

console.log('📦 Current State:', JSON.stringify(state, null, 2));
copy(JSON.stringify(state, null, 2)); // Auto-copy to clipboard (Chrome/Edge)
console.log('✅ State copied to clipboard!');
```

---

## 🎨 Toggle Stats Visibility

```javascript
// Mostra/nascondi pannello stats
const senderStats = document.getElementById('senderStats');
const recvStats = document.getElementById('recvStats');

if (senderStats) {
  senderStats.style.display = senderStats.style.display === 'none' ? 'block' : 'none';
}
if (recvStats) {
  recvStats.style.display = recvStats.style.display === 'none' ? 'block' : 'none';
}

console.log('✅ Stats panels toggled');
```

---

## 🚨 RESET COMPLETO

```javascript
// Reset TUTTO (calibrazione, cache, reload)
localStorage.clear();
sessionStorage.clear();
console.log('✅ Storage cleared!');
location.reload(true); // Hard reload
```

---

## 📌 Quick Copy Commands

**Reset Calibration Only:**
```javascript
localStorage.removeItem('fovea.calib.v1'); location.reload();
```

**Monitor Gaze:**
```javascript
setInterval(() => { const m = document.getElementById('senderStats')?.textContent.match(/gazeNDC:\s+([\-\d.]+),\s+([\-\d.]+)/); if(m) console.log('Gaze:', m[1], m[2]); }, 1000);
```

**Quick Diagnostic:**
```javascript
console.log('Calib:', localStorage.getItem('fovea.calib.v1') ? 'YES' : 'NO'); const s = document.getElementById('senderStats')?.textContent; const m = s?.match(/use_eye:\s+(\w+)/); console.log('Eye:', m?.[1]);
```

---

## 💡 Tips

- **Ctrl + Shift + J** (Windows) o **Cmd + Option + J** (Mac) per aprire console
- I comandi vengono eseguiti nel contesto della pagina corrente
- Alcuni comandi richiedono che la demo sia già caricata
- Per fermare intervalli: `clearInterval(gazeMonitor)`

---

**Salva questo file per reference rapido!** 🚀
