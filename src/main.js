// Splat Mirror — main app
//
// Architecture (think of it like a real bathroom mirror, but with multiple
// objects sitting in front of it):
//
//   - The symmetry PLANE lives in world space (controlled by axis + plane
//     slider). It is fixed; the user moves the splats in front of it.
//
//   - The scene holds up to MAX_LAYERS LAYERS. Each layer is one .spz file
//     with its own gizmo transform (a THREE.Group anchor), visibility, and
//     opacity. The gizmo edits the ACTIVE layer.
//
//   - EVERY LAYER FULLY AUTO-MIRRORS ITSELF across the shared plane(s). A
//     single layer at the origin looks exactly like the v1 single-splat
//     behaviour. Two or more layers each get their own original + mirror
//     pair (and biaxial/triaxial octants, and radial copies) — so each
//     layer always has its own reflection visible.
//
//     To stop multiple layers from stacking on top of each other at the
//     origin (the "muddy bleed" problem), new layers are auto-OFFSET along
//     the secondary perpendicular axis at load time, so they tile next to
//     each other like stitched panoramas. The user can drag any layer
//     wherever they want from there.
//
//     For a single layer, the mirror mesh's world transform each frame is:
//        T_mirror = Reflect_world  ·  T_gizmo  ·  Reflect_local
//
//     where Reflect_world is the reflection across the user-chosen world
//     plane, and Reflect_local is a fixed local-X reflection that was baked
//     into the mirror mesh's data (positions/rotations/SH pre-reflected once
//     at load time). The two reflections cancel in determinant (det = +1) so
//     the final transform is a proper rotation + translation Spark renders
//     correctly.
//
//   - Biaxial / triaxial modes add 2 / 6 more octant meshes per layer,
//     wired up by `applySymmetryMode`. Radial copies further multiply the
//     visible count via `rebuildRadialMeshes`. To keep this manageable on
//     the GPU, every extra octant + radial copy uses `maxSh = 0`, and the
//     active layer is the only one that renders full SH on its primary pair.
//
// The download bakes EVERY visible layer's gizmo transform + symmetry tree
// into a single combined .spz that matches the preview.

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

// ----- Save-folder memory (IndexedDB) -----
// Stores a single directory handle so the user only picks their save folder
// once — after that every download goes straight there automatically.

const IDB_NAME = "splat-mirror";
const IDB_STORE = "settings";
const IDB_KEY = "saveDir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSaveDir() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function setSaveDir(handle) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = resolve;
  });
}

// Save bytes to the remembered folder, or fall back to a normal download.
// First call: asks the user to pick a save folder and remembers it forever.
async function saveSpzFile(bytes, fileName) {
  // Try the File System Access API (Chrome / Edge — works on Netlify)
  if (window.showDirectoryPicker) {
    let dirHandle = await getSaveDir();

    // Verify we still have write permission; re-prompt if not.
    if (dirHandle) {
      const perm = await dirHandle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") dirHandle = null;
    }

    // First time (or permission lost): ask the user to pick a folder.
    if (!dirHandle) {
      try {
        dirHandle = await window.showDirectoryPicker({
          id: "spz-save",
          mode: "readwrite",
          startIn: "downloads",
        });
        await setSaveDir(dirHandle);
      } catch {
        // User cancelled — fall back to normal download
        fallbackDownload(bytes, fileName);
        return;
      }
    }

    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return;
  }

  // Fallback for browsers without File System Access API (Safari, Firefox)
  fallbackDownload(bytes, fileName);
}

