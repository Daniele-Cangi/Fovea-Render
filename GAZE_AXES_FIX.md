# 🔧 Gaze Axes Fix - Summary

## 🐛 Problem Found

**Original Issues:**
1. ❌ Looking RIGHT → patch went LEFT (X axis inverted)
2. ❌ Looking UP → patch went DOWN (Y axis inverted)

## ✅ Fixes Applied

### Fix 1: X Axis (Horizontal)
**File:** `apps/webrtc-dual/src/main.ts` (line 1343)

**Change:**
```typescript
// BEFORE (incorrect)
const gaze = new MediapipeGazeProvider({ mirrorX: true, smoothAlpha: 0.18 });

// AFTER (correct)
const gaze = new MediapipeGazeProvider({ mirrorX: false, smoothAlpha: 0.18 });
```

**Reason:**
- `mirrorX: true` was mirroring X coordinates (like a webcam preview)
- For 3D scene tracking, coordinates should NOT be mirrored
- Looking right should track right, not left

---

### Fix 2: Y Axis (Vertical)
**File:** `packages/gaze-mediapipe/src/MediapipeGazeProvider.ts` (line 286-288)

**Change:**
```typescript
// ADDED (new lines)
// IMPORTANT: Invert Y to match NDC coordinate system (Y+ is up in NDC)
// MediaPipe gives Y+ as down (screen coordinates), but NDC needs Y+ as up
gy = -gy;
```

**Reason:**
- MediaPipe uses screen coordinates: Y=0 is top, Y=1 is bottom (Y+ down)
- Three.js NDC uses: Y=-1 is bottom, Y=+1 is top (Y+ up)
- Need to invert Y to convert from screen to NDC coordinates
- Mouse input already had this inversion (line 1159 in main.ts)

---

## 🧪 Verification Steps

### Step 1: Clear Old Calibration
Old calibration was done with wrong mirror settings, must be cleared.

**Method A - Browser Console:**
```javascript
localStorage.removeItem('fovea.calib.v1');
location.reload();
```

**Method B - UI Page:**
Open: http://localhost:5174/clear-calibration.html

### Step 2: Test Axes Alignment
**URL:** http://localhost:5174/test-gaze-axes.html

**Expected behavior:**
- Move eyes/mouse RIGHT → Cursor moves RIGHT ✓
- Move eyes/mouse LEFT → Cursor moves LEFT ✓
- Move eyes/mouse UP → Cursor moves UP ✓
- Move eyes/mouse DOWN → Cursor moves DOWN ✓

### Step 3: Test Main Demo
**URL:** http://localhost:5174

**Expected behavior:**
- Look RIGHT → PATCH canvas shows RIGHT side of scene ✓
- Look LEFT → PATCH canvas shows LEFT side of scene ✓
- Look UP → PATCH canvas shows TOP of scene ✓
- Look DOWN → PATCH canvas shows BOTTOM of scene ✓

### Step 4: Re-calibrate
**After verification:**
- Press `C` in main demo
- Follow 9 dots with eyes (don't move head)
- New calibration will use correct coordinate system

---

## 📊 Technical Details

### Coordinate Systems Involved

**1. MediaPipe Face Mesh (raw)**
- X: 0 (left) → 1 (right)
- Y: 0 (top) → 1 (bottom)
- Origin: top-left

**2. MediaPipe Normalized (headX/Y, irisX/Y)**
- X: -1.1 (left) → +1.1 (right)
- Y: -1.1 (top) → +1.1 (bottom)
- Origin: center
- Computed: `(value - 0.5) * 2.2`

**3. Three.js NDC (target)**
- X: -1 (left) → +1 (right)
- Y: -1 (bottom) → +1 (top) ⚠️ **Y inverted!**
- Origin: center

### Transformation Pipeline

```
MediaPipe Landmarks
    ↓
Normalize to ±1.1 range (head + iris)
    ↓
Apply Calibration (affine transform)
    ↓
[REMOVED] Mirror X (if mirrorX: true)  ❌
    ↓
[ADDED] Invert Y (gy = -gy)  ✓
    ↓
Clamp to ±1.0 (NDC)
    ↓
One-Euro Filter (smoothing)
    ↓
Output: gazeX, gazeY in Three.js NDC
```

---

## 🔄 Why Mouse Worked Correctly

Mouse input already had Y inversion:

**File:** `apps/webrtc-dual/src/main.ts` (line 1159)
```typescript
const ny = -(y * 2 - 1);  // ← Y axis flip for NDC
mouseNDC.set(
  THREE.MathUtils.clamp(nx, -1, 1),
  THREE.MathUtils.clamp(ny, -1, 1)
);
```

Eye tracking needed the same Y flip to match mouse behavior.

---

## 📝 Files Modified

1. **`apps/webrtc-dual/src/main.ts`**
   - Line 1343: `mirrorX: true` → `mirrorX: false`

2. **`packages/gaze-mediapipe/src/MediapipeGazeProvider.ts`**
   - Lines 286-288: Added `gy = -gy;` for Y axis inversion

3. **`packages/gaze-mediapipe/dist/index.js`** (auto-generated)
   - Rebuilt via `pnpm -C packages/gaze-mediapipe build`

---

## ✅ Status

- [x] X axis fixed (no mirror)
- [x] Y axis fixed (inverted for NDC)
- [x] Package rebuilt
- [x] Vite dev server reloaded
- [ ] **TODO: Clear old calibration**
- [ ] **TODO: Verify with test page**
- [ ] **TODO: Re-calibrate with correct axes**
- [ ] **TODO: Test in main demo**

---

## 🎯 Next Steps

1. **Verify fix works**
   - Test axes alignment page
   - Test main demo

2. **If working correctly:**
   - Re-calibrate (press C)
   - Complete functional test checklist
   - Proceed to **Scenario 3** (production test)

3. **If still issues:**
   - Check browser console for errors
   - Verify package was rebuilt
   - Verify page reloaded (hard refresh: Ctrl+Shift+R)

---

**Fix applied:** 2024-12-25
**Status:** Ready for testing ✓
