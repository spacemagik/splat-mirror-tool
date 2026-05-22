// Headless QA: read the .spz, mirror it, encode it, re-read it. Print stats.
// Not part of the app; run with: node src/_qa-roundtrip.js

import { readFileSync, writeFileSync } from "node:fs";
import { decodeSpz } from "./spz-decode.js";
import { encodeSpz } from "./spz-encode.js";
import { buildMirroredSplat } from "./mirror.js";

const path = process.argv[2] ?? "Dreamlike Room Filled with Clouds.spz";
const axis = Number(process.argv[3] ?? 0); // 0=X, 1=Y, 2=Z
const planeOffset = Number(process.argv[4] ?? 0);

console.log(`Reading ${path}…`);
const bytes = new Uint8Array(readFileSync(path));
console.log(`  ${bytes.byteLength.toLocaleString()} bytes`);

console.log("Decoding…");
const src = decodeSpz(bytes);
console.log(`  numPoints=${src.numPoints.toLocaleString()}`);
console.log(`  version=${src.version} shDegree=${src.shDegree} fractionalBits=${src.fractionalBits}`);
console.log(`  positions range: x=[${minMax(src.positions, 0, 3).join(", ")}]`);
console.log(`                   y=[${minMax(src.positions, 1, 3).join(", ")}]`);
console.log(`                   z=[${minMax(src.positions, 2, 3).join(", ")}]`);

console.log(`\nMirroring across axis=${axis}, plane offset=${planeOffset}…`);
const t0 = Date.now();
const mirrored = buildMirroredSplat(src, axis, planeOffset, false);
console.log(`  done in ${Date.now() - t0}ms; numPoints=${mirrored.numPoints.toLocaleString()}`);
console.log(
  `  expected ~2x source-side count; positions range x=[${minMax(mirrored.positions, 0, 3).join(", ")}]`,
);

console.log("\nEncoding…");
const t1 = Date.now();
const out = encodeSpz(mirrored);
console.log(`  done in ${Date.now() - t1}ms; ${out.byteLength.toLocaleString()} bytes (gzip)`);

const outPath = path.replace(/\.spz$/i, "-mirrored.spz");
writeFileSync(outPath, out);
console.log(`  wrote ${outPath}`);

console.log("\nRound-trip decode…");
const roundTrip = decodeSpz(out);
console.log(`  numPoints=${roundTrip.numPoints.toLocaleString()}`);
console.log(`  shDegree=${roundTrip.shDegree} fractionalBits=${roundTrip.fractionalBits}`);
const ok = roundTrip.numPoints === mirrored.numPoints;
console.log(`  round-trip ${ok ? "OK" : "MISMATCH"}`);
if (!ok) process.exit(1);

function minMax(arr, offset, stride) {
  let min = Infinity,
    max = -Infinity;
  for (let i = offset; i < arr.length; i += stride) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min.toFixed(3), max.toFixed(3)];
}
