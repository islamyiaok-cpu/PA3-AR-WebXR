import * as THREE from "three";

// ---------- variant (student ID 242322) ----------
const STUDENT_ID = "242322";
const VARIANT = {
  product: "Coffee table",   // last digit 2
  mode: "multi",             // 2nd-to-last digit 2 -> 2 mod 2 = 0 -> multi ("single" is the other option)
  maxProducts: 5,
  toleranceDeg: 8,          // 3rd-to-last digit 3 -> 3 mod 3 = 0 -> 8 degrees
  facing: "toward",          // 4th-to-last digit 2 -> 2 mod 2 = 0 -> faces the user ("away" / "hit" = keep hit orientation)
};

// ---------- global scene values ----------
let btn, stopBtn, gl, glCanvas, camera, scene, renderer, controller, reticle;
let overlay, panel, statusEl, fallbackEl;
let trackingEl, logEl;
// ---------- global xr values ----------
let xrSession = null, hitTestSource = null, hitTestSourceRequested = false;
let viewerSpace = null;
let placeRequested = false;
let anchorsOn = false;
let trackingLost = false;
let reticleText = "none"; // none / valid (angle) / too tilted (angle)
let logRequested = false, startLogged = false;
let hitCount = 0;
let product;                // template product; each placement clones it
const placed = [];          // { object, anchor, yaw, removed }

// Test switch for experiment E2a (anchors on vs off): open the page with ?anchors=off
const ANCHORS_OFF = new URLSearchParams(location.search).get("anchors") === "off";
// Test switch for experiment E2b (local vs local-floor): open the page with ?space=floor
const FLOOR = new URLSearchParams(location.search).get("space") === "floor";

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

loadScene();

