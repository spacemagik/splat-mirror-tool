// Splat Mirror — main app
//
// Architecture (think of it like a real bathroom mirror):
//
//   - The symmetry PLANE lives in world space (controlled by axis + plane slider).
//     It is fixed; the user moves the splats in front of it.
//   - SLOT A is the source-side splat — it lives in `splatGroup`, which the
//     gizmo controls. The gizmo moves/rotates it freely in world space.
//   - SLOT B is an optional mirror-side splat. If B is empty we render A's
//     own pre-reflected twin on the mirror side (the original "kaleidoscope
//     selfie" behavior). If B is loaded we render B's pre-reflected version
//     instead — same spatial location, but a different model. This makes the
//     two splats appear to mirror each other even though they're different.
//
//   - The mirror mesh's world transform is computed every frame as:
//        T_mirror = Reflect_world  ·  T_gizmo  ·  Reflect_local
//
//     where Reflect_world is the reflection across the user-chosen world plane,
//     and Reflect_local is a fixed local-X reflection that was baked into the
//     mirror mesh's data (positions/rotations/SH pre-reflected once at load
//     time). The two reflections cancel in determinant (det = +1) so the
//     final transform is a proper rotation + translation that Spark renders
//     correctly.
//
// The download bakes A on the source side and (B if loaded, else A) on the
// mirror side into a single combined .spz that matches the preview.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  SparkRenderer,
  SplatMesh,
  PackedSplats,
  setPackedSplat,
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  SplatEditRgbaBlendMode,
  SparkControls,
} from "@sparkjsdev/spark";

import { createUI } from "./ui.js";
import { decodeSpz, SH_C0 } from "./spz-decode.js";
import { encodeSpz } from "./spz-encode.js";
import {
  buildMirroredSplat,
  mirrorAllSplats,
  keepSourceSide,
  reflectAllSourceSide,
  concatSplats,
  applyTransform,
  AXES,
} from "./mirror.js";

// ----- Scene -----
const canvas = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0b0c10, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  1000,
);
camera.position.set(3, 2, 4);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 10, 7);
scene.add(dir);

const grid = new THREE.GridHelper(10, 20, 0x444444, 0x222222);
grid.material.opacity = 0.4;
grid.material.transparent = true;
scene.add(grid);

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.target.set(0, 0, 0);

// Fly-mode camera controls (WASD + mouse drag). Created up front but only
// "active" (updated in the animation loop) when cameraMode === "fly".
const flyControls = new SparkControls({ canvas });

// Track previous camera mode so we can re-target the orbit pivot when the
// user switches back from fly mode (otherwise orbit would still pivot around
// an old target that may now be far from where the camera was flown to).
let previousCameraMode = "orbit";
const _camForward = new THREE.Vector3();

// ----- Plane visualization (world space, NOT parented to the splat) -----
const planeGroup = new THREE.Group();
scene.add(planeGroup);

let planeMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({
    color: 0x6ea8ff,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
planeGroup.add(planeMesh);

let planeEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(planeMesh.geometry),
  new THREE.LineBasicMaterial({ color: 0x6ea8ff }),
);
planeGroup.add(planeEdges);

// ----- Symmetry-plane SDF (used to clip both meshes at the plane) -----
// One SDF object lives in the scene at the symmetry plane's world transform.
// Both the original and mirror meshes reference it through SplatEdit so the
// "wrong" side of each mesh gets its opacity multiplied by 0 (i.e. clipped).
// The original mesh's edit keeps the +Z half of the SDF visible (source side),
// the mirror mesh's edit is inverted so it keeps the −Z half (mirror side).
const clipSdf = new SplatEditSdf({
  type: SplatEditSdfType.PLANE,
  opacity: 0, // multiplied into splat alpha → 0 = hidden
  color: new THREE.Color(1, 1, 1),
});
scene.add(clipSdf);

// softEdge is in world units (total fade width across the plane). We start
// at a small value here and re-scale it in fitPlaneBoundsFromData() so the
// fade looks similar regardless of how big the loaded splat is.
const DEFAULT_SOFT_EDGE = 0.1;

const originalClipEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: false, // hide splats INSIDE the SDF half-space (the mirror side)
  sdfs: [clipSdf],
});

const mirrorClipEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: true, // hide splats OUTSIDE the SDF (the source side)
  sdfs: [clipSdf],
});

// ----- Splat group (gizmo target; holds the original SplatMesh) -----
const splatGroup = new THREE.Group();
scene.add(splatGroup);
splatGroup.add(new THREE.AxesHelper(0.3));

// ----- State -----
// Slot A: the SOURCE-side splat (always required to render anything).
let splatA = null; // decoded original of A
let packedA = null; // GPU-packed copy of A used for the original mesh + radial originals
let mirrorPackedA = null; // pre-reflected (local-X) copy of A — used as the mirror twin when no B is loaded
let fileNameA = "splat.spz";

// Slot B: an OPTIONAL second splat that replaces A's mirror twin.
let splatB = null; // decoded splat for slot B (null if not loaded)
let mirrorPackedB = null; // pre-reflected (local-X) copy of B — used as the mirror twin when B is loaded
let fileNameB = null;

// Meshes (recreated as needed when packs change).
let originalMesh = null;
let mirrorMesh = null;

// Reusable matrices (avoid per-frame allocation)
const reflectWorld = new THREE.Matrix4();
const reflectLocal = new THREE.Matrix4().makeScale(-1, 1, 1); // local-X flip
const tmpMatrix = new THREE.Matrix4();
const tmpRotY = new THREE.Matrix4();

// Extra rotated copies for the kaleidoscope effect. The primary pair lives in
// splatGroup + mirrorMesh; these arrays hold copies 1..(radialCount-1), each
// rotated by (i * 2π/radialCount) around the world Y axis. They share the
// same PackedSplats data as the primaries (cheap on GPU memory).
let radialOriginals = [];
let radialMirrors = [];

// ----- Gizmo -----
const gizmo = new TransformControls(camera, canvas);
gizmo.size = 0.8;
const gizmoHelper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
scene.add(gizmoHelper);
gizmo.attach(splatGroup);
gizmo.addEventListener("dragging-changed", (e) => {
  // While the user is dragging a gizmo handle, suspend whichever camera
  // controller owns the mouse so its drag doesn't fight the gizmo's drag.
  // The other controller stays in whatever state applyUIState put it in.
  if (!ui) return;
  if (ui.state.cameraMode === "fly") {
    // Only the mouse-look part of fly mode conflicts with the gizmo;
    // WASD/arrow keys can keep moving the camera while you drag.
    flyControls.pointerControls.enable = !e.value;
  } else {
    orbit.enabled = !e.value;
  }
});

// ----- UI -----
const ui = createUI({
  onChange: (state) => applyUIState(state),
  onResetSplat: () => {
    splatGroup.position.set(0, 0, 0);
    splatGroup.quaternion.set(0, 0, 0, 1);
    splatGroup.scale.set(1, 1, 1);
  },
  onDownload: handleDownload,
  onLoadFile: async (slot, file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await loadSpzIntoSlot(slot, bytes, file.name);
    } catch (err) {
      console.error(err);
      ui.setStatus(`Failed to load slot ${slot.toUpperCase()}: ${err.message}`, true);
    }
  },
  onClearSlot: (slot) => clearSlot(slot),
});

const _vFrom = new THREE.Vector3(0, 0, 1);
const _vTo = new THREE.Vector3();
const _q = new THREE.Quaternion();

