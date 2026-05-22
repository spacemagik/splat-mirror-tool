// Mirror math for Gaussian splats across an axis-aligned world plane.
//
// Given a plane with normal along one of the world axes (X, Y, or Z) at offset `d`,
// the reflection of a point p is: p' = p - 2 * ((p · n) - d) * n
// For axis-aligned planes this collapses to negating one coordinate around `d`:
//   X-axis plane (normal = X): x' = 2d - x, y' = y, z' = z
//
// For a Gaussian splat (oriented ellipsoid), we also need to reflect its rotation
// so the ellipsoid orientation matches. The new covariance must satisfy
// M R(q) S^2 R(q)^T M = R(q') S^2 R(q')^T, which is solved by R(q') = M R(q) D
// where D is the same diagonal-sign reflection (chosen so det(M R D) = +1, i.e.
// proper rotation). Translating to quaternion components (x, y, z, w):
//
//   X-axis (negate X): (x, y, z, w) -> ( x, -y, -z,  w)
//   Y-axis (negate Y): (x, y, z, w) -> (-x,  y, -z,  w)
//   Z-axis (negate Z): (x, y, z, w) -> (-x, -y,  z,  w)
//
// Rule of thumb: flip the two components PERPENDICULAR to the mirror axis,
// keep w unchanged. (Negating w gives the inverse rotation — a different rotation
// from the one we want — so it must NOT be flipped.)
//
// Scales (log-space std-devs along splat-local axes): UNCHANGED.
// Alpha / opacity: UNCHANGED.
// Color (SH band 0): UNCHANGED.
// Spherical harmonics bands 1+: sign-flipped for basis functions odd in the mirror axis.

export const AXES = { x: 0, y: 1, z: 2 };

// Sign flips for SH coefficients (bands 1-3) under each axis reflection.
// Order matches spz on-disk: 15 coefficients of degree 1+2+3 per channel, R then G then B... actually
// spz stores 3*(numShBasis) coefficients per point where numShBasis = SH count - 1 (band 0 excluded).
// For degree 1: 3 basis functions (Y_{1,-1}, Y_{1,0}, Y_{1,1}) = 3 per channel × 3 channels = 9 coeffs
// For degree 2: + 5 basis = 8 per channel × 3 channels = 24 coeffs
// For degree 3: + 7 basis = 15 per channel × 3 channels = 45 coeffs
//
// Real SH basis sign behavior under axis reflection (standard derivation):
//   Band 1: Y_{1,-1}(y), Y_{1,0}(z), Y_{1,1}(x)  -> flip if axis matches
//   Band 2: Y_{2,-2}(xy), Y_{2,-1}(yz), Y_{2,0}(z^2-...), Y_{2,1}(xz), Y_{2,2}(x^2-y^2)
//           For X-axis flip: xy -> -xy, yz -> yz, z^2 -> z^2, xz -> -xz, x^2-y^2 -> x^2-y^2
//           Flips: (yes, no, no, yes, no)
//   Band 3: 7 functions -> see table below
//
// Table: 1 = no flip, -1 = flip sign

// per-basis sign flip when reflecting in {X, Y, Z}
// Order: [Y_{1,-1}, Y_{1,0}, Y_{1,1}, Y_{2,-2}, Y_{2,-1}, Y_{2,0}, Y_{2,1}, Y_{2,2},
//         Y_{3,-3}, Y_{3,-2}, Y_{3,-1}, Y_{3,0}, Y_{3,1}, Y_{3,2}, Y_{3,3}]
const SH_FLIP_X = [
  // band 1: basis ~ (y, z, x)
  1, 1, -1,
  // band 2: ~ (xy, yz, 3z^2-r^2, xz, x^2-y^2)
  -1, 1, 1, -1, 1,
  // band 3: ~ (y(3x^2-y^2), xyz, y(5z^2-r^2), z(5z^2-3r^2), x(5z^2-r^2), z(x^2-y^2), x(x^2-3y^2))
  -1, -1, 1, 1, -1, 1, -1,
];

