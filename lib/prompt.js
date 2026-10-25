/**
 * lib/prompt.js — the one place text sent to a model is written.
 *
 * The seek prompt asks for a judgement, not a story: a model that is invited to
 * be creative will always find a hidden message, which is unusable evidence.
 */

export const SEEK_SYSTEM = `You are inspecting one image for signs that a message was hidden in it on purpose.

Look for: text that a viewer would not read as part of the picture; data carried by
near-identical colour steps; deliberate arrangements (counts, first letters, repeated
shapes) that look designed rather than photographed; metadata-like artefacts that
survive rendering.

Rules:
- Most images have nothing hidden. Say so unless the evidence is concrete.
- Cite what you actually see, in one sentence, with the region (e.g. "lower left").
- Never invent a decoded message. You are reporting evidence, not solving a puzzle.
- Answer with JSON only, no prose around it.

Shape:
{"has_message": true|false, "confidence": 0.0-1.0, "evidence": "one sentence", "guess": "short guess or empty string"}`;

export const SEEK_QUESTION = `Does this image carry a hidden message? Answer with the JSON object only.`;

/** Parse the model's answer without trusting it. */
export function parseSeekAnswer(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, reason: "NO_JSON", text: raw.slice(0, 300) };
  }
  let value;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "BAD_JSON", text: raw.slice(0, 300) };
  }
  if (typeof value.has_message !== "boolean") return { ok: false, reason: "NO_VERDICT" };
  let confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  const evidence = typeof value.evidence === "string" ? value.evidence.trim().slice(0, 400) : "";
  const guess = typeof value.guess === "string" ? value.guess.trim().slice(0, 200) : "";
  return { ok: true, hasMessage: value.has_message, confidence, evidence, guess };
}

/** A cheap, deterministic caption used to label exported files. */
export function slugify(text, max = 32) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "murmur";
}