function applyUIState(state) {
  const axisIdx = AXES[state.axis];

  // Position the plane visual in WORLD space — fixed, independent of the splat
  planeGroup.position.set(0, 0, 0);
  planeGroup.position.setComponent(axisIdx, state.plane);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx, 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  planeGroup.quaternion.copy(_q);
  planeGroup.visible = state.showPlane;

  // Position the clip SDF: same plane location, but rotated so its local +Z
  // points toward the SOURCE side (the side we keep on the original mesh).
  // SDF half-space "distance < 0" lives along local −Z, i.e. the mirror side,
  // so the original-mesh edit hides that side and the mirror-mesh edit (with
  // invert=true) hides the source side.
  clipSdf.position.set(0, 0, 0);
  clipSdf.position.setComponent(axisIdx, state.plane);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx, state.flipSide ? -1 : 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  clipSdf.quaternion.copy(_q);
  clipSdf.updateMatrixWorld();

  // Recompute the world-space reflection matrix for the chosen axis + offset
  computeReflectWorld(axisIdx, state.plane);

  // Push the current softness to both edits (cheap; just reassigns a number)
  originalClipEdit.softEdge = state.softEdge;
  mirrorClipEdit.softEdge = state.softEdge;

  // Match the radial-copy count to the slider. Cheap if the count hasn't
  // changed (the helper does nothing in that case).
  rebuildRadialMeshes(state.radialCount);

  // Camera mode: orbit (point-and-orbit around target) or fly (free WASD + mouse-drag).
  // In fly mode we disable the gizmo so the canvas mouse drag controls the camera
  // rather than dragging gizmo arrows.
  const fly = state.cameraMode === "fly";
  // When switching FROM fly TO orbit, re-aim the orbit pivot to a point right
  // in front of the camera at the same distance the user was orbiting before.
  // This keeps the camera still while giving orbit a sensible new target.
  if (previousCameraMode === "fly" && !fly) {
    const prevDist = Math.max(1, camera.position.distanceTo(orbit.target));
    camera.getWorldDirection(_camForward);
    orbit.target.copy(camera.position).addScaledVector(_camForward, prevDist);
  }
  previousCameraMode = state.cameraMode;
  orbit.enabled = !fly;
  flyControls.fpsMovement.enable = fly;
  flyControls.fpsMovement.moveSpeed = state.flySpeed;
  flyControls.pointerControls.enable = fly;

  // Gizmo mode — available in both orbit and fly. While flying, the
  // dragging-changed handler temporarily pauses fly's mouse-look so you can
  // drag the handle without the camera spinning.
  if (state.gizmoMode === "off") {
    gizmo.enabled = false;
    if (gizmoHelper) gizmoHelper.visible = false;
  } else {
    gizmo.enabled = true;
    if (gizmoHelper) gizmoHelper.visible = true;
    gizmo.setMode(state.gizmoMode);
  }
}

// Reflection across the axis-aligned plane: x_axis -> 2*offset - x_axis,
// other axes unchanged. In matrix form: identity with one diagonal entry
// negated and a translation of 2*offset along that axis.
function computeReflectWorld(axisIdx, offset) {
  reflectWorld.identity();
  const e = reflectWorld.elements; // column-major
  e[axisIdx * 5] = -1; // diagonal entry for the chosen axis
  e[12 + axisIdx] = 2 * offset;
}

// Mirror mesh's world matrix updates each frame from the gizmo + plane state.
// Also updates any radial-symmetry copies, applying a Y-axis rotation per copy
// before the same reflection math.
function updateMirrorTransform() {
  if (!mirrorMesh) return;
  splatGroup.updateMatrixWorld(true);
  tmpMatrix.multiplyMatrices(reflectWorld, splatGroup.matrixWorld);
  tmpMatrix.multiply(reflectLocal);
  mirrorMesh.matrix.copy(tmpMatrix);
  mirrorMesh.matrixWorldNeedsUpdate = true;

  const extraCount = radialOriginals.length;
  if (extraCount === 0) return;
  const totalCount = extraCount + 1;
  for (let i = 0; i < extraCount; i++) {
    const angle = ((i + 1) * 2 * Math.PI) / totalCount;
    tmpRotY.makeRotationY(angle);

    // Original radial copy: RotY(angle) * splatGroup.matrixWorld
    radialOriginals[i].matrix.multiplyMatrices(tmpRotY, splatGroup.matrixWorld);
    radialOriginals[i].matrixWorldNeedsUpdate = true;

    // Mirror radial copy: reflectWorld * RotY(angle) * splatGroup.matrixWorld * reflectLocal
    tmpMatrix.multiplyMatrices(reflectWorld, tmpRotY);
    tmpMatrix.multiply(splatGroup.matrixWorld);
    tmpMatrix.multiply(reflectLocal);
    radialMirrors[i].matrix.copy(tmpMatrix);
    radialMirrors[i].matrixWorldNeedsUpdate = true;
  }
}

