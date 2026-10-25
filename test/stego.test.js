import test from "node:test";
import assert from "node:assert/strict";

import {
  bodyMap,
  capacityBytes,
  channelOffset,
  crc32,
  embed,
  embedSequential,
  encodePayload,
  encryptPayload,
  extract,
  extractRaw,
  permutation,
  readHeader,
  spread,
  bitErrorRate,
  ENVELOPE_OVERHEAD,
} from "../lib/stego.js";

function carrier(width = 96, height = 96, fill = 128) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill;
    data[i + 1] = (fill * 3) & 0xff;
    data[i + 2] = (fill * 7 + i) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

const payload = (msg) => encodePayload({ v: 1, app: "murmur", msg, at: "2026-10-25T00:00:00Z" });

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("capacity is the RGB LSB budget minus the header", () => {
  assert.equal(capacityBytes(96, 96), Math.floor((96 * 96 * 3) / 8) - 17);
  assert.equal(capacityBytes(2, 2), 0);
});

test("permutation is a bijection for a few seeds", () => {
  for (const seed of [0, 1, 424242, 0xffffffff]) {
    const perm = permutation(8, 8, seed);
    const seen = new Set();
    for (let i = 0; i < perm.total; i += 1) seen.add(perm.at(i));
    assert.equal(seen.size, perm.total, `seed ${seed} repeats positions`);
  }
});

test("round trips ASCII and non-Latin text", async () => {
  for (const msg of ["meet me at nine", "벤치 두 번째, 오후 9시", "emoji 🕯️ works too"]) {
    const img = carrier();
    const bytes = payload(msg);
    const wrote = embed(img, bytes, { seed: 12345 });
    assert.equal(wrote.ok, true, wrote.reason);
    const read = await extract(img);
    assert.equal(read.ok, true, read.reason);
    assert.equal(read.payload.msg, msg);
  }
});

test("alpha is never modified", () => {
  const img = carrier();
  const before = [...img.data].filter((_, i) => i % 4 === 3);
  embed(img, payload("alpha"), { seed: 7 });
  const after = [...img.data].filter((_, i) => i % 4 === 3);
  assert.deepEqual(after, before);
  assert.ok(after.every((v) => v === 255));
});

test("exact capacity fits, one byte more is refused", () => {
  const img = carrier(32, 32);
  const room = capacityBytes(32, 32);
  const fits = new Uint8Array(room);
  const over = new Uint8Array(room + 1);
  assert.equal(embed(img, fits).ok, true);
  const refused = embed(img, over);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "TOO_LARGE");
});

test("a short payload is spread, the naive baseline is not", () => {
  const img = carrier(128, 128);
  const bytes = payload("spread me");
  embed(img, bytes, { seed: 99 });
  const spreadRatio = spread(128, 128, bytes.length, { seed: 99 });
  assert.ok(spreadRatio > 0.5, `expected wide spread, got ${spreadRatio}`);

  const naive = carrier(128, 128);
  embedSequential(naive, bytes);
  const naiveRatio = (17 + bytes.length) * 8 / (128 * 128 * 3);
  assert.ok(naiveRatio < 0.02, `naive layout should stay local, got ${naiveRatio}`);
});

test("passphrase round trip, wrong passphrase and missing passphrase are distinct", async () => {
  const img = carrier();
  const sealed = await encryptPayload(payload("for your eyes"), "correct horse");
  assert.equal(sealed.encrypted, true);
  assert.ok(sealed.bytes.length >= payload("for your eyes").length + ENVELOPE_OVERHEAD - 16);

  const wrote = embed(img, sealed.bytes, { seed: 4242, encrypted: true });
  assert.equal(wrote.ok, true);

  const missing = await extract(img);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "PASSPHRASE_REQUIRED");

  const wrong = await extract(img, { passphrase: "battery staple" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "WRONG_PASSPHRASE");

  const right = await extract(img, { passphrase: "correct horse" });
  assert.equal(right.ok, true);
  assert.equal(right.payload.msg, "for your eyes");
});

test("the header records the body seed", () => {
  const img = carrier();
  embed(img, payload("seed"), { seed: 0xdeadbeef });
  const header = readHeader(img);
  assert.equal(header.ok, true);
  assert.equal(header.seed, 0xdeadbeef);
});

