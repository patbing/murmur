/**
 * lib/api.js — everything MURMUR sends to Pollinations, and nothing else.
 *
 * The reader's key lives in localStorage in this tab's origin and is only ever
 * sent in an Authorization header. No key in a query string: a URL ends up in
 * proxy logs, CDN logs, HAR files and browser history.
 *
 * Pure-ish: every function takes `fetchImpl` so the tests can drive it.
 */

export const API_BASE = "https://gen.pollinations.ai";
export const ENTER_BASE = "https://enter.pollinations.ai";

export const CHAT_URL = `${API_BASE}/v1/chat/completions`;
export const IMAGE_URL = `${API_BASE}/v1/images/generations`;
export const MODELS_URL = `${API_BASE}/v1/models`;
export const MODELS_STATUS_URL = `${API_BASE}/models/status`;
export const DEVICE_CODE_URL = `${ENTER_BASE}/api/device/code`;
export const DEVICE_TOKEN_URL = `${ENTER_BASE}/api/device/token`;

/** Cover generator: tier-eligible and 0.004 Pollen per image (2026-10-25). */
export const DEFAULT_IMAGE_MODEL = "tongyi-mai/z-image-turbo";
export const FALLBACK_IMAGE_MODEL = "black-forest-labs/flux.1-schnell";

/** Text models we are willing to call, cheapest vision-capable first. */
export const ALLOWED_TEXT_MODELS = [
  "openai/gpt-5.4-nano",
  "openai/gpt-5.6-luna",
  "deepseek/deepseek-v4.1-flash",
];
export const DEFAULT_TEXT_MODEL = "openai/gpt-5.4-nano";

export const LIMITS = {
  secretMax: 2000, // characters
  passphraseMax: 200,
  promptMax: 600,
  requestTimeoutMs: 45000,
  imageTimeoutMs: 120000,
  benchMax: 20,
};

/** Reference prices (pollen per token) if the live sheet cannot be read. */
export const REFERENCE_PRICING = {
  "openai/gpt-5.4-nano": { promptTextTokens: 0.00000015, completionTextTokens: 0.0000009375 },
  "openai/gpt-5.6-luna": { promptTextTokens: 0.00000015, completionTextTokens: 0.0000009 },
  "deepseek/deepseek-v4.1-flash": { promptTextTokens: 0.00000015, completionTextTokens: 0.0000006 },
};

export function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/* --------------------------------------------------------------- device flow */