const SH_FLIP_Y = [
  // band 1: basis ~ (y, z, x)
  -1, 1, 1,
  // band 2: ~ (xy, yz, 3z^2-r^2, xz, x^2-y^2)
  -1, -1, 1, 1, 1,
  // band 3: ~ (y(3x^2-y^2), xyz, y(5z^2-r^2), z(5z^2-3r^2), x(5z^2-r^2), z(x^2-y^2), x(x^2-3y^2))
  -1, -1, -1, 1, 1, 1, 1,
];

const SH_FLIP_Z = [
  // band 1: basis ~ (y, z, x)
  1, -1, 1,
  // band 2: ~ (xy, yz, 3z^2-r^2, xz, x^2-y^2)
  1, -1, 1, -1, 1,
  // band 3: ~ (y(3x^2-y^2), xyz, y(5z^2-r^2), z(5z^2-3r^2), x(5z^2-r^2), z(x^2-y^2), x(x^2-3y^2))
  1, -1, 1, -1, 1, -1, 1,
];

const SH_FLIPS = { 0: SH_FLIP_X, 1: SH_FLIP_Y, 2: SH_FLIP_Z };

// Number of SH coefficients per channel (excluding band 0)
const SH_PER_CHANNEL = { 0: 0, 1: 3, 2: 8, 3: 15 };

/**
 * Reflect a single splat across an axis-aligned world plane.
 *
 * @param {object} splat  source decoded splat data (output from decodeSpz)
 * @param {number} index  index of the splat to reflect
 * @param {object} outBuffers  parallel output arrays (same field names)
 * @param {number} outIndex  index in output arrays
 * @param {number} axis  0=X, 1=Y, 2=Z
 * @param {number} d  plane offset along that axis (world units)
 */
export function reflectSplat(splat, index, outBuffers, outIndex, axis, d) {
  // Position
  const p3 = index * 3;
  const o3 = outIndex * 3;
  const px = splat.positions[p3 + 0];
  const py = splat.positions[p3 + 1];
  const pz = splat.positions[p3 + 2];
  outBuffers.positions[o3 + 0] = axis === 0 ? 2 * d - px : px;
  outBuffers.positions[o3 + 1] = axis === 1 ? 2 * d - py : py;
  outBuffers.positions[o3 + 2] = axis === 2 ? 2 * d - pz : pz;

  // Alpha (unchanged)
  outBuffers.alphas[outIndex] = splat.alphas[index];

  // Colors (SH band 0, unchanged)
  outBuffers.colors[o3 + 0] = splat.colors[p3 + 0];
  outBuffers.colors[o3 + 1] = splat.colors[p3 + 1];
  outBuffers.colors[o3 + 2] = splat.colors[p3 + 2];
  if (outBuffers.rawColors) {
    outBuffers.rawColors[o3 + 0] = splat.rawColors[p3 + 0];
    outBuffers.rawColors[o3 + 1] = splat.rawColors[p3 + 1];
    outBuffers.rawColors[o3 + 2] = splat.rawColors[p3 + 2];
  }

  // Scales (unchanged — scales are along splat-local axes which rotate with the quat)
  outBuffers.scales[o3 + 0] = splat.scales[p3 + 0];
  outBuffers.scales[o3 + 1] = splat.scales[p3 + 1];
  outBuffers.scales[o3 + 2] = splat.scales[p3 + 2];

  // Rotation
  const r4 = index * 4;
  const o4 = outIndex * 4;
  const qx = splat.rotations[r4 + 0];
  const qy = splat.rotations[r4 + 1];
  const qz = splat.rotations[r4 + 2];
  const qw = splat.rotations[r4 + 3];
  // For axis-aligned reflection: flip the two components perpendicular to the
  // mirror axis. KEEP w (the scalar part) — negating w gives the INVERSE rotation,
  // which is a different rotation from what we want.
  let nx, ny, nz, nw;
  if (axis === 0) {
    nx = qx;
    ny = -qy;
    nz = -qz;
    nw = qw;
  } else if (axis === 1) {
    nx = -qx;
    ny = qy;
    nz = -qz;
    nw = qw;
  } else {
    nx = -qx;
    ny = -qy;
    nz = qz;
    nw = qw;
  }
  // Normalize defensively
  const ln = Math.hypot(nx, ny, nz, nw) || 1;
  outBuffers.rotations[o4 + 0] = nx / ln;
  outBuffers.rotations[o4 + 1] = ny / ln;
  outBuffers.rotations[o4 + 2] = nz / ln;
  outBuffers.rotations[o4 + 3] = nw / ln;

  // Spherical harmonics (bands 1+): sign-flip per basis
  if (splat.sh && outBuffers.sh && splat.shCoeffsPerPoint > 0) {
    const flips = SH_FLIPS[axis];
    const perChannel = SH_PER_CHANNEL[splat.shDegree];
    const totalPerPoint = splat.shCoeffsPerPoint; // = perChannel * 3
    const inBase = index * totalPerPoint;
    const outBase = outIndex * totalPerPoint;
    // spz stores SH as: for each basis index b, three channel values (R, G, B) interleaved
    for (let b = 0; b < perChannel; b++) {
      const flip = flips[b];
      for (let c = 0; c < 3; c++) {
        const off = b * 3 + c;
        outBuffers.sh[outBase + off] = flip * splat.sh[inBase + off];
      }
    }
  }
}