function fallbackDownload(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
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

// ----- Layers -----
//
// A "layer" is one loaded .spz with its own gizmo transform, visibility,
// opacity, and its OWN auto-mirror tree (originalMesh + mirrorMesh + biaxial
// /triaxial octants + radial copies). The mirror plane is shared across all
// layers — every layer is reflected by the same plane — but each layer's
// mirror is rooted in its own group, so layers can be positioned anywhere
// in the scene and each one gets mirrored to its own twin position.
//
// We cap the count at MAX_LAYERS so the GPU budget stays predictable: in
// triaxial + radial=N modes the mesh count is `MAX_LAYERS · 8 · N`, which
// blows up quickly.
const MAX_LAYERS = 4;
let layers = []; // active layers, in stable insertion order
let activeLayerId = null; // which layer the gizmo currently edits
let nextLayerId = 0; // monotonic counter for unique layer ids

// Auto-offset baseline. Captured from the FIRST loaded layer's AABB so
// subsequent layers slide over by ~one room's worth along the secondary
// perpendicular axis at load time. This stops everything from stacking
// at origin (the "muddy bleed" problem) without forcing the user to do
// math with the gizmo. They can still drag any layer wherever after.
let baseLayerExtent = 0;

// Which world-axis index (0 = X, 1 = Y, 2 = Z) we slide new layers along
// when auto-offsetting. We pick the secondary perpendicular axis of the
// current primary symmetry axis, using the same rule as ui.js's
// pickPerpendicularAxes(): primary X → secondary Z, primary Y → X,
// primary Z → X. (So the up-axis stays free whenever possible.)
function secondaryAxisIdxFor(primaryAxisIdx) {
  return primaryAxisIdx === 0 ? 2 : 0;
}

// Latest symmetry axes pushed by applyUIState. We mirror them out here as
// module state so updateLayerTransform (called every frame) can size the
// per-layer slot SDFs without re-reading ui.state on the hot path. They
// match the three indices computed at the top of applyUIState.
let _primaryAxisIdx = 0;
let _secondaryAxisIdx = 2;
let _tertiaryAxisIdx = 1;

// Huge half-extent used along the slot SDF axes we DON'T want to clip
// against. Anything well beyond a reasonable scene size works — at 1e4
// world units, no real splat will ever extend out that far.
const SLOT_HUGE = 1e4;

// ----- Per-layer mesh slot keys -----
//
// Each layer carries up to 8 SplatMesh slots — one per compartment of the
// fullest symmetry mode (triaxial = 8 octants). In simpler modes the
// trailing slots are kept alive but hidden (so we don't dispose the
// shared packedSplats buffers — see configureLayerSlot).
//
// The sign suffix reads (P1 P2 P3) where '+' = source side of that plane
// and '-' = mirror side. Order matters: handleDownload's compartmentRecipe
// and applyActiveLayerSHRule both index into this list.
const COMPARTMENT_MESH_KEY = [
  "originalMesh",   // 0  (+ + +)  — primary source
  "mirrorMesh",     // 1  (- + +)  — primary mirror
  "secondaryMesh",  // 2  (+ - +)  — biaxial+ only
  "diagonalMesh",   // 3  (- - +)  — biaxial+ only
  "mesh_ppm",       // 4  (+ + -)  — triaxial only
  "mesh_mpm",       // 5  (- + -)  — triaxial only
  "mesh_pmm",       // 6  (+ - -)  — triaxial only
  "mesh_mmm",       // 7  (- - -)  — triaxial only (point-inversion)
];

// How many of the 8 compartments are alive in each symmetry mode.
function compartmentCount(mode) {
  if (mode === "triaxial") return 8;
  if (mode === "biaxial") return 4;
  return 2;
}

// Per-mesh-slot signature in comments below: "pps" = (p)rimary-source side,
// (p)rimary-source side, ... for each of the up-to-three symmetry planes.
//
//   originalMesh   — quadrant (++) in biaxial / octant (+++) in triaxial
//   mirrorMesh     — quadrant (-+) / octant (-++)
//   secondaryMesh  — quadrant (+-) / octant (+-+)   (biaxial+ only)
//   diagonalMesh   — quadrant (--) / octant (--+)   (biaxial+ only)
//   mesh_ppm                                        (triaxial only)
//   mesh_mpm                                        (triaxial only)
//   mesh_pmm                                        (triaxial only)
//   mesh_mmm                                        (triaxial only, point inversion)
//
// "Even-parity" octants (0 or 2 minuses) use the ORIGINAL packedSplats data
// and a world matrix with det = +1. "Odd-parity" octants (1 or 3 minuses)
// use the pre-X-flipped data with a world matrix that, combined with the
// data's bake-in flip, gives the desired reflection. See updateLayerTransform
// for the matrix formulas.
//
// A Layer object has shape:
//   {
//     id, name, splat, mirrorBytes, fileName,
//     group,          // THREE.Group — the source-side gizmo anchor
//     originalMesh, mirrorMesh,
//     secondaryMesh, diagonalMesh,
//     mesh_ppm, mesh_mpm, mesh_pmm, mesh_mmm,
//     radialOriginals: [], radialMirrors: [],
//     visible, opacity,
//   }

function findLayer(id) {
  return layers.find((l) => l.id === id) ?? null;
}
function activeLayer() {
  return findLayer(activeLayerId);
}

function createLayer(name) {
  const id = `layer-${nextLayerId++}`;
  const group = new THREE.Group();
  scene.add(group);
  group.add(new THREE.AxesHelper(0.3));

  // ----- Per-layer slot SDFs -----
  //
  // Each layer carries its own axis-aligned BOX SDF that confines all of
  // its meshes to a slab along the secondary axis (the "auto-offset"
  // direction). Without this, layers loaded at different secondary-axis
  // offsets would still bleed into each other because .spz files have
  // tons of low-opacity fog splats reaching well beyond their visible
  // AABB. The slot box is hard along secondary but huge along the other
  // two axes, so it doesn't interfere with primary/tertiary clipping.
  //
  // We build TWO slot SDFs per layer:
  //   slotSdfSrc  — at layer.group's world position; clips all meshes
  //                 on the source side of the secondary plane
  //                 (P2='+', i.e. originalMesh / mirrorMesh / ppm / mpm).
  //   slotSdfMir  — at the biaxial-reflected position
  //                 (layer.group reflected across secondary plane);
  //                 clips meshes whose content the biaxial mode shoves
  //                 to the mirror side of the secondary plane
  //                 (P2='-', i.e. secondaryMesh / diagonalMesh / pmm / mmm).
  //
  // Without the second SDF, biaxial-reflected octants of non-first layers
  // would get clipped out by the source slot (which is at +offset, while
  // their content sits at −offset). Each slot is rebuilt-in-place every
  // frame in updateLayerSlots().
  //
  // Box dimensions live in sdf.scale (Spark reads sizes.xyz from there at
  // encode time — see SplatEdits.update). We set the actual half-extents
  // every frame too, because they depend on which axis is currently the
  // secondary and on baseLayerExtent (only known after the first load).
  const slotSdfSrc = new SplatEditSdf({
    type: SplatEditSdfType.BOX,
    opacity: 0,
    color: new THREE.Color(1, 1, 1),
  });
  slotSdfSrc.scale.set(SLOT_HUGE, SLOT_HUGE, SLOT_HUGE);
  scene.add(slotSdfSrc);

  const slotSdfMir = new SplatEditSdf({
    type: SplatEditSdfType.BOX,
    opacity: 0,
    color: new THREE.Color(1, 1, 1),
  });
  slotSdfMir.scale.set(SLOT_HUGE, SLOT_HUGE, SLOT_HUGE);
  scene.add(slotSdfMir);

  // invert: true → hide OUTSIDE the box (keep inside). Soft-edge follows
  // the user's edge-softness slider so adjacent slots blend at their seam.
  const slotEditSrc = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
    softEdge: 0,
    sdfSmooth: 0,
    invert: true,
    sdfs: [slotSdfSrc],
  });

  const slotEditMir = new SplatEdit({
    rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
    softEdge: 0,
    sdfSmooth: 0,
    invert: true,
    sdfs: [slotSdfMir],
  });

  return {
    id,
    name,
    splat: null,
    mirrorBytes: null,
    fileName: name,
    group,
    originalMesh: null,
    mirrorMesh: null,
    secondaryMesh: null,
    diagonalMesh: null,
    mesh_ppm: null,
    mesh_mpm: null,
    mesh_pmm: null,
    mesh_mmm: null,
    radialOriginals: [],
    radialMirrors: [],
    visible: true,
    opacity: 1,
    slotSdfSrc,
    slotSdfMir,
    slotEditSrc,
    slotEditMir,
  };
}

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
const _tmpMirrorMat = new THREE.Matrix4();

