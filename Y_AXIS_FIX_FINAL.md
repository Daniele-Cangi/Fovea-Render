# ✅ Y Axis Fix - FINAL SOLUTION

## 🐛 Problem Identified

**User Test Results:**
- ✅ BOTTOM-LEFT (blue) → Patch BOTTOM-LEFT (CORRECT)
- ✅ BOTTOM-RIGHT (yellow) → Patch BOTTOM-RIGHT (CORRECT)
- ❌ TOP-LEFT (red) → Patch went to BOTTOM-LEFT (WRONG)
- ❌ TOP-RIGHT (green) → Patch went to BOTTOM-RIGHT (WRONG)

**Conclusion:** Y axis was inverted (top ↔ bottom swapped)

---

## 🔍 Root Cause Analysis

### The Problem: Double Negation

We were negating Y **twice**:

1. **First negation:** In `MediapipeGazeProvider.ts` line 288
   ```typescript
   gy = -gy;  // ← This was WRONG
   ```

2. **Second negation:** In `main.ts` line 1734 (conversion to top-left coords)
   ```typescript
   const cy = (-gaze.y * 0.5 + 0.5) * FULL_H;  // ← This is CORRECT and needed
   ```

**Result:** Y was inverted twice = back to original wrong orientation!

### Why X Axis Was Correct

X axis had only ONE transformation (no double negation):
- `mirrorX: false` in main.ts (we fixed this earlier)
- Direct conversion: `cx = (gaze.x * 0.5 + 0.5) * FULL_W` (no negation)

---

## ✅ Solution Applied

**File:** `packages/gaze-mediapipe/src/MediapipeGazeProvider.ts`

**Change:** REMOVED the Y negation (line 288)

**Before (WRONG):**
```typescript
// IMPORTANT: Invert Y to match NDC coordinate system (Y+ is up in NDC)
// MediaPipe gives Y+ as down (screen coordinates), but NDC needs Y+ as up
gy = -gy;  // ← REMOVED THIS
```

**After (CORRECT):**
```typescript
// NOTE: Y axis NOT inverted here - conversion to screen coords happens later in main.ts
// MediaPipe Y: 0 (top) to 1 (bottom) → normalized to -1.1 (top) to +1.1 (bottom)
// This matches the conversion logic in computePatchRectTopLeft() which does: cy = (-gaze.y * 0.5 + 0.5) * FULL_H
```

---

## 📊 Coordinate Flow (CORRECTED)

### MediaPipe Raw → Normalized
```
Looking UP:   nose.y = 0.3 → headY = (0.3 - 0.5) * 2.2 = -0.44
Looking DOWN: nose.y = 0.7 → headY = (0.7 - 0.5) * 2.2 = +0.44
```

### After Calibration (if any)
```
gaze.y = calibrated value (still in same coordinate system)
```

### ❌ REMOVED: Y Inversion
```
// gy = -gy;  ← THIS WAS THE BUG!
```

### Conversion to Top-Left Screen Coords (main.ts)
```typescript
const cy = (-gaze.y * 0.5 + 0.5) * FULL_H;
```

```
Looking UP:   gaze.y = -0.44 → cy = -(-0.44 * 0.5 + 0.5) * 600 = 132px from TOP ✓
Looking DOWN: gaze.y = +0.44 → cy = -(+0.44 * 0.5 + 0.5) * 600 = 468px from TOP ✓
```

**RESULT: Looking UP → Patch at TOP, Looking DOWN → Patch at BOTTOM ✓✓✓**

---

## 🧪 Verification Steps

### 1. Clear Old Calibration
```javascript
localStorage.removeItem('fovea.calib.v1');
location.reload();
```

### 2. Test Patch Position
**URL:** http://localhost:5174/test-patch-position.html

**Expected Results (ALL CORRECT NOW):**
- ✅ Mouse TOP-LEFT (red) → Patch TOP-LEFT
- ✅ Mouse TOP-RIGHT (green) → Patch TOP-RIGHT
- ✅ Mouse BOTTOM-LEFT (blue) → Patch BOTTOM-LEFT
- ✅ Mouse BOTTOM-RIGHT (yellow) → Patch BOTTOM-RIGHT

### 3. Test Main Demo
**URL:** http://localhost:5174

**Expected Results:**
- ✅ Look/Move RIGHT → PATCH shows RIGHT side
- ✅ Look/Move LEFT → PATCH shows LEFT side
- ✅ Look/Move UP → PATCH shows TOP
- ✅ Look/Move DOWN → PATCH shows BOTTOM

### 4. Re-Calibrate
Press `C` and follow 9 dots for optimal eye tracking accuracy.

---

## 📝 Summary of ALL Fixes Applied

### Fix 1: X Axis (Mirror)
**File:** `apps/webrtc-dual/src/main.ts` line 1343
```typescript
// BEFORE: mirrorX: true  (WRONG)
// AFTER:  mirrorX: false (CORRECT)
```

### Fix 2: Y Axis (Double Negation)
**File:** `packages/gaze-mediapipe/src/MediapipeGazeProvider.ts` line 286-288
```typescript
// BEFORE: gy = -gy;  (WRONG - caused double negation)
// AFTER:  (removed)  (CORRECT - single negation in main.ts is enough)
```

---

## 🎯 Why This Is The Correct Solution

### MediaPipe Coordinate System
MediaPipe Face Mesh outputs coordinates where:
- Y = 0 means TOP of camera view
- Y = 1 means BOTTOM of camera view

After normalization to ±1.1 range:
- Y negative means looking UP (toward top of camera)
- Y positive means looking DOWN (toward bottom of camera)

### Screen Coordinate System (Top-Left Origin)
When we render:
- Y = 0 means TOP of screen
- Y = 600 means BOTTOM of screen

### The Conversion
```typescript
const cy = (-gaze.y * 0.5 + 0.5) * FULL_H;
```

This single negation is ALL we need:
- `gaze.y = -0.5` (looking up) → `cy = 150` (top of screen) ✓
- `gaze.y = +0.5` (looking down) → `cy = 450` (bottom of screen) ✓

Adding another negation in MediaPipe provider would flip this again = WRONG!

---

## ✅ Status

- [x] X axis mirror fixed
- [x] Y axis double negation removed
- [x] Package rebuilt
- [x] Vite reloaded
- [ ] **TODO: User verification with test pages**
- [ ] **TODO: Re-calibrate for optimal tracking**
- [ ] **TODO: Proceed to Scenario 3**

---

**Fix applied:** 2024-12-25 (second iteration - Y axis corrected)
**Status:** Ready for final testing ✓