/**
 * Determine if a splat is on the "source" side of the symmetry plane (i.e. should be mirrored).
 *
 * @param {object} splat  source decoded splat data
 * @param {number} index  index of the splat
 * @param {number} axis  0=X, 1=Y, 2=Z
 * @param {number} d  plane offset
 * @param {boolean} flipSide  if true, source is negative side; else positive side
 * @returns {boolean}
 */
export function isOnSourceSide(splat, index, axis, d, flipSide) {
  const v = splat.positions[index * 3 + axis];
  return flipSide ? v < d : v > d;
}

/**
 * Reflect EVERY splat across an axis-aligned local plane (no clipping).
 * Used to build a "mirror twin" copy of the entire splat at load time, which
 * we then render through a parent transform that places it on the right side
 * of whatever world plane the user has set.
 *
 * @param {object} splat  decoded source splat
 * @param {number} axis   0=X, 1=Y, 2=Z (local axis to flip)
 * @param {number} d      plane offset in local space (usually 0)
 * @returns {object} new splat data with every splat reflected
 */
export function mirrorAllSplats(splat, axis, d = 0) {
  const total = splat.numPoints;
  const out = {
    version: splat.version,
    numPoints: total,
    shDegree: splat.shDegree,
    fractionalBits: splat.fractionalBits,
    antialiased: splat.antialiased,
    positions: new Float32Array(total * 3),
    alphas: new Float32Array(total),
    rawColors: splat.rawColors ? new Uint8Array(total * 3) : null,
    colors: new Float32Array(total * 3),
    scales: new Float32Array(total * 3),
    rotations: new Float32Array(total * 4),
    sh:
      splat.sh && splat.shCoeffsPerPoint > 0
        ? new Float32Array(total * splat.shCoeffsPerPoint)
        : null,
    shCoeffsPerPoint: splat.shCoeffsPerPoint,
  };
  for (let i = 0; i < total; i++) {
    reflectSplat(splat, i, out, i, axis, d);
  }
  return out;
}

/**
 * Build the full mirrored splat dataset: original splats on the source side,
 * each followed by its mirrored twin.
 *
 * The original splats on the *destination* side are dropped (replaced by mirrors).
 *
 * @param {object} splat  decoded source splat
 * @param {number} axis   0=X, 1=Y, 2=Z
 * @param {number} d      plane offset
 * @param {boolean} flipSide  if true, mirror the negative side to positive (default: positive to negative)
 * @returns {object} new splat data in the same shape as decodeSpz output
 */
