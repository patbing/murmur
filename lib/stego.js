/**
 * lib/stego.js — MURMUR's deterministic core.
 *
 * A PNG-friendly LSB codec that works on a plain ImageData-shaped object:
 *   { width, height, data: Uint8ClampedArray }   // RGBA, 4 bytes per pixel
 *
 * No DOM, no chrome.*: everything here is unit-testable with `node --test`.
 *
 * Layout
 *   A 17-byte header always sits at the seed-0 permutation positions:
 *     magic  4  "MRM1"
 *     flags  1  bit0 = payload is AES-GCM encrypted
 *     length 4  uint32 big-endian, payload bytes
 *     seed   4  uint32, the permutation used for the payload body
 *     crc32  4  CRC-32 of the stored payload bytes (after encryption)
 *   The body lives in the channels the header did not take, spread with a
 *   stride derived from its length so a short secret is not clustered in the
 *   first few hundred pixels (which is what makes naive LSB easy to spot).
 *
 * Only the RGB least-significant bits carry data; alpha is never touched.
 */

export const MAGIC = Uint8Array.from([0x4d, 0x52, 0x4d, 0x31]); // "MRM1"
export const HEADER_BYTES = 17;
export const HEADER_BITS = HEADER_BYTES * 8;
export const FLAG_ENCRYPTED = 0b1;

/** AES-GCM envelope: salt(16) | iv(12) | ciphertext+tag(16). */
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const ENVELOPE_OVERHEAD = SALT_BYTES + IV_BYTES + 16;
export const PBKDF2_ITERATIONS = 100000;

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- capacity */

/** Bytes a carrier can hold: RGB LSBs, minus the header. */
export function capacityBytes(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  const total = Math.floor(width) * Math.floor(height) * 3;
  if (total < HEADER_BITS) return 0;
  return Math.max(0, Math.floor(total / 8) - HEADER_BYTES);
}

/* ---------------------------------------------------- seeded permutation */

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * A permutation over [0, total) that needs no memory: an affine map
 * i -> (offset + mult * i) mod total, with mult coprime to total.
 */
export function affine(total, seed = 0) {
  if (total <= 0) throw new RangeError("nothing to permute");
  const s = seed | 0;
  let mult = (Math.imul(s, 2654435761) >>> 0) % total || 1;
  while (gcd(mult, total) !== 1) mult = (mult + 1) % total || 1;
  const offset = (Math.imul(s, 40503) >>> 0) % total;
  return {
    total,
    at(i) {
      return (offset + mult * (i % total)) % total;
    },
  };
}

/** The channel permutation for a whole carrier. */
export function permutation(width, height, seed = 0) {
  return affine(Math.floor(width) * Math.floor(height) * 3, seed);
}

/** Map a channel index (0..w*h*3) to a byte offset in the RGBA buffer. */
export function channelOffset(channel) {
  return Math.floor(channel / 3) * 4 + (channel % 3);
}

/* ------------------------------------------------- header/body placement */

function countAtMost(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The header's channel indices, sorted, so the body can step around them. */
function headerChannels(width, height) {
  const perm = permutation(width, height, 0);
  const list = new Uint32Array(HEADER_BITS);
  for (let i = 0; i < HEADER_BITS; i += 1) list[i] = perm.at(i);
  return list.sort();
}

/** The k-th channel index that is *not* used by the header. */
function freeChannel(k, holes) {
  // Each step strictly increases c unless it is already free, and c can grow
  // by at most holes.length, so holes.length + 1 passes always converge.
  // (The old fixed guard of 8 left body positions inside the header for
  // dense hole runs, e.g. the seed-0 identity permutation.)
  let c = k;
  for (let guard = 0; guard <= holes.length + 1; guard += 1) {
    const skipped = countAtMost(holes, c);
    const next = k + skipped;
    if (next === c) return c;
    c = next;
  }
  return c;
}

function dimsOk(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/**
 * The body's position map: an affine permutation over the free channels only,
 * so writing the body can never overwrite a header bit.
 */
export function bodyMap(width, height, seed = 0) {
  if (!dimsOk(width, height)) return { total: 0, holes: [], at: () => 0 };
  const total = Math.floor(width) * Math.floor(height) * 3;
  if (total <= HEADER_BITS) return { total: 0, holes: [], at: () => 0 };
  const holes = headerChannels(width, height);
  const free = total - holes.length;
  if (free <= 0) return { total: 0, holes, at: () => 0 };
  const perm = affine(Math.max(1, free), seed);
  return {
    total: Math.max(0, free),
    holes,
    at(k) {
      return freeChannel(perm.at(k), holes);
    },
  };
}

/* ------------------------------------------------------------ bit helpers */

const readBit = (data, offset) => data[offset] & 1;

function writeBit(data, offset, value) {
  if (value) data[offset] |= 1;
  else data[offset] &= ~1;
}

/* --------------------------------------------------------------- payload */

export function encodePayload(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodePayload(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* ------------------------------------------------------------ encryption */

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is unavailable");
  return c.subtle;
}

export async function deriveKey(passphrase, salt) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** salt | iv | ciphertext. Salt and iv are not secret and precede the tag. */
export async function encryptPayload(bytes, passphrase) {
  if (!passphrase) return { bytes, encrypted: false };
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + cipher.length);
  out.set(salt, 0);
  out.set(iv, SALT_BYTES);
  out.set(cipher, SALT_BYTES + IV_BYTES);
  return { bytes: out, encrypted: true };
}

export async function decryptPayload(bytes, passphrase) {
  if (bytes.length <= SALT_BYTES + IV_BYTES) throw new Error("envelope too short");
  const salt = bytes.slice(0, SALT_BYTES);
  const iv = bytes.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const cipher = bytes.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, key, cipher));
}

