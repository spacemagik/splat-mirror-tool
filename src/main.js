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
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  SplatEditRgbaBlendMode,
  SparkControls,
} from "@sparkjsdev/spark";

import { createUI } from "./ui.js";
import { decodeSpz } from "./spz-decode.js";
import { encodeSpz } from "./spz-encode.js";
import {
  buildMirroredSplat,
  mirrorAllSplats,
  keepSourceSide,
  keepMirrorSide,
  reflectAllSourceSide,
  concatSplats,
  applyTransform,
  AXES,
} from "./mirror.js";

// ----- Scene -----
const canvas = document.getElementById("viewport");
// NOTE on antialias: Gaussian splats already render as smooth 2D gaussians
// (Spark fades each splat's alpha at its edge), so MSAA at the renderer
// level only marginally cleans up the hard cull edge while costing 2-4x
// fragment work at retina DPRs. Splat-heavy scenes run much smoother with
// MSAA off. The helper grid still looks fine because the SparkRenderer's
// own resolve pass is what we're seeing through.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "high-performance",
});
// Cap pixel ratio at 1.5 in single mode: splat rendering is fragment-bound,
// and DPR 2 on a retina display means rendering 4x the pixels of a 1x display
// for very little perceptual gain on splats (the per-splat gaussian already
// softens edges). In biaxial / triaxial mode we drop the cap further (see
// updatePixelRatioForMode), because each pixel is now shaded by 4 or 8
// overlapping mesh draws and fragment work is the bottleneck.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

// Lower the pixel ratio as more octant meshes are active. The split is rough
// but matches roughly the increase in per-pixel fragment work:
//   single   → 2 meshes drawing splats, cap at 1.5
//   biaxial  → 4 meshes (≈2x more fragment work), cap at 1.2
//   triaxial → 8 meshes (≈4x more fragment work), cap at 1.0
// Going below 1.0 looks too soft, so we floor there.
function updatePixelRatioForMode(mode) {
  const cap = mode === "triaxial" ? 1.0 : mode === "biaxial" ? 1.2 : 1.5;
  const target = Math.min(window.devicePixelRatio, cap);
  if (Math.abs(renderer.getPixelRatio() - target) > 1e-3) {
    renderer.setPixelRatio(target);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
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
// Two planes: primary (always shown when state.showPlane is on) and secondary
// (shown only when biaxial mode is on AND state.showPlane is on). They're
// rendered as translucent quads with edge lines so the user can see exactly
// where each mirror plane lives.
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

// Secondary plane visualization, used in biaxial AND triaxial modes. Tinted
// differently from the primary plane so the user can tell them apart at a glance.
const planeGroup2 = new THREE.Group();
planeGroup2.visible = false;
scene.add(planeGroup2);

let planeMesh2 = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({
    color: 0xffa566,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
planeGroup2.add(planeMesh2);

let planeEdges2 = new THREE.LineSegments(
  new THREE.EdgesGeometry(planeMesh2.geometry),
  new THREE.LineBasicMaterial({ color: 0xffa566 }),
);
planeGroup2.add(planeEdges2);

// Tertiary plane visualization, used only in triaxial mode. Third color
// (green) so all three planes are visually distinguishable.
const planeGroup3 = new THREE.Group();
planeGroup3.visible = false;
scene.add(planeGroup3);

let planeMesh3 = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({
    color: 0x66ff9a,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
planeGroup3.add(planeMesh3);

let planeEdges3 = new THREE.LineSegments(
  new THREE.EdgesGeometry(planeMesh3.geometry),
  new THREE.LineBasicMaterial({ color: 0x66ff9a }),
);
planeGroup3.add(planeEdges3);

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

// ----- Secondary symmetry plane (biaxial mode only) -----
// A second axis-aligned plane perpendicular to the primary one, used to cut
// the scene into four mirrored quadrants. The two edits below mirror the
// pattern of the primary ones (hide-mirror-side / hide-source-side) but on
// the secondary SDF. When biaxial mode is off, no mesh references these
// edits, so the SDF is effectively inert.
const clipSdf2 = new SplatEditSdf({
  type: SplatEditSdfType.PLANE,
  opacity: 0,
  color: new THREE.Color(1, 1, 1),
});
scene.add(clipSdf2);

const secondaryHideMirrorEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: false, // hide splats on the secondary plane's MIRROR side
  sdfs: [clipSdf2],
});

const secondaryHideSourceEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: true, // hide splats on the secondary plane's SOURCE side
  sdfs: [clipSdf2],
});

// ----- Tertiary symmetry plane (triaxial mode only) -----
// A third plane perpendicular to BOTH plane 1 and plane 2. All three pass
// through the world origin, so they meet at a single point — the splat
// becomes point-symmetric about that origin.
const clipSdf3 = new SplatEditSdf({
  type: SplatEditSdfType.PLANE,
  opacity: 0,
  color: new THREE.Color(1, 1, 1),
});
scene.add(clipSdf3);

const tertiaryHideMirrorEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: false, // hide splats on the tertiary plane's MIRROR side
  sdfs: [clipSdf3],
});

const tertiaryHideSourceEdit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: DEFAULT_SOFT_EDGE,
  sdfSmooth: 0,
  invert: true, // hide splats on the tertiary plane's SOURCE side
  sdfs: [clipSdf3],
});

// ----- Splat groups (gizmo targets) -----
// splatGroupA owns the SOURCE-side mesh (originalMesh).
const splatGroupA = new THREE.Group();
scene.add(splatGroupA);
splatGroupA.add(new THREE.AxesHelper(0.3));

