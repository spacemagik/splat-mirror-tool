// .spz decoder
// Format reference: https://github.com/nianticlabs/spz
//
// File layout: gzip(header || data)
// Header (16 bytes, little-endian):
//   uint32 magic      = 0x5053474e ("NGSP")
//   uint32 version    = 2  (or 1; we support both for read)
//   uint32 numPoints
//   uint8  shDegree   (0, 1, 2, or 3)
//   uint8  fractionalBits  (positions are fixed-point with this many fractional bits)
//   uint8  flags      (bit 0: antialiased)
//   uint8  reserved
// Data sections (each numPoints * sizePerPoint, contiguous):
//   positions: 9 bytes per point (3 * int24 little-endian, scaled by 1<<fractionalBits)
//   alphas:    1 byte per point (sigmoid-encoded: value = sigmoid(alpha_raw / 255 * scale - bias) ... actually plain uint8 -> alpha = byte/255)
//   colors:    3 bytes per point (uint8 each; SH band-0 component encoded as (color - 0.5) * SH_C0 * 255 + 127.5 in spz v2)
//   scales:    3 bytes per point (uint8 each; log-scale encoded: scale = (byte/255)*scaleRange - scaleOffset; commonly byte/16 - 10)
//   rotations: 3 bytes per point (smallest-three quaternion encoding)
//   sh:        numShCoefficients * numPoints bytes (uint8 each, centered at 128, scaled by sphericalHarmonicsQuantizationFactor)
//
// Returns a struct with raw, decoded-to-float arrays ready for math.

import { gunzipSync } from "fflate";

export const SPZ_MAGIC = 0x5053474e; // "NGSP" little-endian
export const SH_C0 = 0.28209479177387814; // Y_0^0 spherical harmonic constant

const SH_COEFFS_PER_DEGREE = { 0: 0, 1: 9, 2: 24, 3: 45 };

/**
 * @param {ArrayBuffer|Uint8Array} buffer  raw bytes of .spz file (gzip-compressed)
 * @returns {{
 *   numPoints: number,
 *   shDegree: number,
 *   fractionalBits: number,
 *   antialiased: boolean,
 *   positions: Float32Array,    // length = numPoints * 3, world units
 *   alphas: Float32Array,       // length = numPoints, in [0,1]
 *   colors: Float32Array,       // length = numPoints * 3, in [0,1] (linear, base SH band-0 contribution)
 *   scales: Float32Array,       // length = numPoints * 3, log-scale (e^scale = world-space sigma)
 *   rotations: Float32Array,    // length = numPoints * 4, quaternion (x, y, z, w), normalized
 *   sh: Float32Array | null,    // length = numPoints * numShCoefficients, centered around 0
 * }}
 */
export function decodeSpz(buffer) {
  const compressed =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const raw = gunzipSync(compressed);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== SPZ_MAGIC) {
    throw new Error(
      `Not an .spz file (magic 0x${magic.toString(16)} expected 0x${SPZ_MAGIC.toString(16)})`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported .spz version ${version}`);
  }
  const numPoints = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  const flags = view.getUint8(14);
  const antialiased = (flags & 1) !== 0;

  const shCoeffsPerPoint = SH_COEFFS_PER_DEGREE[shDegree] ?? 0;
  const scaleFactor = 1 / (1 << fractionalBits);

  let cursor = 16;

  // Positions: 3 * int24 per point
  const positions = new Float32Array(numPoints * 3);
  for (let i = 0; i < numPoints; i++) {
    for (let c = 0; c < 3; c++) {
      const b0 = raw[cursor++];
      const b1 = raw[cursor++];
      const b2 = raw[cursor++];
      // int24 little-endian, sign-extended
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= 0xff000000; // sign extend to int32
      // JS bitwise ops produce int32; reinterpret
      positions[i * 3 + c] = (v | 0) * scaleFactor;
    }
  }

  // Alphas: 1 byte per point — sigmoid-encoded in v2
  const alphas = new Float32Array(numPoints);
  for (let i = 0; i < numPoints; i++) {
    alphas[i] = raw[cursor++] / 255;
  }

  // Colors: 3 bytes per point — band-0 SH encoded as (col - 0.5) / (SH_C0 * 0.15) (per spz spec scaling)
  // We store the *linear color* contribution by reversing band-0: color = (byte/255 - 0.5) / SH_C0
  // Note: spec uses a "colorScale" of 0.15 in v2 but we store the raw byte/255 here for simplicity
  // and let the encoder do the reverse. We keep two forms: rawColors (byte/255) for encode round-trip,
  // and colors (linear, after SH_C0 conversion) for rendering math.
  const rawColors = new Uint8Array(numPoints * 3);
  const colors = new Float32Array(numPoints * 3);
  for (let i = 0; i < numPoints * 3; i++) {
    const b = raw[cursor++];
    rawColors[i] = b;
    // Reverse the spz v2 color encoding: color = (byte / 255 - 0.5) / 0.15 (then * SH_C0 + 0.5 gives RGB)
    // We store the SH band-0 coefficient form (centered ~0) for mirror math; encoder reverses.
    colors[i] = (b / 255 - 0.5) / 0.15;
  }

  // Scales: 3 bytes per point — stored as ln(stddev) = byte/16 - 10, so the
  // linear stddev is exp(byte/16 - 10). We store the LINEAR stddev to match
  // Spark's convention (setPackedSplat does Math.log() internally).
  const scales = new Float32Array(numPoints * 3);
  for (let i = 0; i < numPoints * 3; i++) {
    scales[i] = Math.exp(raw[cursor++] / 16 - 10);
  }

  // Rotations: 3 bytes per point — "compressed" quaternion (spz v2): just the 3 imaginary components
  // stored as (q_xyz * 127.5 + 127.5), w computed as sqrt(1 - x^2 - y^2 - z^2)
  const rotations = new Float32Array(numPoints * 4);
  for (let i = 0; i < numPoints; i++) {
    const xb = raw[cursor++];
    const yb = raw[cursor++];
    const zb = raw[cursor++];
    const x = (xb - 127.5) / 127.5;
    const y = (yb - 127.5) / 127.5;
    const z = (zb - 127.5) / 127.5;
    const wsq = 1 - x * x - y * y - z * z;
    const w = wsq > 0 ? Math.sqrt(wsq) : 0;
    rotations[i * 4 + 0] = x;
    rotations[i * 4 + 1] = y;
    rotations[i * 4 + 2] = z;
    rotations[i * 4 + 3] = w;
  }

  // Spherical harmonics: shCoeffsPerPoint bytes per point, byte centered at 128, scaled
  let sh = null;
  let shQuantBytes = null;
  if (shCoeffsPerPoint > 0) {
    const total = numPoints * shCoeffsPerPoint;
    sh = new Float32Array(total);
    shQuantBytes = new Uint8Array(total);
    // SPZ stores SH as bytes; convert to centered float in [-1, 1] range (then encoder reverses).
    for (let i = 0; i < total; i++) {
      const b = raw[cursor++];
      shQuantBytes[i] = b;
      sh[i] = (b - 128) / 128;
    }
  }

  return {
    version,
    numPoints,
    shDegree,
    fractionalBits,
    antialiased,
    positions,
    alphas,
    rawColors,
    colors,
    scales,
    rotations,
    sh,
    shQuantBytes,
    shCoeffsPerPoint,
  };
}
