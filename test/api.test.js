import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_URL,
  DEVICE_CODE_URL,
  DEVICE_TOKEN_URL,
  IMAGE_URL,
  MODELS_URL,
  chat,
  estimateChatCost,
  fetchCatalog,
  generateImage,
  mapUpstreamError,
  pollDeviceToken,
  requestDeviceCode,
} from "../lib/api.js";

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  fn.calls = calls;
  return fn;
}

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const TOKEN = "sk_test_do_not_leak";

test("device code request carries no secret and returns the flow fields", async () => {
  const fetchImpl = mockFetch(() =>
    reply({
      device_code: "dev123",
      user_code: "ABCD-1234",
      verification_uri: "https://enter.pollinations.ai/device",
      verification_uri_complete: "https://enter.pollinations.ai/device?user_code=ABCD-1234",
      interval: 5,
      expires_in: 1800,
    }),
  );
  const res = await requestDeviceCode({ fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.userCode, "ABCD-1234");
  assert.equal(res.interval, 5);
  assert.equal(fetchImpl.calls[0].url, DEVICE_CODE_URL);
  assert.ok(!fetchImpl.calls[0].url.includes("sk_"));
});

test("device polling: pending, slow_down, success and expiry", async () => {
  const pending = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({ error: "authorization_pending" }, 400)),
    deviceCode: "d",
    interval: 5,
  });
  assert.equal(pending.pending, true);
  assert.equal(pending.interval, 5);

  const slow = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({ error: "slow_down" }, 400)),
    deviceCode: "d",
    interval: 5,
  });
  assert.equal(slow.interval, 10);

  const ok = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({ access_token: TOKEN, token_type: "bearer" })),
    deviceCode: "d",
    interval: 5,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.token, TOKEN);

  const expired = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({ error: "expired_token" }, 400)),
    deviceCode: "d",
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "AUTH_REJECTED");

  const down = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({}, 503)),
    deviceCode: "d",
  });
  assert.equal(down.pending, true);
});

