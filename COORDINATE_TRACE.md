# 🔍 Detailed Coordinate Trace Analysis

## 📊 Test Results (from user)

✅ **WORKING:**
- BOTTOM-LEFT (blue) → Patch goes to BOTTOM-LEFT ✓
- BOTTOM-RIGHT (yellow) → Patch goes to BOTTOM-RIGHT ✓

❌ **BROKEN:**
- TOP-LEFT (red) → Patch goes to BOTTOM-LEFT ✗
- TOP-RIGHT (green) → Patch goes to BOTTOM-RIGHT ✗

## 🧮 Let's Trace Mouse Coordinates Step by Step

### Constants
```
FULL_W = 1280
FULL_H = 720
PATCH_W = 640
PATCH_H = 640
```

### CASE 1: Mouse at BOTTOM-LEFT (✓ WORKS)

**Step 1: Screen coordinates**
```
Mouse at bottom-left corner of canvas
clientX ≈ 0 (left edge)
clientY ≈ 720 (bottom edge)
```

**Step 2: Normalize to 0-1**
```javascript
// main.ts line 1156-1157
x = (e.clientX - rect.left) / rect.width = 0 / 800 = 0.0
y = (e.clientY - rect.top) / rect.height = 720 / 600 = 1.0
```

**Step 3: Convert to NDC (-1 to +1)**
```javascript
// main.ts line 1158-1159
nx = x * 2 - 1 = 0.0 * 2 - 1 = -1.0
ny = -(y * 2 - 1) = -(1.0 * 2 - 1) = -(1.0) = -1.0
```
**mouseNDC = (-1.0, -1.0)**
✓ Correct: Left = -1, Bottom = -1 in NDC

**Step 4: Compute patch rect**
```javascript
// main.ts line 1733-1734 (CURRENT CODE)
cx = (gaze.x * 0.5 + 0.5) * FULL_W = (-1.0 * 0.5 + 0.5) * 1280 = 0 * 1280 = 0
cy = (gaze.y * 0.5 + 0.5) * FULL_H = (-1.0 * 0.5 + 0.5) * 720 = 0 * 720 = 0
```
**Patch position = (0, 0) = TOP-LEFT in screen coordinates!**

❌ **WAIT! This says TOP-LEFT but user says it works for BOTTOM-LEFT???**

---

### CASE 2: Mouse at TOP-LEFT (✗ BROKEN - goes to BOTTOM-LEFT)

**Step 1: Screen coordinates**
```
Mouse at top-left corner of canvas
clientX ≈ 0 (left edge)
clientY ≈ 0 (top edge)
```

**Step 2: Normalize to 0-1**
```javascript
x = 0 / 800 = 0.0
y = 0 / 600 = 0.0
```

**Step 3: Convert to NDC**
```javascript
nx = 0.0 * 2 - 1 = -1.0
ny = -(0.0 * 2 - 1) = -(-1.0) = +1.0
```
**mouseNDC = (-1.0, +1.0)**
✓ Correct: Left = -1, Top = +1 in NDC

**Step 4: Compute patch rect**
```javascript
cx = (-1.0 * 0.5 + 0.5) * 1280 = 0
cy = (+1.0 * 0.5 + 0.5) * 720 = 1.0 * 720 = 720
```
**Patch position = (0, 720) = BOTTOM-LEFT in screen coordinates!**

✓ **This matches user's report: TOP-LEFT mouse → BOTTOM-LEFT patch**

---

## 🎯 PROBLEM IDENTIFIED!

The formula `cy = (gaze.y * 0.5 + 0.5) * FULL_H` is treating Y as if:
- Y = -1 (NDC bottom) → cy = 0 (screen top)
- Y = +1 (NDC top) → cy = 720 (screen bottom)

This is **INVERTED** from what we need!

## ✅ CORRECT FORMULA

We need:
- Y = +1 (NDC top) → cy = 0 (screen top)
- Y = -1 (NDC bottom) → cy = 720 (screen bottom)

**The fix:**
```javascript
cy = (-gaze.y * 0.5 + 0.5) * FULL_H;
```

Wait... that's what we HAD BEFORE! Let me re-trace with the OLD formula...

---

## 🔄 Re-trace with OLD formula (with negation)

### CASE 1: Mouse at BOTTOM-LEFT (should work)

**mouseNDC = (-1.0, -1.0)**

```javascript
cx = (-1.0 * 0.5 + 0.5) * 1280 = 0
cy = (-(-1.0) * 0.5 + 0.5) * 720 = (1.0 * 0.5 + 0.5) * 720 = 720
```
**Patch = (0, 720) = BOTTOM-LEFT ✓**

### CASE 2: Mouse at TOP-LEFT (should work but user says goes to BOTTOM-LEFT)

**mouseNDC = (-1.0, +1.0)**

```javascript
cx = (-1.0 * 0.5 + 0.5) * 1280 = 0
cy = (-(+1.0) * 0.5 + 0.5) * 720 = (-0.5 + 0.5) * 720 = 0
```
**Patch = (0, 0) = TOP-LEFT ✓**

---

## 🤔 WAIT... THE OLD FORMULA WAS CORRECT!

If the old formula gives:
- BOTTOM-LEFT mouse → BOTTOM-LEFT patch ✓
- TOP-LEFT mouse → TOP-LEFT patch ✓

But user says TOP-LEFT mouse → BOTTOM-LEFT patch...

**THEN THE PROBLEM IS NOT IN THE FORMULA!**

## 💡 HYPOTHESIS: The test page is using the NEW formula!

Let me check what formula the test-patch-position.html is using...

Actually, the test page has its OWN implementation of the formula!

Let me check it...