function loadScene() {
  window.addEventListener("error", (e) => log("ERROR: " + e.message));
  window.addEventListener("unhandledrejection", (e) => log("PROMISE ERROR: " + e.reason));
  overlay = document.getElementById("overlay");
  panel = document.getElementById("panel");
  statusEl = document.getElementById("status");
  fallbackEl = document.getElementById("fallback");
  stopBtn = document.getElementById("stop");
  stopBtn.addEventListener("click", endXRSession);
  document.getElementById("clear").addEventListener("click", clearAll);
  trackingEl = document.getElementById("tracking");
  logEl = document.getElementById("log");
  document.getElementById("logpose").addEventListener("click", () => { logRequested = true; });
  // Taps on the panel must not also count as an XR "select" (placement).
  panel.addEventListener("beforexrselect", (e) => e.preventDefault());
  // PORTING FIX 1: Three.js >= r163 dropped WebGL1, so the book's
  // getContext('webgl') makes the WebGLRenderer constructor throw.
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

  // Light: one HemisphereLight (sky/ground) + one DirectionalLight.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1, 3, 2);
  scene.add(sun);

  product = buildProduct();
  checkProductSize(product);

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
  // inside the next frame callback with that frame's hit result.
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
      optionalFeatures: [...(ANCHORS_OFF ? [] : ["anchors"]), "dom-overlay", ...(FLOOR ? ["local-floor"] : [])],
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
  // Anchors are an optional feature: use them only if the browser really enabled them.
  anchorsOn = !!(session.enabledFeatures && session.enabledFeatures.includes("anchors"));

  btn.textContent = "STOP AR";
  btn.disabled = false;
  fallbackEl.hidden = true;
  overlay.style.display = "block"; // "" would keep the CSS rule display:none

  try {
    // setSession() already does makeXRCompatible + creates the XR layer,
    // so the book's setupWebGLLayer() is not needed.
    renderer.xr.setReferenceSpaceType(FLOOR ? "local-floor" : "local");
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
    // requests a new hit-test source EVERY frame. Set the flag immediately.
    if (!hitTestSourceRequested) {
      hitTestSourceRequested = true;
      session.requestReferenceSpace("viewer")
        .then((vs) => {
          viewerSpace = vs;
          return session.requestHitTestSource({ space: vs });
        })
        .then((source) => {
          if (xrSession !== session) { source.cancel(); return; } // session ended meanwhile
                   hitTestSource = source;
          log("hit-test source: ready");
        })
        .catch((e) => { console.warn("hit-test source request failed:", e); log("hit-test source FAILED: " + e); });
    }

    const localSpace = renderer.xr.getReferenceSpace();
    const viewerPose = localSpace ? frame.getViewerPose(localSpace) : null;
    // Tracking lost: no pose at all, or a pose that is only guessed (emulatedPosition).
    trackingLost = !viewerPose || viewerPose.emulatedPosition;
    trackingEl.hidden = !trackingLost;
    if (viewerPose && !startLogged) {
      startLogged = true;
      const p = viewerPose.transform.position;
      log(`camera in ${FLOOR ? "local-floor" : "local"} (start): ${fmt3(p.x, p.y, p.z)}`);
    }

    // Hit results are read in the LOCAL space (the space the scene lives in),
    // while the source was created from the VIEWER space (it follows the phone).
    let hit = null, hitMatrix = null, valid = false;
    hitCount = 0;
    reticleText = "none";
    if (hitTestSource && localSpace) {
      const results = frame.getHitTestResults(hitTestSource);
            hitCount = results.length;
      if (results.length > 0) {
        const pose = results[0].getPose(localSpace);
        if (pose) {
          hit = results[0];
          hitMatrix = pose.transform.matrix;        // 16 numbers, column-major
          reticle.matrix.fromArray(hitMatrix);
          reticle.matrixWorldNeedsUpdate = true;
          const tilt = tiltDegrees(hitMatrix);
          valid = tilt <= VARIANT.toleranceDeg;     // 8 degrees for ID 242322
          reticle.material.color.set(valid ? 0x00ff00 : 0xff0000);
          reticleText = (valid ? "valid" : "too tilted") + ` (${tilt.toFixed(1)}°)`;
        }
      }
    }
    reticle.visible = hit !== null;

    // Placement happens HERE, inside the frame callback, with THIS frame's hit result.
    if (placeRequested) {
      placeRequested = false;
      if (hit && valid && !trackingLost && viewerPose) {
        placeProduct(hit, hitMatrix, viewerPose.transform.position);
      }
    }

    // Anchored products follow their anchor every frame (tracking keeps improving).
    if (localSpace) {
      for (const entry of placed) {
        if (!entry.anchor) continue;
        const pose = frame.getPose(entry.anchor.anchorSpace, localSpace);
        if (pose) applyMatrix(entry, pose.transform.matrix);
      }
    }
    if (logRequested) {
      logRequested = false;
      logPose(localSpace, viewerPose, hit);
    }
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
  viewerSpace = null;
  anchorsOn = false;
  trackingLost = false;
  if (hitTestSource) {
    try { hitTestSource.cancel(); } catch (e) { /* source already gone */ }
    hitTestSource = null;
  }
  clearAll(); // also deletes every anchor
  reticleText = "none";
  if (reticle) reticle.visible = false;
  if (trackingEl) trackingEl.hidden = true;
  startLogged = false;
  logRequested = false;
  if (renderer) renderer.setAnimationLoop(null);
  overlay.style.display = "none";
  if (btn) { btn.textContent = "START AR"; btn.disabled = false; }
  updateStatus();
}

// ---------- product: coffee table (ID 242322, last digit 2) ----------
// Units: metres. Origin = centre of the base (on the floor). Front = +z side.
function buildProduct() {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 0.8 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.4, roughness: 0.4 });

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.5), wood);
  top.position.set(0, 0.43, 0);
  group.add(top);

  const legGeo = new THREE.BoxGeometry(0.05, 0.41, 0.05);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, dark);
      leg.position.set(sx * 0.45, 0.205, sz * 0.2);
      group.add(leg);
    }
  }

  const front = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.02), accent);
  front.position.set(0, 0.385, 0.235);
  group.add(front);

  return group;
}

function checkProductSize(obj) {
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(size);
  console.log(`product size (m): x=${size.x.toFixed(3)} y=${size.y.toFixed(3)} z=${size.z.toFixed(3)} (target 1.00 x 0.45 x 0.50)`);
  const ok = Math.abs(size.x - 1.0) <= 0.02 && Math.abs(size.y - 0.45) <= 0.02 && Math.abs(size.z - 0.5) <= 0.02;
  console.log(ok ? "size check: OK (within +-2 cm)" : "size check: OUT OF TOLERANCE");
}

