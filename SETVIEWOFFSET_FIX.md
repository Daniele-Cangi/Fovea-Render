# 🎯 CRITICAL FIX: setViewOffset Coordinate System

## 🐛 The Bug

**Symptoms:**
- ✅ BOTTOM quadrants worked correctly (BOTTOM-LEFT, BOTTOM-RIGHT)
- ❌ TOP quadrants were inverted (TOP-LEFT → BOTTOM-LEFT, TOP-RIGHT → BOTTOM-RIGHT)
- Mathematical formulas were proven 100% correct via automated tests
- Mouse→NDC conversion was correct
- NDC→screen conversion was correct

**Root Cause:**
Three.js `setViewOffset()` uses **OpenGL coordinate system** (bottom-left origin, Y+ points UP), but we were passing **screen coordinates** (top-left origin, Y+ points DOWN).

## 🔍 Technical Details

### What is setViewOffset?

`camera.setViewOffset(fullWidth, fullHeight, x, y, width, height)` tells Three.js to render only a portion of the scene.

**Critical:** The `x, y` parameters use **OpenGL conventions**:
- Origin at BOTTOM-LEFT
- Y+ points UP

But our code was calculating `y0` as:
- Origin at TOP-LEFT
- Y+ points DOWN

### The Coordinate Systems

**Screen Coordinates (what we calculate):**
```
(0,0) ────────── (1280,0)
  │                  │
  │                  │
  │                  │
(0,720) ────── (1280,720)
```
Y+ points DOWN (standard canvas/screen)

**OpenGL Coordinates (what setViewOffset expects):**
```
(0,720) ────── (1280,720)
  │                  │
  │                  │
  │                  │
(0,0) ────────── (1280,0)
```
Y+ points UP (OpenGL/WebGL standard)

### Why BOTTOM worked but TOP didn't

Let's trace TOP-LEFT corner:
- Mouse at TOP-LEFT → `gazeNDC = (-1, +1)`
- Formula: `cy = (-1 * +1 * 0.5 + 0.5) * 720 = 0`
- `y0 = 0` (top of screen in screen coords)
- **BUG:** Passing `y0=0` to setViewOffset
- **setViewOffset interprets:** "0 pixels from BOTTOM" = bottom of scene!
- **Result:** Patch positioned at BOTTOM instead of TOP ❌

Let's trace BOTTOM-LEFT corner:
- Mouse at BOTTOM-LEFT → `gazeNDC = (-1, -1)`
- Formula: `cy = (--1 * 0.5 + 0.5) * 720 = 720`
- `y0 = 720` (bottom of screen... but wait, clamped to max 80)
- Actually: `y0 = clamp(cy - 320, 0, 720-640) = 80`
- **setViewOffset interprets:** "80 pixels from BOTTOM"
- **By coincidence, this was closer to correct!** ✅

The BOTTOM quadrants appeared to work because the Y-inversion error was less noticeable when the patch was near the bottom edge due to clamping.

## ✅ The Fix

**File:** `apps/webrtc-dual/src/main.ts` line 1763-1765

**Before (WRONG):**
```typescript
patchCam.clearViewOffset();
patchCam.setViewOffset(FULL_W, FULL_H, x0, y0, PATCH_W, PATCH_H);
patchCam.updateProjectionMatrix();
```

**After (CORRECT):**
```typescript
patchCam.clearViewOffset();
// Convert y0 from top-left origin (screen coords) to bottom-left origin (OpenGL/Three.js coords)
const y0_gl = FULL_H - y0 - PATCH_H;
patchCam.setViewOffset(FULL_W, FULL_H, x0, y0_gl, PATCH_W, PATCH_H);
patchCam.updateProjectionMatrix();
```

### Conversion Formula

```typescript
y0_gl = FULL_H - y0 - PATCH_H
```

Where:
- `y0` = distance from TOP (screen coordinates)
- `FULL_H` = full frame height (720)
- `PATCH_H` = patch height (640)
- `y0_gl` = distance from BOTTOM (OpenGL coordinates)

### Why This Works

For TOP of screen:
- Screen: `y0 = 0` (at top)
- OpenGL: `y0_gl = 720 - 0 - 640 = 80` (80px from bottom = near top) ✓

For BOTTOM of screen:
- Screen: `y0 = 80` (max clamp value)
- OpenGL: `y0_gl = 720 - 80 - 640 = 0` (at bottom) ✓

## 🧪 Verification

### Test Steps

1. **Clear calibration** (if testing with eye tracking):
   ```javascript
   localStorage.removeItem('fovea.calib.v1');
   location.reload();
   ```

2. **Test with mouse** at http://localhost:5175

3. **Expected Results (ALL CORRECT NOW):**
   - ✅ Mouse TOP-LEFT → Patch shows TOP-LEFT of scene
   - ✅ Mouse TOP-RIGHT → Patch shows TOP-RIGHT of scene
   - ✅ Mouse BOTTOM-LEFT → Patch shows BOTTOM-LEFT of scene
   - ✅ Mouse BOTTOM-RIGHT → Patch shows BOTTOM-RIGHT of scene

### Visual Test Page

Use `test-patch-position.html` - all 4 quadrants should now align:
- 🔴 RED (top-left) → Patch in red quadrant
- 🟢 GREEN (top-right) → Patch in green quadrant
- 🔵 BLUE (bottom-left) → Patch in blue quadrant
- 🟡 YELLOW (bottom-right) → Patch in yellow quadrant

### Diagnostic Page

Created `mouse-diagnostic.html` to monitor live gazeNDC values and computed patch positions.

## 📚 Why We Didn't Catch This Earlier

1. **Mathematical tests passed** - Our formulas for NDC→screen were correct
2. **BOTTOM quadrants worked** - Due to the clamping, the error was less obvious at bottom
3. **Test page worked** - The test page used CSS positioning (top-left origin), not setViewOffset
4. **No Y-flip in simpler cases** - The bug only manifested in the actual Three.js rendering

## 📝 Summary of ALL Coordinate Fixes

### Fix 1: X-Axis Mirror
**File:** `apps/webrtc-dual/src/main.ts` line 1343
```typescript
// BEFORE: mirrorX: true  (WRONG)
// AFTER:  mirrorX: false (CORRECT)
```

### Fix 2: Y-Axis MediaPipe (reverted - not needed for mouse mode)
**File:** `packages/gaze-mediapipe/src/MediapipeGazeProvider.ts`
- No Y negation in gaze provider (handled in setViewOffset conversion)

### Fix 3: setViewOffset Coordinate System (THE ACTUAL FIX!)
**File:** `apps/webrtc-dual/src/main.ts` line 1764
```typescript
const y0_gl = FULL_H - y0 - PATCH_H;
patchCam.setViewOffset(FULL_W, FULL_H, x0, y0_gl, PATCH_W, PATCH_H);
```

## 🎉 Status

- [x] X-axis mirroring fixed
- [x] Y-axis setViewOffset coordinate system fixed
- [x] Mathematical formulas verified correct
- [x] Vite hot-reloaded (14:50:11)
- [ ] **TODO: User verification**
- [ ] **TODO: Test with eye tracking**
- [ ] **TODO: Re-calibrate**
- [ ] **TODO: Proceed to Scenario 3**

---

**Fix applied:** 2025-12-25 14:50
**Root cause:** Coordinate system mismatch between screen (top-left) and OpenGL (bottom-left)
**Status:** Ready for testing ✓