// Rebuild the array of extra radial meshes so it contains exactly
// `count - 1` pairs (since the primary pair is the originalMesh + mirrorMesh).
// Each extra is a lightweight SplatMesh sharing the same PackedSplats GPU
// buffer as the primary — only the world transform differs.
function rebuildRadialMeshes(count) {
  const desiredExtras = Math.max(0, Math.floor(count) - 1);

  // Dispose extras beyond what we need
  while (radialOriginals.length > desiredExtras) {
    const m = radialOriginals.pop();
    scene.remove(m);
    m.dispose?.();
  }
  while (radialMirrors.length > desiredExtras) {
    const m = radialMirrors.pop();
    scene.remove(m);
    m.dispose?.();
  }

  if (!packedA || !activeMirrorPacked()) return;

  // Add extras to reach desired count
  while (radialOriginals.length < desiredExtras) {
    const o = new SplatMesh({ packedSplats: packedA });
    o.editable = true;
    o.edits = [originalClipEdit];
    o.matrixAutoUpdate = false;
    scene.add(o);
    radialOriginals.push(o);
  }
  while (radialMirrors.length < desiredExtras) {
    const m = new SplatMesh({ packedSplats: activeMirrorPacked() });
    m.editable = true;
    m.edits = [mirrorClipEdit];
    m.matrixAutoUpdate = false;
    scene.add(m);
    radialMirrors.push(m);
  }
}