export async function requestDeviceCode({ fetchImpl = fetch, clientId = "" } = {}) {
  let res;
  try {
    res = await fetchImpl(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clientId ? { client_id: clientId } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }
  if (!res.ok) return fail("PROVIDER_ERROR", `Could not start sign-in (HTTP ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    return fail("PROVIDER_ERROR", "Pollinations returned an unreadable sign-in response.");
  }
  if (!data || !data.device_code) return fail("PROVIDER_ERROR", "No device code in the response.");
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code || "",
    verificationUri: data.verification_uri || "",
    verificationUriComplete: data.verification_uri_complete || "",
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 1800,
  };
}

/**
 * One poll. Returns { ok:true, token } or { ok:false, pending:true, interval }.
 * `slow_down` widens the interval exactly as the provider asks.
 */
export async function pollDeviceToken({ fetchImpl = fetch, deviceCode, interval = 5, clientId = "" } = {}) {
  if (!deviceCode) return fail("AUTH_REQUIRED", "Start the sign-in flow first.");
  let res;
  try {
    res = await fetchImpl(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clientId ? { device_code: deviceCode, client_id: clientId } : { device_code: deviceCode }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (data && typeof data.access_token === "string" && data.access_token.startsWith("sk_")) {
    return { ok: true, token: data.access_token };
  }
  const err = (data && data.error) || "";
  if (err === "slow_down") return { ok: false, pending: true, interval: Math.min(30, interval + 5) };
  if (err === "authorization_pending") return { ok: false, pending: true, interval };
  if (err === "expired_token" || err === "access_denied") {
    return fail("AUTH_REJECTED", "The sign-in request expired or was denied. Start again.");
  }
  if (res.status === 429 || res.status >= 500) return { ok: false, pending: true, interval };
  // Any other 4xx with a body we do not recognise (bad device_code, unknown
  // grant, …) will never turn into a token by waiting, so stop polling.
  if (res.status >= 400 && res.status < 500) {
    return fail("AUTH_REJECTED", "Could not complete sign-in. Start again.");
  }
  if (!res.ok) return { ok: false, pending: true, interval };
  return fail("AUTH_REJECTED", "Could not complete sign-in. Start again.");
}

/* ------------------------------------------------------------------ catalog */

/**
 * Read the live catalogue once and decide what we may call.
 * Only an explicit `paid_only: false` is usable, so a reader whose balance is
 * Quest Pollen is never handed a paid-only model.
 */
export async function fetchCatalog({ fetchImpl = fetch, token } = {}) {
  if (!token) return fail("AUTH_REQUIRED", "Connect your Pollen account first.");
  let res;
  try {
    res = await fetchImpl(MODELS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("OFFLINE", "Could not read the model catalogue.");
  }
  if (!res.ok) return fail("PROVIDER_ERROR", `Model catalogue unavailable (HTTP ${res.status}).`);
  let body;
  try {
    body = await res.json();
  } catch {
    return fail("PROVIDER_ERROR", "Model catalogue was not JSON.");
  }
  const items = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];
  const byId = new Map(items.map((m) => [m && m.id, m]));

  const text = [];
  const vision = [];
  const pricing = { ...REFERENCE_PRICING };
  for (const id of ALLOWED_TEXT_MODELS) {
    const m = byId.get(id);
    if (!m || m.paid_only !== false) continue;
    text.push(id);
    const inMods = Array.isArray(m.input_modalities) ? m.input_modalities : [];
    if (inMods.includes("image")) vision.push(id);
    const p = m.pricing || {};
    const inRate = Number(p.promptTextTokens);
    const outRate = Number(p.completionTextTokens);
    if (Number.isFinite(inRate) && Number.isFinite(outRate)) {
      pricing[id] = {
        promptTextTokens: inRate,
        completionTextTokens: outRate,
        promptImageTokens: Number(p.promptImageTokens) || 0,
      };
    }
  }

  const image = [];
  const imagePricing = {};
  const imageEst = {};
  for (const [id, m] of byId) {
    if (!m || m.paid_only !== false) continue;
    const outs = Array.isArray(m.output_modalities) ? m.output_modalities : [];
    if (!outs.includes("image")) continue;
    image.push(id);
    const per = Number((m.pricing || {}).completionImageTokens);
    if (Number.isFinite(per)) {
      imagePricing[id] = per;
      // ~40 prompt tokens for a cover description; keeps the button honest
      // when the cheapest model prices prompt and image separately.
      const promptRate = Number((m.pricing || {}).promptTextTokens) || 0;
      imageEst[id] = per + 40 * promptRate;
    }
  }
  image.sort((a, b) => (imagePricing[a] ?? 9) - (imagePricing[b] ?? 9));

  return { ok: true, text, vision, image, pricing, imagePricing, imageEst };
}

/* --------------------------------------------------------------------- chat */

/** Estimate a chat call in pollen, including a rough per-image token charge. */
export function estimateChatCost({ pricing, model, promptTokens = 900, completionTokens = 80, images = 0 }) {
  const sheet = (pricing && pricing[model]) || REFERENCE_PRICING[model];
  if (!sheet) return null;
  const imageRate = Number(sheet.promptImageTokens) || 0;
  // A 1024px image is ~1,300 tokens on the OpenAI family; we downscale to 512.
  const imageTokens = images * 400;
  const pollen =
    (promptTokens + imageTokens) * Number(sheet.promptTextTokens || 0) +
    completionTokens * Number(sheet.completionTextTokens || 0) +
    imageTokens * imageRate;
  return { pollen, imageTokens };
}

export async function chat({
  fetchImpl = fetch,
  token,
  model = DEFAULT_TEXT_MODEL,
  messages,
  maxTokens = 700,
  temperature = 0.2,
  timeoutMs = LIMITS.requestTimeoutMs,
} = {}) {
  if (!token) return fail("AUTH_REQUIRED", "Connect your Pollen account first.");
  if (!Array.isArray(messages) || messages.length === 0) return fail("BAD_REQUEST", "Empty conversation.");
  // The library is permissive about model ids on purpose: the catalogue decides
  // what exists. Callers must pass a catalogue-filtered id (app.js visionModel()
  // only returns paid_only:false entries). Reject only malformed ids here.
  if (typeof model !== "string" || !model || /\s/.test(model) || model.length > 200) {
    return fail("BAD_REQUEST", "Unknown model.");
  }
  let res;
  try {
    res = await fetchImpl(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(timedOut ? "TIMEOUT" : "OFFLINE", timedOut ? "The model took too long." : "Offline.");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return { ok: false, error: mapUpstreamError(res.status, body) };
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
  const usage = (body && body.usage) || {};
  return {
    ok: true,
    text,
    finishReason: (choice && choice.finish_reason) || "",
    usage: {
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
    },
  };
}

/* -------------------------------------------------------------------- image */

/**
 * Generate a cover. Uses the JSON endpoint (key in the header) and asks for
 * base64 so the bytes never leave the browser.
 */
export async function generateImage({
  fetchImpl = fetch,
  token,
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  width = 1024,
  height = 1024,
  seed = -1,
  timeoutMs = LIMITS.imageTimeoutMs,
} = {}) {
  if (!token) return fail("AUTH_REQUIRED", "Connect your Pollen account first.");
  if (!prompt || !String(prompt).trim()) return fail("BAD_REQUEST", "Describe the cover first.");
  if (typeof model !== "string" || !model || /\s/.test(model) || model.length > 200) {
    return fail("BAD_REQUEST", "Unknown model.");
  }
  let res;
  try {
    res = await fetchImpl(IMAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: String(prompt).slice(0, LIMITS.promptMax),
        model,
        n: 1,
        size: `${width}x${height}`,
        response_format: "b64_json",
        seed,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(timedOut ? "TIMEOUT" : "OFFLINE", timedOut ? "The image took too long." : "Offline.");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return { ok: false, error: mapUpstreamError(res.status, body) };
  const first = body && Array.isArray(body.data) ? body.data[0] : null;
  const b64 = first && (first.b64_json || first.b64);
  if (!b64) return fail("PROVIDER_ERROR", "The image response had no data.");
  return { ok: true, b64, model };
}

/* ------------------------------------------------------------------- errors */

export function mapUpstreamError(status, body) {
  const text = JSON.stringify(body || {}).toLowerCase();
  const message = (body && (body.error?.message || body.message || body.error)) || "";
  if (status === 401) return { code: "AUTH_REJECTED", message: "That Pollen key was rejected. Reconnect." };
  if (status === 402) return { code: "BALANCE_REQUIRED", message: "Not enough eligible Pollen." };
  if (status === 429) return { code: "RATE_LIMITED", message: "Rate limited. Try again shortly." };
  if (status === 403) {
    if (/invalid.{0,12}(api[ _-]?key|token)|unauthorized/.test(text)) {
      return { code: "AUTH_REJECTED", message: "That Pollen key was rejected. Reconnect." };
    }
    if (/insufficient.{0,20}(balance|credit|funds|pollen)/.test(text)) {
      return { code: "BALANCE_REQUIRED", message: "Not enough eligible Pollen." };
    }
  }
  return {
    code: "PROVIDER_ERROR",
    message: typeof message === "string" && message ? message.slice(0, 300) : `Provider error (HTTP ${status}).`,
  };
}