// ---------- surface filter ----------
// Angle between the surface normal and world up (0,1,0).
// In a hit pose matrix the surface normal is the y-axis column = elements 4, 5, 6.
function tiltDegrees(m) {
  const len = Math.hypot(m[4], m[5], m[6]);
  const c = Math.min(1, Math.max(-1, m[5] / len));
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------- placement ----------
function placeProduct(hit, hitMatrix, cameraPos) {
  // Placement mode: multi = keep up to maxProducts (6th removes the oldest);
  // single = one product, each tap moves it (old one + its anchor are deleted).
  if (VARIANT.mode === "single") {
    clearAll();
  } else {
    while (placed.length >= VARIANT.maxProducts) removeEntry(placed.shift());
  }

  const object = product.clone(); // clones share geometry/materials
  object.matrixAutoUpdate = false;

  // Facing rule: rotate about Y only. Product front is +z, so yaw = atan2(dx, dz)
  // where (dx, dz) points from the product to the camera at the moment of placement.
  tmpM.fromArray(hitMatrix);
  tmpPos.setFromMatrixPosition(tmpM);
  let yaw = Math.atan2(cameraPos.x - tmpPos.x, cameraPos.z - tmpPos.z);
  if (VARIANT.facing === "away") yaw += Math.PI;

  const entry = { object, anchor: null, yaw, removed: false };
  applyMatrix(entry, hitMatrix);   // fallback / first frame: place with the hit pose
  scene.add(object);
  placed.push(entry);
  logMatrix(hitMatrix);

  // Anchor: asks the system to keep this spot fixed to the real world.
  if (anchorsOn && typeof hit.createAnchor === "function") {
    hit.createAnchor()
      .then((anchor) => {
        if (entry.removed) anchor.delete();   // removed while the promise was pending
        else entry.anchor = anchor;
      })
      .catch((e) => console.warn("createAnchor failed, using the hit pose instead:", e));
  }
}

// Set the product matrix from a pose matrix (hit pose or anchor pose) + facing rule.
function applyMatrix(entry, m) {
  tmpM.fromArray(m);
  if (VARIANT.facing === "hit") {
    entry.object.matrix.copy(tmpM);               // keep the orientation of the hit pose
  } else {
    tmpPos.setFromMatrixPosition(tmpM);           // only the position; rotation = yaw about Y
    tmpQuat.setFromAxisAngle(UP, entry.yaw);
    entry.object.matrix.compose(tmpPos, tmpQuat, ONE);
  }
  entry.object.matrixWorldNeedsUpdate = true;
}

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

// ---------- on-screen log (for the write-up screenshots) ----------
const logLines = [];
function fmt3(...v) { return v.map((n) => n.toFixed(3)).join(", "); }
function log(msg) {
  console.log(msg);
  logLines.push(msg);
  while (logLines.length > 12) logLines.shift();
  if (logEl) logEl.textContent = logLines.join("\n");
}
// Print the 16 values of a pose matrix, grouped by column (column-major order).
function logMatrix(m) {
  const col = (i) => fmt3(m[i], m[i + 1], m[i + 2], m[i + 3]);
  log("hit pose matrix (16 values, by column):");
  log(` c0 x-axis : ${col(0)}`);
  log(` c1 NORMAL : ${col(4)}`);
  log(` c2 z-axis : ${col(8)}`);
  log(` c3 POSITION: ${col(12)}`);
  console.log("hit pose matrix (16 values):", Array.from(m));
}
// "Log pose" button: camera in local, and the same hit in viewer and in local space.
function logPose(localSpace, viewerPose, hit) {
  if (viewerPose) {
    const p = viewerPose.transform.position;
    log(`camera in ${FLOOR ? "local-floor" : "local"}: ${fmt3(p.x, p.y, p.z)}`);
  } else {
    log("camera pose: null (tracking lost)");
  }
  if (hit && viewerSpace && localSpace) {
    const pv = hit.getPose(viewerSpace);
    const pl = hit.getPose(localSpace);
    if (pv) log(`hit in viewer: ${fmt3(pv.transform.position.x, pv.transform.position.y, pv.transform.position.z)}`);
    if (pl) log(`hit in local : ${fmt3(pl.transform.position.x, pl.transform.position.y, pl.transform.position.z)}`);
    if (pv) console.log("hit pose in viewer (matrix):", Array.from(pv.transform.matrix));
    if (pl) console.log("hit pose in local (matrix):", Array.from(pl.transform.matrix));
  } else {
    log("no hit right now: aim at a surface first");
  }
}

// ---------- overlay ----------
let lastStatus = "";
function updateStatus() {
  const facingText = VARIANT.facing === "toward" ? "faces user"
    : VARIANT.facing === "away" ? "faces away" : "hit orientation";
  const maxCount = VARIANT.mode === "single" ? 1 : VARIANT.maxProducts;
  const text = [
    `ID ${STUDENT_ID} · ${VARIANT.product}`,
    `${VARIANT.mode} (max ${maxCount}) · tol ${VARIANT.toleranceDeg}° · ${facingText}`,
    `session: ${xrSession ? "active" : "inactive"}`,
    `reticle: ${reticleText}`,
    `hit results: ${hitCount}`,
    `space: ${FLOOR ? "local-floor" : "local"}`,
    `anchors: ${anchorsOn ? "on" : "off"}`,
    `products: ${placed.length} / ${maxCount}`,
  ].join("\n");
  if (text !== lastStatus) { statusEl.textContent = text; lastStatus = text; }
}