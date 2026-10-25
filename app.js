/**
 * app.js — MURMUR's UI. No framework, no bundler: one module and ./lib.
 *
 * Rules this file follows:
 *  - the key never leaves this origin except in an Authorization header;
 *  - every model call is explicit and priced before it happens;
 *  - nothing that was measured is reported as a guess, and nothing that was
 *    guessed is reported as measured.
 */

import {
  bitErrorRate,
  capacityBytes,
  embed,
  embedSequential,
  encodePayload,
  encryptPayload,
  extract,
  extractRaw,
  readHeader,
  ENVELOPE_OVERHEAD,
} from "./lib/stego.js";
import { analyze } from "./lib/detect.js";
import {
  DEFAULT_TEXT_MODEL,
  LIMITS,
  chat,
  estimateChatCost,
  fail,
  fetchCatalog,
  generateImage,
  pollDeviceToken,
  requestDeviceCode,
} from "./lib/api.js";
import { SEEK_QUESTION, SEEK_SYSTEM, parseSeekAnswer, slugify } from "./lib/prompt.js";
import {
  blobToBytes,
  decodeImage,
  download,
  encodePng,
  noiseCarrier,
  simulatePipeline,
  toModelDataUrl,
} from "./lib/canvas.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const KEY_STORAGE = "murmurKey";
const MODEL_STORAGE = "murmurModel";

const state = {
  token: readStorage(KEY_STORAGE),
  catalog: null,
  cover: null,
  coverBytes: null,
  output: null,
  outputBytes: null,
  secretBytes: null,
  hideSeed: 0,
  seek: null,
  poll: null,
  benchBusy: false,
};

/* --------------------------------------------------------------- utilities */

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: keep it in memory only */
  }
}

