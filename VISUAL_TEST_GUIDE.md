# 🎯 Guida al Test Visivo del Tracking

## 📍 Cosa ho aggiunto

Ho modificato `main.ts` per aggiungere **4 sfere colorate** nella scena 3D agli angoli:

- 🔴 **Rosso** - TOP-LEFT (alto sinistra)
- 🟢 **Verde** - TOP-RIGHT (alto destra)
- 🔵 **Blu** - BOTTOM-LEFT (basso sinistra)
- 🟡 **Giallo** - BOTTOM-RIGHT (basso destra)

Queste sfere sono **parte della scena 3D**, quindi saranno visibili sia nel video LOW che nel video PATCH.

## 🧪 Come Testare

### 1. Apri il Demo
```
http://localhost:5175
```

### 2. Guarda lo Schermo

Vedrai **2 pannelli video**:
- **SINISTRA (LOW):** Video a bassa risoluzione dell'intera scena
- **DESTRA (PATCH):** Video ad alta risoluzione della zona dove stai guardando

### 3. Test con Mouse (più semplice)

Se non hai ancora calibrato l'eye tracking, il sistema usa il **mouse** come fallback.

**COSA FARE:**
1. Muovi il mouse verso l'**angolo TOP-LEFT** (dove vedi la sfera rossa nel video LOW)
2. Guarda il video **PATCH (destra)**
3. **VERIFICA:** La sfera rossa DEVE apparire nel video PATCH
4. Ripeti per tutti e 4 gli angoli

### 4. Test con Eye Tracking

**PRIMA:** Calibra premendo `C` e seguendo i 9 punti.

**DOPO LA CALIBRAZIONE:**
1. **Guarda** verso l'angolo TOP-LEFT (sfera rossa)
2. Il video PATCH dovrebbe mostrare automaticamente quella zona
3. **VERIFICA:** La sfera rossa DEVE apparire nel video PATCH
4. Ripeti per tutti e 4 gli angoli

## ✅ Risultati Attesi (SE IL FIX È CORRETTO)

### Quando guardi/muovi verso ogni angolo:

| Angolo | Colore | LOW (sinistra) | PATCH (destra) |
|--------|--------|----------------|----------------|
| TOP-LEFT | 🔴 Rosso | Vedi sfera in alto a sinistra | ✅ Vedi STESSA sfera rossa |
| TOP-RIGHT | 🟢 Verde | Vedi sfera in alto a destra | ✅ Vedi STESSA sfera verde |
| BOTTOM-LEFT | 🔵 Blu | Vedi sfera in basso a sinistra | ✅ Vedi STESSA sfera blu |
| BOTTOM-RIGHT | 🟡 Giallo | Vedi sfera in basso a destra | ✅ Vedi STESSA sfera gialla |

## ❌ Se Vedi Questo = C'È ANCORA UN BUG

| Guardi verso | LOW mostra | PATCH mostra | Problema |
|--------------|------------|--------------|----------|
| 🔴 TOP-LEFT | Sfera rossa | 🔵 Sfera blu | ❌ Y invertito |
| 🟢 TOP-RIGHT | Sfera verde | 🟡 Sfera gialla | ❌ Y invertito |
| 🔴 TOP-LEFT | Sfera rossa | 🟢 Sfera verde | ❌ X invertito |
| 🔵 BOTTOM-LEFT | Sfera blu | 🟢 Sfera verde | ❌ X invertito |

## 📊 Interpretazione Risultati

### ✅ TUTTO CORRETTO
Se quando guardi/muovi verso una sfera, quella STESSA sfera appare nel PATCH:
- **Il fix `setViewOffset` ha funzionato!** ✓
- Il tracking è corretto
- Puoi procedere allo **Scenario 3**

### ❌ TOP ANCORA INVERTITO
Se quando guardi TOP-LEFT vedi la sfera blu (BOTTOM-LEFT) nel patch:
- Il problema Y persiste
- Potrebbe essere un altro punto dove serve inversione coordinate
- Dovremo investigare ulteriormente

### ❌ LEFT/RIGHT INVERTITO
Se quando guardi sinistra vedi destra e viceversa:
- Il problema X è ancora presente
- Controllare di nuovo `mirrorX: false`

## 🔍 Debug Avanzato

Nel pannello stats (in basso a sinistra) ora c'è scritto:

```
🎯 TEST MARKERS: Guarda le 4 sfere colorate (🔴🟢🔵🟡) agli angoli.
   Se il tracking funziona, la sfera DEVE apparire nel PATCH (destra)!
gazeNDC:    X.XXX, Y.YYY
```

Puoi controllare i valori `gazeNDC`:
- **X:** -1 (sinistra) a +1 (destra)
- **Y:** -1 (basso) a +1 (alto)

## 💡 Tips

1. **Le sfere sono GRANDI** - dovrebbero essere facilmente visibili
2. **Funziona sia con mouse che con eye tracking**
3. **Non serve calibrare per il test con mouse**
4. **Puoi muovere la scena 3D** - le sfere ruotano con la scena, ma la posizione relativa rimane fissa

## 🎬 Prossimi Passi

Dopo aver testato tutti e 4 gli angoli:

### Se TUTTO FUNZIONA ✅
1. Calibra l'eye tracking (`C`)
2. Testa nuovamente con gli occhi
3. Se ancora tutto ok → **Procedi a Scenario 3**

### Se C'È ANCORA UN PROBLEMA ❌
1. **Dimmi esattamente cosa vedi** (es: "Quando guardo rosso vedo blu nel patch")
2. Copia i valori `gazeNDC` dalla console quando sei su ogni angolo
3. Investigheremo insieme

---

**File modificato:** `apps/webrtc-dual/src/main.ts` (linee 1330-1349, 2251-2252)
**Vite reload:** Automatico (controlla che dica "page reload src/main.ts")
**Status:** ✅ Pronto per test
