// .spz encoder
// Mirror of spz-decode.js. Takes a splat data object (with float arrays) and
// produces a gzip-compressed .spz binary.
//
// Format: gzip(header || positions || alphas || colors || scales || rotations || sh)

import { gzipSync } from "fflate";
import { SPZ_MAGIC } from "./spz-decode.js";

const SH_COEFFS_PER_DEGREE = { 0: 0, 1: 9, 2: 24, 3: 45 };

/**
 * @param {object} splat   data shaped like decodeSpz output
 * @param {object} [opts]
 * @param {number} [opts.fractionalBits]  override (default: input's fractionalBits)
 * @returns {Uint8Array}  gzip-compressed .spz file bytes
 */
export function encodeSpz(splat, opts = {}) {
  const fractionalBits = opts.fractionalBits ?? splat.fractionalBits ?? 12;
  const shDegree = splat.shDegree ?? 0;
  const shCoeffsPerPoint = SH_COEFFS_PER_DEGREE[shDegree] ?? 0;
  const numPoints = splat.numPoints;
  const antialiased = splat.antialiased ?? false;

  const positionBytes = numPoints * 9;
  const alphaBytes = numPoints * 1;
  const colorBytes = numPoints * 3;
  const scaleBytes = numPoints * 3;
  const rotationBytes = numPoints * 3;
  const shBytes = numPoints * shCoeffsPerPoint;
  const totalBytes =
    16 + positionBytes + alphaBytes + colorBytes + scaleBytes + rotationBytes + shBytes;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);

  // Header
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, 2, true); // version 2
  view.setUint32(8, numPoints, true);
  out[12] = shDegree;
  out[13] = fractionalBits;
  out[14] = antialiased ? 1 : 0;
  out[15] = 0;

  let cursor = 16;
  const scale = 1 << fractionalBits;

  // Positions: 3 int24 little-endian per point
  for (let i = 0; i < numPoints; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.round(splat.positions[i * 3 + c] * scale);
      // Clamp to int24 range
      const clamped = Math.max(-(1 << 23), Math.min((1 << 23) - 1, v));
      const u24 = clamped & 0xffffff;
      out[cursor++] = u24 & 0xff;
      out[cursor++] = (u24 >> 8) & 0xff;
      out[cursor++] = (u24 >> 16) & 0xff;
    }
  }

  // Alphas: byte = round(alpha * 255)
  for (let i = 0; i < numPoints; i++) {
    out[cursor++] = clampByte(Math.round(splat.alphas[i] * 255));
  }

  // Colors: round-trip via rawColors if available, else re-encode from `colors` (band-0 SH form)
  if (splat.rawColors && splat.rawColors.length === numPoints * 3) {
    out.set(splat.rawColors, cursor);
    cursor += colorBytes;
  } else {
    for (let i = 0; i < numPoints * 3; i++) {
      // colors[] are in SH-band-0 form (centered ~0). Reverse: byte = (col * 0.15 + 0.5) * 255
      out[cursor++] = clampByte(Math.round((splat.colors[i] * 0.15 + 0.5) * 255));
    }
  }

  // Scales: stored as ln(stddev), so byte = (ln(linearScale) + 10) * 16
  for (let i = 0; i < numPoints * 3; i++) {
    const s = splat.scales[i];
    const ln = s > 0 ? Math.log(s) : -10; // guard against 0/negative
    out[cursor++] = clampByte(Math.round((ln + 10) * 16));
  }

  // Rotations: store the 3 imaginary components, byte = (q + 1) * 127.5
  // Ensure w >= 0 by negating the quaternion if w < 0 (q and -q represent the same rotation).
  for (let i = 0; i < numPoints; i++) {
    let x = splat.rotations[i * 4 + 0];
    let y = splat.rotations[i * 4 + 1];
    let z = splat.rotations[i * 4 + 2];
    let w = splat.rotations[i * 4 + 3];
    if (w < 0) {
      x = -x;
      y = -y;
      z = -z;
      w = -w;
    }
    out[cursor++] = clampByte(Math.round(x * 127.5 + 127.5));
    out[cursor++] = clampByte(Math.round(y * 127.5 + 127.5));
    out[cursor++] = clampByte(Math.round(z * 127.5 + 127.5));
  }

  // Spherical harmonics: byte = round(sh * 128 + 128)
  if (shCoeffsPerPoint > 0 && splat.sh) {
    for (let i = 0; i < numPoints * shCoeffsPerPoint; i++) {
      out[cursor++] = clampByte(Math.round(splat.sh[i] * 128 + 128));
    }
  } else if (shCoeffsPerPoint > 0) {
    // Zero-fill if SH expected but missing
    cursor += shBytes;
  }

  // Gzip
  return gzipSync(out, { level: 6 });
}

function clampByte(v) {
  return Math.max(0, Math.min(255, v | 0));
}