// splatGroupB is a transform-only anchor for the MIRROR-side splat (B). It
// has no children. Each frame we compute mirrorMesh's manual matrix from
// either splatGroupB.matrixWorld (when slot B is loaded) or from the
// auto-mirror of splatGroupA (when no B is loaded).
const splatGroupB = new THREE.Group();
scene.add(splatGroupB);

// ----- State -----
// Slot A: the SOURCE-side splat (always required to render anything).
let splatA = null; // decoded original of A (needed for mirror math + download)
let mirrorBytesA = null; // re-encoded .spz bytes for A's pre-reflected twin
let fileNameA = "splat.spz";

// Slot B: an OPTIONAL second splat that replaces A's mirror twin.
let splatB = null; // decoded splat for slot B (null if not loaded)
let mirrorBytesB = null; // re-encoded .spz bytes for B's pre-reflected twin
let fileNameB = null;

// Meshes (recreated as needed when slot data changes).
//
// Naming uses three sign letters indicating which side of each plane the
// mesh occupies, where '+' = source side of that plane and '-' = mirror side:
//
//   mesh_ppp  ↔ originalMesh   — quadrant (++) in biaxial, octant (+++) in triaxial
//   mesh_mpp  ↔ mirrorMesh     — quadrant (-+) / octant (-++)
//   mesh_pmp  ↔ secondaryMesh  — quadrant (+-) / octant (+-+)   (biaxial+ only)
//   mesh_mmp  ↔ diagonalMesh   — quadrant (--) / octant (--+)   (biaxial+ only)
//   mesh_ppm                   — octant (++-)   (triaxial only)
//   mesh_mpm                   — octant (-+-)   (triaxial only)
//   mesh_pmm                   — octant (+--)   (triaxial only)
//   mesh_mmm                   — octant (---)   (triaxial only, point inversion)
//
// "Even-parity" octants (those with an even number of '-' signs) use the
// ORIGINAL packedSplats data and a world matrix with det = +1. "Odd-parity"
// octants use the pre-X-flipped data with a world matrix that, combined with
// the data's bake-in flip, gives the desired reflection. See updateMirrorTransform
// for the matrix formulas.
let originalMesh = null;   // ppp
let mirrorMesh = null;     // mpp
let secondaryMesh = null;  // pmp  (biaxial / triaxial)
let diagonalMesh = null;   // mmp  (biaxial / triaxial)
let mesh_ppm = null;       // triaxial only
let mesh_mpm = null;       // triaxial only
let mesh_pmm = null;       // triaxial only
let mesh_mmm = null;       // triaxial only — point inversion

// Reusable matrices (avoid per-frame allocation)
const reflectWorld = new THREE.Matrix4();
const reflectWorld2 = new THREE.Matrix4(); // biaxial+ mode: reflection across the secondary plane
const reflectWorld3 = new THREE.Matrix4(); // triaxial mode: reflection across the tertiary plane
const reflectLocal = new THREE.Matrix4().makeScale(-1, 1, 1); // local-X flip
const tmpMatrix = new THREE.Matrix4();
const tmpRotY = new THREE.Matrix4();
// Scratch matrices for biaxial/triaxial per-frame transform math
const _tmpMatA = new THREE.Matrix4();
const _tmpMatB = new THREE.Matrix4();
const _tmpMatC = new THREE.Matrix4();

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
gizmo.attach(splatGroupA);
let currentGizmoTarget = "a";
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
    // Reset whichever group the gizmo is currently editing.
    const target = ui.state.editTarget === "b" ? splatGroupB : splatGroupA;
    target.position.set(0, 0, 0);
    target.quaternion.set(0, 0, 0, 1);
    target.scale.set(1, 1, 1);
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
  // Auto-pick perpendicular axes for biaxial/triaxial modes. Secondary is
  // the "next horizontal" (X→Z, Y/Z→X) so the vertical Y axis is left free
  // when possible. Tertiary is whichever axis isn't primary or secondary.
  const axisIdx2 = axisIdx === 0 ? 2 : 0;
  const axisIdx3 = 3 - axisIdx - axisIdx2; // the remaining axis (0+1+2 = 3)
  const mode = state.symmetryMode; // 'single' | 'biaxial' | 'triaxial'

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

  // Secondary plane + SDF (used by biaxial and triaxial). Always anchored at
  // the world origin — no separate slider yet.
  planeGroup2.position.set(0, 0, 0);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx2, 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  planeGroup2.quaternion.copy(_q);
  planeGroup2.visible = state.showPlane && mode !== "single";

  clipSdf2.position.set(0, 0, 0);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx2, 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  clipSdf2.quaternion.copy(_q);
  clipSdf2.updateMatrixWorld();

  // Tertiary plane + SDF (triaxial only)
  planeGroup3.position.set(0, 0, 0);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx3, 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  planeGroup3.quaternion.copy(_q);
  planeGroup3.visible = state.showPlane && mode === "triaxial";

  clipSdf3.position.set(0, 0, 0);
  _vTo.set(0, 0, 0);
  _vTo.setComponent(axisIdx3, 1);
  _q.setFromUnitVectors(_vFrom, _vTo);
  clipSdf3.quaternion.copy(_q);
  clipSdf3.updateMatrixWorld();

  // Recompute the world-space reflection matrices for all three planes
  computeReflectWorld(axisIdx, state.plane);
  computeReflectWorld2(axisIdx2, 0); // secondary always at offset 0 in V1
  computeReflectWorld3(axisIdx3, 0); // tertiary always at offset 0 in V1

  // Push the current softness to all edits (cheap; just reassigns a number).
  // Biaxial mode adds two more edits per mesh, triaxial adds four more, so
  // we keep all six in sync.
  originalClipEdit.softEdge = state.softEdge;
  mirrorClipEdit.softEdge = state.softEdge;
  secondaryHideMirrorEdit.softEdge = state.softEdge;
  secondaryHideSourceEdit.softEdge = state.softEdge;
  tertiaryHideMirrorEdit.softEdge = state.softEdge;
  tertiaryHideSourceEdit.softEdge = state.softEdge;

  // Scale down the WebGL pixel ratio as more octant meshes come online —
  // each additional mesh roughly doubles fragment work for overlapping splats.
  updatePixelRatioForMode(mode);

  // Attach/detach the extra meshes for the chosen symmetry mode and rewrite
  // each mesh's edits array to match the appropriate octant clipping.
  applySymmetryMode(mode);

  // Match the radial-copy count to the slider. Cheap if the count hasn't
  // changed (the helper does nothing in that case).
  rebuildRadialMeshes(state.radialCount);

  // Seed the new biaxial/triaxial meshes with their correct world matrices
  // BEFORE the next render. updateMirrorTransform() also runs each frame
  // from the animation loop; calling it here just avoids a one-frame flash
  // when a mode toggle creates a fresh mesh (which would otherwise render
  // at identity for one frame).
  updateMirrorTransform();

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

  // Edit target — attach the gizmo to whichever splat group the UI selects.
  // (Falls back to A if the user picked B but B isn't loaded.)
  const targetName =
    state.editTarget === "b" && splatB ? "b" : "a";
  if (targetName !== currentGizmoTarget) {
    gizmo.detach();
    gizmo.attach(targetName === "b" ? splatGroupB : splatGroupA);
    currentGizmoTarget = targetName;
  }

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

