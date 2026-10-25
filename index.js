import * as THREE from "three";

// ---------- variant (student ID 242322) ----------
const STUDENT_ID = "242322";
const VARIANT = {
  product: "Coffee table",   // last digit 2
  mode: "multi",             // 2nd-to-last digit 2 -> 2 mod 2 = 0 -> multi
  maxProducts: 5,
  toleranceDeg: 8,           // 3rd-to-last digit 3 -> 3 mod 3 = 0 -> 8 degrees
  faceUser: true,            // 4th-to-last digit 2 -> 2 mod 2 = 0 -> faces the user
};

// ---------- global scene values ----------
let btn, stopBtn, gl, glCanvas, camera, scene, renderer, controller, reticle;
let overlay, panel, statusEl, fallbackEl;
// ---------- global xr values ----------
let xrSession = null, hitTestSource = null, hitTestSourceRequested = false;
let placeRequested = false;
let reticleText = "none"; // none / valid (angle) / too tilted (angle)
const placed = []; // { object, anchor, yaw } (used from Day 2-3)

loadScene();

function loadScene() {
  overlay = document.getElementById("overlay");
  panel = document.getElementById("panel");
  statusEl = document.getElementById("status");
  fallbackEl = document.getElementById("fallback");
  stopBtn = document.getElementById("stop");
  stopBtn.addEventListener("click", endXRSession);
  // Taps on the panel must not also count as an XR "select" (placement).
  panel.addEventListener("beforexrselect", (e) => e.preventDefault());

  // PORTING FIX 1: Three.js >= r163 dropped WebGL1, so the book's
  // getContext('webgl') makes the WebGLRenderer constructor throw.
  // Ask for WebGL2 and make it XR-compatible from the start.
  glCanvas = document.createElement("canvas");
  gl = glCanvas.getContext("webgl2", { antialias: true, alpha: true, xrCompatible: true });
  if (!gl) {
    showMessage("WebGL2 is not available in this browser.");
    return;
  }

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, context: gl });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (!renderer.xr.isPresenting) renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Reticle: a flat ring lying on the surface. Its matrix is set from the hit pose
  // every frame, so Three.js must not recompute it (matrixAutoUpdate = false).
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2), // PORTING FIX 2: RingGeometry, not RingBufferGeometry
    new THREE.MeshBasicMaterial({ color: 0x00ff00 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // The 'select' handler only raises a flag; the placement itself happens
  // inside the next frame callback with that frame's hit result (Task D).
  controller = renderer.xr.getController(0);
  controller.addEventListener("select", () => { placeRequested = true; });
  scene.add(controller);

  checkSupport();
}

function showMessage(text) {
  fallbackEl.textContent = text;
  fallbackEl.hidden = false;
}

function checkSupport() {
  if (!navigator.xr) {
    showMessage(window.isSecureContext === false
      ? "WebXR needs a secure context: open this page over HTTPS or localhost."
      : "This browser does not support WebXR (try Chrome on an ARCore-capable Android phone).");
    return;
  }
  navigator.xr.isSessionSupported("immersive-ar")
    .then((supported) => {
      if (supported) createStartButton();
      else showMessage("immersive-ar is not supported on this device or browser " +
        "(iPhone/iPad Safari has no WebXR AR). Use Chrome on an ARCore-capable Android phone.");
    })
    .catch((reason) => showMessage("WebXR check failed: " + reason));
}

function createStartButton() {
  btn = document.createElement("button");
  btn.id = "start";
  btn.textContent = "START AR";
  btn.addEventListener("click", () => (xrSession ? endXRSession() : onRequestSession()));
  document.querySelector("header").appendChild(btn);
}

function onRequestSession() {
  btn.disabled = true;
  navigator.xr
    .requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay"],
      domOverlay: { root: overlay },
    })
    .then(onSessionStarted)
    .catch((reason) => {
      console.warn("requestSession failed:", reason);
      btn.disabled = false;
      showMessage("Could not start AR: " + reason);
    });
}

