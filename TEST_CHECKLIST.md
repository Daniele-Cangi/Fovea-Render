# 🧪 FoveaRender - Test Checklist

## Pre-Test Setup
- [ ] Server running on http://localhost:5174
- [ ] Browser: Chrome/Edge 90+ or Firefox 88+
- [ ] Webcam connected and working
- [ ] Good lighting for face detection

## 🔍 Step 1: System Diagnostics (2 min)

**Open:** http://localhost:5174/test-diagnostics.html

Expected results:
- [ ] All green ✅ checkmarks (or max 1-2 warnings ⚠️)
- [ ] WebGL2 support: ENABLED
- [ ] WebRTC support: ENABLED
- [ ] MediaPipe CDN: REACHABLE
- [ ] Webcam detected: At least 1 camera

**If any FAIL (❌):** Stop and fix before proceeding!

---

## 🎮 Step 2: Visual Verification (5 min)

**Open:** http://localhost:5174

### 2.1 Initial Load
- [ ] 3 canvas elements visible (LOW, PATCH, RECEIVER)
- [ ] 3D point cloud scene rotating smoothly
- [ ] Stats updating every second in both panels
- [ ] Browser asks for webcam permission → ALLOW

### 2.2 Eye Tracking Check
Look at the stats panel and verify:
- [ ] `use_eye: true` appears (after webcam permission granted)
- [ ] `conf: 0.XX` shows confidence > 0.30
- [ ] `gaze_x/y` values change when you move your eyes
- [ ] If webcam fails: `use_eye: false` and mouse fallback works

**Move your eyes around the screen:**
- [ ] PATCH canvas content changes (follows your gaze)
- [ ] RECEIVER canvas shows high-quality region where you look

---

## 🎯 Step 3: Calibration Test (3 min)

**Press `C` key** to start calibration