// Same shape as computeReflectWorld but writes into the secondary
// reflection matrix used for biaxial/triaxial modes.
function computeReflectWorld2(axisIdx, offset) {
  reflectWorld2.identity();
  const e = reflectWorld2.elements;
  e[axisIdx * 5] = -1;
  e[12 + axisIdx] = 2 * offset;
}

function computeReflectWorld3(axisIdx, offset) {
  reflectWorld3.identity();
  const e = reflectWorld3.elements;
  e[axisIdx * 5] = -1;
  e[12 + axisIdx] = 2 * offset;
}

// Helper: ensure an octant mesh slot is in the right state — exists & has
// the requested edits when `wantMesh` is true, or torn down when it's false.
//
// We always (re)assign `slot.edits` here, even if the mesh already existed,
// because the edit list for a given quadrant/octant CHANGES with the symmetry
// mode. For example, originalMesh's edits go from `[primary]` in single mode
// to `[primary, secondaryHideMirror]` in biaxial to `[primary, sec, tert]` in
// triaxial — same mesh, different clip combination.
//
// Setting `mesh.edits` BEFORE adding to the scene avoids a one-frame window
// where Spark sees `editable=true` + `edits=null`, falls back to its child-
// traversal path, and ends up with a different edits buffer layout than the
// next frame uses. That layout swap is what was causing the splats to flash
// out when flipping between modes — Spark would rebuild the shader generator
// for the wrong edit-count and the mesh would skip a render.
function configureMesh(slot, wantMesh, sourceMesh, edits) {
  if (wantMesh) {
    if (!slot) {
      if (!sourceMesh?.packedSplats) return null;
      // CRITICAL: When we create a new SplatMesh by sharing another mesh's
      // packedSplats, Spark's constructor OVERWRITES the shared object's
      // `.splatEncoding` with DEFAULT_SPLAT_ENCODING unless we explicitly
      // pass the source's encoding through. That overwrite corrupts the
      // original .spz quantization parameters (scale range etc.) on the
      // shared buffer, and every mesh referencing it then decodes splats
      // at the wrong positions/scales — which looked exactly like "the
      // splats disappear when I flip symmetry modes".
      slot = new SplatMesh({
        packedSplats: sourceMesh.packedSplats,
        splatEncoding: sourceMesh.packedSplats.splatEncoding,
      });
      slot.editable = true;
      slot.edits = edits; // assign BEFORE scene.add so spark sees them on its first frameUpdate
      slot.matrixAutoUpdate = false;
      slot.matrix.identity(); // updateMirrorTransform() will overwrite this same frame
      // Performance: the extra octant meshes drop view-dependent SH lighting
      // (the spherical-harmonics coefficients past the DC term). At 8 meshes
      // for triaxial mode, SH evaluation dominates the fragment shader. The
      // visual difference on a mirrored copy is very subtle because reflected
      // SH coefficients already partially break view consistency.
      slot.maxSh = 0;
      scene.add(slot);
    } else {
      slot.edits = edits;
    }
    return slot;
  }
  // wantMesh === false: dispose if present
  if (slot) {
    scene.remove(slot);
    slot.dispose?.();
  }
  return null;
}

