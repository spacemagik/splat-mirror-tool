// Splat Mirror — main app
//
// Architecture (think of it like a real bathroom mirror):
//
//   - The symmetry PLANE lives in world space (controlled by axis + plane slider).
//     It is fixed; the user moves the splat in front of it.
//   - The ORIGINAL splat lives in `splatGroup`, which is the gizmo's target.
//     The gizmo moves/rotates the splat freely in world space.
//   - A MIRROR copy of the splat is rendered as a separate SplatMesh whose
//     world transform is computed every frame as:
//
//        T_mirror = Reflect_world  ·  T_gizmo  ·  Reflect_local
//
//     where Reflect_world is the reflection across the user-chosen world plane,
//     and Reflect_local is a fixed local-X reflection that was baked into the
//     mirror mesh's data (positions/rotations/SH pre-reflected once at load
//     time). The two reflections cancel in determinant (det = +1) so the
//     final transform is a proper rotation + translation that Spark renders
//     correctly.
//
// The download takes the gizmo-transformed splat in world space, applies the
// usual "keep one side, mirror to the other" clip, encodes a single .spz.

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
let splatData = null; // decoded original
let originalMesh = null;
let originalPacked = null;
let mirrorMesh = null;
let mirrorPacked = null;
let sourceFileName = "splat.spz";

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

  if (!originalPacked || !mirrorPacked) return;

  // Add extras to reach desired count
  while (radialOriginals.length < desiredExtras) {
    const o = new SplatMesh({ packedSplats: originalPacked });
    o.editable = true;
    o.edits = [originalClipEdit];
    o.matrixAutoUpdate = false;
    scene.add(o);
    radialOriginals.push(o);
  }
  while (radialMirrors.length < desiredExtras) {
    const m = new SplatMesh({ packedSplats: mirrorPacked });
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
  await loadSpzFromBytes(buf, fileName);
}

async function loadSpzFromBytes(bytes, fileName) {
  sourceFileName = fileName;
  ui.setStatus(`Decoding ${fileName}…`);
  ui.enableDownload(false);

  // Decode original
  splatData = decodeSpz(bytes);

  // Dispose previous meshes
  if (originalMesh) {
    splatGroup.remove(originalMesh);
    originalMesh.dispose?.();
    originalMesh = null;
  }
  if (mirrorMesh) {
    scene.remove(mirrorMesh);
    mirrorMesh.dispose?.();
    mirrorMesh = null;
  }
  // Dispose any radial extras BEFORE freeing the packed buffers they reference.
  for (const m of radialOriginals) {
    scene.remove(m);
    m.dispose?.();
  }
  radialOriginals = [];
  for (const m of radialMirrors) {
    scene.remove(m);
    m.dispose?.();
  }
  radialMirrors = [];
  if (originalPacked) {
    originalPacked.dispose?.();
    originalPacked = null;
  }
  if (mirrorPacked) {
    mirrorPacked.dispose?.();
    mirrorPacked = null;
  }

  ui.setStatus(
    `Building meshes (${splatData.numPoints.toLocaleString()} splats)…`,
  );

  // Pack the original splat data
  originalPacked = await packFromData(splatData);
  originalMesh = new SplatMesh({ packedSplats: originalPacked });
  originalMesh.editable = true;
  originalMesh.edits = [originalClipEdit];
  await originalMesh.initialized;
  splatGroup.add(originalMesh);

  // Build the pre-reflected copy of the same data (local-X reflection) and
  // pack it. This is the mesh we'll position through reflectWorld * gizmo * reflectLocal.
  const mirrorData = mirrorAllSplats(splatData, 0, 0);
  mirrorPacked = await packFromData(mirrorData);
  mirrorMesh = new SplatMesh({ packedSplats: mirrorPacked });
  mirrorMesh.editable = true;
  mirrorMesh.edits = [mirrorClipEdit];
  mirrorMesh.matrixAutoUpdate = false; // we drive .matrix manually
  await mirrorMesh.initialized;
  scene.add(mirrorMesh);

  // Auto-fit plane bounds + camera to the splat extents
  fitPlaneBoundsFromData();

  // Apply UI state once so the plane visualization and reflectWorld are in sync
  applyUIState(ui.state);
  // And push the mirror mesh's first transform
  updateMirrorTransform();

  ui.setStatus(
    `Loaded: ${splatData.numPoints.toLocaleString()} splats from ${fileName}`,
  );
  ui.enableDownload(true);
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

function fitPlaneBoundsFromData() {
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
const dropOverlay = document.getElementById("drop-overlay");
let dragDepth = 0;
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
  }
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("active");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".spz")) {
    ui.setStatus("Only .spz files are supported", true);
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await loadSpzFromBytes(bytes, file.name);
  } catch (err) {
    console.error(err);
    ui.setStatus(`Failed to load: ${err.message}`, true);
  }
});

// ----- Download -----
// Takes the original splat, applies the current gizmo transform (so the splat
// is in world space), then runs the clip+mirror in world space using the
// user's chosen axis/offset/flip-side. The result is a single .spz of the
// symmetric splat as it appears in the preview.
async function handleDownload() {
  if (!splatData) return;
  ui.enableDownload(false);
  ui.setStatus("Applying gizmo + mirror, encoding .spz…");
  try {
    splatGroup.updateMatrixWorld(true);
    const baseQuat = new THREE.Quaternion();
    splatGroup.getWorldQuaternion(baseQuat);
    const axisIdx = AXES[ui.state.axis];
    const radialCount = Math.max(1, Math.floor(ui.state.radialCount));

    // Build one "wedge" (gizmo-transformed splat → clip + mirror across the
    // user's plane) for each radial slot, then concat them. For radialCount=1
    // this is just the existing single-wedge path.
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
      // composed = RotY(angle) * splatGroup.matrixWorld
      composedMat.multiplyMatrices(rotMat, splatGroup.matrixWorld);
      composedQuat.multiplyQuaternions(rotQuat, baseQuat);

      const worldSplat = cloneSplatData(splatData);
      const composedQuatArr = new Float32Array([
        composedQuat.x,
        composedQuat.y,
        composedQuat.z,
        composedQuat.w,
      ]);
      applyTransform(
        worldSplat,
        composedMat.elements,
        composedQuatArr,
      );

      const wedge = buildMirroredSplat(
        worldSplat,
        axisIdx,
        ui.state.plane,
        ui.state.flipSide,
      );
      parts.push(wedge);
    }

    const mirroredData = concatSplats(parts);
    const bytes = encodeSpz(mirroredData);
    const baseName = sourceFileName.replace(/\.spz$/i, "");
    const suffix = radialCount > 1 ? `-radial${radialCount}` : "-mirrored";
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