function setNote(el, text, kind = "") {
  el.textContent = text;
  el.classList.toggle("bad", kind === "bad");
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const fmtPollen = (n) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(6)} Pollen`);

/** Short adaptive price for button labels: 0.004, 0.000046, never 0.0000. */
function trimPollen(n) {
  if (!Number.isFinite(n)) return "…";
  if (n === 0) return "0";
  return String(Number(n.toPrecision(2)));
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || "Working…";
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

function paint(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

function copyCarrier(imageData) {
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data),
  };
}

function payloadBytesFor(text, passphrase) {
  const payload = {
    v: 1,
    app: "murmur",
    msg: text,
    at: new Date().toISOString(),
  };
  const plain = encodePayload(payload);
  return { plain, extra: passphrase ? ENVELOPE_OVERHEAD : 0 };
}

/* ------------------------------------------------------------------ account */

function renderAccount() {
  const pill = $("#account-state");
  const connect = $("#connect");
  const disconnect = $("#disconnect");
  const connected = Boolean(state.token);
  pill.textContent = connected
    ? state.catalog
      ? `connected · ${state.catalog.text.length} model(s) usable`
      : "connected"
    : "not connected";
  pill.classList.toggle("ok", connected);
  connect.hidden = connected;
  disconnect.hidden = !connected;
  $("#hide").disabled = !(connected && state.cover);
  $("#seek-run").disabled = !(connected && state.seek && $("#seek-ask").checked);
  $("#bench-run").disabled = !(connected && state.cover && !state.benchBusy);
}

async function connectAccount() {
  const dialog = $("#device-dialog");
  const codeEl = $("#device-code");
  const linkEl = $("#device-link");
  const statusEl = $("#device-status");
  busy($("#connect"), true, "Starting…");
  try {
    const started = await requestDeviceCode();
    if (!started.ok) {
      setNote($("#cover-note"), started.error.message, "bad");
      return;
    }
    codeEl.textContent = started.userCode || "····";
    linkEl.href = started.verificationUriComplete || started.verificationUri || "#";
    statusEl.textContent = "Waiting for approval…";
    dialog.showModal();
    window.open(linkEl.href, "_blank", "noopener,noreferrer");

    const deadline = Date.now() + started.expiresIn * 1000;
    let interval = started.interval;
    const cancelled = { value: false };
    state.poll = cancelled;
    $("#device-cancel").onclick = () => {
      cancelled.value = true;
      dialog.close();
    };
    while (!cancelled.value && Date.now() < deadline) {
      await sleep(interval * 1000);
      if (cancelled.value) break;
      const polled = await pollDeviceToken({ deviceCode: started.deviceCode, interval });
      if (polled.ok) {
        state.token = polled.token;
        writeStorage(KEY_STORAGE, polled.token);
        dialog.close();
        await loadCatalog();
        renderAccount();
        return;
      }
      if (polled.pending) {
        interval = polled.interval || interval;
        statusEl.textContent = `Waiting for approval… (${Math.round((deadline - Date.now()) / 1000)}s left)`;
        continue;
      }
      statusEl.textContent = polled.error.message;
      return;
    }
  } finally {
    busy($("#connect"), false);
    state.poll = null;
  }
}

function disconnectAccount() {
  state.token = "";
  state.catalog = null;
  writeStorage(KEY_STORAGE, "");
  renderAccount();
  renderCostLines();
}

async function loadCatalog() {
  const cat = await fetchCatalog({ token: state.token });
  if (!cat.ok) {
    state.catalog = null;
    return cat;
  }
  state.catalog = cat;
  const select = $("#bench-model");
  select.innerHTML = "";
  const models = cat.vision.length ? cat.vision : cat.text;
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    select.append(opt);
  }
  const saved = readStorage(MODEL_STORAGE);
  if (saved && models.includes(saved)) select.value = saved;
  // The cheapest cover model changes with the live catalogue; price the
  // button from it instead of the hardcoded ~0.004 label.
  const cover = cat.image[0];
  const coverBtn = $("#generate-cover");
  if (cover && cat.imageEst && Number.isFinite(cat.imageEst[cover])) {
    coverBtn.textContent = `Generate cover · ~${trimPollen(cat.imageEst[cover])} Pollen`;
  } else if (cover) {
    coverBtn.textContent = "Generate cover";
  }
  renderCostLines();
  return cat;
}

function visionModel() {
  const select = $("#bench-model");
  const chosen = select.value;
  if (chosen && state.catalog && state.catalog.vision.includes(chosen)) return chosen;
  if (state.catalog && state.catalog.vision.length) return state.catalog.vision[0];
  return "";
}

function renderCostLines() {
  const model = visionModel();
  const estimate = model
    ? estimateChatCost({ pricing: state.catalog && state.catalog.pricing, model, images: 1 })
    : null;
  $("#seek-cost").textContent = model
    ? `One 512px image + a short answer ≈ ${fmtPollen(estimate && estimate.pollen)}.`
    : state.token
      ? "No vision-capable model is available to this account right now."
      : "Connect to price this call.";
  $("#bench-cost").textContent = !state.cover
    ? "Load a cover first: the matrix runs in this tab and costs nothing."
    : state.catalog
      ? "Runs entirely in this tab: no model calls, no Pollen."
      : "Connect to run the matrix.";
}

/* -------------------------------------------------------------------- cover */

async function generateCover() {
  if (!state.token) return setNote($("#cover-note"), "Connect your Pollen account first.", "bad");
  const prompt = $("#cover-prompt").value.trim();
  const model = (state.catalog && state.catalog.image && state.catalog.image[0]) || undefined;
  busy($("#generate-cover"), true, "Generating…");
  setNote($("#cover-note"), "Asking Pollinations for a cover…");
  try {
    const res = await generateImage({ token: state.token, prompt, model, width: 1024, height: 1024 });
    if (!res.ok) return setNote($("#cover-note"), res.error.message, "bad");
    const blob = await (await fetch(`data:image/png;base64,${res.b64}`)).blob();
    const imageData = await decodeImage(blob);
    setCover(imageData, new Uint8Array(await blob.arrayBuffer()));
    setNote($("#cover-note"), `Cover ready · ${res.model || model || "default model"}`);
  } catch (e) {
    setNote($("#cover-note"), e && e.message ? e.message : "Could not read the generated image.", "bad");
  } finally {
    busy($("#generate-cover"), false);
    renderAccount();
  }
}

function setCover(imageData, bytes) {
  state.cover = imageData;
  state.coverBytes = bytes || null;
  paint($("#cover-canvas"), imageData);
  $("#result-card").hidden = true;
  state.output = null;
  state.outputBytes = null;
  renderCapacity();
  renderAccount();
  renderCostLines();
}

async function useOwnImage(file) {
  try {
    const imageData = await decodeImage(file);
    setCover(imageData, await blobToBytes(file));
    setNote($("#cover-note"), `Using your image · ${imageData.width}×${imageData.height}`);
  } catch {
    setNote($("#cover-note"), "That file is not an image this browser can decode.", "bad");
  }
}

function renderCapacity() {
  const capacity = state.cover ? capacityBytes(state.cover.width, state.cover.height) : 0;
  const text = $("#secret").value;
  const passphrase = $("#passphrase").value;
  const { plain, extra } = payloadBytesFor(text, passphrase);
  const needed = plain.length + extra;
  const ratio = capacity ? needed / capacity : 0;
  const fill = $("#capacity-fill");
  fill.style.width = `${Math.min(100, ratio * 100).toFixed(2)}%`;
  fill.classList.toggle("over", ratio > 1);
  const textEl = $("#capacity-text");
  if (!state.cover) {
    textEl.textContent = "Load a cover to see the capacity.";
  } else if (!text.trim()) {
    textEl.textContent = `Capacity ${fmtBytes(capacity)} · nothing to hide yet.`;
  } else {
    textEl.textContent = `Needs ${fmtBytes(needed)} of ${fmtBytes(capacity)} · ${(ratio * 100).toFixed(
      2,
    )}% of the carrier${ratio > 1 ? " — too large" : ""}`;
  }
  $("#hide").disabled = !(state.token && state.cover && text.trim() && ratio <= 1);
}

/* --------------------------------------------------------------------- hide */

async function hideMessage() {
  if (!state.cover) return;
  const text = $("#secret").value;
  const passphrase = $("#passphrase").value;
  const { plain, extra } = payloadBytesFor(text, passphrase);
  if (plain.length + extra > capacityBytes(state.cover.width, state.cover.height)) {
    return setNote($("#hide-note"), "The message does not fit in this cover.", "bad");
  }
  busy($("#hide"), true, "Hiding…");
  setNote($("#hide-note"), "Embedding into the least significant bits…");
  try {
    const sealed = passphrase ? await encryptPayload(plain, passphrase) : { bytes: plain, encrypted: false };
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0 || 1;
    const carrier = copyCarrier(state.cover);
    const result = embed(carrier, sealed.bytes, { seed, encrypted: sealed.encrypted });
    if (!result.ok) return setNote($("#hide-note"), `Embedding failed: ${result.reason}`, "bad");
    const blob = await encodePng(carrier);
    state.output = carrier;
    state.outputBytes = sealed.bytes;
    state.hideSeed = seed;
    paint($("#out-canvas"), carrier);
    $("#result-card").hidden = false;
    $("#download").onclick = () =>
      download(blob, `murmur-${slugify(text)}-${seed.toString(16).slice(0, 6)}.png`);
    setNote($("#hide-note"), `Hidden · ${fmtBytes(sealed.bytes.length)} payload · seed ${seed}`);
    await renderSurvival(carrier, sealed.bytes);
  } finally {
    busy($("#hide"), false);
  }
}

/**
 * What a platform does to the file, measured here. A row is "intact" only when
 * the payload survives the round trip with a matching CRC.
 */
async function renderSurvival(carrier, payload) {
  const rows = [
    { label: "PNG, re-encoded", opts: { type: "image/png" } },
    { label: "JPEG 95%", opts: { type: "image/jpeg", quality: 0.95 } },
    { label: "JPEG 85%", opts: { type: "image/jpeg", quality: 0.85 } },
    { label: "JPEG 70%", opts: { type: "image/jpeg", quality: 0.7 } },
    { label: "Resized to 75% (PNG)", opts: { type: "image/png", scale: 0.75 } },
    { label: "Resized to 50% (PNG)", opts: { type: "image/png", scale: 0.5 } },
  ];
  const body = $("#survival-body");
  body.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = row.label;
    const tdState = document.createElement("td");
    const tdErr = document.createElement("td");
    try {
      const after = await simulatePipeline(carrier, row.opts);
      const read = extractRaw(after.imageData);
      if (!read.ok) {
        tdState.textContent = `gone (${read.reason.toLowerCase().replace(/_/g, " ")})`;
        tdState.className = "broken";
        tdErr.textContent = "100%";
      } else {
        const ber = bitErrorRate(read.bytes, payload);
        const intact = read.crcOk && ber === 0;
        tdState.textContent = intact ? "intact" : "corrupted";
        tdState.className = intact ? "intact" : "broken";
        tdErr.textContent = `${(ber * 100).toFixed(2)}%`;
      }
    } catch {
      tdState.textContent = "could not test";
      tdState.className = "broken";
      tdErr.textContent = "—";
    }
    tr.append(tdLabel, tdState, tdErr);
    body.append(tr);
  }
}

/* --------------------------------------------------------------------- seek */

async function seekFile(file) {
  const result = $("#seek-result");
  result.innerHTML = "";
  state.seek = { file };
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  let report = null;
  let imageData = null;
  const bytes = await blobToBytes(file);
  if (isSvg) {
    const text = new TextDecoder().decode(bytes);
    report = analyze({ text, mime: file.type });
  } else {
    try {
      imageData = await decodeImage(file);
    } catch {
      result.append(el("p", "Could not decode that image.", "hint"));
      return;
    }
    report = analyze({ imageData, fileBytes: bytes, mime: file.type });
  }
  state.seek.imageData = imageData;

  result.append(verdictBadge(report.verdict));
  const list = document.createElement("ul");
  list.className = "findings";
  for (const f of report.findings) {
    const li = document.createElement("li");
    li.className = f.severity;
    li.append(el("code", f.id), document.createTextNode(` — ${f.detail}`));
    list.append(li);
  }
  if (!report.findings.length) {
    list.append(el("li", "No deterministic evidence: I did not find a payload, and I did not find a reason to think one is there. Absence of evidence, not proof of absence.", "info"));
  }
  result.append(list);
  if (report.lsb && report.lsb.applicable) {
    result.append(
      el(
        "p",
        `LSB pair test: chi²=${report.lsb.chi2}, df=${report.lsb.df}, p=${report.lsb.pValue} (p<0.01 is the strong band; ${report.lsb.samples} samples).`,
        "hint",
      ),
    );
  }

  if (imageData) {
    const header = readHeader(imageData);
    if (header.ok) result.append(await murmurPanel(imageData, header));
  }
  renderCostLines();
  $("#seek-model-card").hidden = false;
  $("#seek-ask").checked = false;
  $("#seek-run").disabled = true;
  $("#seek-answer").innerHTML = "";
}

async function murmurPanel(imageData, header) {
  const box = document.createElement("div");
  box.className = "stack";
  box.append(
    el(
      "p",
      header.encrypted
        ? `MURMUR payload found · ${fmtBytes(header.length)} · encrypted. The passphrase is required to read it.`
        : `MURMUR payload found · ${fmtBytes(header.length)} · not encrypted.`,
      "hint",
    ),
  );
  if (!header.encrypted) {
    const read = await extract(imageData);
    if (read.ok) box.append(el("p", `“${read.payload.msg}”`, "answer"));
    return box;
  }
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Passphrase";
  const button = document.createElement("button");
  button.className = "btn";
  button.textContent = "Decrypt";
  const out = document.createElement("p");
  button.onclick = async () => {
    button.disabled = true;
    const read = await extract(imageData, { passphrase: input.value });
    out.textContent = read.ok ? `“${read.payload.msg}”` : `Could not read it (${read.reason}).`;
    button.disabled = false;
  };
  box.append(input, button, out);
  return box;
}

function verdictBadge(verdict) {
  const map = {
    evidence: "something is hidden here",
    suspicion: "weak signals",
    clean: "nothing found",
  };
  return el("span", map[verdict] || "inconclusive", `verdict ${verdict}`);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function askModel() {
  const model = visionModel();
  if (!state.seek || !state.seek.imageData || !model) return;
  const answer = $("#seek-answer");
  answer.innerHTML = "";
  busy($("#seek-run"), true, "Asking…");
  try {
    const { dataUrl } = await toModelDataUrl(state.seek.imageData, 512);
    const res = await chat({
      token: state.token,
      model,
      messages: [
        { role: "system", content: SEEK_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: SEEK_QUESTION },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      maxTokens: 300,
    });
    if (!res.ok) {
      answer.append(el("p", res.error.message, "hint"));
      return;
    }
    const parsed = parseSeekAnswer(res.text);
    if (!parsed.ok) {
      answer.append(el("p", "The model answered outside the requested shape, so it is not counted.", "hint"));
      answer.append(el("pre", res.text.slice(0, 400), "hint"));
      return;
    }
    answer.append(verdictBadge(parsed.hasMessage ? "suspicion" : "clean"));
    answer.append(
      el(
        "p",
        `${parsed.hasMessage ? "It thinks something is hidden" : "It thinks nothing is hidden"} · confidence ${(
          parsed.confidence * 100
        ).toFixed(0)}% · ${model}`,
        "hint",
      ),
    );
    if (parsed.evidence) answer.append(el("p", parsed.evidence));
    if (parsed.guess) answer.append(el("p", `Guess: ${parsed.guess}`, "hint"));
  } finally {
    busy($("#seek-run"), false);
  }
}

/* -------------------------------------------------------------------- bench */

/**
 * A local detection matrix: how often our own chi-square test notices a payload,
 * per embedding style. Costs nothing and calls no model, so the claim "spreading
 * defeats the classic test" is something the reader can reproduce in one click.
 */
async function runBench() {
  if (!state.cover || state.benchBusy) return;
  state.benchBusy = true;
  renderAccount();
  const out = $("#bench-out");
  out.innerHTML = "";
  const trials = Math.max(2, Math.min(LIMITS.benchMax, Number($("#bench-n") && $("#bench-n").value) || 8));
  const styles = [
    { key: "clean", label: "no payload", apply: () => {} },
    { key: "seq", label: "naive sequential LSB", apply: (img, bytes) => embedSequential(img, bytes) },
    { key: "spread", label: "MURMUR spread", apply: (img, bytes) => embed(img, bytes, { seed: randomSeed() }) },
  ];
  const secret = encodePayload({ v: 1, app: "murmur-bench", msg: "x".repeat(120), at: "bench" });
  const rows = [];
  for (const style of styles) {
    let flagged01 = 0;
    let flagged05 = 0;
    let applicable = 0;
    for (let i = 0; i < trials; i += 1) {
      const carrier = copyCarrier(state.cover);
      style.apply(carrier, secret);
      const report = analyze({ imageData: carrier });
      if (!report.lsb || !report.lsb.applicable) continue;
      applicable += 1;
      if (report.lsb.pValue < 0.01) flagged01 += 1;
      if (report.lsb.pValue < 0.05) flagged05 += 1;
      if (i === 0) rows.push({ style: style.label, first: report.lsb });
    }
    rows.push({
      style: style.label,
      trials: applicable,
      rate01: applicable ? flagged01 / applicable : 0,
      rate05: applicable ? flagged05 / applicable : 0,
    });
  }

  const table = document.createElement("table");
  table.className = "bench";
  table.innerHTML = `<thead><tr><th>Embedding</th><th>Flagged (p&lt;0.01)</th><th>Flagged (p&lt;0.05)</th><th>Trials</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const row of rows.filter((r) => r.trials !== undefined)) {
    const tr = document.createElement("tr");
    tr.append(el("td", row.style));
    tr.append(el("td", `${(row.rate01 * 100).toFixed(0)}%`, row.rate01 > 0.5 ? "yes" : "no"));
    tr.append(el("td", `${(row.rate05 * 100).toFixed(0)}%`, row.rate05 > 0.5 ? "yes" : "no"));
    tr.append(el("td", String(row.trials)));
    tbody.append(tr);
  }
  table.append(tbody);
  out.append(table);
  out.append(
    el(
      "p",
      `Read it this way: "no payload" is the false-positive rate, so anything near 100% for a payload style is a real signal, and a low number for MURMUR spread says the classic test alone will not find us. ${trials} trials per style, ${state.cover.width}×${state.cover.height} cover, in this tab.`,
      "hint",
    ),
  );
  state.benchBusy = false;
  renderAccount();
}

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0 || 1;
}