// Switch the scene between single-plane (2 meshes), biaxial (4 meshes), and
// triaxial (8 meshes). Each octant gets clipped by its specific combination
// of plane half-spaces — multiple SplatEdit items on one mesh AND together
// because they each multiply alpha by 0 in their half-space.
//
//   mesh_ppp (originalMesh): [hide-mirror-P1, hide-mirror-P2 (biax+), hide-mirror-P3 (tri)]
//   mesh_mpp (mirrorMesh)  : [hide-source-P1, hide-mirror-P2 (biax+), hide-mirror-P3 (tri)]
//   mesh_pmp (secondary)   : [hide-mirror-P1, hide-source-P2,         hide-mirror-P3 (tri)]
//   mesh_mmp (diagonal)    : [hide-source-P1, hide-source-P2,         hide-mirror-P3 (tri)]
//   mesh_ppm (triax only)  : [hide-mirror-P1, hide-mirror-P2,         hide-source-P3]
//   mesh_mpm (triax only)  : [hide-source-P1, hide-mirror-P2,         hide-source-P3]
//   mesh_pmm (triax only)  : [hide-mirror-P1, hide-source-P2,         hide-source-P3]
//   mesh_mmm (triax only)  : [hide-source-P1, hide-source-P2,         hide-source-P3]
//
// (Where "source-P_i" / "mirror-P_i" refer to the source/mirror side of plane i.)
//
// Octant transforms — see updateMirrorTransform for the matrix formulas.
function applySymmetryMode(mode) {
  const biaxial = mode === "biaxial" || mode === "triaxial";
  const triaxial = mode === "triaxial";

  // Build all eight edit-lists up front. The variable `biaxial` is captured
  // in the closure so the helper knows which clips to include.
  const editsFor = (sign1, sign2, sign3) => {
    const list = [];
    list.push(sign1 === "+" ? originalClipEdit : mirrorClipEdit);
    if (biaxial)
      list.push(sign2 === "+" ? secondaryHideMirrorEdit : secondaryHideSourceEdit);
    if (triaxial)
      list.push(sign3 === "+" ? tertiaryHideMirrorEdit : tertiaryHideSourceEdit);
    return list;
  };

  // Primary pair is always present (as long as A is loaded), so we just
  // rewrite their edits in place. In single mode this collapses to a single
  // clip per mesh; biaxial adds a secondary clip, triaxial adds a tertiary.
  if (originalMesh) originalMesh.edits = editsFor("+", "+", "+");
  if (mirrorMesh) mirrorMesh.edits = editsFor("-", "+", "+");

  // Biaxial pair: needed in biaxial AND triaxial. Odd-parity octants (1 or 3
  // minuses) share the X-flipped pack with mirrorMesh; even-parity (0 or 2
  // minuses) share originalMesh's pack.
  secondaryMesh = configureMesh(secondaryMesh, biaxial, mirrorMesh, editsFor("+", "-", "+"));
  diagonalMesh = configureMesh(diagonalMesh, biaxial, originalMesh, editsFor("-", "-", "+"));

  // Triaxial-only extras (four more octants).
  mesh_ppm = configureMesh(mesh_ppm, triaxial, mirrorMesh, editsFor("+", "+", "-"));
  mesh_mpm = configureMesh(mesh_mpm, triaxial, originalMesh, editsFor("-", "+", "-"));
  mesh_pmm = configureMesh(mesh_pmm, triaxial, originalMesh, editsFor("+", "-", "-"));
  mesh_mmm = configureMesh(mesh_mmm, triaxial, mirrorMesh, editsFor("-", "-", "-"));
}

// When slot B is empty, splatGroupB auto-tracks the mirror of A so the
// mirror-side mesh follows A's gizmo (original single-splat behaviour).
// The matrix being decomposed has det = +1 (two reflections cancel), so it
// decomposes cleanly into a positive-scale transform — no negative scale on
// splatGroupB, which keeps the gizmo behaving normally if the user later
// loads a B and starts editing it.
const _autoSyncMat = new THREE.Matrix4();
function autoSyncSplatGroupBToA() {
  splatGroupA.updateMatrixWorld(true);
  _autoSyncMat.multiplyMatrices(reflectWorld, splatGroupA.matrixWorld);
  _autoSyncMat.multiply(reflectLocal);
  _autoSyncMat.decompose(
    splatGroupB.position,
    splatGroupB.quaternion,
    splatGroupB.scale,
  );
  splatGroupB.updateMatrixWorld(true);
}

