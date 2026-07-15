# Splat Mirror

A browser-based tool for mirroring [Gaussian splat](https://en.wikipedia.org/wiki/Gaussian_splatting) scenes in real time. Drop in a `.spz` file, position the mirror plane, and export a new `.spz` that matches exactly what you see in the preview.

**[Try it live →](https://splat-mirror-tool.netlify.app)** (also mirrored on [GitHub Pages](https://spacemagik.github.io/splat-mirror-tool/))

---

## Features

- **Live mirror preview** — the reflected splat updates instantly as you drag the plane slider
- **Adjustable symmetry axis** — mirror across X, Y, or Z
- **Movable mirror plane** — slide the plane anywhere along the chosen axis
- **Flip side** — swap which half is treated as the source vs. mirror
- **Soft edge** — feather the boundary between original and mirrored halves
- **Biaxial symmetry** — two perpendicular mirror planes → 4 quadrants
- **Triaxial symmetry** — three perpendicular planes → 8 octants (fully point-symmetric)
- **Radial copies** — duplicate the scene with rotational symmetry around the Y axis (kaleidoscope mode)
- **Multi-layer** — load up to 4 `.spz` files simultaneously; each mirrors independently
- **Gizmo** — translate, rotate, and scale any layer with a 3D transform handle
- **Fly camera** — WASD + mouse-look mode for navigating large scenes
- **Export** — bakes every visible layer + symmetry tree into a single `.spz` file

---

## Usage

### Online (GitHub Pages)

Open the live link above in any modern browser — no install required.

### Local

```bash
git clone https://github.com/spacemagik/splat-mirror-tool.git
cd splat-mirror-tool
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

> **Note:** The first time the page loads it will reload once automatically. This is the `coi-serviceworker` registering itself to enable `SharedArrayBuffer`, which the Spark renderer requires. It only happens on the first visit (or after clearing site data).

---

## Controls

| Action | How |
|---|---|
| Load a splat | Drag a `.spz` onto the window, or click **+ Add splat** in the panel |
| Mirror axis | X / Y / Z buttons under **Symmetry axis** |
| Move the plane | **Plane position** slider or numeric input |
| Soft fade | **Edge softness** slider (or click **Auto** to match the splat's size) |
| Symmetry mode | **Single / Biaxial / Triaxial** buttons |
| Radial copies | **Radial copies** slider (1 = off, 2–12 = kaleidoscope) |
| Move/rotate/scale a layer | Select the layer, then choose a **Gizmo** mode |
| Fly camera | Switch to **Fly** under Camera; use `W A S D` + mouse drag |
| Download | Click **Download mirrored .spz** (bottom right) |

---

## How it works

Each loaded `.spz` gets two `SplatMesh` objects from the [Spark](https://sparkjs.dev) renderer:

1. **Original mesh** — displays splats on the source side of the plane
2. **Mirror mesh** — displays a pre-X-flipped copy on the reflected side

The mirror mesh's world matrix is computed every frame:

```
T_mirror = Reflect_world × T_gizmo × Reflect_local
```

`Reflect_local` is baked into the mirror data once at load time (X-axis flip of positions + rotation quaternion). `Reflect_world` is the world-space reflection across the current plane. The two flips cancel (determinant = +1), giving a proper rotation that Spark renders correctly at full quality.

When you click **Download**, the same transform math is applied to the raw splat data and everything is re-encoded into a single `.spz` via [fflate](https://github.com/101arrowz/fflate).

---

## File format

The tool reads and writes Niantic's `.spz` format — a gzip-compressed binary containing:

- File header (magic, version, point count, SH degree)
- Per-splat positions (float16 in v1, 24-bit fixed-point in v2)
- Alpha, base color, scale, rotation (quantized bytes)
- Spherical harmonics coefficients (optional, for view-dependent color)

---

## Tech stack

| Library | Version | Purpose |
|---|---|---|
| [Three.js](https://threejs.org) | 0.180 | Scene graph, camera, renderer base |
| [@sparkjsdev/spark](https://sparkjs.dev) | 2.1 | Gaussian splat renderer |
| [fflate](https://github.com/101arrowz/fflate) | 0.8 | gzip decode/encode for `.spz` |
| [Vite](https://vitejs.dev) | 6 | Dev server + build tool |

All runtime dependencies are loaded from CDN via an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) — no bundling needed to run the source.

---

## Deploying your own copy

### GitHub Pages (automatic)

1. Fork this repository
2. Go to **Settings → Pages → Source** and choose **GitHub Actions**
3. Push to `main` — the workflow in `.github/workflows/deploy.yml` builds and deploys automatically

### Netlify / Vercel

Both platforms support custom response headers, so `coi-serviceworker` is technically optional (the server-side COOP/COEP headers in `vite.config.js` handle isolation). Just connect your repo and deploy.

### Self-hosted

```bash
npm run build      # outputs to dist/
```

Serve `dist/` from any static file server. If you're not using `coi-serviceworker`, make sure your server sets:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## License

MIT
