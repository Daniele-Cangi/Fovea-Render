# ⚡ FoveaRender - Quick Test Guide

## 🎯 Obiettivo
Verificare che il sistema funzioni correttamente prima di procedere con lo Scenario 3 (test produzione).

---

## 🚀 Quick Start (5 minuti)

### 1️⃣ Diagnostica Sistema
**URL:** http://localhost:5174/test-diagnostics.html

**Verifica:**
- ✅ Tutti i check verdi (o max 1-2 warning gialli)
- ❌ Se vedi errori rossi → Fermati e segnala

---

### 2️⃣ Test Demo Principale
**URL:** http://localhost:5174

**Verifica visiva rapida:**
1. **Concedi permesso webcam** quando richiesto
2. **Vedi 3 canvas?** → LOW (piccolo) + PATCH (medio) + RECEIVER (grande)
3. **Scena 3D ruota?** → Cloud di punti che gira lentamente
4. **Stats si aggiornano?** → Numeri che cambiano ogni secondo

**Se tutto OK → Procedi**

---

### 3️⃣ Test Controlli (2 minuti)

Premi questi tasti e osserva le stats:

| Tasto | Effetto Atteso | Verifica |
|-------|----------------|----------|
| **L** | Toggle LOD | `lod: true/false` cambia |
| **G** | Toggle GPU governor | `gov_on: true/false` cambia |
| **B** | Toggle BW governor | `bw_on: true/false` cambia |
| **T** | Start telemetry | Indica "recording" |
| **C** | Calibrazione | Appare griglia 3×3 con dot arancione |

**Se tutti rispondono → Sistema OK**

---

### 4️⃣ Test Eye Tracking (1 minuto)

**Guarda le stats del SENDER:**

Cerca questa riga:
```
use_eye: true    conf: 0.75    gaze_x: 0.123  gaze_y: -0.456
```

**Muovi gli occhi** (non la testa):
- `gaze_x` e `gaze_y` devono cambiare
- PATCH canvas deve seguire il tuo sguardo
- RECEIVER deve mostrare alta qualità dove guardi

**Se `use_eye: false`:**
- Mouse fallback attivo (muovi mouse invece)
- Comunque funzionale!

---

### 5️⃣ Test Calibrazione (3 minuti) - OPZIONALE ma RACCOMANDATO

**Premi `C`**

1. Appare dot arancione in posizione griglia
2. **Guarda il dot** (solo occhi, testa ferma!)
3. Dot salta in nuova posizione (9 totali)
4. Fine: "Calibration saved"

**Dopo calibrazione:**
- Eye tracking più preciso
- `conf` valore più alto
- Refresh pagina → calibrazione persiste

---

## ✅ CHECKLIST FINALE

Segna ✓ se OK:

- [ ] Diagnostica: tutti ✅ (o max 1-2 ⚠️)
- [ ] 3 canvas visibili e aggiornati
- [ ] Stats mostrano valori realistici:
  - `gpu_*_ms`: 2-10ms ciascuno
  - `kbps_*`: 500-3000 range
  - `rtt_ms`: < 10ms (loopback)
- [ ] Controlli tastiera funzionanti (L, G, B, T)
- [ ] Eye tracking O mouse funzionante
- [ ] Nessun errore in console (F12)

---

## 🎉 SE TUTTO ✓ → READY FOR SCENARIO 3!

**Sistema pronto per:**
- Split sender/receiver su network reale
- Test con throttling network
- Analisi telemetria avanzata
- Scene 3D complesse

---

## 🚨 SE PROBLEMI

**Controlla console browser (F12):**

Common errors e fix:

| Errore | Fix |
|--------|-----|
| MediaPipe CDN fail | Check internet connection |
| Webcam permission denied | Grant permission e refresh |
| WebRTC not supported | Use Chrome/Edge/Firefox moderno |
| Stats frozen | Refresh (F5) o restart server |

**Se bloccato → Documenta errore console e chiedi aiuto**

---

## 📊 Valori Normali di Riferimento

**GPU Timing (ms):**
- LOW: 2-6ms
- PATCH: 3-7ms
- RECEIVER: 1-4ms
- TOTALE: < 15ms (ottimo) / < 20ms (ok)

**Bandwidth (kbps):**
- Balanced profile: ~2000 LOW + ~1000 PATCH
- Mobile profile: ~800 LOW + ~400 PATCH
- LAN profile: ~5000 LOW + ~3000 PATCH

**Network (loopback):**
- RTT: 0-5ms
- Loss: 0-0.5%

**Eye Tracking:**
- Confidence: > 0.30 (ok) / > 0.60 (good) / > 0.80 (excellent)
- Gaze range: -1.0 to +1.0 (NDC coordinates)

---

## 📝 Note per Scenario 3

Una volta verificato tutto, annota:

1. **Hardware usato:**
   - CPU: ______________
   - GPU: ______________
   - RAM: ______________

2. **Performance baseline:**
   - GPU time totale: _______ ms
   - Bitrate LOW: _______ kbps
   - Bitrate PATCH: _______ kbps

3. **Eye tracking quality:**
   - Confidence media: _______
   - Calibrato: SI / NO

**Questi dati serviranno come baseline per confronto in Scenario 3!**

---

**Buon test! 🚀**
