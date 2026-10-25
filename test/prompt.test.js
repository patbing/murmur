import test from "node:test";
import assert from "node:assert/strict";

import { parseSeekAnswer, slugify } from "../lib/prompt.js";

test("parses a bare JSON answer", () => {
  const parsed = parseSeekAnswer('{"has_message": true, "confidence": 0.7, "evidence": "faint text", "guess": "nine pm"}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hasMessage, true);
  assert.equal(parsed.confidence, 0.7);
  assert.equal(parsed.guess, "nine pm");
});

test("parses JSON wrapped in fences or prose", () => {
  const parsed = parseSeekAnswer('Sure.\n```json\n{"has_message": false, "confidence": 0.2, "evidence": ""}\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hasMessage, false);
  assert.equal(parsed.evidence, "");
});

test("rejects answers without a boolean verdict", () => {
  assert.equal(parseSeekAnswer("I think there is something hidden.").ok, false);
  assert.equal(parseSeekAnswer('{"confidence": 0.9}').ok, false);
  assert.equal(parseSeekAnswer('{"has_message": "yes"}').ok, false);
});

test("clamps confidence instead of trusting it", () => {
  assert.equal(parseSeekAnswer('{"has_message": true, "confidence": 5}').confidence, 1);
  assert.equal(parseSeekAnswer('{"has_message": true, "confidence": -3}').confidence, 0);
  assert.equal(parseSeekAnswer('{"has_message": true}').confidence, 0.5);
});

test("truncates runaway evidence instead of storing it", () => {
  const parsed = parseSeekAnswer(
    JSON.stringify({ has_message: true, confidence: 0.5, evidence: "x".repeat(2000), guess: "y".repeat(2000) }),
  );
  assert.equal(parsed.evidence.length, 400);
  assert.equal(parsed.guess.length, 200);
});

test("slugify keeps filenames boring", () => {
  assert.equal(slugify("Meet me at the second bench, 9pm."), "meet-me-at-the-second-bench-9pm");
  assert.equal(slugify("벤치"), "murmur");
  assert.equal(slugify(""), "murmur");
});