/* --------------------------------------------------------------------- wire */

function init() {
  $$(".tabs button").forEach((button) => {
    button.onclick = () => {
      $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
      for (const panel of $$(".panel")) panel.hidden = panel.id !== `panel-${button.dataset.tab}`;
    };
  });

  $("#connect").onclick = connectAccount;
  $("#disconnect").onclick = disconnectAccount;
  $("#generate-cover").onclick = generateCover;
  $("#cover-file").onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) useOwnImage(file);
    e.target.value = "";
  };
  $("#secret").oninput = renderCapacity;
  $("#passphrase").oninput = renderCapacity;
  $("#hide").onclick = hideMessage;
  $("#seek-file").onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) seekFile(file);
    e.target.value = "";
  };
  $("#seek-ask").onchange = () => {
    $("#seek-run").disabled = !(state.token && state.seek && $("#seek-ask").checked);
  };
  $("#seek-run").onclick = askModel;
  $("#bench-model").onchange = () => {
    writeStorage(MODEL_STORAGE, $("#bench-model").value);
    renderCostLines();
  };
  $("#bench-run").onclick = runBench;

  renderAccount();
  renderCapacity();
  renderCostLines();
  if (state.token) loadCatalog().then(renderAccount);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (typeof document !== "undefined") init();

export { fail };