async function onSessionStarted(session) {
  xrSession = session;
  // Both ways of ending (STOP button or system, e.g. Android back gesture)
  // fire this 'end' event, so there is ONE reset path: onSessionEnd.
  session.addEventListener("end", onSessionEnd);

  btn.textContent = "STOP AR";
  btn.disabled = false;
  fallbackEl.hidden = true;
  overlay.style.display = "";

  try {
    // PORTING NOTE: setSession() already does makeXRCompatible + creates the
    // XR layer + updateRenderState, so the book's setupWebGLLayer() is not needed.
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
  } catch (err) {
    console.error("setSession failed:", err);
    session.end().catch(() => {});
    return;
  }
  if (xrSession !== session) return; // ended while we were awaiting
  animate();
  updateStatus();
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(time, frame) {
  if (frame) {
    const session = frame.session;

    // PORTING FIX 3: the book never sets hitTestSourceRequested = true, so it
    // requests a new hit-test source (and a new 'end' listener) EVERY frame.
    // Set the flag immediately, before the async calls, so it happens once.
    if (!hitTestSourceRequested) {
      hitTestSourceRequested = true;
      session.requestReferenceSpace("viewer")
        .then((viewerSpace) => session.requestHitTestSource({ space: viewerSpace }))
        .then((source) => {
          if (xrSession !== session) { source.cancel(); return; } // session ended meanwhile
          hitTestSource = source;
        })
        .catch((e) => console.warn("hit-test source request failed:", e));
    }
    // Hit results are read in the LOCAL space (the space the scene lives in),
    // while the source was created from the VIEWER space (it follows the phone).
    const localSpace = renderer.xr.getReferenceSpace();
    let valid = false;
    let hasHit = false;
    reticleText = "none";
    if (hitTestSource && localSpace) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        const pose = results[0].getPose(localSpace);
        if (pose) {
          hasHit = true;
          const m = pose.transform.matrix;          // 16 numbers, column-major
          reticle.matrix.fromArray(m);
          reticle.matrixWorldNeedsUpdate = true;
          const tilt = tiltDegrees(m);
          valid = tilt <= VARIANT.toleranceDeg;     // 8 degrees for ID 242322
          reticle.material.color.set(valid ? 0x00ff00 : 0xff0000);
          reticleText = (valid ? "valid" : "too tilted") + ` (${tilt.toFixed(1)}°)`;
        }
      }
    }
    reticle.visible = hasHit;

    if (placeRequested) {
      placeRequested = false;
      // Day 3: real placement. For now only a log so the tap path can be tested.
      console.log("tap received, reticle valid =", valid);
    }
    // TODO Day 3: placement + anchors
    updateStatus();
  }
  renderer.render(scene, camera);
}

function endXRSession() {
  if (xrSession) xrSession.end().catch(() => {});
}

function onSessionEnd() {
  xrSession = null;
  hitTestSourceRequested = false;
  placeRequested = false;
  if (hitTestSource) {
    try { hitTestSource.cancel(); } catch (e) { /* source already gone */ }
    hitTestSource = null;
  }
  clearAll();
  reticleText = "none";
  if (reticle) reticle.visible = false;
  if (renderer) renderer.setAnimationLoop(null);
  overlay.style.display = "none";
  if (btn) { btn.textContent = "START AR"; btn.disabled = false; }
  updateStatus();
}

// Angle between the surface normal and world up (0,1,0).
// In a hit pose matrix the surface normal is the y-axis column = elements 4, 5, 6.
// cos(angle) = dot(normal, up) / |normal| = m[5] / |normal|
function tiltDegrees(m) {
  const len = Math.hypot(m[4], m[5], m[6]);
  const c = Math.min(1, Math.max(-1, m[5] / len));
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------- products (full logic comes on Day 3) ----------
function removeEntry(entry) {
  entry.removed = true;
  scene.remove(entry.object);
  if (entry.anchor) {
    try { entry.anchor.delete(); } catch (e) { /* ignore */ }
    entry.anchor = null;
  }
}
function clearAll() {
  while (placed.length) removeEntry(placed.pop());
}

// ---------- overlay ----------
let lastStatus = "";
function updateStatus() {
  const text = [
    `ID ${STUDENT_ID} · ${VARIANT.product}`,
    `mode: ${VARIANT.mode} (max ${VARIANT.maxProducts}) · tol ${VARIANT.toleranceDeg}° · faces user`,
    `session: ${xrSession ? "active" : "inactive"}`,
    `hit-test source: ${hitTestSource ? "ready" : "waiting"}`,
    `reticle: ${reticleText}`,
  ].join("\n");
  if (text !== lastStatus) { statusEl.textContent = text; lastStatus = text; }
}
