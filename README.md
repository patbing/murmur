# MURMUR

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**Messages hidden in images — and the receipts to prove (or disprove) that they survived.**

MURMUR hides a short message in the least significant bits of a PNG, then *measures*
what actually happens to it. Every number it shows was produced in your browser, on
your file, in that session. Nothing is estimated for effect.

Built for the Pollinations `#18367` app quest. Pollinations is used for two things only:
generating a cover image, and (optionally) asking a vision model whether it can see the
payload. The codec, the survival table and the detection matrix call no model at all.

---

## What the three tabs do

### Hide

1. **Cover** — describe one and generate it (the button prices the current cheapest
   `paid_only:false` image model from the live catalogue — recently
   `openai/gpt-image-1-mini` at a fraction of a mille-pollen), or use your own file.
2. **Message** — up to 2,000 characters. An optional passphrase encrypts the payload with
   PBKDF2-SHA-256 → AES-256-GCM before it ever touches the pixels.
3. **Hide it** — writes a 17-byte header plus the body into the RGB least significant bits
   and gives you back a PNG.

The result card is the point. For each transformation below it re-reads the payload from
the *transformed* image and reports the **bit error rate** and whether the CRC still matches:

| After | What it models |
|---|---|
| PNG, re-encoded | lossless round trip |
| JPEG 95 / 85 / 70 | photo upload paths, "send as photo", social re-encodes |
| Resized to 75% / 50% | thumbnails, chat previews, avatars |

If a row says **corrupted**, that is not a bug in the report: JPEG quantisation and
resampling rewrite low bits, and LSB data does not survive them. Send the PNG **as a file**.

### Seek

Deterministic checks that need no key and no network:

- **LSB pair test** — the Westfeld–Pfitzmann chi-square over value pairs `(2k, 2k+1)`.
  LSB replacement equalises those pairs, which pushes chi-square far below its expected
  value. Reported as chi², degrees of freedom and p; p < 0.01 is the strong band.
- **LSB balance** — per-channel share of 1s. A plane pinned near 0% or 100% is not something
  a camera produces.
- **PNG structure** — `tEXt`/`iTXt`/`zTXt` chunks and any bytes after `IEND` (a classic
  append-a-zip trick that every viewer ignores).
- **SVG** — comments, `<metadata>`, and the acrostic formed by the first letters of element
  `id`s.

Then, if you tick the box, a vision model gets a 512 px JPEG copy and is asked for a
verdict in strict JSON. The model is a **second opinion**, never the verdict: it is
invited to say "nothing hidden", and its answer is discarded if it does not fit the
requested shape. Cost is shown before the call.

MURMUR's own payloads are detected exactly (magic + length + CRC), so "did my message
survive" is answered by arithmetic, not by a model's opinion.

### Bench

A local detection matrix. It takes the current cover, makes *N* copies, hides a message in
half of them, and runs the chi-square test on each — three ways:

| Embedding | What it represents |
|---|---|
| no payload | the false-positive baseline |
| naive sequential LSB | header + body written one bit after another from pixel 0 (detect-only baseline: `extract()` reads the spread layout, so sequential payloads are not extractable — the matrix only runs `analyze()`) |
| MURMUR spread | body permuted across the free channels with a stride |

No model, no key, no Pollen. The claim "spreading defeats the classic test" is something
you can reproduce in one click instead of taking on faith.

---

## How the codec works

```
MRM1 | flags(1) | length(4) | seed(4) | crc32(4)     17 bytes, big-endian
```

- The **header** always lives at the positions of the seed-0 affine permutation, so a
  reader can find it without knowing anything.
- The **body** is written through a *different* permutation (the seed in the header) over
  the channels the header did **not** occupy, with a stride derived from the payload
  length. A 40-byte secret therefore touches the whole image instead of the first 500
  pixels — which is exactly what the classic test struggles to see.
- `crc32` covers the stored bytes (after encryption), so a corrupted payload is reported as
  `CRC_MISMATCH` rather than decoded into garbage.