// ----- Gizmo -----
const gizmo = new TransformControls(camera, canvas);
gizmo.size = 0.8;
const gizmoHelper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
scene.add(gizmoHelper);
let currentGizmoLayerId = null; // tracks which layer's group the gizmo is currently attached to
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
    const layer = activeLayer();
    if (!layer) return;
    layer.group.position.set(0, 0, 0);
    layer.group.quaternion.set(0, 0, 0, 1);
    layer.group.scale.set(1, 1, 1);
  },
  onDownload: handleDownload,
  onAddLayerFromFile: async (file) => {
    if (layers.length >= MAX_LAYERS) {
      ui.setStatus(`At most ${MAX_LAYERS} layers (remove one first)`, true);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await addLayerFromBytes(bytes, file.name);
    } catch (err) {
      console.error(err);
      ui.setStatus(`Failed to load ${file.name}: ${err.message}`, true);
    }
  },
  onReplaceLayerFromFile: async (layerId, file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await replaceLayerFromBytes(layerId, bytes, file.name);
    } catch (err) {
      console.error(err);
      ui.setStatus(`Failed to replace layer: ${err.message}`, true);
    }
  },
  onRemoveLayer: (layerId) => removeLayer(layerId),
  onSelectLayer: (layerId) => selectLayer(layerId),
  onToggleLayerVisible: (layerId, visible) => setLayerVisible(layerId, visible),
  onSetLayerOpacity: (layerId, opacity) => setLayerOpacity(layerId, opacity),
  onRenameLayer: (layerId, name) => renameLayer(layerId, name),
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

  // Cache for the per-frame slot updates in updateLayerTransform.
  _primaryAxisIdx = axisIdx;
  _secondaryAxisIdx = axisIdx2;
  _tertiaryAxisIdx = axisIdx3;

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
  // Per-layer slot edits also pick up the user's edge-softness slider so
  // adjacent layer slots can blend at their seam instead of having a hard
  // wall between them.
  for (const layer of layers) {
    layer.slotEditSrc.softEdge = state.softEdge;
    layer.slotEditMir.softEdge = state.softEdge;
  }

  // Scale down the WebGL pixel ratio as more octant meshes come online —
  // each additional mesh roughly doubles fragment work for overlapping splats.
  updatePixelRatioForMode(mode);

  // Attach/detach the extra meshes for the chosen symmetry mode and rewrite
  // each mesh's edits array to match the appropriate octant clipping.
  applySymmetryMode(mode);

  // Match the radial-copy count to the slider. Cheap if the count hasn't
  // changed (the helper does nothing in that case). This also (re)sets
  // visibility on every existing radial copy, so layers that aren't
  // visible right now drop their radials too.
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

  // Gizmo attaches to the active layer's group. If no layer is loaded, detach.
  attachGizmoToActiveLayer();

  // Gizmo mode — available in both orbit and fly. While flying, the
  // dragging-changed handler temporarily pauses fly's mouse-look so you can
  // drag the handle without the camera spinning.
  if (state.gizmoMode === "off" || !activeLayer()) {
    gizmo.enabled = false;
    if (gizmoHelper) gizmoHelper.visible = false;
  } else {
    gizmo.enabled = true;
    if (gizmoHelper) gizmoHelper.visible = true;
    gizmo.setMode(state.gizmoMode);
  }
}

