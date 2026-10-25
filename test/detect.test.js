import test from "node:test";
import assert from "node:assert/strict";

import { analyze, lsbBalance, lsbPairTest, pngReport, svgReport } from "../lib/detect.js";

/**
 * Build a synthetic RGBA image whose value pairs are either balanced or not.
 * `balanced` alternates even/odd once per 128 samples, so every pair (2k, 2k+1)
 * ends up with exactly the same count — the signature LSB replacement leaves.
 */
function pattern(width, height, mode) {
  const data = new Uint8ClampedArray(width * height * 4);
  let i = 0;
  for (let p = 0; p < width * height; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const n = p * 3 + c;
      const k = n % 128;
      const offset = mode === "balanced" ? Math.floor(n / 128) & 1 : 0;
      data[i] = 2 * k + offset;
      i += 1;
    }
    data[i] = 255;
    i += 1;
  }
  return { width, height, data };
}

/**
 * A smooth, photograph-like carrier: rounded sines over a wide value range.
 * Unlike a modular gradient it does not hit every value equally often, so its
 * pairs keep the natural imbalance the chi-square test looks for.
 */
function photo(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let i = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[i] = clamp(128 + 40 * Math.sin(x / 5) + 30 * Math.cos(y / 7));
      data[i + 1] = clamp(130 + 35 * Math.sin(y / 6));
      data[i + 2] = clamp(120 + 30 * Math.cos((x + y) / 8));
      data[i + 3] = 255;
      i += 4;
    }
  }
  return { width, height, data };
}

function pngBytes({ text = false, trailing = 0, end = true } = {}) {
  const chunks = [];
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunks.push(["IHDR", ihdr]);
  if (text) chunks.push(["tEXt", new TextEncoder().encode("Comment\0hidden")]);
  if (end) chunks.push(["IEND", new Uint8Array(0)]);

  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, payload] of chunks) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, payload.length);
    head.set(new TextEncoder().encode(type), 4);
    parts.push(head, payload, new Uint8Array(4)); // parser does not verify CRCs
  }
  if (trailing) parts.push(new Uint8Array(trailing).fill(0x41));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("chi-square separates balanced pairs from an untouched plane", () => {
  const balanced = lsbPairTest(pattern(64, 64, "balanced").data);
  const uneven = lsbPairTest(pattern(64, 64, "even").data);
  assert.equal(balanced.applicable, true);
  assert.equal(uneven.applicable, true);
  assert.ok(balanced.pValue < 0.01, `balanced should look planted, p=${balanced.pValue}`);
  assert.ok(uneven.pValue > 0.5, `untouched should not, p=${uneven.pValue}`);
});

test("lsbBalance spots a constant bit plane", () => {
  const flat = pattern(32, 32, "even");
  const result = lsbBalance(flat.data);
  assert.equal(result.flatChannels, 3);
});

test("pngReport finds text chunks and bytes after IEND", () => {
  const clean = pngReport(pngBytes());
  assert.equal(clean.isPng, true);
  assert.equal(clean.complete, true);
  assert.equal(clean.textChunks, 0);
  assert.equal(clean.trailingBytes, 0);

  const sneaky = pngReport(pngBytes({ text: true, trailing: 42 }));
  assert.equal(sneaky.textChunks, 1);
  assert.equal(sneaky.trailingBytes, 42);
});

test("pngReport survives a truncated stream", () => {
  const truncated = pngBytes({ end: false });
  const report = pngReport(truncated);
  assert.equal(report.isPng, true);
  assert.equal(report.complete, false);
});

test("svgReport reads comments, ids and text elements", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">
    <!-- the second bench, nine pm -->
    <g id="Mango"><text>hello</text></g>
    <g id="East"></g><g id="Map"></g>
    <metadata>author</metadata>
  </svg>`;
  const report = svgReport(svg);
  assert.equal(report.isSvg, true);
  assert.equal(report.comments, 1);
  assert.equal(report.idAcrostic.startsWith("mem"), true);
  assert.equal(report.textElements, 1);
  assert.equal(report.metadata, true);
});

test("analyze calls a smooth carrier clean and a text chunk strong evidence", () => {
  const clean = analyze({ imageData: photo(64, 64), fileBytes: pngBytes() });
  assert.equal(clean.verdict, "clean");

  const suspicious = analyze({ fileBytes: pngBytes({ text: true }) });
  assert.equal(suspicious.verdict, "evidence");
  assert.ok(suspicious.findings.some((f) => f.id === "png.text"));
});

test("analyze reports LSB pairing as a strong finding", () => {
  const report = analyze({ imageData: pattern(64, 64, "balanced") });
  assert.equal(report.verdict, "evidence");
  assert.ok(report.findings.some((f) => f.id === "lsb.pairs"));
});