export function buildMirroredSplat(splat, axis, d, flipSide = false) {
  // Pass 1: count source-side splats
  let sourceCount = 0;
  for (let i = 0; i < splat.numPoints; i++) {
    if (isOnSourceSide(splat, i, axis, d, flipSide)) sourceCount++;
  }

  const total = sourceCount * 2;
  const out = {
    version: splat.version,
    numPoints: total,
    shDegree: splat.shDegree,
    fractionalBits: splat.fractionalBits,
    antialiased: splat.antialiased,
    positions: new Float32Array(total * 3),
    alphas: new Float32Array(total),
    rawColors: new Uint8Array(total * 3),
    colors: new Float32Array(total * 3),
    scales: new Float32Array(total * 3),
    rotations: new Float32Array(total * 4),
    sh: splat.sh ? new Float32Array(total * splat.shCoeffsPerPoint) : null,
    shQuantBytes: splat.shQuantBytes
      ? new Uint8Array(total * splat.shCoeffsPerPoint)
      : null,
    shCoeffsPerPoint: splat.shCoeffsPerPoint,
  };

  // Pass 2: copy source-side splats, then write their mirrored twins
  let w = 0;
  for (let i = 0; i < splat.numPoints; i++) {
    if (!isOnSourceSide(splat, i, axis, d, flipSide)) continue;
    // Original copy
    copySplat(splat, i, out, w);
    w++;
  }
  // Now write the mirrored twins
  let twinIdx = 0;
  for (let i = 0; i < splat.numPoints; i++) {
    if (!isOnSourceSide(splat, i, axis, d, flipSide)) continue;
    reflectSplat(splat, i, out, sourceCount + twinIdx, axis, d);
    twinIdx++;
  }

  return out;
}

function copySplat(splat, i, out, j) {
  const i3 = i * 3,
    j3 = j * 3,
    i4 = i * 4,
    j4 = j * 4;
  out.positions[j3 + 0] = splat.positions[i3 + 0];
  out.positions[j3 + 1] = splat.positions[i3 + 1];
  out.positions[j3 + 2] = splat.positions[i3 + 2];
  out.alphas[j] = splat.alphas[i];
  out.rawColors[j3 + 0] = splat.rawColors[i3 + 0];
  out.rawColors[j3 + 1] = splat.rawColors[i3 + 1];
  out.rawColors[j3 + 2] = splat.rawColors[i3 + 2];
  out.colors[j3 + 0] = splat.colors[i3 + 0];
  out.colors[j3 + 1] = splat.colors[i3 + 1];
  out.colors[j3 + 2] = splat.colors[i3 + 2];
  out.scales[j3 + 0] = splat.scales[i3 + 0];
  out.scales[j3 + 1] = splat.scales[i3 + 1];
  out.scales[j3 + 2] = splat.scales[i3 + 2];
  out.rotations[j4 + 0] = splat.rotations[i4 + 0];
  out.rotations[j4 + 1] = splat.rotations[i4 + 1];
  out.rotations[j4 + 2] = splat.rotations[i4 + 2];
  out.rotations[j4 + 3] = splat.rotations[i4 + 3];
  if (out.sh && splat.sh) {
    const n = splat.shCoeffsPerPoint;
    for (let k = 0; k < n; k++) {
      out.sh[j * n + k] = splat.sh[i * n + k];
    }
  }
}

/**
 * Concatenate multiple decoded splats (same shDegree / shCoeffsPerPoint) into
 * one. All typed arrays are joined; numPoints becomes the sum.
 *
 * Used by the download path to merge per-wedge mirrored outputs into a single
 * .spz when radial symmetry is active.
 *
 * @param {object[]} parts  array of decoded splats with matching schema
 * @returns {object} merged splat
 */
export function concatSplats(parts) {
  if (parts.length === 0) throw new Error("concatSplats: no parts");
  if (parts.length === 1) return parts[0];

  const first = parts[0];
  let total = 0;
  for (const p of parts) total += p.numPoints;

  const hasSh = first.sh != null && first.shCoeffsPerPoint > 0;
  const out = {
    version: first.version,
    numPoints: total,
    shDegree: first.shDegree,
    fractionalBits: first.fractionalBits,
    antialiased: first.antialiased,
    positions: new Float32Array(total * 3),
    alphas: new Float32Array(total),
    rawColors: new Uint8Array(total * 3),
    colors: new Float32Array(total * 3),
    scales: new Float32Array(total * 3),
    rotations: new Float32Array(total * 4),
    sh: hasSh ? new Float32Array(total * first.shCoeffsPerPoint) : null,
    shCoeffsPerPoint: first.shCoeffsPerPoint,
  };

  let offset = 0;
  for (const p of parts) {
    out.positions.set(p.positions, offset * 3);
    out.alphas.set(p.alphas, offset);
    if (p.rawColors) out.rawColors.set(p.rawColors, offset * 3);
    out.colors.set(p.colors, offset * 3);
    out.scales.set(p.scales, offset * 3);
    out.rotations.set(p.rotations, offset * 4);
    if (out.sh && p.sh) {
      out.sh.set(p.sh, offset * first.shCoeffsPerPoint);
    }
    offset += p.numPoints;
  }
  return out;
}