// Attach the gizmo to the active layer's group, or detach if no layers.
// Also refreshes the per-layer SH cap so the active layer renders with
// full view-dependent shading while the others drop to flat shading.
function attachGizmoToActiveLayer() {
  const layer = activeLayer();
  if (!layer) {
    if (currentGizmoLayerId !== null) {
      gizmo.detach();
      currentGizmoLayerId = null;
    }
    applyActiveLayerSHRule();
    return;
  }
  if (currentGizmoLayerId !== layer.id) {
    gizmo.detach();
    gizmo.attach(layer.group);
    currentGizmoLayerId = layer.id;
  }
  applyActiveLayerSHRule();
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

// Helper: ensure an octant mesh slot is in the right state on a layer —
// exists & has the requested edits when `wantMesh` is true, hidden (but
// kept alive) when `wantMesh` is false.
//
// We do NOT dispose these meshes when switching back to a simpler symmetry
// mode. Why? Because they share `packedSplats` with the layer's primary
// pair, and Spark's `SplatMesh.dispose()` releases the underlying GPU buffer
// — which would corrupt the primary meshes that still reference the same
// shared buffer. So the rule is: create once on demand, then just toggle
// `.visible` to enable/disable them. The cost of a hidden SplatMesh is a
// few hundred bytes; far better than the symptom of "splats vanish when
// I flip through symmetry modes".
//
// We always (re)assign `mesh.edits` here, even if the mesh already existed,
// because the edit list for a given quadrant/octant CHANGES with the symmetry
// mode (single = 1 clip per mesh, biaxial = 2, triaxial = 3).
//
// Setting `mesh.edits` BEFORE adding to the scene avoids a one-frame window
// where Spark sees `editable=true` + `edits=null`, falls back to its child-
// traversal path, and ends up with a different edits buffer layout than the
// next frame uses.
function configureLayerSlot(layer, slotKey, wantMesh, sourceMesh, edits) {
  let slot = layer[slotKey];

  // First time we need this octant for the layer — create it. We never
  // destroy after this point; toggling `.visible` is enough.
  if (wantMesh && !slot) {
    if (!sourceMesh?.packedSplats) return;
    // CRITICAL: When we create a new SplatMesh by sharing another mesh's
    // packedSplats, Spark's constructor OVERWRITES the shared object's
    // `.splatEncoding` with DEFAULT_SPLAT_ENCODING unless we explicitly
    // pass the source's encoding through. That overwrite corrupts the
    // original .spz quantization parameters (scale range etc.) on the
    // shared buffer, and every mesh referencing it then decodes splats
    // at the wrong positions/scales.
    slot = new SplatMesh({
      packedSplats: sourceMesh.packedSplats,
      splatEncoding: sourceMesh.packedSplats.splatEncoding,
    });
    slot.editable = true;
    slot.edits = edits; // assign BEFORE scene.add so spark sees them on its first frameUpdate
    slot.matrixAutoUpdate = false;
    slot.matrix.identity(); // updateLayerTransform() will overwrite this same frame
    // Performance: extra octant meshes drop view-dependent SH lighting.
    slot.maxSh = 0;
    scene.add(slot);
    layer[slotKey] = slot;
  }

  if (!slot) return; // wanted but no source mesh available — bail

  // Refresh state on every call so existing meshes pick up new edit lists,
  // visibility changes, etc.
  slot.edits = edits;
  slot.visible = wantMesh && layer.visible;
}

// Per-layer symmetry-mode application. Each layer carries its own set of
// octant meshes; we configure the same eight clip combinations on every
// layer so they all participate in the same shared symmetry.
function applySymmetryModeToLayer(layer, mode) {
  const biaxial = mode === "biaxial" || mode === "triaxial";
  const triaxial = mode === "triaxial";

  // Build the edits list for ONE mesh (one octant of the symmetry tree).
  // Order in the array matters: Spark applies edits in sequence. We use
  // MULTIPLY blend mode everywhere so the order is commutative in effect,
  // but we still keep the global plane clips first and the per-layer slot
  // clip last so it's easy to read.
  const editsFor = (sign1, sign2, sign3) => {
    const list = [];
    list.push(sign1 === "+" ? originalClipEdit : mirrorClipEdit);
    if (biaxial)
      list.push(sign2 === "+" ? secondaryHideMirrorEdit : secondaryHideSourceEdit);
    if (triaxial)
      list.push(sign3 === "+" ? tertiaryHideMirrorEdit : tertiaryHideSourceEdit);
    // Per-layer slot clip: confines this mesh's content to the layer's
    // own slab along the secondary axis. P2='+' meshes live on the
    // source side of the secondary plane → use slotEditSrc; P2='-'
    // meshes (biaxial / triaxial reflections through the secondary
    // plane) live on the mirror side → use slotEditMir.
    list.push(sign2 === "+" ? layer.slotEditSrc : layer.slotEditMir);
    return list;
  };

  // Primary pair — present whenever the layer has data loaded.
  if (layer.originalMesh) layer.originalMesh.edits = editsFor("+", "+", "+");
  if (layer.mirrorMesh) layer.mirrorMesh.edits = editsFor("-", "+", "+");

  // Biaxial pair: needed in biaxial AND triaxial.
  configureLayerSlot(layer, "secondaryMesh", biaxial, layer.mirrorMesh, editsFor("+", "-", "+"));
  configureLayerSlot(layer, "diagonalMesh", biaxial, layer.originalMesh, editsFor("-", "-", "+"));

  // Triaxial-only extras.
  configureLayerSlot(layer, "mesh_ppm", triaxial, layer.mirrorMesh, editsFor("+", "+", "-"));
  configureLayerSlot(layer, "mesh_mpm", triaxial, layer.originalMesh, editsFor("-", "+", "-"));
  configureLayerSlot(layer, "mesh_pmm", triaxial, layer.originalMesh, editsFor("+", "-", "-"));
  configureLayerSlot(layer, "mesh_mmm", triaxial, layer.mirrorMesh, editsFor("-", "-", "-"));
}

// Apply the chosen symmetry mode to every loaded layer.
function applySymmetryMode(mode) {
  for (const layer of layers) applySymmetryModeToLayer(layer, mode);
}

// Reusable scratch vector for slot updates.
const _slotWorldPos = new THREE.Vector3();

// Recompute one layer's source/mirror slot SDFs from its current gizmo
// position and the active symmetry axes. Called once per frame per layer
// from updateLayerTransform. Cheap — just a few sets and one matrix-world
// fetch — but adjusting `sdf.scale` re-encodes the SDF buffer next frame,
// so we only re-set values that actually changed.
function updateLayerSlots(layer) {
  // Slot half-width along the secondary axis. Until the first layer has
  // loaded (and baseLayerExtent has been measured), we fall back to a
  // huge slot — effectively "no clipping" — so a half-loaded scene still
  // renders normally.
  const halfWidth = baseLayerExtent > 0 ? baseLayerExtent / 2 : SLOT_HUGE;
  const sx = _secondaryAxisIdx === 0 ? halfWidth : SLOT_HUGE;
  const sy = _secondaryAxisIdx === 1 ? halfWidth : SLOT_HUGE;
  const sz = _secondaryAxisIdx === 2 ? halfWidth : SLOT_HUGE;
  // Only call .set() if dimensions actually changed (it triggers an SDF
  // texture re-encode each frame otherwise).
  if (
    layer.slotSdfSrc.scale.x !== sx ||
    layer.slotSdfSrc.scale.y !== sy ||
    layer.slotSdfSrc.scale.z !== sz
  ) {
    layer.slotSdfSrc.scale.set(sx, sy, sz);
    layer.slotSdfMir.scale.set(sx, sy, sz);
  }

  layer.group.getWorldPosition(_slotWorldPos);
  layer.slotSdfSrc.position.copy(_slotWorldPos);
  // The mirror slot is the source slot reflected across the secondary
  // plane at world origin (matches where biaxial mode places that
  // layer's secondaryMesh / diagonalMesh / pmm / mmm content).
  layer.slotSdfMir.position.copy(_slotWorldPos);
  layer.slotSdfMir.position.setComponent(
    _secondaryAxisIdx,
    -_slotWorldPos.getComponent(_secondaryAxisIdx),
  );
}

// Mirror-side mesh of a layer: its matrix is derived from the source-side
// group each frame. Since each layer has its OWN auto-mirror (no separate
// gizmo for the mirror side any more), we just compute:
//
//   mirrorMesh.matrix = Reflect_world · layer.group.matrixWorld · Reflect_local
//
// The Reflect_local "undoes" the pre-X-flip baked into mirrorBytes, and the
// Reflect_world then moves the result across the active symmetry plane.
function updateLayerTransform(layer) {
  if (!layer.originalMesh && !layer.mirrorMesh) return;
  layer.group.updateMatrixWorld(true);

  // Keep this layer's slot SDFs glued to its world position (translation
  // only — we deliberately ignore the layer's gizmo rotation/scale so the
  // slot stays axis-aligned to the world's secondary axis).
  updateLayerSlots(layer);

  if (layer.mirrorMesh) {
    _tmpMirrorMat.multiplyMatrices(reflectWorld, layer.group.matrixWorld);
    layer.mirrorMesh.matrix.multiplyMatrices(_tmpMirrorMat, reflectLocal);
    layer.mirrorMesh.matrixWorldNeedsUpdate = true;
  }

  // Biaxial / triaxial: drive the extra meshes' world matrices.
  //
  // For an octant with signs (s1, s2, s3) where '-' = mirror across that
  // plane, the effective transform on the ORIGINAL splat positions is:
  //
  //   T_octant = [Reflect_p1 if s1=-] · [Reflect_p2 if s2=-]
  //            · [Reflect_p3 if s3=-] · layer.group.matrixWorld
  //
  // Even-k octants (0 or 2 minuses) use the original data and mesh.matrix = T.
  // Odd-k octants use the X-flipped data, mesh.matrix = T · Reflect_local.
  if (layer.secondaryMesh) {
    // (+-+): 1 minus (P2) — odd parity, X-flipped data
    _tmpMatA.multiplyMatrices(reflectWorld2, layer.group.matrixWorld);
    layer.secondaryMesh.matrix.multiplyMatrices(_tmpMatA, reflectLocal);
    layer.secondaryMesh.matrixWorldNeedsUpdate = true;
  }
  if (layer.diagonalMesh) {
    // (--+): 2 minuses — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld, reflectWorld2);
    layer.diagonalMesh.matrix.multiplyMatrices(_tmpMatB, layer.group.matrixWorld);
    layer.diagonalMesh.matrixWorldNeedsUpdate = true;
  }
  if (layer.mesh_ppm) {
    // (++-): 1 minus (P3) — odd parity, X-flipped data
    _tmpMatA.multiplyMatrices(reflectWorld3, layer.group.matrixWorld);
    layer.mesh_ppm.matrix.multiplyMatrices(_tmpMatA, reflectLocal);
    layer.mesh_ppm.matrixWorldNeedsUpdate = true;
  }
  if (layer.mesh_mpm) {
    // (-+-): 2 minuses — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld, reflectWorld3);
    layer.mesh_mpm.matrix.multiplyMatrices(_tmpMatB, layer.group.matrixWorld);
    layer.mesh_mpm.matrixWorldNeedsUpdate = true;
  }
  if (layer.mesh_pmm) {
    // (+--): 2 minuses — even parity, original data
    _tmpMatB.multiplyMatrices(reflectWorld2, reflectWorld3);
    layer.mesh_pmm.matrix.multiplyMatrices(_tmpMatB, layer.group.matrixWorld);
    layer.mesh_pmm.matrixWorldNeedsUpdate = true;
  }
  if (layer.mesh_mmm) {
    // (---): 3 minuses — odd parity, X-flipped data.
    _tmpMatA.multiplyMatrices(reflectWorld, reflectWorld2);
    _tmpMatB.multiplyMatrices(_tmpMatA, reflectWorld3);
    _tmpMatC.multiplyMatrices(_tmpMatB, layer.group.matrixWorld);
    layer.mesh_mmm.matrix.multiplyMatrices(_tmpMatC, reflectLocal);
    layer.mesh_mmm.matrixWorldNeedsUpdate = true;
  }

  // Radial copies of this layer.
  const extraCount = layer.radialOriginals.length;
  if (extraCount === 0) return;
  const totalCount = extraCount + 1;
  for (let i = 0; i < extraCount; i++) {
    const angle = ((i + 1) * 2 * Math.PI) / totalCount;
    tmpRotY.makeRotationY(angle);

    layer.radialOriginals[i].matrix.multiplyMatrices(
      tmpRotY,
      layer.group.matrixWorld,
    );
    layer.radialOriginals[i].matrixWorldNeedsUpdate = true;

    // Mirror radial copy = RotY · (Reflect_world · group · Reflect_local)
    _tmpMirrorMat.multiplyMatrices(reflectWorld, layer.group.matrixWorld);
    _tmpMatA.multiplyMatrices(_tmpMirrorMat, reflectLocal);
    layer.radialMirrors[i].matrix.multiplyMatrices(tmpRotY, _tmpMatA);
    layer.radialMirrors[i].matrixWorldNeedsUpdate = true;
  }
}

// Tick every layer's mirror tree. Called from applyUIState() (to seed the
// first frame after a mode change) and from the render loop.
function updateMirrorTransform() {
  for (const layer of layers) updateLayerTransform(layer);
}

// Rebuild the array of extra radial meshes for a single layer so it shows
// exactly `count - 1` pairs (since the primary pair is layer.originalMesh +
// layer.mirrorMesh). Each extra is a lightweight SplatMesh sharing the same
// PackedSplats GPU buffer as the primary — only the world transform differs.
//
// Like the octant meshes, we NEVER dispose radial copies when the count
// goes down — disposing would free the shared `packedSplats` and corrupt
// the primary meshes. Instead, we grow the array on demand and hide the
// extras (set `visible = false`) when the count is lower than the high-
// water mark we previously needed.
function rebuildLayerRadialMeshes(layer, count) {
  const desiredExtras = Math.max(0, Math.floor(count) - 1);

  // Share the GPU-resident PackedSplats from the primary meshes — we just
  // want extra rotated copies, not extra data. We pass `splatEncoding`
  // through explicitly — see configureLayerSlot for the long explanation.
  const srcPacked = layer.originalMesh?.packedSplats;
  const mirrorPacked = layer.mirrorMesh?.packedSplats;
  if (!srcPacked || !mirrorPacked) return;

  // Grow each array to the high-water mark on demand. Hidden extras cost
  // basically nothing.
  while (layer.radialOriginals.length < desiredExtras) {
    const o = new SplatMesh({
      packedSplats: srcPacked,
      splatEncoding: srcPacked.splatEncoding,
    });
    o.editable = true;
    o.edits = [originalClipEdit];
    o.matrixAutoUpdate = false;
    o.maxSh = 0;
    scene.add(o);
    layer.radialOriginals.push(o);
  }
  while (layer.radialMirrors.length < desiredExtras) {
    const m = new SplatMesh({
      packedSplats: mirrorPacked,
      splatEncoding: mirrorPacked.splatEncoding,
    });
    m.editable = true;
    m.edits = [mirrorClipEdit];
    m.matrixAutoUpdate = false;
    m.maxSh = 0;
    scene.add(m);
    layer.radialMirrors.push(m);
  }

  // Set visibility on every radial we own: only the first `desiredExtras`
  // copies are wanted for the current slider value, AND we honor the
  // layer's own visibility toggle. Hidden extras stay alive in the scene
  // (so we never dispose the shared packedSplats buffer) — they just
  // don't render until the user dials the count back up.
  for (let i = 0; i < layer.radialOriginals.length; i++) {
    layer.radialOriginals[i].visible = i < desiredExtras && layer.visible;
  }
  for (let i = 0; i < layer.radialMirrors.length; i++) {
    layer.radialMirrors[i].visible = i < desiredExtras && layer.visible;
  }
}

function rebuildRadialMeshes(count) {
  for (const layer of layers) rebuildLayerRadialMeshes(layer, count);
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
  await addLayerFromBytes(buf, fileName);
}

// Tear down every mesh belonging to a layer. Used when the layer is removed
// or its splat data is replaced. The layer.group itself is left in the scene
// so the caller can decide whether to also unparent / remove it.
function disposeLayerMeshes(layer) {
  if (layer.originalMesh) {
    layer.group.remove(layer.originalMesh);
    layer.originalMesh.dispose?.();
    layer.originalMesh = null;
  }
  if (layer.mirrorMesh) {
    scene.remove(layer.mirrorMesh);
    layer.mirrorMesh.dispose?.();
    layer.mirrorMesh = null;
  }
  for (const key of [
    "secondaryMesh",
    "diagonalMesh",
    "mesh_ppm",
    "mesh_mpm",
    "mesh_pmm",
    "mesh_mmm",
  ]) {
    if (layer[key]) {
      scene.remove(layer[key]);
      layer[key].dispose?.();
      layer[key] = null;
    }
  }
  for (const m of layer.radialOriginals) {
    scene.remove(m);
    m.dispose?.();
  }
  layer.radialOriginals = [];
  for (const m of layer.radialMirrors) {
    scene.remove(m);
    m.dispose?.();
  }
  layer.radialMirrors = [];
}

// Build the source-side + mirror-side primary pair for a layer from raw .spz
// bytes. The pre-reflected mirror bytes are also computed and stashed on the
// layer so download() and slot replacement don't need to redo the mirror math.
async function buildLayerPrimaries(layer, spzBytes, decoded) {
  // Source-side mesh loads straight from the original .spz bytes — Spark
  // decodes through its high-precision native loader (no double quantization).
  layer.originalMesh = await buildSplatMeshFromSpzBytes(spzBytes);
  layer.originalMesh.editable = true;
  layer.originalMesh.edits = [originalClipEdit];
  layer.originalMesh.visible = layer.visible;
  layer.group.add(layer.originalMesh);

  // Mirror-side mesh: re-encode a pre-X-flipped copy of the data and load it
  // through the same path so render quality matches the source.
  layer.mirrorBytes = encodeSpz(mirrorAllSplats(decoded, 0, 0));
  layer.mirrorMesh = await buildSplatMeshFromSpzBytes(layer.mirrorBytes);
  layer.mirrorMesh.editable = true;
  layer.mirrorMesh.edits = [mirrorClipEdit];
  layer.mirrorMesh.matrixAutoUpdate = false;
  layer.mirrorMesh.visible = layer.visible;
  scene.add(layer.mirrorMesh);
}

// Common load path: takes raw .spz bytes and a target layer, decodes once
// for the mirror math, then hands the original bytes to Spark for rendering.
async function loadBytesIntoLayer(layer, bytes, fileName) {
  ui.setStatus(`Decoding ${fileName}…`);
  ui.enableDownload(false);

  const decoded = decodeSpz(bytes);
  layer.fileName = fileName;
  layer.name = fileName.replace(/\.spz$/i, "");
  layer.splat = decoded;

  disposeLayerMeshes(layer);

  ui.setStatus(
    `Building meshes (${decoded.numPoints.toLocaleString()} splats)…`,
  );
  await buildLayerPrimaries(layer, bytes, decoded);
}

// Add a brand-new layer (when the user adds a splat via drag-and-drop or
// the "Add splat" button). Refuses to exceed MAX_LAYERS — callers check
// before calling.
async function addLayerFromBytes(bytes, fileName) {
  if (layers.length >= MAX_LAYERS) {
    ui.setStatus(`At most ${MAX_LAYERS} layers (remove one first)`, true);
    return;
  }
  const layerIdx = layers.length; // 0 for the first one, 1 for the second, etc.
  const layer = createLayer(fileName.replace(/\.spz$/i, ""));
  layers.push(layer);

  await loadBytesIntoLayer(layer, bytes, fileName);

  // Selecting the new layer makes the gizmo jump to it immediately, which
  // is what the user expects after dropping a file in.
  activeLayerId = layer.id;

  if (layerIdx === 0) {
    // First layer: fit the plane visualization + camera to its AABB, AND
    // capture its extent as our auto-offset baseline for subsequent layers.
    fitPlaneBoundsFromData(layer.splat);
    const aabb = computeAabb(layer.splat.positions, layer.splat.numPoints);
    baseLayerExtent = Math.max(
      aabb.maxX - aabb.minX,
      aabb.maxY - aabb.minY,
      aabb.maxZ - aabb.minZ,
      1, // floor so a tiny first splat doesn't make all subsequent layers stack on top
    );
  } else {
    // Auto-offset: slide the new layer over by (idx * baseExtent) along
    // the secondary perpendicular axis so it lands NEXT TO the existing
    // layers instead of on top of them. The user can drag with the gizmo
    // after if they want a different layout — this is just a sensible
    // starting position for "stitched" environments. Each layer still
    // auto-mirrors itself across the same shared plane, so each gets its
    // own reflection.
    const primaryAxisIdx = AXES[ui.state.axis];
    const secAxisIdx = secondaryAxisIdxFor(primaryAxisIdx);
    layer.group.position.setComponent(secAxisIdx, layerIdx * baseLayerExtent);
  }

  syncLayerUI();
  applyUIState(ui.state); // rebuilds octant/radial meshes for the new layer
  updateMirrorTransform();
  ui.setStatus(
    `Loaded ${layer.name} (${layer.splat.numPoints.toLocaleString()} splats)`,
  );
  ui.enableDownload(true);
}

// Replace an existing layer's data (when the user clicks the row's load
// button on a layer that already has data, or drops a file with a layer
// targeted).
async function replaceLayerFromBytes(layerId, bytes, fileName) {
  const layer = findLayer(layerId);
  if (!layer) return;
  await loadBytesIntoLayer(layer, bytes, fileName);
  syncLayerUI();
  applyUIState(ui.state);
  updateMirrorTransform();
  ui.setStatus(
    `Replaced ${layer.name} (${layer.splat.numPoints.toLocaleString()} splats)`,
  );
  ui.enableDownload(true);
}

function removeLayer(layerId) {
  const idx = layers.findIndex((l) => l.id === layerId);
  if (idx === -1) return;
  const layer = layers[idx];
  disposeLayerMeshes(layer);
  // Layer-level resources that aren't part of the mesh tree.
  scene.remove(layer.slotSdfSrc);
  scene.remove(layer.slotSdfMir);
  scene.remove(layer.group);
  layers.splice(idx, 1);

  // If we removed the active one, pick the next sibling (prefer left, then right).
  if (activeLayerId === layerId) {
    if (layers.length === 0) activeLayerId = null;
    else if (idx > 0) activeLayerId = layers[idx - 1].id;
    else activeLayerId = layers[0].id;
  }

  syncLayerUI();
  applyUIState(ui.state);
  updateMirrorTransform();
  ui.enableDownload(layers.some((l) => l.splat));
  if (layers.length === 0) ui.setStatus("All layers cleared");
  else ui.setStatus(`Removed ${layer.name}`);
}

function selectLayer(layerId) {
  if (!findLayer(layerId)) return;
  activeLayerId = layerId;
  syncLayerUI();
  applyUIState(ui.state); // re-attach gizmo to the new active layer
}

function setLayerVisible(layerId, visible) {
  const layer = findLayer(layerId);
  if (!layer) return;
  layer.visible = visible;
  // Re-run the UI-state pipeline so the octant + radial meshes' computed
  // visibility (which AND-s layer.visible with "is this slot active in the
  // current mode") gets refreshed alongside the primary pair.
  applyLayerVisibility(layer);
  applyUIState(ui.state);
  syncLayerUI();
}

function setLayerOpacity(layerId, opacity) {
  const layer = findLayer(layerId);
  if (!layer) return;
  layer.opacity = Math.max(0, Math.min(1, opacity));
  applyLayerOpacity(layer);
  syncLayerUI();
}

function renameLayer(layerId, name) {
  const layer = findLayer(layerId);
  if (!layer) return;
  layer.name = name;
}

// Push the layer's `visible` flag onto the primary pair only. The octant
// and radial extras have a computed visibility (`isWanted && layer.visible`)
// that's reapplied by applyUIState() → applySymmetryMode() / rebuildRadial,
// so we don't touch them here — touching them directly would un-hide an
// octant that the current symmetry mode doesn't want shown.
function applyLayerVisibility(layer) {
  if (layer.originalMesh) layer.originalMesh.visible = layer.visible;
  if (layer.mirrorMesh) layer.mirrorMesh.visible = layer.visible;
}

// Push a layer's `opacity` (0..1) onto every mesh it owns. Spark's SplatMesh
// exposes a built-in `opacity` uniform we just scale uniformly per mesh.
function applyLayerOpacity(layer) {
  const meshes = [
    layer.originalMesh,
    layer.mirrorMesh,
    layer.secondaryMesh,
    layer.diagonalMesh,
    layer.mesh_ppm,
    layer.mesh_mpm,
    layer.mesh_pmm,
    layer.mesh_mmm,
    ...layer.radialOriginals,
    ...layer.radialMirrors,
  ];
  for (const m of meshes) {
    if (m) m.opacity = layer.opacity;
  }
}

// Push the layer list into the UI (rebuilds the row list whenever the
// underlying layer set or active selection changes). Every loaded layer
// is fully visible (with its own mirror), so we never report an
// "offscreen" state any more.
function syncLayerUI() {
  ui.renderLayerList(
    layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      active: l.id === activeLayerId,
      loaded: !!l.splat,
      offscreen: false,
    })),
    { maxLayers: MAX_LAYERS, activeLayerId, hint: null },
  );
}