/* ----------------------------------------------------------------- embed */

function buildHeader(payloadBytes, encrypted, seed) {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = encrypted ? FLAG_ENCRYPTED : 0;
  const view = new DataView(header.buffer);
  view.setUint32(5, payloadBytes.length, false);
  view.setUint32(9, seed >>> 0, false);
  view.setUint32(13, crc32(payloadBytes), false);
  return header;
}

/**
 * Write `payload` into the carrier's RGB LSBs.
 * `encrypted` only marks the header flag; encrypt with encryptPayload first.
 * Returns { ok, bytes, stride, seed } or { ok: false, reason }.
 */
export function embed(imageData, payload, { seed = 0, encrypted = false } = {}) {
  const { width, height, data } = imageData || {};
  if (!dimsOk(width, height) || !data || data.length < Math.floor(width) * Math.floor(height) * 4) {
    return { ok: false, reason: "BAD_DIMS" };
  }
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const room = capacityBytes(width, height);
  if (payloadBytes.length === 0) return { ok: false, reason: "EMPTY_PAYLOAD" };
  if (payloadBytes.length > room) {
    return { ok: false, reason: "TOO_LARGE", capacity: room, needed: payloadBytes.length };
  }

  const header = buildHeader(payloadBytes, encrypted, seed);
  const headerPerm = permutation(width, height, 0);
  const body = bodyMap(width, height, seed);
  const payloadBits = payloadBytes.length * 8;
  const stride = Math.max(1, Math.floor(body.total / payloadBits));

  for (let i = 0; i < HEADER_BITS; i += 1) {
    writeBit(data, channelOffset(headerPerm.at(i)), (header[i >> 3] >> (7 - (i & 7))) & 1);
  }
  for (let j = 0; j < payloadBits; j += 1) {
    const k = j * stride;
    if (k >= body.total) return { ok: false, reason: "OVERFLOW" };
    writeBit(data, channelOffset(body.at(k)), (payloadBytes[j >> 3] >> (7 - (j & 7))) & 1);
  }
  return { ok: true, bytes: payloadBytes.length, seed, stride };
}

/**
 * The naive baseline: header and body written one bit after another. Kept in
 * the product (not just the tests) so the detection matrix can show what a
 * difference spreading makes. Detect-only: extract()/readBody() read the
 * spread layout, so a sequential payload's header is readable but its body
 * is not extractable — the bench only runs analyze(), never extract().
 */