/**
 * Apply a 4x4 transform (THREE.Matrix4 elements) to every position in-place.
 * Also rotates each quaternion by the rotational component of the transform.
 * Note: this assumes the transform is a rigid-body transform (rotation + translation, no scale).
 *
 * @param {object} splat  decoded splat
 * @param {number[]} m16  4x4 matrix in column-major (THREE.Matrix4.elements format)
 * @param {Float32Array} [outQuat]  optional rotation as quaternion (x,y,z,w) — if supplied,
 *                                  used directly for rotating splat quaternions (faster than
 *                                  extracting from m16). Translation is taken from m16.
 */
export function applyTransform(splat, m16, outQuat) {
  // Extract translation
  const tx = m16[12],
    ty = m16[13],
    tz = m16[14];
  // Extract rotation as quaternion either from input or by decomposing the rotation part of m16
  let rx, ry, rz, rw;
  if (outQuat) {
    rx = outQuat[0];
    ry = outQuat[1];
    rz = outQuat[2];
    rw = outQuat[3];
  } else {
    // Decompose: m16's upper-left 3x3 is the rotation
    const trace = m16[0] + m16[5] + m16[10];
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      rw = 0.25 / s;
      rx = (m16[6] - m16[9]) * s;
      ry = (m16[8] - m16[2]) * s;
      rz = (m16[1] - m16[4]) * s;
    } else if (m16[0] > m16[5] && m16[0] > m16[10]) {
      const s = 2 * Math.sqrt(1 + m16[0] - m16[5] - m16[10]);
      rw = (m16[6] - m16[9]) / s;
      rx = 0.25 * s;
      ry = (m16[4] + m16[1]) / s;
      rz = (m16[8] + m16[2]) / s;
    } else if (m16[5] > m16[10]) {
      const s = 2 * Math.sqrt(1 + m16[5] - m16[0] - m16[10]);
      rw = (m16[8] - m16[2]) / s;
      rx = (m16[4] + m16[1]) / s;
      ry = 0.25 * s;
      rz = (m16[9] + m16[6]) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m16[10] - m16[0] - m16[5]);
      rw = (m16[1] - m16[4]) / s;
      rx = (m16[8] + m16[2]) / s;
      ry = (m16[9] + m16[6]) / s;
      rz = 0.25 * s;
    }
  }

  // Apply to every position: p' = R * p + t
  const n = splat.numPoints;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const px = splat.positions[i3 + 0];
    const py = splat.positions[i3 + 1];
    const pz = splat.positions[i3 + 2];
    // Rotate by quaternion (rx,ry,rz,rw)
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const cx = ry * pz - rz * py;
    const cy = rz * px - rx * pz;
    const cz = rx * py - ry * px;
    const wcx = cx + rw * px;
    const wcy = cy + rw * py;
    const wcz = cz + rw * pz;
    const cx2 = ry * wcz - rz * wcy;
    const cy2 = rz * wcx - rx * wcz;
    const cz2 = rx * wcy - ry * wcx;
    splat.positions[i3 + 0] = px + 2 * cx2 + tx;
    splat.positions[i3 + 1] = py + 2 * cy2 + ty;
    splat.positions[i3 + 2] = pz + 2 * cz2 + tz;

    // Compose quaternions: q' = r * q
    const i4 = i * 4;
    const qx = splat.rotations[i4 + 0];
    const qy = splat.rotations[i4 + 1];
    const qz = splat.rotations[i4 + 2];
    const qw = splat.rotations[i4 + 3];
    splat.rotations[i4 + 0] = rw * qx + rx * qw + ry * qz - rz * qy;
    splat.rotations[i4 + 1] = rw * qy - rx * qz + ry * qw + rz * qx;
    splat.rotations[i4 + 2] = rw * qz + rx * qy - ry * qx + rz * qw;
    splat.rotations[i4 + 3] = rw * qw - rx * qx - ry * qy - rz * qz;
  }
}