// Active-layer-only full SH: every mesh on the active (editing) layer
// renders with the .spz's full SH degree; other layers drop to SH=0 (DC
// term only). We lift the cap on EVERY mesh of the active layer (hidden
// ones don't cost anything). Radial copies still always render at SH=0
// because they're inherently low-priority.
function applyActiveLayerSHRule() {
  for (const layer of layers) {
    const cap = layer.id === activeLayerId ? Infinity : 0;
    for (const key of COMPARTMENT_MESH_KEY) {
      if (layer[key]) layer[key].maxSh = cap;
    }
  }
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
  const splatData = splatForFit ?? layers[0]?.splat;
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
// Drop a .spz anywhere on the window to ADD it as a new layer (up to
// MAX_LAYERS). If the cap is hit we show an error in the status line.
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
    await addLayerFromBytes(bytes, file.name);
  } catch (err) {
    console.error(err);
    ui.setStatus(`Failed to load ${file.name}: ${err.message}`, true);
  }
});

// ----- Download -----
// Bakes the symmetry tree the user is currently seeing — one part per
// visible, loaded layer × every compartment in the active symmetry mode
// × the radial rotation count (compartments 0 + 1 only) — and
// concatenates everything into a single .spz. Each layer contributes its
// own full mirror tree, exactly matching the preview.
async function handleDownload() {
  const loaded = layers.filter((l) => l.splat);
  if (loaded.length === 0) return;

  ui.enableDownload(false);
  ui.setStatus("Applying transforms + symmetry, encoding .spz…");
  try {
    const axisIdx = AXES[ui.state.axis];
    const mode = ui.state.symmetryMode;
    const compCount = compartmentCount(mode);
    // Auto-picked perpendicular axes (matches applyUIState's rule).
    const axisIdx2 = axisIdx === 0 ? 2 : 0;
    const axisIdx3 = 3 - axisIdx - axisIdx2;
    const radialCount = Math.max(1, Math.floor(ui.state.radialCount));

    const parts = [];
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    // Helper: bake one part for one layer.
    //   `M_world`  = world matrix to apply (det = +1; already includes
    //                radial rotation + any plane reflections).
    //   `useXFlip` = pre-X-flip the data first (true for odd-parity compartments).
    //   `clips`    = list of [axisIdx, plane, useMirrorSide] half-spaces to AND.
    function bakePart(layer, M_world, useXFlip, clips) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      M_world.decompose(pos, quat, scl);
      const s = (scl.x + scl.y + scl.z) / 3;
      const world = useXFlip
        ? mirrorAllSplats(layer.splat, 0, 0)
        : cloneSplatData(layer.splat);
      applyTransform(
        world,
        M_world.elements,
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

    // Build a per-compartment recipe: how to construct the world matrix
    // (given the layer's group matrix + an optional radial rotation),
    // whether to use the X-flipped data, and which half-spaces to clip
    // against. Compartments outside the current mode return `null` so
    // they're skipped.
    function compartmentRecipe(compIdx, layer, rotMat) {
      const G = layer.group.matrixWorld;
      const biaxial = mode === "biaxial" || mode === "triaxial";
      const triaxial = mode === "triaxial";
      const baseClips0 = [[axisIdx, ui.state.plane, false]]; // src of P1
      const baseClips1 = [[axisIdx, ui.state.plane, true]];  // mirror of P1
      const addBi = (clips, mirrorOfP2) => {
        if (biaxial) clips.push([axisIdx2, 0, mirrorOfP2]);
        return clips;
      };
      const addTri = (clips, mirrorOfP3) => {
        if (triaxial) clips.push([axisIdx3, 0, mirrorOfP3]);
        return clips;
      };
      // Slot clip: hard walls along the secondary axis that match the
      // per-layer slotSdfSrc / slotSdfMir applied in the live preview.
      // `mirrorOfP2` flips which side of the secondary plane the slot
      // sits on (same convention as `addBi`). The slot is centered on
      // the layer's current secondary-axis position (±, depending on
      // the compartment's P2 sign) and is one baseLayerExtent wide.
      const addSlot = (clips, mirrorOfP2) => {
        if (baseLayerExtent <= 0) return clips;
        const layerSecPos = layer.group.position.getComponent(axisIdx2);
        const slotCenter = mirrorOfP2 ? -layerSecPos : layerSecPos;
        const halfW = baseLayerExtent / 2;
        clips.push([axisIdx2, slotCenter - halfW, false]); // keep right of left wall
        clips.push([axisIdx2, slotCenter + halfW, true]);  // keep left of right wall
        return clips;
      };
      const compose = (...mats) => {
        const out = new THREE.Matrix4().copy(mats[0]);
        for (let i = 1; i < mats.length; i++) out.multiply(mats[i]);
        return out;
      };
      // Recipe builder: each compartment has signs (s1, s2, s3) for the
      // primary / secondary / tertiary planes. We call addBi / addTri /
      // addSlot in that order so the per-layer slot clip always lives at
      // the END of the clips array (purely cosmetic — they all MULTIPLY).
      const build = (M, useXFlip, baseClips, s2) => ({
        M,
        useXFlip,
        clips: addSlot(addTri(addBi(baseClips.slice(), s2), false), s2),
      });
      switch (compIdx) {
        case 0: // (+ + +) originalMesh — radial-multiplied
          return build(compose(rotMat, G), false, baseClips0, false);
        case 1: // (- + +) mirrorMesh — radial-multiplied
          return build(
            compose(rotMat, reflectWorld, G, reflectLocal),
            true,
            baseClips1,
            false,
          );
        case 2: // (+ - +) secondaryMesh — biaxial+ only
          if (!biaxial) return null;
          return build(
            compose(reflectWorld2, G, reflectLocal),
            true,
            baseClips0,
            true,
          );
        case 3: // (- - +) diagonalMesh — biaxial+ only
          if (!biaxial) return null;
          return build(
            compose(reflectWorld, reflectWorld2, G),
            false,
            baseClips1,
            true,
          );
        case 4: // (+ + -) mesh_ppm — triaxial only
          if (!triaxial) return null;
          return {
            M: compose(reflectWorld3, G, reflectLocal),
            useXFlip: true,
            clips: addSlot(addTri(addBi(baseClips0.slice(), false), true), false),
          };
        case 5: // (- + -) mesh_mpm — triaxial only
          if (!triaxial) return null;
          return {
            M: compose(reflectWorld, reflectWorld3, G),
            useXFlip: false,
            clips: addSlot(addTri(addBi(baseClips1.slice(), false), true), false),
          };
        case 6: // (+ - -) mesh_pmm — triaxial only
          if (!triaxial) return null;
          return {
            M: compose(reflectWorld2, reflectWorld3, G),
            useXFlip: false,
            clips: addSlot(addTri(addBi(baseClips0.slice(), true), true), true),
          };
        case 7: // (- - -) mesh_mmm — triaxial only (point inversion)
          if (!triaxial) return null;
          return {
            M: compose(reflectWorld, reflectWorld2, reflectWorld3, G, reflectLocal),
            useXFlip: true,
            clips: addSlot(addTri(addBi(baseClips1.slice(), true), true), true),
          };
      }
      return null;
    }

    const rotMat = new THREE.Matrix4();
    const rotQuat = new THREE.Quaternion();

    for (const layer of loaded) {
      if (!layer.visible) continue; // hidden layers contribute nothing
      layer.group.updateMatrixWorld(true);

      // Warn once if a layer has non-uniform scale (download approximates it).
      const sclTmp = new THREE.Vector3();
      const posTmp = new THREE.Vector3();
      const quatTmp = new THREE.Quaternion();
      layer.group.matrixWorld.decompose(posTmp, quatTmp, sclTmp);
      const scaleSpread =
        Math.max(sclTmp.x, sclTmp.y, sclTmp.z) /
        Math.min(sclTmp.x, sclTmp.y, sclTmp.z);
      if (scaleSpread > 1.001) {
        ui.setStatus(
          `Note: non-uniform scale on ${layer.name} — download uses the average.`,
        );
      }

      for (let comp = 0; comp < compCount; comp++) {
        // Every layer bakes every compartment of the active mode — that
        // mirrors the live preview, where each layer fully auto-mirrors.

        // Compartments 0 and 1 (primary pair) get the radial multiplication.
        // The extras (2..7) are baked once — matches the preview, where
        // radial copies are only spawned for the primary pair.
        const radialReps = comp <= 1 ? radialCount : 1;
        for (let i = 0; i < radialReps; i++) {
          const angle = (i * 2 * Math.PI) / radialCount;
          rotQuat.setFromAxisAngle(Y_AXIS, angle);
          rotMat.makeRotationFromQuaternion(rotQuat);
          // Extras use identity rotation — no radial multiplication, but
          // we still need a matrix to pass to compose().
          const r = comp <= 1 ? rotMat : new THREE.Matrix4(); // identity
          const recipe = compartmentRecipe(comp, layer, r);
          if (!recipe) continue;
          parts.push(bakePart(layer, recipe.M, recipe.useXFlip, recipe.clips));
        }
      }
    }

    const mirroredData = concatSplats(parts);
    const bytes = encodeSpz(mirroredData);
    const visibleLoaded = loaded.filter((l) => l.visible);
    const baseName =
      visibleLoaded.length === 1
        ? visibleLoaded[0].fileName.replace(/\.spz$/i, "")
        : "splat-mirror";
    // Filename suffix reflects what was baked in.
    const suffixBits = [];
    if (visibleLoaded.length > 1)
      suffixBits.push(`${visibleLoaded.length}layers`);
    if (mode === "triaxial") suffixBits.push("triaxial");
    else if (mode === "biaxial") suffixBits.push("biaxial");
    if (radialCount > 1) suffixBits.push(`radial${radialCount}`);
    const suffix = suffixBits.length
      ? `-${suffixBits.join("-")}`
      : "-mirrored";
    const downloadName = `${baseName}${suffix}.spz`;
    await saveSpzFile(bytes, downloadName);
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
loadSpzFromUrl("./mystical-forest.spz").catch((err) => {
  console.error(err);
  ui.setStatus("Drag a .spz file onto the window to get started.", true);
});