test("catalogue keeps only paid_only:false and splits text, vision and image", async () => {
  const fetchImpl = mockFetch(() =>
    reply({
      data: [
        {
          id: "openai/gpt-5.4-nano",
          paid_only: false,
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
          pricing: { promptTextTokens: 0.00000015, completionTextTokens: 0.0000009375, promptImageTokens: 0.000006 },
        },
        { id: "deepseek/deepseek-v4.1-flash", paid_only: true, input_modalities: ["text"], output_modalities: ["text"] },
        {
          id: "tongyi-mai/z-image-turbo",
          paid_only: false,
          output_modalities: ["image"],
          pricing: { completionImageTokens: 0.004 },
        },
        {
          id: "expensive/image",
          paid_only: false,
          output_modalities: ["image"],
          pricing: { completionImageTokens: 0.03 },
        },
      ],
    }),
  );
  const cat = await fetchCatalog({ fetchImpl, token: TOKEN });
  assert.equal(cat.ok, true);
  assert.deepEqual(cat.text, ["openai/gpt-5.4-nano"]);
  assert.deepEqual(cat.vision, ["openai/gpt-5.4-nano"]);
  assert.equal(cat.image[0], "tongyi-mai/z-image-turbo");
  assert.equal(cat.imagePricing["tongyi-mai/z-image-turbo"], 0.004);
  assert.equal(fetchImpl.calls[0].url, MODELS_URL);
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("catalogue estimates a cover price from prompt and image rates", async () => {
  const fetchImpl = mockFetch(() =>
    reply({
      data: [
        {
          id: "tongyi-mai/z-image-turbo",
          paid_only: false,
          output_modalities: ["image"],
          pricing: { completionImageTokens: 0.004 },
        },
        {
          id: "openai/gpt-image-1-mini",
          paid_only: false,
          output_modalities: ["image"],
          pricing: { promptTextTokens: 0.0000015, completionImageTokens: 0.000006 },
        },
      ],
    }),
  );
  const cat = await fetchCatalog({ fetchImpl, token: TOKEN });
  assert.equal(cat.ok, true);
  assert.equal(cat.image[0], "openai/gpt-image-1-mini");
  assert.ok(Math.abs(cat.imageEst["openai/gpt-image-1-mini"] - (0.000006 + 40 * 0.0000015)) < 1e-12);
  assert.equal(cat.imageEst["tongyi-mai/z-image-turbo"], 0.004);
});

test("chat sends the key in a header only and parses usage", async () => {
  const fetchImpl = mockFetch(() =>
    reply({
      choices: [{ message: { content: '{"has_message":false}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 420, completion_tokens: 12 },
    }),
  );
  const res = await chat({ fetchImpl, token: TOKEN, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.ok, true);
  assert.equal(res.usage.promptTokens, 420);
  assert.equal(fetchImpl.calls[0].url, CHAT_URL);
  assert.ok(!fetchImpl.calls[0].url.includes(TOKEN));
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.stream, false);
  assert.equal(body.model, "openai/gpt-5.4-nano");
});

test("chat maps 402 to a balance error and 401 to an auth error", async () => {
  const broke = await chat({
    fetchImpl: mockFetch(() => reply({ error: { message: "no pollen" } }, 402)),
    token: TOKEN,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(broke.ok, false);
  assert.equal(broke.error.code, "BALANCE_REQUIRED");

  const unauth = await chat({
    fetchImpl: mockFetch(() => reply({ error: { message: "bad key" } }, 401)),
    token: TOKEN,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(unauth.error.code, "AUTH_REJECTED");
});

test("image generation asks for base64 and never puts the key in the URL", async () => {
  const fetchImpl = mockFetch(() => reply({ data: [{ b64_json: "AAAA" }] }));
  const res = await generateImage({ fetchImpl, token: TOKEN, prompt: "a bench" });
  assert.equal(res.ok, true);
  assert.equal(res.b64, "AAAA");
  assert.equal(fetchImpl.calls[0].url, IMAGE_URL);
  assert.ok(!fetchImpl.calls[0].url.includes(TOKEN));
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.size, "1024x1024");
});

test("an image response without data is an error, not an empty image", async () => {
  const res = await generateImage({
    fetchImpl: mockFetch(() => reply({ data: [] })),
    token: TOKEN,
    prompt: "x",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "PROVIDER_ERROR");
});

test("cost estimates scale with the number of images", () => {
  const one = estimateChatCost({ model: "openai/gpt-5.4-nano", images: 1, promptTokens: 600 });
  const three = estimateChatCost({ model: "openai/gpt-5.4-nano", images: 3, promptTokens: 600 });
  assert.ok(one && one.pollen > 0);
  assert.ok(three.pollen > one.pollen);
  assert.equal(estimateChatCost({ model: "unknown/model" }), null);
});

test("mapUpstreamError does not treat every 403 as a balance problem", () => {
  assert.equal(mapUpstreamError(403, { error: "content policy" }).code, "PROVIDER_ERROR");
  assert.equal(mapUpstreamError(403, { error: "insufficient balance" }).code, "BALANCE_REQUIRED");
  assert.equal(mapUpstreamError(403, { error: "invalid api key" }).code, "AUTH_REJECTED");
  assert.equal(mapUpstreamError(429, {}).code, "RATE_LIMITED");
});

test("device endpoints are the documented ones", () => {
  assert.equal(DEVICE_CODE_URL, "https://enter.pollinations.ai/api/device/code");
  assert.equal(DEVICE_TOKEN_URL, "https://enter.pollinations.ai/api/device/token");
});

test("an unknown 400 stops polling instead of waiting for expiry", async () => {
  const res = await pollDeviceToken({
    fetchImpl: mockFetch(() => reply({ error: "invalid_grant" }, 400)),
    deviceCode: "d",
  });
  assert.equal(res.ok, false);
  assert.equal(res.pending, undefined);
  assert.equal(res.error.code, "AUTH_REJECTED");
});

test("malformed model ids are rejected before any request", async () => {
  for (const bad of ["", "has space", "x".repeat(201)]) {
    const r1 = await chat({ fetchImpl: mockFetch(() => reply({})), token: TOKEN, model: bad, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, "BAD_REQUEST");
    const r2 = await generateImage({ fetchImpl: mockFetch(() => reply({})), token: TOKEN, model: bad, prompt: "x" });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, "BAD_REQUEST");
  }
});

test("long prompts are cut to the documented limit", async () => {
  const fetchImpl = mockFetch(() => reply({ data: [{ b64_json: "AAAA" }] }));
  await generateImage({ fetchImpl, token: TOKEN, prompt: "x".repeat(2000) });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.ok(body.prompt.length <= 600, `prompt sent with ${body.prompt.length} chars`);
});