// ----- Splat data → PackedSplats -----
async function packFromData(data) {
  const ps = new PackedSplats({ maxSplats: Math.max(data.numPoints, 1) });
  await ps.initialized;
  ps.ensureSplats(data.numPoints);
  for (let i = 0; i < data.numPoints; i++) {
    const i3 = i * 3;
    const i4 = i * 4;
    setPackedSplat(
      ps.packedArray,
      i,
      data.positions[i3 + 0],
      data.positions[i3 + 1],
      data.positions[i3 + 2],
      data.scales[i3 + 0],
      data.scales[i3 + 1],
      data.scales[i3 + 2],
      data.rotations[i4 + 0],
      data.rotations[i4 + 1],
      data.rotations[i4 + 2],
      data.rotations[i4 + 3],
      data.alphas[i],
      clamp01(data.colors[i3 + 0] * SH_C0 + 0.5),
      clamp01(data.colors[i3 + 1] * SH_C0 + 0.5),
      clamp01(data.colors[i3 + 2] * SH_C0 + 0.5),
    );
  }
  ps.numSplats = data.numPoints;
  ps.needsUpdate = true;
  return ps;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ----- .spz loading -----
async function loadSpzFromUrl(url) {
  ui.setStatus(`Loading ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const fileName = decodeURIComponent(url.split("/").pop() || "splat.spz");
  await loadSpzIntoSlot("a", buf, fileName);
}

// Return whichever pre-reflected packed splat should currently feed the
// mirror-side mesh (and the radial mirror copies): B's if loaded, A's
// otherwise.
function activeMirrorPacked() {
  return mirrorPackedB ?? mirrorPackedA;
}

// Tear down the original mesh + any radial source-side copies (cheap helpers
// used by the slot loaders to avoid duplicating dispose logic).
function disposeOriginalMeshes() {
  if (originalMesh) {
    splatGroup.remove(originalMesh);
    originalMesh.dispose?.();
    originalMesh = null;
  }
  for (const m of radialOriginals) {
    scene.remove(m);
    m.dispose?.();
  }
  radialOriginals = [];
}

function disposeMirrorMeshes() {
  if (mirrorMesh) {
    scene.remove(mirrorMesh);
    mirrorMesh.dispose?.();
    mirrorMesh = null;
  }
  for (const m of radialMirrors) {
    scene.remove(m);
    m.dispose?.();
  }
  radialMirrors = [];
}

// Build / rebuild the original mesh from the currently-loaded packedA.
async function buildOriginalMesh() {
  disposeOriginalMeshes();
  if (!packedA) return;
  originalMesh = new SplatMesh({ packedSplats: packedA });
  originalMesh.editable = true;
  originalMesh.edits = [originalClipEdit];
  await originalMesh.initialized;
  splatGroup.add(originalMesh);
}

// Build / rebuild the mirror mesh from whichever pre-reflected pack is active.
async function buildMirrorMesh() {
  disposeMirrorMeshes();
  const src = activeMirrorPacked();
  if (!src) return;
  mirrorMesh = new SplatMesh({ packedSplats: src });
  mirrorMesh.editable = true;
  mirrorMesh.edits = [mirrorClipEdit];
  mirrorMesh.matrixAutoUpdate = false; // we drive .matrix manually
  await mirrorMesh.initialized;
  scene.add(mirrorMesh);
}

async function loadSpzIntoSlot(slot, bytes, fileName) {
  if (slot !== "a" && slot !== "b") return;
  ui.setStatus(`Decoding ${fileName}…`);
  ui.enableDownload(false);

  const decoded = decodeSpz(bytes);

  if (slot === "a") {
    splatA = decoded;
    fileNameA = fileName;

    // Disposing meshes BEFORE freeing the packed buffers they referenced
    disposeOriginalMeshes();
    disposeMirrorMeshes();
    if (packedA) {
      packedA.dispose?.();
      packedA = null;
    }
    if (mirrorPackedA) {
      mirrorPackedA.dispose?.();
      mirrorPackedA = null;
    }

    ui.setStatus(
      `Building meshes (${decoded.numPoints.toLocaleString()} splats from A)…`,
    );
    packedA = await packFromData(decoded);
    mirrorPackedA = await packFromData(mirrorAllSplats(decoded, 0, 0));

    await buildOriginalMesh();
    await buildMirrorMesh();
    fitPlaneBoundsFromData(splatA);
  } else {
    splatB = decoded;
    fileNameB = fileName;

    // Mirror mesh + radial mirrors will be rebuilt; dispose first
    disposeMirrorMeshes();
    if (mirrorPackedB) {
      mirrorPackedB.dispose?.();
      mirrorPackedB = null;
    }

    ui.setStatus(
      `Building mirror-side mesh (${decoded.numPoints.toLocaleString()} splats from B)…`,
    );
    mirrorPackedB = await packFromData(mirrorAllSplats(decoded, 0, 0));
    await buildMirrorMesh();
  }

  applyUIState(ui.state); // re-apply (recreates radial copies referencing new packs)
  updateMirrorTransform();
  ui.setSlotName("a", splatA ? fileNameA : null);
  ui.setSlotName("b", splatB ? fileNameB : null);
  ui.setStatus(
    `Slot ${slot.toUpperCase()} loaded: ${decoded.numPoints.toLocaleString()} splats from ${fileName}`,
  );
  if (splatA) ui.enableDownload(true);
}

async function clearSlot(slot) {
  if (slot === "a") {
    // Clearing A unloads everything (nothing to render without a source-side splat).
    splatA = null;
    fileNameA = "splat.spz";
    disposeOriginalMeshes();
    disposeMirrorMeshes();
    if (packedA) {
      packedA.dispose?.();
      packedA = null;
    }
    if (mirrorPackedA) {
      mirrorPackedA.dispose?.();
      mirrorPackedA = null;
    }
    // Slot B's pre-reflected buffer is still valid, but with no A there's
    // nothing to anchor the mirror to. Keep B's data around so it reappears
    // when the user reloads A.
    ui.enableDownload(false);
  } else {
    if (!splatB) return;
    splatB = null;
    fileNameB = null;
    disposeMirrorMeshes();
    if (mirrorPackedB) {
      mirrorPackedB.dispose?.();
      mirrorPackedB = null;
    }
    // Mirror reverts to A's twin
    await buildMirrorMesh();
    applyUIState(ui.state);
    updateMirrorTransform();
  }
  ui.setSlotName("a", splatA ? fileNameA : null);
  ui.setSlotName("b", splatB ? fileNameB : null);
  ui.setStatus(`Slot ${slot.toUpperCase()} cleared`);
}

function computeAabb(positions, n) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3 + 0];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function fitPlaneBoundsFromData(splatForFit) {
  const splatData = splatForFit ?? splatA;
  if (!splatData) return;
  const aabb = computeAabb(splatData.positions, splatData.numPoints);
  const extent = Math.max(
    Math.abs(aabb.minX),
    Math.abs(aabb.maxX),
    Math.abs(aabb.minY),
    Math.abs(aabb.maxY),
    Math.abs(aabb.minZ),
    Math.abs(aabb.maxZ),
  );
  const safeExtent = Math.max(1, extent * 1.2);
  ui.setPlaneBounds(-safeExtent, safeExtent);

  // Configure the Edge-softness slider for this splat's size: max ≈ 10% of
  // the splat's extent, auto-default at ≈ 1.5% (matches the previous hardcoded
  // default). The slider will then update state.softEdge → applyUIState() →
  // both edits' softEdge live as the user drags.
  const softMax = Math.max(0.05, safeExtent * 0.1);
  const softAuto = Math.max(0.02, safeExtent * 0.015);
  ui.setSoftEdgeBounds(softMax, softAuto);

  // Size the plane visualization
  const planeSize = safeExtent * 2;
  planeMesh.geometry.dispose();
  planeMesh.geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  planeEdges.geometry.dispose();
  planeEdges.geometry = new THREE.EdgesGeometry(planeMesh.geometry);

  // Camera looks at the splat center, sits ~2x extent away. We use the AABB
  // center rather than world origin so the user can see their splat right
  // away regardless of where it sits in the source file's local space.
  const cx = (aabb.minX + aabb.maxX) / 2;
  const cy = (aabb.minY + aabb.maxY) / 2;
  const cz = (aabb.minZ + aabb.maxZ) / 2;
  orbit.target.set(cx, cy, cz);
  camera.position.set(
    cx + safeExtent * 1.5,
    cy + safeExtent * 0.9,
    cz + safeExtent * 1.5,
  );
}

// ----- Drag and drop -----
// The overlay is split into two halves (data-slot="a" | "b"). When the user
// drags a file over the window we show the overlay; the half they release
// the mouse on decides which slot the file loads into.
const dropOverlay = document.getElementById("drop-overlay");
const dropHalves = dropOverlay.querySelectorAll(".drop-half");
let dragDepth = 0;

function clearDropHover() {
  dropHalves.forEach((h) => h.classList.remove("hover"));
}

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("active");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.remove("active");
    clearDropHover();
  }
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});

dropHalves.forEach((half) => {
  half.addEventListener("dragenter", () => {
    clearDropHover();
    half.classList.add("hover");
  });
  half.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  half.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove("active");
    clearDropHover();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".spz")) {
      ui.setStatus("Only .spz files are supported", true);
      return;
    }
    const slot = half.dataset.slot;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await loadSpzIntoSlot(slot, bytes, file.name);
    } catch (err) {
      console.error(err);
      ui.setStatus(
        `Failed to load slot ${slot.toUpperCase()}: ${err.message}`,
        true,
      );
    }
  });
});

// ----- Download -----
// Takes the original splat, applies the current gizmo transform (so the splat
// is in world space), then runs the clip+mirror in world space using the
// user's chosen axis/offset/flip-side. The result is a single .spz of the
// symmetric splat as it appears in the preview.
async function handleDownload() {
  if (!splatA) return;
  ui.enableDownload(false);
  ui.setStatus("Applying gizmo + mirror, encoding .spz…");
  try {
    splatGroup.updateMatrixWorld(true);
    const baseQuat = new THREE.Quaternion();
    splatGroup.getWorldQuaternion(baseQuat);
    const axisIdx = AXES[ui.state.axis];
    const radialCount = Math.max(1, Math.floor(ui.state.radialCount));

    // For each radial slot we bake one "wedge":
    //   - A's source-side splats at  RotY(angle) · T_gizmo
    //   - (B if loaded, else A)'s source-side splats reflected across the
    //     world plane (same world transform as A's wedge, then mirrored).
    // For radialCount=1 + no B this collapses to the original behaviour.
    const splatForMirror = splatB ?? splatA;
    if (
      splatB &&
      (splatA.shCoeffsPerPoint !== splatB.shCoeffsPerPoint ||
        splatA.shDegree !== splatB.shDegree)
    ) {
      ui.setStatus(
        `Note: A and B have different SH degrees; B will be downscaled to A's schema.`,
      );
    }

    const parts = [];
    const rotMat = new THREE.Matrix4();
    const rotQuat = new THREE.Quaternion();
    const composedMat = new THREE.Matrix4();
    const composedQuat = new THREE.Quaternion();
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < radialCount; i++) {
      const angle = (i * 2 * Math.PI) / radialCount;
      rotQuat.setFromAxisAngle(Y_AXIS, angle);
      rotMat.makeRotationFromQuaternion(rotQuat);
      composedMat.multiplyMatrices(rotMat, splatGroup.matrixWorld);
      composedQuat.multiplyQuaternions(rotQuat, baseQuat);
      const composedQuatArr = new Float32Array([
        composedQuat.x,
        composedQuat.y,
        composedQuat.z,
        composedQuat.w,
      ]);

      // A's source-side half (world-space)
      const worldA = cloneSplatData(splatA);
      applyTransform(worldA, composedMat.elements, composedQuatArr);
      parts.push(
        keepSourceSide(worldA, axisIdx, ui.state.plane, ui.state.flipSide),
      );

      // B's (or A's fallback) source-side half, reflected to the mirror side
      const worldMirror = cloneSplatData(splatForMirror);
      applyTransform(worldMirror, composedMat.elements, composedQuatArr);
      parts.push(
        reflectAllSourceSide(
          worldMirror,
          axisIdx,
          ui.state.plane,
          ui.state.flipSide,
        ),
      );
    }

    const mirroredData = concatSplats(parts);
    const bytes = encodeSpz(mirroredData);
    const baseName = fileNameA.replace(/\.spz$/i, "");
    const suffix = splatB
      ? radialCount > 1
        ? `-AB-radial${radialCount}`
        : "-AB"
      : radialCount > 1
        ? `-radial${radialCount}`
        : "-mirrored";
    const downloadName = `${baseName}${suffix}.spz`;
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    ui.setStatus(
      `Saved ${downloadName} (${mirroredData.numPoints.toLocaleString()} splats)`,
    );
  } catch (err) {
    console.error(err);
    ui.setStatus(`Export failed: ${err.message}`, true);
  } finally {
    ui.enableDownload(true);
  }
}

