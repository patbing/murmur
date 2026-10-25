/**
 * lib/detect.js — deterministic "seek" side of MURMUR.
 *
 * These are the checks that need no model and no key, so they run offline and
 * can be unit tested. They never claim certainty: each finding is evidence with
 * a stated reason, and the verdict is assembled from that evidence.
 *
 * The chi-square test is the classic Westfeld–Pfitzmann LSB test: replacing the
 * least significant bit of a natural image makes value pairs (2k, 2k+1) equally
 * frequent, which pushes chi-square far below its expected value for 128 pairs.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* ---------------------------------------------------------- chi-square CDF */

/** Regularized lower incomplete gamma P(a, x) — Numerical Recipes 6.2. */
function lowerGamma(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 200; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // continued fraction for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-30;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = b + an / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function logGamma(z) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = z;
  let x = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

const chiSquareCdf = (chi2, df) => lowerGamma(df / 2, chi2 / 2);

/* --------------------------------------------------------------- detectors */

/**
 * LSB pair test over the RGB channels.
 * pValue is P(chi2 <= observed) for a clean carrier: a *small* pValue means the
 * value pairs are unusually balanced, which is what LSB replacement produces.
 */
export function lsbPairTest(data) {
  const counts = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    counts[data[i]] += 1;
    counts[data[i + 1]] += 1;
    counts[data[i + 2]] += 1;
    total += 3;
  }
  let chi2 = 0;
  let pairs = 0;
  for (let k = 0; k < 128; k += 1) {
    const even = counts[2 * k];
    const odd = counts[2 * k + 1];
    const sum = even + odd;
    if (sum < 5) continue; // too few samples to say anything
    chi2 += ((even - odd) ** 2) / sum;
    pairs += 1;
  }
  if (pairs < 16) return { applicable: false, reason: "TOO_FEW_SAMPLES", pairs, total };
  const pValue = chiSquareCdf(chi2, pairs);
  return {
    applicable: true,
    chi2: Number(chi2.toFixed(3)),
    df: pairs,
    pValue: Number(pValue.toExponential(3)),
    // 1 - p, rounded: how strongly the pairing looks machine-made
    suspicion: Number((1 - pValue).toFixed(6)),
    samples: total,
  };
}

/** Share of RGB LSBs that are 1, per channel. A flat 0 or 1 plane is odd. */
export function lsbBalance(data) {
  const ones = [0, 0, 0];
  const counts = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      ones[c] += data[i + c] & 1;
      counts[c] += 1;
    }
  }
  const ratios = ones.map((n, c) => (counts[c] ? Number((n / counts[c]).toFixed(4)) : 0));
  const flat = ratios.filter((r) => r < 0.02 || r > 0.98).length;
  return { ratios, flatChannels: flat };
}

/** Parse PNG chunks and look at what follows IEND. */
export function pngReport(bytes) {
  if (!bytes || bytes.length < 8 + 12) return { isPng: false };
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) return { isPng: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  let endedAt = null;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    chunks.push({ type, length, offset });
    const next = offset + 12 + length;
    if (type === "IEND") {
      endedAt = next;
      break;
    }
    if (length > bytes.length || next <= offset) break; // truncated or hostile
    offset = next;
  }
  const text = chunks.filter((c) => c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt");
  const trailing = endedAt === null ? 0 : Math.max(0, bytes.length - endedAt);
  return {
    isPng: true,
    chunks,
    chunkTypes: chunks.map((c) => c.type),
    textChunks: text.length,
    trailingBytes: trailing,
    complete: endedAt !== null,
  };
}

/** Look for the things people actually hide text in inside an SVG. */
export function svgReport(text) {
  const src = String(text || "");
  const comments = src.match(/<!--[\s\S]*?-->/g) || [];
  const ids = [...src.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);
  const texts = [...src.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].trim());
  const firstLetters = ids
    .map((id) => id.replace(/[^A-Za-z]/g, "").charAt(0))
    .join("")
    .toLowerCase();
  return {
    isSvg: /<svg[\s>]/i.test(src),
    comments: comments.length,
    commentText: comments.map((c) => c.replace(/<!--|-->/g, "").trim()).filter(Boolean),
    ids: ids.length,
    idAcrostic: firstLetters,
    textElements: texts.length,
    metadata: /<metadata[\s>]/i.test(src),
  };
}

/* ----------------------------------------------------------------- verdict */

/**
 * Combine the signals into one verdict.
 * `secret` is what the carrier claims to hold (only known to the hider).
 */
export function analyze({ imageData, fileBytes, mime = "", text = "" } = {}) {
  const findings = [];
  const add = (id, severity, detail) => findings.push({ id, severity, detail });

  let lsb = null;
  let balance = null;
  if (imageData && imageData.data && imageData.data.length >= 4) {
    lsb = lsbPairTest(imageData.data);
    balance = lsbBalance(imageData.data);
    if (lsb.applicable && lsb.pValue < 0.01) {
      add(
        "lsb.pairs",
        "strong",
        `LSB value pairs are far more balanced than a camera image (chi2=${lsb.chi2}, df=${lsb.df}, p=${lsb.pValue}). This is the classic signature of LSB replacement.`,
      );
    } else if (lsb.applicable && lsb.pValue < 0.2) {
      add(
        "lsb.pairs",
        "weak",
        `LSB pairs lean uniform (chi2=${lsb.chi2}, df=${lsb.df}, p=${lsb.pValue}); weak evidence, can also come from heavy editing.`,
      );
    }
    if (balance.flatChannels > 0) {
      add(
        "lsb.flat",
        "weak",
        `${balance.flatChannels} RGB channel(s) have a nearly constant least significant bit (${balance.ratios.join(
          " / ",
        )}); a wiped or synthetic plane does this.`,
      );
    }
  }

  if (fileBytes && fileBytes.length) {
    const png = pngReport(fileBytes);
    if (png.isPng) {
      if (png.textChunks > 0) {
        add("png.text", "strong", `${png.textChunks} PNG text chunk(s) carry metadata a viewer never shows.`);
      }
      if (png.trailingBytes > 0) {
        add(
          "png.trailing",
          "strong",
          `${png.trailingBytes} bytes follow IEND. PNG readers ignore them; a decoder does not.`,
        );
      }
      if (!png.complete) add("png.truncated", "info", "The PNG stream has no IEND; the file is truncated.");
    }
  }

  if (text && /<svg[\s>]/i.test(text)) {
    const svg = svgReport(text);
    if (svg.comments > 0) {
      add("svg.comments", "strong", `${svg.comments} SVG comment(s) are invisible in the rendering.`);
    }
    if (svg.metadata) add("svg.metadata", "weak", "The SVG carries a <metadata> block.");
  }

  const strong = findings.filter((f) => f.severity === "strong").length;
  const weak = findings.filter((f) => f.severity === "weak").length;
  const verdict = strong > 0 ? "evidence" : weak > 0 ? "suspicion" : "clean";
  return { verdict, findings, lsb, balance, mime };
}
