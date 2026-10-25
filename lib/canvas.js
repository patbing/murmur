/**
 * lib/canvas.js — browser-only image plumbing.
 *
 * Kept apart from lib/stego.js so the codec stays testable in Node. Everything
 * here works on plain ImageData-shaped objects and never touches the network.
 */

const canOffscreen = typeof OffscreenCanvas !== "undefined";

function makeCanvas(width, height) {
  if (canOffscreen) return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Force alpha to 255: a transparent PNG re-encodes differently in each browser. */
function opaque(imageData) {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return imageData;
}

export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodeImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return opaque(data);
}

export async function encodePng(imageData) {
  const canvas = makeCanvas(imageData.width, imageData.height);
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
  });
}

export async function encodeJpeg(imageData, quality) {
  const canvas = makeCanvas(imageData.width, imageData.height);
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))),
      "image/jpeg",
      quality,
    );
  });
}

/** Draw into a new size; `scale` < 1 shrinks, which usually destroys LSBs. */
export async function resize(imageData, scale) {
  if (scale === 1) return imageData;
  const w = Math.max(1, Math.round(imageData.width * scale));
  const h = Math.max(1, Math.round(imageData.height * scale));
  const from = makeCanvas(imageData.width, imageData.height);
  from.getContext("2d").putImageData(imageData, 0, 0);
  const to = makeCanvas(w, h);
  const ctx = to.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, 0, 0, w, h);
  return opaque(ctx.getImageData(0, 0, w, h));
}

/** Simulate what a platform does to an upload, in memory. */
export async function simulatePipeline(imageData, { type = "image/png", quality = 1, scale = 1 } = {}) {
  const resized = await resize(imageData, scale);
  if (type === "image/png") return { imageData: resized, bytes: await blobToBytes(await encodePng(resized)) };
  const blob = await encodeJpeg(resized, quality);
  const decoded = await decodeImage(blob);
  return { imageData: decoded, bytes: await blobToBytes(blob), jpegQuality: quality, scale };
}

/** A small JPEG data URL for the vision model: 512px on the long edge. */
export async function toModelDataUrl(imageData, maxSide = 512) {
  const scale = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
  const small = await resize(imageData, scale);
  const blob = await encodeJpeg(small, 0.85);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}`, width: small.width, height: small.height };
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Build a blank synthetic carrier, used by the bench when no cover exists. */
export function noiseCarrier(width, height, seed = 1) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < data.length; i += 4) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = s & 0xff;
    data[i + 1] = (s >>> 8) & 0xff;
    data[i + 2] = (s >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}