// Shallow clone of a decoded splat — copies typed arrays so applyTransform
// mutations don't clobber the source data.
function cloneSplatData(s) {
  return {
    version: s.version,
    numPoints: s.numPoints,
    shDegree: s.shDegree,
    fractionalBits: s.fractionalBits,
    antialiased: s.antialiased,
    positions: new Float32Array(s.positions),
    alphas: new Float32Array(s.alphas),
    rawColors: s.rawColors ? new Uint8Array(s.rawColors) : null,
    colors: new Float32Array(s.colors),
    scales: new Float32Array(s.scales),
    rotations: new Float32Array(s.rotations),
    sh: s.sh ? new Float32Array(s.sh) : null,
    shCoeffsPerPoint: s.shCoeffsPerPoint,
  };
}

// ----- Resize -----
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ----- Animation loop -----
renderer.setAnimationLoop(() => {
  if (ui && ui.state.cameraMode === "fly") {
    flyControls.update(camera, camera);
  } else {
    orbit.update();
  }
  updateMirrorTransform();
  renderer.render(scene, camera);
});

// ----- Boot -----
loadSpzFromUrl("/Dreamlike%20Room%20Filled%20with%20Clouds.spz").catch((err) => {
  console.error(err);
  ui.setStatus("Drag a .spz file onto the window to start", true);
});
