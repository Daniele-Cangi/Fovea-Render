# 🔍 Y Axis Coordinate System Analysis

## 🎯 TEST IMMEDIATI DA FARE

### Test 1: Patch Position Test
**URL:** http://localhost:5174/test-patch-position.html

**Cosa osservare:**
1. Muovi mouse su **TOP-LEFT (quadrante ROSSO)**
2. Il rettangolo MAGENTA (patch) dovrebbe andare su **TOP-LEFT** ✓
3. Se va in un quadrante diverso → ERRORE, annota quale!

**Ripeti per tutti i 4 quadranti:**
- TOP-LEFT (ROSSO) → Patch dovrebbe essere TOP-LEFT
- TOP-RIGHT (VERDE) → Patch dovrebbe essere TOP-RIGHT
- BOTTOM-LEFT (BLU) → Patch dovrebbe essere BOTTOM-LEFT
- BOTTOM-RIGHT (GIALLO) → Patch dovrebbe essere BOTTOM-RIGHT

### Test 2: Detailed Gaze Test
**URL:** http://localhost:5174/test-gaze-detailed.html

**Cosa osservare:**
1. Clicca su quadrato "TOP" (in alto centro)
2. Muovi mouse verso l'alto
3. Osserva il valore **"Mouse/Gaze Y"**:
   - Se diventa **POSITIVO** (+0.5, +0.8, ecc.) → ✓ CORRETTO
   - Se diventa **NEGATIVO** (-0.5, -0.8, ecc.) → ❌ INVERTITO

---

## 📊 Coordinate Systems Stack

### 1. MediaPipe Raw (Face Landmarks)
```
X: 0 (left) ────→ 1 (right)
Y: 0 (top)  ────→ 1 (bottom)
Origin: TOP-LEFT
```

### 2. MediaPipe Normalized (after processing)
```
headX = (nose.x - 0.5) * 2.2
headY = (nose.y - 0.5) * 2.2

Range: -1.1 to +1.1
Origin: CENTER

When looking UP:   nose.y ≈ 0.3 → headY = (0.3-0.5)*2.2 = -0.44
When looking DOWN: nose.y ≈ 0.7 → headY = (0.7-0.5)*2.2 = +0.44
```

### 3. After Our Y Inversion (line 288 in MediapipeGazeProvider.ts)
```typescript
gy = -gy;
```

```
When looking UP:   headY = -0.44 → gy = -(-0.44) = +0.44 ✓
When looking DOWN: headY = +0.44 → gy = -(+0.44) = -0.44 ✓
```

**This SHOULD be correct for NDC!**

### 4. Three.js NDC (target)
```
X: -1 (left)   ────→ +1 (right)
Y: -1 (bottom) ────→ +1 (top)    ⚠️ Y+ is UP
Origin: CENTER
```

### 5. Conversion to Top-Left (for patch rect calculation)
```typescript
// main.ts line 1734
const cy = (-gaze.y * 0.5 + 0.5) * FULL_H;
```

```
Input (NDC):         gaze.y = +0.5 (looking UP)
After negation:      -gaze.y = -0.5
After normalization: (-0.5 * 0.5 + 0.5) = 0.25
Screen Y:            0.25 * 600 = 150px from TOP ✓

Input (NDC):         gaze.y = -0.5 (looking DOWN)
After negation:      -gaze.y = +0.5
After normalization: (+0.5 * 0.5 + 0.5) = 0.75
Screen Y:            0.75 * 600 = 450px from TOP ✓
```

**This seems correct too!**

---

## 🤔 Potential Issues

### Hypothesis 1: Double Negation
We negate Y in MediaPipe provider (line 288), but maybe mouse coordinates don't have the same negation pattern?

**Check mouse Y conversion:**
```typescript
// main.ts line 1159
const ny = -(y * 2 - 1);
```

Let's trace mouse at TOP of screen:
```
y = 0 (top of screen)
y * 2 - 1 = 0 * 2 - 1 = -1
ny = -(-1) = +1 ✓ (NDC Y+ is up, so top = +1 is correct!)
```

Let's trace mouse at BOTTOM of screen:
```
y = 1 (bottom of screen)
y * 2 - 1 = 1 * 2 - 1 = +1
ny = -(+1) = -1 ✓ (NDC Y- is down, so bottom = -1 is correct!)
```

**Mouse Y conversion is CORRECT!**

### Hypothesis 2: MediaPipe Y Axis Interpretation
Maybe MediaPipe's Y axis interpretation is different than we thought?

**Need to test:**
1. Look UP → What is raw `nose.y` value?
2. Look DOWN → What is raw `nose.y` value?

### Hypothesis 3: Calibration Matrix Issue
If you did calibration with old mirror settings, the calibration matrix might have inverted coefficients.

**Solution:** Clear calibration and test WITHOUT calibration first!

---

## 🧪 Diagnostic Steps

### Step 1: Clear Calibration
```javascript
localStorage.removeItem('fovea.calib.v1');
location.reload();
```

### Step 2: Test with Mouse ONLY (not eyes)
This eliminates eye tracking as variable. Mouse coordinates are simpler to verify.

### Step 3: Console Logging
Add this to browser console while on main demo:

```javascript
// Monitor gaze values in real-time
setInterval(() => {
  const stats = document.getElementById('senderStats');
  if (stats) {
    const text = stats.textContent;
    const match = text.match(/gazeNDC:\s+([\d.-]+),\s+([\d.-]+)/);
    if (match) {
      console.log('gazeNDC:', { x: parseFloat(match[1]), y: parseFloat(match[2]) });
    }
  }
}, 1000);
```

Then:
- Move mouse to TOP of screen → Y should be POSITIVE
- Move mouse to BOTTOM of screen → Y should be NEGATIVE

### Step 4: Test Patch Position Visual Test
Use the patch-position test page to see if patch goes to correct quadrant.

---

## 🔧 Possible Fixes

### If mouse Y works but eye Y doesn't:

**Option A: Remove our Y negation**
```typescript
// In MediapipeGazeProvider.ts, REMOVE line 288:
// gy = -gy;  // ← Comment this out
```

**Option B: MediaPipe already gives correct Y**
Maybe MediaPipe's coordinate system already matches what we need?

### If both mouse and eye Y are inverted:

**Option: Invert Y in conversion to top-left**
```typescript
// main.ts line 1734, change:
const cy = (-gaze.y * 0.5 + 0.5) * FULL_H;
// to:
const cy = (gaze.y * 0.5 + 0.5) * FULL_H;
```

---

## ✅ Action Plan

1. **Run test-patch-position.html** → Note which quadrants are wrong
2. **Run test-gaze-detailed.html** → Note if Y value has correct sign
3. **Report findings** → Based on results, we'll know exact fix needed

**Please test both pages and tell me:**
- Does patch go to correct quadrant?
- When you move mouse UP, does Y value become POSITIVE?
- When you move mouse DOWN, does Y value become NEGATIVE?

This will tell us exactly where the problem is!