- [ ] Orange dot appears in grid pattern (3×3)
- [ ] Follow dot with EYES ONLY (don't move head!)
- [ ] Complete all 9 points without pressing ESC
- [ ] "Calibration saved" message appears (check console)

**After calibration:**
- [ ] Eye tracking more accurate
- [ ] `conf` value higher than before
- [ ] Gaze follows actual eye position better

**Test persistence:**
- [ ] Refresh page (F5)
- [ ] Calibration still active (loaded from localStorage)

---

## ⚙️ Step 4: Controls Test (5 min)

### 4.1 LOD Toggle
**Press `L` key**
- [ ] Stats show `lod: false` → `lod: true` toggle
- [ ] Visual change in point density (periphery less dense)
- [ ] GPU time should decrease slightly with LOD ON

### 4.2 GPU Governor
**Press `G` key** to toggle
- [ ] Stats show `gov_on: true/false`
- [ ] When ON: `gov_tgt_ms`, `gov_ema_ms`, `gov_thr` values appear

**Press `+` key** (increase target)
- [ ] `gov_tgt_ms` increases by 0.5ms
- [ ] Max value: 20ms

**Press `-` key** (decrease target)
- [ ] `gov_tgt_ms` decreases by 0.5ms
- [ ] Min value: 4ms

### 4.3 Bandwidth Governor
**Press `B` key** to toggle
- [ ] Stats show `bw_on: true/false`

**Press `1` key** (Mobile profile)
- [ ] `bw_prof: mobile`
- [ ] `target_*_kbps` values change to ~800/400

**Press `2` key** (Balanced profile)
- [ ] `bw_prof: balanced`
- [ ] `target_*_kbps` values change to ~2000/1000

**Press `3` key** (LAN profile)
- [ ] `bw_prof: lan`
- [ ] `target_*_kbps` values change to ~5000/3000

**Press `[` key** (decrease cap)
- [ ] Total bandwidth decreases by ~200 kbps

**Press `]` key** (increase cap)
- [ ] Total bandwidth increases by ~200 kbps

### 4.4 Telemetry
**Press `T` key**
- [ ] Stats show recording indicator
- [ ] Telemetry buffer filling

**Press `D` key** (download)
- [ ] File `telemetry_YYYY-MM-DDTHH-MM-SS.jsonl` downloads
- [ ] Open file: valid JSONL format (one JSON object per line)

**Press `X` key** (clear)
- [ ] Buffer cleared
- [ ] Sequence number resets

---

## 📊 Step 5: Performance Metrics (5 min)

### 5.1 GPU Timing
Look at sender stats panel:
- [ ] `gpu_low_ms`: Should be 2-6ms
- [ ] `gpu_patch_ms`: Should be 3-7ms
- [ ] `gpu_recv_ms`: Should be 1-4ms
- [ ] Total < 20ms (smooth 30fps)

**With LOD OFF:**
- [ ] GPU times higher

**With LOD ON:**
- [ ] GPU times lower (20-40% reduction)

### 5.2 Bandwidth Usage
- [ ] `kbps_low`: Shows real bitrate (500-3000 kbps)
- [ ] `kbps_patch`: Shows real bitrate (200-1500 kbps)
- [ ] `kbps_*_ema`: Smoothed values (more stable)
- [ ] `applied_*_kbps`: Should match `target_*_kbps` after 2-3 seconds

### 5.3 Network Quality (Loopback)
- [ ] `rtt_ms`: Should be very low (0-5ms in loopback)
- [ ] `loss_pct`: Should be 0% or very low (< 0.5%)
- [ ] `loss_tx_pct` / `loss_rx_pct`: Both near 0%
- [ ] `ice_rtt_ms`: Similar to rtt_ms

---

## 🧪 Step 6: Stress Test (Optional, 5 min)

### 6.1 GPU Stress
**Goal:** Test GPU governor under load

1. Disable LOD: Press `L` (off)
2. Lower GPU target: Press `-` multiple times (set to ~6ms)
3. Observe:
   - [ ] `gov_ema_ms` increases (red zone)
   - [ ] `gov_thr` increases (throttling FAR cloud)
   - [ ] `fovea_r` might shrink (reduce quality area)
   - [ ] Frame rate stabilizes (governor working)

### 6.2 Bandwidth Stress
**Goal:** Test bandwidth governor adaptation

1. Set to Mobile profile: Press `1`
2. Manually reduce further: Press `[` several times
3. Observe:
   - [ ] `kbps_*` actual values decrease
   - [ ] `applied_*_kbps` matches new targets
   - [ ] Visual quality degrades gracefully
   - [ ] No freezing or stuttering

---

## ✅ Final Verification

### Visual Quality
- [ ] LOW stream: Lower resolution but recognizable scene
- [ ] PATCH stream: High quality crop following gaze
- [ ] RECEIVER: Seamless composite with fovea region sharp

### Smoothness
- [ ] 30 FPS maintained (no stuttering)
- [ ] Gaze tracking smooth (no jitter)
- [ ] Stream updates fluid (no lag)

### Reliability
- [ ] No errors in browser console
- [ ] No WebRTC connection failures
- [ ] Stats update consistently (no freezes)

---

## 🚨 Common Issues & Fixes

### ❌ "use_eye: false" always
**Fix:**
- Grant webcam permission
- Check lighting (need good face visibility)
- Try calibration (Press `C`)
- Fallback: Use mouse (still functional)

### ❌ Stats frozen
**Fix:**
- Check console for errors
- Refresh page (F5)
- Restart dev server

### ❌ Bitrate doesn't match targets
**Fix:**
- Wait 3-5 seconds (WebRTC needs negotiation time)
- Check `connectionState` in console (should be "connected")
- Verify no console errors about `setParameters`

### ❌ GPU timing very high (> 30ms)
**Fix:**
- Enable LOD (Press `L`)
- Enable GPU governor (Press `G`)
- Lower target with `-` key
- Check if hardware acceleration enabled in browser

---

## ✅ SUCCESS CRITERIA

System is **READY FOR SCENARIO 3** if:

- ✅ All diagnostics PASS (green)
- ✅ Eye tracking working OR mouse fallback functional
- ✅ All controls responsive (L, G, B, T, etc.)
- ✅ GPU timing < 20ms total
- ✅ Bandwidth governor adapting correctly
- ✅ Telemetry downloadable and valid
- ✅ No console errors
- ✅ Visual quality acceptable in all 3 canvas

**If all ✅ → Proceed to Scenario 3!**
**If any ❌ → Document issue and we'll fix before Scenario 3**

---

## 📝 Notes Section

Use this space to note any anomalies:

```
[Your observations here]
```
