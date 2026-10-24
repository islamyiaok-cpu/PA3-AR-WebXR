# PA3 - AR product preview with hit-testing

- **Student:** Islamiya Okassova, ID 242322
- **Variant:** Coffee table & multi mode (max 5, 6th tap removes the oldest) & surface tolerance 8° & product faces the user
- **Device / browser:** TODO (phone model, Android version, Chrome version)
- **Three.js:** 0.186.1 via import map (no node_modules committed)

## How to run
TODO (GitHub Pages URL and/or localhost + ADB port forwarding, filled in after testing on the device)

## Porting notes (Ch. 7 → Three.js 0.186.1)
1. **`new WebGLRenderer` throws.** The book creates a `webgl` (WebGL1) context and passes it in. WebGL1 support was removed from Three.js (r163), so the renderer rejects the context. Fix: `getContext("webgl2", { xrCompatible: true, ... })`. Observed error text: TODO (paste from my console)
2. **`BoxBufferGeometry`, `CylinderBufferGeometry`, `RingBufferGeometry` are undefined.** The `*BufferGeometry` aliases were removed; use `BoxGeometry`, `CylinderGeometry`, `RingGeometry`. Observed error text: TODO
3. **A new hit-test source is requested on every frame.** In the book `hitTestSourceRequested` is never set to `true`, so the `if` runs each frame (and adds a new `end` listener each time). Fix: set the flag to `true` right away, before the async calls, and cancel the source in `onSessionEnd`.