test("a flipped payload bit fails the CRC", async () => {
  const img = carrier(64, 64);
  const wrote = embed(img, payload("integrity"), { seed: 11 });
  assert.equal(wrote.ok, true);
  // channel index `stride` is the second body bit; the header never uses it
  img.data[channelOffset(bodyMap(64, 64, 11).at(wrote.stride))] ^= 1;
  const read = await extract(img);
  assert.equal(read.ok, false);
  assert.equal(read.reason, "CRC_MISMATCH");
});

test("no header on random noise", () => {
  const img = carrier(64, 64);
  let s = 123456789;
  for (let i = 0; i < img.data.length; i += 4) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    img.data[i] = s & 0xff;
    img.data[i + 1] = (s >>> 8) & 0xff;
    img.data[i + 2] = (s >>> 16) & 0xff;
  }
  const header = readHeader(img);
  assert.equal(header.ok, false);
  assert.equal(header.reason, "NO_MAGIC");
});

test("extractRaw reports bytes even when the checksum fails", () => {
  const img = carrier(64, 64);
  const bytes = payload("raw read");
  const wrote = embed(img, bytes, { seed: 3 });
  assert.equal(wrote.ok, true);
  img.data[channelOffset(bodyMap(64, 64, 3).at(wrote.stride))] ^= 1;
  const raw = extractRaw(img);
  assert.equal(raw.ok, true);
  assert.equal(raw.crcOk, false);
  assert.equal(raw.bytes.length, bytes.length);
});

test("bitErrorRate is the fraction of differing bits", () => {
  assert.equal(bitErrorRate(new Uint8Array([0b00000000]), new Uint8Array([0b00000000])), 0);
  assert.equal(bitErrorRate(new Uint8Array([0b11111111]), new Uint8Array([0b00000000])), 1);
  assert.equal(bitErrorRate(new Uint8Array([0b00000001]), new Uint8Array([0b00000000])), 1 / 8);
  assert.equal(bitErrorRate(new Uint8Array([1]), new Uint8Array([1, 2])), 1);
});

test("body positions never land on header channels, including seed 0", () => {
  for (const seed of [0, 1, 11, 4242, 0xdeadbeef, 0xffffffff]) {
    const map = bodyMap(96, 96, seed);
    const holes = new Set(map.holes);
    for (let k = 0; k < Math.min(2000, map.total); k += 1) {
      assert.ok(!holes.has(map.at(k)), `seed ${seed} k=${k} collides with the header`);
    }
  }
});

test("round trip holds for seed 0 and a sweep of other seeds", async () => {
  const seeds = [0, 1, 7, 1009, 1012, 1016, 1031, 1037, 424242, 0xdeadbeef];
  for (const seed of seeds) {
    const img = carrier(96, 96);
    const bytes = payload(`seed ${seed}`);
    assert.equal(embed(img, bytes, { seed }).ok, true);
    const read = await extract(img);
    assert.equal(read.ok, true, `seed ${seed}: ${read.reason}`);
    assert.equal(read.payload.msg, `seed ${seed}`);
  }
});

test("a small carrier that fits the header is usable", async () => {
  assert.ok(capacityBytes(12, 12) > 0);
  const img = carrier(12, 12);
  const bytes = new Uint8Array(8).fill(0x61);
  assert.equal(embed(img, bytes, { seed: 5 }).ok, true);
  const raw = extractRaw(img);
  assert.equal(raw.ok, true);
  assert.equal(raw.crcOk, true);
});

test("bad dimensions fail closed instead of throwing", async () => {
  for (const bad of [
    { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    { width: -4, height: 8, data: new Uint8ClampedArray(0) },
    { width: NaN, height: 8, data: new Uint8ClampedArray(0) },
  ]) {
    assert.equal(embed(bad, new Uint8Array([1])).reason, "BAD_DIMS");
    assert.equal(readHeader(bad).reason, "BAD_DIMS");
    assert.equal((await extract(bad)).reason, "BAD_DIMS");
    assert.equal(extractRaw(bad).reason, "BAD_DIMS");
  }
  assert.equal(spread(0, 0, 10), 0);
  assert.equal(spread(96, 96, 0), 0);
});
