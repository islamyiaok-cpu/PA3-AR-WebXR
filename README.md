# PA3 - AR product preview with hit-testing

- **Student:** Islamiya Okassova, ID 242322
- **Variant:** Coffee table, multi mode (max 5, the 6th tap removes the oldest), surface tolerance 8°, product faces the user
- **Device / browser:** Samsung Galaxy S23 Ultra, Android 13, Chrome 155.0.8059.85, Google Play Services for AR 1.57.262640093
- **Three.js:** 0.186.1 via import map (no node_modules committed). No ARButton, no AR frameworks, no model files.

## How to run
- Open https://islamyiaok-cpu.github.io/PA3-AR-WebXR/ in Chrome on an ARCore-capable Android phone and tap START AR.
- Local run: open the folder in VS Code, start Live Server, and use ADB port forwarding with chrome://inspect (as in Ch. 6-7).
- Test switches for the write-up experiments:
  - `?anchors=off` - disables anchors (panel shows `anchors: off`).
  - `?space=floor` - requests `local-floor` instead of `local`.
- The on-screen log (the Log pose button) prints camera and hit poses for experiment E1 and the matrix for E3.

## Porting notes (Ch. 7 -> Three.js 0.186.1)
1. **`new WebGLRenderer` throws.** The book creates a `webgl` (WebGL1) context and passes it to the renderer. Observed error: `THREE.WebGLRenderer: WebGL 1 is not supported since r163.` Fix: `getContext("webgl2", { antialias: true, alpha: true, xrCompatible: true })`.
2. **Geometry constructors are undefined.** Observed: `THREE.BoxBufferGeometry is not a constructor`; `typeof BoxBufferGeometry`, `CylinderBufferGeometry` and `RingBufferGeometry` are all `undefined`. The `*BufferGeometry` names were removed. Fix: `BoxGeometry`, `CylinderGeometry`, `RingGeometry`.
3. **A new hit-test source is requested on every frame.** Found by reading the code, no console error. In the book `hitTestSourceRequested` is never set to `true`, so the request runs every frame. Fix: set the flag to `true` immediately, before the async calls, and cancel the source in `onSessionEnd`.