export function embedSequential(imageData, payload, { encrypted = false } = {}) {
  const { width, height, data } = imageData || {};
  if (!dimsOk(width, height) || !data || data.length < Math.floor(width) * Math.floor(height) * 4) {
    return { ok: false, reason: "BAD_DIMS" };
  }
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (payloadBytes.length === 0) return { ok: false, reason: "EMPTY_PAYLOAD" };
  if (payloadBytes.length > capacityBytes(width, height)) return { ok: false, reason: "TOO_LARGE" };
  const header = buildHeader(payloadBytes, encrypted, 0);
  const all = new Uint8Array(HEADER_BYTES + payloadBytes.length);
  all.set(header, 0);
  all.set(payloadBytes, HEADER_BYTES);
  const bits = all.length * 8;
  if (bits > width * height * 3) return { ok: false, reason: "OVERFLOW" };
  for (let i = 0; i < bits; i += 1) {
    writeBit(data, channelOffset(i), (all[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return { ok: true, bytes: payloadBytes.length, stride: 1, seed: 0 };
}

/* ---------------------------------------------------------------- extract */

/** Read just the header (always at the seed-0 permutation). */
export function readHeader(imageData, { seed = 0 } = {}) {
  void seed; // the header location never moves
  const { width, height, data } = imageData || {};
  if (!dimsOk(width, height) || !data || data.length < Math.floor(width) * Math.floor(height) * 4) {
    return { ok: false, reason: "BAD_DIMS" };
  }
  const perm = permutation(width, height, 0);
  const header = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < HEADER_BITS; i += 1) {
    header[i >> 3] |= readBit(data, channelOffset(perm.at(i))) << (7 - (i & 7));
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (header[i] !== MAGIC[i]) return { ok: false, reason: "NO_MAGIC" };
  }
  const view = new DataView(header.buffer);
  const length = view.getUint32(5, false);
  const bodySeed = view.getUint32(9, false);
  const room = capacityBytes(width, height);
  if (length === 0 || length > room) return { ok: false, reason: "BAD_LENGTH" };
  return {
    ok: true,
    encrypted: (header[4] & FLAG_ENCRYPTED) !== 0,
    length,
    seed: bodySeed,
    crc: view.getUint32(13, false),
    room,
  };
}

function readBody(imageData, header) {
  const { width, height, data } = imageData;
  const body = bodyMap(width, height, header.seed);
  const payloadBits = header.length * 8;
  const stride = Math.max(1, Math.floor(body.total / payloadBits));
  const out = new Uint8Array(header.length);
  for (let j = 0; j < payloadBits; j += 1) {
    const k = j * stride;
    if (k >= body.total) return { ok: false, reason: "OVERFLOW" };
    out[j >> 3] |= readBit(data, channelOffset(body.at(k))) << (7 - (j & 7));
  }
  return { ok: true, bytes: out };
}

/** Payload bytes without CRC checking or decryption (used for bit-error rates). */
export function extractRaw(imageData, { seed = 0 } = {}) {
  void seed;
  const header = readHeader(imageData);
  if (!header.ok) return header;
  const body = readBody(imageData, header);
  if (!body.ok) return body;
  return {
    ok: true,
    bytes: body.bytes,
    encrypted: header.encrypted,
    seed: header.seed,
    crcOk: crc32(body.bytes) === header.crc,
  };
}

/**
 * Read the payload. With `passphrase`, an encrypted payload is decrypted.
 * Returns { ok, payload, encrypted } or { ok: false, reason }.
 */
export async function extract(imageData, { seed = 0, passphrase = "" } = {}) {
  void seed;
  const header = readHeader(imageData);
  if (!header.ok) return header;
  const body = readBody(imageData, header);
  if (!body.ok) return body;
  if (crc32(body.bytes) !== header.crc) return { ok: false, reason: "CRC_MISMATCH" };
  if (!header.encrypted) {
    try {
      return { ok: true, encrypted: false, payload: decodePayload(body.bytes), seed: header.seed };
    } catch {
      return { ok: false, reason: "BAD_JSON" };
    }
  }
  if (!passphrase) return { ok: false, reason: "PASSPHRASE_REQUIRED", encrypted: true };
  let plain;
  try {
    plain = await decryptPayload(body.bytes, passphrase);
  } catch {
    return { ok: false, reason: "WRONG_PASSPHRASE", encrypted: true };
  }
  try {
    return { ok: true, encrypted: true, payload: decodePayload(plain), seed: header.seed };
  } catch {
    return { ok: false, reason: "BAD_JSON", encrypted: true };
  }
}

/* ---------------------------------------------------------------- metrics */

/** Fraction of differing bits between two byte arrays (1 when lengths differ). */
export function bitErrorRate(a, b) {
  if (a.length !== b.length) return 1;
  if (a.length === 0) return 0;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = a[i] ^ b[i];
    while (x) {
      diff += x & 1;
      x >>= 1;
    }
  }
  return diff / (a.length * 8);
}

/** Share of the free channels the body touches (0..1). */
export function spread(width, height, payloadBytes, { seed = 0 } = {}) {
  if (!payloadBytes || payloadBytes <= 0) return 0;
  const body = bodyMap(width, height, seed);
  if (!body.total) return 0;
  const payloadBits = payloadBytes * 8;
  const stride = Math.max(1, Math.floor(body.total / payloadBits));
  const last = (payloadBits - 1) * stride;
  return body.total ? Math.min(1, (last + 1) / body.total) : 0;
}
