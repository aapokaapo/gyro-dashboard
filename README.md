# DualSense / DualSense Edge IMU Dashboard

Node.js + Express + browser WebHID dashboard for Sony DualSense and DualSense Edge IMU telemetry.

## Structure

- `server.js` — Express server
- `public/index.html` — dashboard UI
- `public/app.js` — dashboard/WebHID application logic
- `package.json` — Node.js metadata

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` in a Chromium browser with WebHID support.

## Aiming profile

The dashboard calculates a live session profile from completed FPS-perspective turns and active IMU samples, including turn-angle percentiles, left/right distribution, angular-velocity percentiles, peak velocity, and effective-sensitivity percentiles. `GYRO_OFF` samples are excluded from these statistics.


## v23
- Corrected the JoyShockMapper model to follow JSM's documented 3D mouse-output semantics.
- `GYRO_SENS` now explicitly represents the intended controller-angle → in-game-camera-angle ratio.
- `REAL_WORLD_CALIBRATION / IN_GAME_SENS` is used to derive JSM mouse output from that camera target; it no longer goes through a synthetic mouse→camera round-trip.
- The heatmap integrates intended calibrated camera velocity directly.
- The JSM panel shows the resulting mouse-units-per-degree calibration factor.
- `GYRO_CUTOFF_SPEED` now also zeros modeled camera/mouse output, not only the processed-axis display.


## v24 aiming profile
- Separate horizontal (X) and vertical (Y) sensitivity percentiles.
- Time-weighted low / ramp / max JSM sensitivity-zone usage.
- Existing fine-grained turn-angle distribution retained.
- Local run comparison table with optional Halo Infinite accuracy and browser-local persistence.


## v26 aiming-profile fixes
- Aiming-profile velocity now uses the exact processed velocity magnitude written to CSV.
- Profile retention increased from 100,000 to 1,000,000 active samples (~16.7 minutes at 1000 Hz), preventing the end of a session from replacing most gameplay statistics.
- Added a consistency warning for impossible-looking sensitivity summaries.
- Turn-angle distribution now uses fixed multi-resolution bins, preserving 5° detail from 0–50° even when rare 200–300° turns occur; bins also show raw counts.


## v26 heatmap scaling
The FPS-perspective turn heatmap now auto-scales to the 90th percentile of completed turn extent, rounded to 10 degrees with a 50-degree minimum. Rare large turns remain in turn-distribution/profile statistics but no longer expand the heatmap or get clamped onto its edge.