// Mirror mesh's world matrix updates each frame from splatGroupB's current
// transform.
//
// splatGroupB is set up so its matrixWorld already encodes the desired final
// "mirror-side" transform — i.e. autoSync stores Reflect_world · splatGroupA
// · Reflect_local in splatGroupB, which (when multiplied with the pre-X-flipped
// mirror data) gives Reflect_world · splatGroupA · p_B in world space.
// So mirrorMesh.matrix = splatGroupB.matrixWorld; NO extra Reflect_local here.
function updateMirrorTransform() {
  if (!mirrorMesh) return;
  if (!splatB) autoSyncSplatGroupBToA();
  splatGroupB.updateMatrixWorld(true);

  mirrorMesh.matrix.copy(splatGroupB.matrixWorld);
  mirrorMesh.matrixWorldNeedsUpdate = true;

  // Biaxial / triaxial: drive the extra meshes' world matrices.
  //
  // For an octant with signs (s1, s2, s3) where '-' = mirror across that
  // plane, the effective transform on the ORIGINAL splat positions is:
  //
  //   T_octant = [Reflect_p1 if s1=-]
  //            · [Reflect_p2 if s2=-]
  //            · [Reflect_p3 if s3=-]
  //            · splatGroupA.matrixWorld
  //
  // That T has det = (-1)^k · det(M_A) where k = number of minus signs.
  // Three.js / Spark expect a det = +1 mesh matrix to render correctly, so:
  //   - Even-k (0 or 2 minuses): T already has det = +1 → use ORIGINAL data,
  //     and mesh.matrix = T.
  //   - Odd-k (1 or 3 minuses): T has det = -1. We instead use the pre-X-
  //     flipped data (mirrorMesh.packedSplats) and set mesh.matrix = T · X_flip.
  //     Then mesh.matrix · X_flipped_data = T · X_flip · X_flip · data = T · data,
  //     and mesh.matrix has det = (-1)·(-1) = +1 → renders fine.
  if (secondaryMesh || diagonalMesh || mesh_ppm || mesh_mpm || mesh_pmm || mesh_mmm) {
    splatGroupA.updateMatrixWorld(true);
  }
  if (secondaryMesh) {
    // (+-+): 1 minus (P2) — odd parity, X-flipped data
    _tmpMatA.multiplyMatrices(reflectWorld2, splatGroupA.matrixWorld);
    secondaryMesh.matrix.multiplyMatrices(_tmpMatA, reflectLocal);
    secondaryMesh.matrixWorldNeedsUpdate = true;
  }
  if (diagonalMesh) {
    // (--+): 2 minuses (P1, P2) — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld, reflectWorld2);
    diagonalMesh.matrix.multiplyMatrices(_tmpMatB, splatGroupA.matrixWorld);
    diagonalMesh.matrixWorldNeedsUpdate = true;
  }
  if (mesh_ppm) {
    // (++-): 1 minus (P3) — odd parity, X-flipped data
    _tmpMatA.multiplyMatrices(reflectWorld3, splatGroupA.matrixWorld);
    mesh_ppm.matrix.multiplyMatrices(_tmpMatA, reflectLocal);
    mesh_ppm.matrixWorldNeedsUpdate = true;
  }
  if (mesh_mpm) {
    // (-+-): 2 minuses (P1, P3) — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld, reflectWorld3);
    mesh_mpm.matrix.multiplyMatrices(_tmpMatB, splatGroupA.matrixWorld);
    mesh_mpm.matrixWorldNeedsUpdate = true;
  }
  if (mesh_pmm) {
    // (+--): 2 minuses (P2, P3) — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld2, reflectWorld3);
    mesh_pmm.matrix.multiplyMatrices(_tmpMatB, splatGroupA.matrixWorld);
    mesh_pmm.matrixWorldNeedsUpdate = true;
  }
  if (mesh_mmm) {
    // (---): 3 minuses — odd parity, X-flipped data.
    // T = Reflect_p1 · Reflect_p2 · Reflect_p3 · M_A · X_flip.
    // When all three planes pass through the origin, the triple reflection
    // is point inversion (−I), so the rendered output is the splat flipped
    // through the world origin.
    _tmpMatA.multiplyMatrices(reflectWorld, reflectWorld2);
    _tmpMatB.multiplyMatrices(_tmpMatA, reflectWorld3);
    _tmpMatC.multiplyMatrices(_tmpMatB, splatGroupA.matrixWorld);
    mesh_mmm.matrix.multiplyMatrices(_tmpMatC, reflectLocal);
    mesh_mmm.matrixWorldNeedsUpdate = true;
  }

  const extraCount = radialOriginals.length;
  if (extraCount === 0) return;
  const totalCount = extraCount + 1;
  for (let i = 0; i < extraCount; i++) {
    const angle = ((i + 1) * 2 * Math.PI) / totalCount;
    tmpRotY.makeRotationY(angle);

    // Source radial copy: RotY(angle) · splatGroupA.matrixWorld
    radialOriginals[i].matrix.multiplyMatrices(
      tmpRotY,
      splatGroupA.matrixWorld,
    );
    radialOriginals[i].matrixWorldNeedsUpdate = true;

    // Mirror radial copy: RotY(angle) · splatGroupB.matrixWorld
    radialMirrors[i].matrix.multiplyMatrices(
      tmpRotY,
      splatGroupB.matrixWorld,
    );
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

  // Share the GPU-resident PackedSplats from the primary meshes — we just
  // want extra rotated copies, not extra data.
  const srcPacked = originalMesh?.packedSplats;
  const mirrorPacked = mirrorMesh?.packedSplats;
  if (!srcPacked || !mirrorPacked) return;

  // Add extras to reach desired count. Same SH=0 trick as the biaxial/triaxial
  // extras — kaleidoscope copies are usually further from the camera and
  // their view-dependent shading is the first thing the eye lets go of.
  //
  // We pass `splatEncoding` through explicitly here too — see configureMesh
  // for the long explanation. tl;dr: without it Spark blows away the .spz's
  // own quantization parameters on the shared packedSplats and everything
  // decodes wrong.
  while (radialOriginals.length < desiredExtras) {
    const o = new SplatMesh({
      packedSplats: srcPacked,
      splatEncoding: srcPacked.splatEncoding,
    });
    o.editable = true;
    o.edits = [originalClipEdit];
    o.matrixAutoUpdate = false;
    o.maxSh = 0;
    scene.add(o);
    radialOriginals.push(o);
  }
  while (radialMirrors.length < desiredExtras) {
    const m = new SplatMesh({
      packedSplats: mirrorPacked,
      splatEncoding: mirrorPacked.splatEncoding,
    });
    m.editable = true;
    m.edits = [mirrorClipEdit];
    m.matrixAutoUpdate = false;
    m.maxSh = 0;
    scene.add(m);
    radialMirrors.push(m);
  }
}

// ----- .spz bytes → SplatMesh (native Spark loader) -----
//
// Spark's SplatMesh accepts raw .spz bytes via { fileBytes, fileType }. We use
// this path for ALL meshes (originals + mirrors + radial copies) so the splats
// are rendered through Spark's high-precision internal decoder. The previous
// approach (decode → setPackedSplat per splat) re-quantized the data twice
// and visibly degraded quality — see the use-spark rule in .cursor/rules/.
async function buildSplatMeshFromSpzBytes(bytes) {
  const mesh = new SplatMesh({
    fileBytes: bytes,
    fileType: "spz",
  });
  await mesh.initialized;
  return mesh;
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

// Return whichever pre-reflected .spz bytes should currently feed the mirror
// mesh (and its radial copies): B's if loaded, A's otherwise.
function activeMirrorBytes() {
  return mirrorBytesB ?? mirrorBytesA;
}

// Tear down the original mesh + any radial source-side copies. Also tears
// down the biaxial/triaxial extras that share originalMesh's packedSplats
// (diagonalMesh, mesh_mpm, mesh_pmm).
function disposeOriginalMeshes() {
  if (originalMesh) {
    splatGroupA.remove(originalMesh);
    originalMesh.dispose?.();
    originalMesh = null;
  }
  for (const m of radialOriginals) {
    scene.remove(m);
    m.dispose?.();
  }
  radialOriginals = [];
  if (diagonalMesh) {
    scene.remove(diagonalMesh);
    diagonalMesh.dispose?.();
    diagonalMesh = null;
  }
  if (mesh_mpm) {
    scene.remove(mesh_mpm);
    mesh_mpm.dispose?.();
    mesh_mpm = null;
  }
  if (mesh_pmm) {
    scene.remove(mesh_pmm);
    mesh_pmm.dispose?.();
    mesh_pmm = null;
  }
}

// Tear down the mirror mesh + any radial mirror copies. Also tears down the
// biaxial/triaxial extras that share mirrorMesh's packedSplats (secondaryMesh,
// mesh_ppm, mesh_mmm).
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
  if (secondaryMesh) {
    scene.remove(secondaryMesh);
    secondaryMesh.dispose?.();
    secondaryMesh = null;
  }
  if (mesh_ppm) {
    scene.remove(mesh_ppm);
    mesh_ppm.dispose?.();
    mesh_ppm = null;
  }
  if (mesh_mmm) {
    scene.remove(mesh_mmm);
    mesh_mmm.dispose?.();
    mesh_mmm = null;
  }
}

// Build the source-side SplatMesh by handing the raw .spz bytes for slot A
// to Spark's native loader. We then mark the mesh editable and attach the
// SDF clip so only the source-side half of the splat shows in the preview.
async function buildOriginalMesh(spzBytes) {
  disposeOriginalMeshes();
  if (!spzBytes) return;
  originalMesh = await buildSplatMeshFromSpzBytes(spzBytes);
  originalMesh.editable = true;
  originalMesh.edits = [originalClipEdit];
  splatGroupA.add(originalMesh);
}

// Build the mirror-side SplatMesh from the active pre-reflected .spz bytes.
// The mesh's matrix is driven manually each frame by updateMirrorTransform().
async function buildMirrorMesh() {
  disposeMirrorMeshes();
  const bytes = activeMirrorBytes();
  if (!bytes) return;
  mirrorMesh = await buildSplatMeshFromSpzBytes(bytes);
  mirrorMesh.editable = true;
  mirrorMesh.edits = [mirrorClipEdit];
  mirrorMesh.matrixAutoUpdate = false;
  scene.add(mirrorMesh);
}

async function loadSpzIntoSlot(slot, bytes, fileName) {
  if (slot !== "a" && slot !== "b") return;
  ui.setStatus(`Decoding ${fileName}…`);
  ui.enableDownload(false);

  // We still decode the .spz once on our side so we can do the mirror math
  // and write an export at the end. But the bytes that actually feed the
  // renderer are passed straight to Spark's native loader — no per-splat
  // re-quantization through setPackedSplat.
  const decoded = decodeSpz(bytes);

  if (slot === "a") {
    splatA = decoded;
    fileNameA = fileName;

    disposeOriginalMeshes();
    disposeMirrorMeshes();
    mirrorBytesA = null;

    ui.setStatus(
      `Building meshes (${decoded.numPoints.toLocaleString()} splats from A)…`,
    );

    // The source-side mesh loads straight from the original .spz bytes.
    await buildOriginalMesh(bytes);

    // The mirror-side mesh uses a re-encoded copy of the data with every
    // splat already pre-reflected across local X. Encoding back to .spz
    // and going through Spark's native loader keeps the rendering quality
    // identical to the source mesh.
    mirrorBytesA = encodeSpz(mirrorAllSplats(decoded, 0, 0));
    await buildMirrorMesh();

    fitPlaneBoundsFromData(splatA);
  } else {
    splatB = decoded;
    fileNameB = fileName;

    disposeMirrorMeshes();
    mirrorBytesB = null;

    ui.setStatus(
      `Building mirror-side mesh (${decoded.numPoints.toLocaleString()} splats from B)…`,
    );
    mirrorBytesB = encodeSpz(mirrorAllSplats(decoded, 0, 0));
    await buildMirrorMesh();

    // First-time slot-B load: splatGroupB has been auto-synced to A's
    // mirror every frame while B was empty, so its current transform is
    // already at the right "mirror of A" position. Nothing extra to do.
  }

  applyUIState(ui.state); // re-apply (rebuilds radial copies on the new meshes)
  updateMirrorTransform();
  ui.setSlotName("a", splatA ? fileNameA : null);
  ui.setSlotName("b", splatB ? fileNameB : null);
  ui.setEditTargetAvailability({ aLoaded: !!splatA, bLoaded: !!splatB });
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
    mirrorBytesA = null;
    // Slot B's pre-reflected bytes are still valid, but with no A there's
    // nothing to anchor the mirror to. Keep B's data around so it reappears
    // when the user reloads A.
    ui.enableDownload(false);
  } else {
    if (!splatB) return;
    splatB = null;
    fileNameB = null;
    disposeMirrorMeshes();
    mirrorBytesB = null;
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

  // Size all three plane visualizations (biaxial uses 2, triaxial uses 3)
  const planeSize = safeExtent * 2;
  planeMesh.geometry.dispose();
  planeMesh.geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  planeEdges.geometry.dispose();
  planeEdges.geometry = new THREE.EdgesGeometry(planeMesh.geometry);
  planeMesh2.geometry.dispose();
  planeMesh2.geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  planeEdges2.geometry.dispose();
  planeEdges2.geometry = new THREE.EdgesGeometry(planeMesh2.geometry);
  planeMesh3.geometry.dispose();
  planeMesh3.geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  planeEdges3.geometry.dispose();
  planeEdges3.geometry = new THREE.EdgesGeometry(planeMesh3.geometry);

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
    splatGroupA.updateMatrixWorld(true);
    splatGroupB.updateMatrixWorld(true);
    const axisIdx = AXES[ui.state.axis];
    const mode = ui.state.symmetryMode;
    const biaxial = mode === "biaxial" || mode === "triaxial";
    const triaxial = mode === "triaxial";
    // Auto-picked perpendicular axes (matches applyUIState's rule).
    const axisIdx2 = axisIdx === 0 ? 2 : 0;
    const axisIdx3 = 3 - axisIdx - axisIdx2;
    const radialCount = Math.max(1, Math.floor(ui.state.radialCount));

    // Decompose each group's matrixWorld into position/quaternion/scale so
    // we can pass a scalar uniform-scale into applyTransform (which only
    // supports uniform). Non-uniform scale is approximated by the average.
    const posA = new THREE.Vector3();
    const quatA = new THREE.Quaternion();
    const sclA = new THREE.Vector3();
    splatGroupA.matrixWorld.decompose(posA, quatA, sclA);
    const sA = (sclA.x + sclA.y + sclA.z) / 3;
    if (Math.max(sclA.x, sclA.y, sclA.z) / Math.min(sclA.x, sclA.y, sclA.z) > 1.001) {
      ui.setStatus(
        "Note: non-uniform scale on A — download uses the average; preview is exact.",
      );
    }

    const posB = new THREE.Vector3();
    const quatB = new THREE.Quaternion();
    const sclB = new THREE.Vector3();
    splatGroupB.matrixWorld.decompose(posB, quatB, sclB);
    const sB = (sclB.x + sclB.y + sclB.z) / 3;

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
    const composedMatA = new THREE.Matrix4();
    const composedMatB = new THREE.Matrix4();
    const composedQuatA = new THREE.Quaternion();
    const composedQuatB = new THREE.Quaternion();
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < radialCount; i++) {
      const angle = (i * 2 * Math.PI) / radialCount;
      rotQuat.setFromAxisAngle(Y_AXIS, angle);
      rotMat.makeRotationFromQuaternion(rotQuat);
      composedMatA.multiplyMatrices(rotMat, splatGroupA.matrixWorld);
      composedMatB.multiplyMatrices(rotMat, splatGroupB.matrixWorld);
      composedQuatA.multiplyQuaternions(rotQuat, quatA);
      composedQuatB.multiplyQuaternions(rotQuat, quatB);

      // A: clone, apply T_A (pos+quat+uniform scale), keep source side.
      const worldA = cloneSplatData(splatA);
      applyTransform(
        worldA,
        composedMatA.elements,
        new Float32Array([
          composedQuatA.x,
          composedQuatA.y,
          composedQuatA.z,
          composedQuatA.w,
        ]),
        sA,
      );
      let partA = keepSourceSide(
        worldA,
        axisIdx,
        ui.state.plane,
        ui.state.flipSide,
      );
      // In biaxial/triaxial mode, clip to the source side of every other
      // plane too so this part only occupies its specific octant.
      if (biaxial) partA = keepSourceSide(partA, axisIdx2, 0, false);
      if (triaxial) partA = keepSourceSide(partA, axisIdx3, 0, false);
      parts.push(partA);

      // B: clone, pre-X-flip (matches mirrorBytesB in the live preview),
      // apply T_B, keep mirror side. Falls back to A's data when B is empty.
      const worldB = mirrorAllSplats(splatForMirror, 0, 0);
      applyTransform(
        worldB,
        composedMatB.elements,
        new Float32Array([
          composedQuatB.x,
          composedQuatB.y,
          composedQuatB.z,
          composedQuatB.w,
        ]),
        sB,
      );
      let partB = keepMirrorSide(
        worldB,
        axisIdx,
        ui.state.plane,
        ui.state.flipSide,
      );
      if (biaxial) partB = keepSourceSide(partB, axisIdx2, 0, false);
      if (triaxial) partB = keepSourceSide(partB, axisIdx3, 0, false);
      parts.push(partB);
    }

    // Biaxial / triaxial extras. One copy each — these don't get the radial
    // multiplication in V1 (matches the preview, which also keeps a single
    // copy of each extra octant regardless of radialCount).
    //
    // Helper: bake one octant. `m` is the world matrix to apply (det = +1),
    // `useXFlip` says whether the splat data should be pre-X-flipped first
    // (true for odd-parity octants), and `clips` is an array of
    // [axisIdx, plane, useMirrorSide] entries that intersect the result.
    function bakeOctant(m, useXFlip, clips) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      m.decompose(pos, quat, scl);
      const s = (scl.x + scl.y + scl.z) / 3;
      const src = useXFlip ? splatForMirror : splatA;
      const world = useXFlip ? mirrorAllSplats(src, 0, 0) : cloneSplatData(src);
      applyTransform(
        world,
        m.elements,
        new Float32Array([quat.x, quat.y, quat.z, quat.w]),
        s,
      );
      let part = world;
      for (const [ax, plane, mirrorSide] of clips) {
        part = mirrorSide
          ? keepMirrorSide(part, ax, plane, ax === axisIdx ? ui.state.flipSide : false)
          : keepSourceSide(part, ax, plane, ax === axisIdx ? ui.state.flipSide : false);
      }
      return part;
    }

    if (biaxial) {
      // C (+-+): reflection across plane 2 only. 1 minus → X-flipped data.
      //   M_C = Reflect_world2 · M_A · Reflect_local_X
      const matC = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld2, splatGroupA.matrixWorld)
        .multiply(reflectLocal);
      const clipsC = [
        [axisIdx, ui.state.plane, false], // source of P1
        [axisIdx2, 0, true], // mirror of P2
      ];
      if (triaxial) clipsC.push([axisIdx3, 0, false]); // source of P3
      parts.push(bakeOctant(matC, true, clipsC));

      // D (--+): reflection across BOTH planes 1 and 2. 2 minuses → original data.
      //   M_D = Reflect_world · Reflect_world2 · M_A
      const matD = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld, reflectWorld2)
        .multiply(splatGroupA.matrixWorld);
      const clipsD = [
        [axisIdx, ui.state.plane, true], // mirror of P1
        [axisIdx2, 0, true], // mirror of P2
      ];
      if (triaxial) clipsD.push([axisIdx3, 0, false]); // source of P3
      parts.push(bakeOctant(matD, false, clipsD));
    }

    // Triaxial-only octants: the four that lie on the MIRROR side of plane 3.
    if (triaxial) {
      // (++-): reflection across plane 3 only. 1 minus → X-flipped data.
      //   M = Reflect_world3 · M_A · Reflect_local_X
      const mat_ppm = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld3, splatGroupA.matrixWorld)
        .multiply(reflectLocal);
      parts.push(
        bakeOctant(mat_ppm, true, [
          [axisIdx, ui.state.plane, false], // source of P1
          [axisIdx2, 0, false], // source of P2
          [axisIdx3, 0, true], // mirror of P3
        ]),
      );

      // (-+-): reflection across planes 1 and 3. 2 minuses → original data.
      //   M = Reflect_world · Reflect_world3 · M_A
      const mat_mpm = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld, reflectWorld3)
        .multiply(splatGroupA.matrixWorld);
      parts.push(
        bakeOctant(mat_mpm, false, [
          [axisIdx, ui.state.plane, true],
          [axisIdx2, 0, false],
          [axisIdx3, 0, true],
        ]),
      );

      // (+--): reflection across planes 2 and 3. 2 minuses → original data.
      //   M = Reflect_world2 · Reflect_world3 · M_A
      const mat_pmm = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld2, reflectWorld3)
        .multiply(splatGroupA.matrixWorld);
      parts.push(
        bakeOctant(mat_pmm, false, [
          [axisIdx, ui.state.plane, false],
          [axisIdx2, 0, true],
          [axisIdx3, 0, true],
        ]),
      );

      // (---): reflection across all three planes = point inversion through
      // the origin. 3 minuses → X-flipped data.
      //   M = Reflect_world · Reflect_world2 · Reflect_world3 · M_A · Reflect_local_X
      const mat_mmm = new THREE.Matrix4()
        .multiplyMatrices(reflectWorld, reflectWorld2)
        .multiply(reflectWorld3)
        .multiply(splatGroupA.matrixWorld)
        .multiply(reflectLocal);
      parts.push(
        bakeOctant(mat_mmm, true, [
          [axisIdx, ui.state.plane, true],
          [axisIdx2, 0, true],
          [axisIdx3, 0, true],
        ]),
      );
    }

    const mirroredData = concatSplats(parts);
    const bytes = encodeSpz(mirroredData);
    const baseName = fileNameA.replace(/\.spz$/i, "");
    // Filename suffix reflects what was baked in.
    const suffixBits = [];
    if (splatB) suffixBits.push("AB");
    if (triaxial) suffixBits.push("triaxial");
    else if (biaxial) suffixBits.push("biaxial");
    if (radialCount > 1) suffixBits.push(`radial${radialCount}`);
    const suffix = suffixBits.length
      ? `-${suffixBits.join("-")}`
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