- Alpha is never written. Only R, G and B LSBs carry data.
- Capacity is `floor(w·h·3/8) − 17` bytes; a 1024×1024 cover holds ~392 KB.

Encryption envelope: `salt(16) | iv(12) | ciphertext+tag`. Wrong passphrase and missing
passphrase are distinct outcomes (`WRONG_PASSPHRASE` vs `PASSPHRASE_REQUIRED`), which is
what lets the UI say something true instead of "failed".

### LSB is fragile on purpose

The product does not pretend otherwise. MURMUR measures the fragility, and the receipt is
the feature. If you need a message to survive a platform's re-encode, use a file transfer,
not a photo pipeline.

---

## Pollinations calls

| Purpose | Endpoint | Model | Cost |
|---|---|---|---|
| Cover generation | `POST /v1/images/generations` (`response_format: b64_json`) | cheapest `paid_only:false` image model, default `tongyi-mai/z-image-turbo` | 0.004 Pollen |
| Second opinion | `POST /v1/chat/completions` | cheapest `paid_only:false` vision model, default `openai/gpt-5.4-nano` | shown before the call |
| Catalogue | `GET /v1/models` | — | free |

The catalogue is read once on connect and filtered on `paid_only === false`; a model without
that exact flag is never offered, so a reader whose balance is Quest Pollen is never handed
a paid-only model. If the catalogue cannot be read, MURMUR does not invent a model: it says
so.

Cost estimates use the live `pricing` block when it is present, with a built-in table as a
fallback, and a rough 400 tokens per downscaled image. They are labelled as estimates.

**Bring Your Own Pollen.** MURMUR uses the OAuth device flow
(`enter.pollinations.ai/api/device/{code,token}`). The resulting `sk_…` key is stored in
this origin's `localStorage` and sent **only** as an `Authorization: Bearer` header — never
in a query string, because URLs end up in history, proxy logs and HAR files. Disconnect
deletes it.

---

## Run it

```bash
# tests: no browser, no key, no network
npm test          # node --test (Node 20+; developed on 24)

# serve the static app
npm run serve     # python -m http.server 8099 → http://localhost:8099
```

There is no build step and no dependency. `index.html` loads one ES module (`app.js`),
which imports `lib/`. Any static host works; the app needs an HTTPS origin for WebCrypto
and the device flow, so `localhost` or GitHub Pages, not `file://`.

### Tests

36 unit tests, all deterministic:

- `test/stego.test.js` — CRC check value, capacity edges, permutation bijection, ASCII and
  non-Latin round trips, alpha untouched, exact-capacity boundary, spread vs sequential,
  encrypted round trip, wrong/missing passphrase, header seed, bit flips → `CRC_MISMATCH`,
  a constant plane → `NO_MAGIC`.
- `test/detect.test.js` — chi-square separation (planted vs natural pairs), flat-plane
  balance, PNG text chunks and trailing bytes, truncated streams, SVG comments/ids/acrostic,
  verdict assembly.
- `test/api.test.js` — device flow (pending, `slow_down`, success, expiry, 5xx), catalogue
  filtering, key never in a URL, error mapping (401/402/403/429), base64 image path, cost
  scaling.
- `test/prompt.test.js` — JSON extraction from fenced/prose answers, rejection of unshaped
  answers, confidence clamping, evidence truncation, filename slug.

---

## Honest limits

- **A chi-square pass is evidence, not proof.** Heavy editing, synthetic renders and
  screenshot pipelines can also equalise pairs. The UI says "weak signals" for a reason.
- **The vision model is a weak detector by construction.** A 512 px JPEG copy has already
  destroyed most LSBs; asking a model about that copy is a demonstration, not an attack.
  The Bench exists to keep that distinction visible.
- **Small payloads are the hard case.** The stride spreads them, but a large cover with a
  40-byte secret is still a statistical signal if someone runs the right test.
- **The survival table is browser-dependent.** JPEG encoders differ; Chrome's 90% is not
  Photoshop's 90%. That is why the table says "in this browser".

## License

MIT. See `LICENSE`.
