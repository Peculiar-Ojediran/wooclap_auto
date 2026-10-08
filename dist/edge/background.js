"use strict";
(() => {
  // src/shared/types.ts
  var BRIDGE_URL = "http://127.0.0.1:4318";
  var PROTOCOL_VERSION = 2;
  var DEFAULT_SETTINGS = {
    bridgeToken: "",
    model: "gpt-4.1-mini",
    mode: "suggest",
    requestLimit: 25,
    captureImages: true,
    backgroundMode: false,
    selectors: { question: "", choices: "", submit: "", confirmation: "", multiple: false, choiceClickSubmits: false }
  };
  var INITIAL_SESSION = {
    running: false,
    tabId: null,
    phase: "idle",
    detail: "Open a Wooclap question or the practice page to begin.",
    mode: "suggest",
    requestCount: 0,
    pending: null,
    log: []
  };

  // src/shared/core.ts
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function fingerprint(question) {
    const identity = {
      source: question.source,
      event: question.eventKey,
      id: question.questionId,
      text: normalizeText(question.text),
      multiple: question.multiple,
      kind: question.kind ?? "choice",
      choices: (question.kind === "sorting" ? [...question.choices].sort((a, b) => a.id.localeCompare(b.id)) : question.choices).map((c) => [c.id, normalizeText(c.text)]),
      images: question.imageKeys
    };
    const extended = {};
    if (question.wooclapType !== void 0) extended.wooclapType = question.wooclapType;
    if (question.fields !== void 0) extended.fields = question.fields.map((field) => ({
      id: field.id,
      label: normalizeText(field.label),
      kind: field.kind,
      required: field.required,
      options: field.options?.map((option) => [option.id, normalizeText(option.text)]),
      min: field.min,
      max: field.max,
      step: field.step,
      maxLength: field.maxLength
    }));
    if (question.constraints !== void 0) extended.constraints = {
      min: question.constraints.min,
      max: question.constraints.max,
      step: question.constraints.step,
      maxLength: question.constraints.maxLength,
      total: question.constraints.total,
      maxEntries: question.constraints.maxEntries,
      uniqueTargets: question.constraints.uniqueTargets
    };
    if (question.responseMode !== void 0) extended.responseMode = question.responseMode;
    if (question.application !== void 0) extended.application = question.application;
    return JSON.stringify({ ...identity, ...extended });
  }
  function decimal(value) {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match || value.length > 256) return null;
    const exponent = Number(match[4] ?? 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 324) return null;
    let coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
    let scale = (match[3]?.length ?? 0) - exponent;
    if (scale < 0) {
      coefficient *= 10n ** BigInt(-scale);
      scale = 0;
    }
    return { coefficient, scale };
  }
  function compareDecimals(left, right) {
    const a = decimal(left);
    const b = decimal(right);
    const scale = Math.max(a.scale, b.scale);
    const difference = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  function validateNumericValue(value, bounds = {}) {
    if (typeof value !== "string" || value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return "Enter a finite decimal number without units or separators.";
    const parsed = decimal(value);
    if (bounds.min !== void 0 && (!Number.isFinite(bounds.min) || compareDecimals(value, String(bounds.min)) < 0)) return "The number is below the allowed minimum.";
    if (bounds.max !== void 0 && (!Number.isFinite(bounds.max) || compareDecimals(value, String(bounds.max)) > 0)) return "The number exceeds the allowed maximum.";
    if (bounds.step !== void 0) {
      if (!Number.isFinite(bounds.step) || bounds.step <= 0) return "The question has an invalid numeric step.";
      const step = decimal(String(bounds.step));
      const origin = decimal(String(bounds.min ?? 0));
      const scale = Math.max(parsed.scale, step.scale, origin.scale);
      const offset = parsed.coefficient * 10n ** BigInt(scale - parsed.scale) - origin.coefficient * 10n ** BigInt(scale - origin.scale);
      if (offset % (step.coefficient * 10n ** BigInt(scale - step.scale)) !== 0n) return "The number does not match the allowed step.";
    }
    return null;
  }
  function exactTotal(values, total) {
    const parts = values.map((value) => decimal(value));
    const target = decimal(String(total));
    if (!target || !Number.isFinite(total)) return false;
    const scale = Math.max(target.scale, ...parts.map((part) => part.scale));
    return parts.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale), 0n) === target.coefficient * 10n ** BigInt(scale - target.scale);
  }
  function fieldValueError(field, value) {
    if (field.kind === "select") return field.options?.some((option) => option.id === value) ? null : "An answer refers to an unavailable field option.";
    if (field.kind === "number") return validateNumericValue(value, field);
    if (!value.trim() || value.length > Math.min(field.maxLength ?? 2e4, 2e4)) return "A text answer is empty or exceeds the allowed length.";
    return null;
  }
  function validateAnswerPayload(question, answer) {
    if (!answer || typeof answer.needsReview !== "boolean" || typeof answer.explanation !== "string" || answer.explanation.length > 4e3 || !Array.isArray(answer.selectedChoiceIds) || answer.selectedChoiceIds.length > 60 || answer.selectedChoiceIds.some((id) => typeof id !== "string" || id.length > 256) || Object.keys(answer).some((key) => !["selectedChoiceIds", "value", "values", "points", "explanation", "needsReview"].includes(key))) return "The AI returned an invalid answer.";
    const kind = question.kind ?? "choice";
    const ids = answer.selectedChoiceIds;
    const review = answer.needsReview;
    const hasScalar = answer.value !== void 0;
    const hasValues = answer.values !== void 0;
    const hasPoints = answer.points !== void 0;
    if (kind === "choice" || kind === "sorting" || kind === "scenario") {
      if (hasScalar || hasValues || hasPoints) return "The answer contains data for a different question type.";
      if (!review && !ids.length || new Set(ids).size !== ids.length) return "The answer has no choices or contains duplicates.";
      if (kind === "sorting" && !review && ids.length !== question.choices.length) return "Sorting requires every item exactly once.";
      if (kind !== "sorting" && (kind === "scenario" || !question.multiple) && (ids.length > 1 || !review && ids.length !== 1)) return "This question needs exactly one choice.";
      if (ids.some((id) => !question.choices.some((c) => c.id === id))) return "The answer refers to a choice that is no longer available.";
      return null;
    }
    if (ids.length) return "This question does not accept selected choices.";
    if (kind === "numeric" || kind === "text") {
      if (hasValues || hasPoints || hasScalar && typeof answer.value !== "string") return "The answer contains data for a different question type.";
      if (!hasScalar || answer.value === "") return review ? null : "The answer is empty.";
      if (kind === "numeric") return validateNumericValue(answer.value, question.constraints);
      return !answer.value.trim() || answer.value.length > Math.min(question.constraints?.maxLength ?? 2e4, 2e4) ? "The text answer is empty or exceeds the allowed length." : null;
    }
    if (["fields", "matching", "rating", "allocation", "categorized"].includes(kind)) {
      if (hasScalar || hasPoints || hasValues && !Array.isArray(answer.values)) return "The answer contains data for a different question type.";
      const values = answer.values ?? [];
      if (values.length > 60 || values.some((item) => !item || typeof item.id !== "string" || item.id.length > 256 || typeof item.value !== "string" || item.value.length > 2e4 || Object.keys(item).some((key) => key !== "id" && key !== "value"))) return "The answer contains invalid field values.";
      if (kind === "categorized") {
        if (!review && values.length === 0 || values.length > (question.constraints?.maxEntries ?? 1)) return "The answer has an invalid number of contributions.";
        if (new Set(values.map((item) => `${item.id}\0${normalizeText(item.value)}`)).size !== values.length) return "The answer contains duplicate contributions.";
        if (values.some((item) => !question.choices.some((choice) => choice.id === item.id) || !item.value.trim() || item.value.length > Math.min(question.constraints?.maxLength ?? 2e4, 2e4))) return "A contribution has an unavailable category or invalid text.";
        return null;
      }
      const fields = question.fields ?? [];
      if (!fields.length || new Set(values.map((item) => item.id)).size !== values.length) return "The answer has missing fields or duplicate field IDs.";
      if (kind === "matching" && fields.some((field) => field.kind !== "select") || ["rating", "allocation"].includes(kind) && fields.some((field) => field.kind !== "number")) return "The question has incompatible field definitions.";
      for (const item of values) {
        const field = fields.find((candidate) => candidate.id === item.id);
        if (!field) return "The answer refers to an unavailable field.";
        const error = fieldValueError(field, item.value);
        if (error) return error;
        if (kind === "allocation" && compareDecimals(item.value, "0") < 0) return "Allocated points cannot be negative.";
      }
      if (!review && fields.some((field) => field.required && !values.some((item) => item.id === field.id))) return "Every required field needs an answer.";
      if (kind === "matching" && question.constraints?.uniqueTargets && new Set(values.map((item) => item.value)).size !== values.length) return "Each matching destination can only be used once.";
      if (!review && kind === "allocation" && (question.constraints?.total === void 0 || !exactTotal(values.map((item) => item.value), question.constraints.total))) return "Allocated points must equal the required total.";
      return null;
    }
    if (kind === "point" || kind === "placements") {
      if (hasScalar || hasValues || hasPoints && !Array.isArray(answer.points)) return "The answer contains data for a different question type.";
      const points = answer.points ?? [];
      if (points.length > 60 || points.some((point) => !point || typeof point.id !== "string" || point.id.length > 256 || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || Object.keys(point).some((key) => !["id", "x", "y"].includes(key)))) return "Image points must be inside the image.";
      if (new Set(points.map((point) => point.id)).size !== points.length || points.some((point) => !question.choices.some((choice) => choice.id === point.id))) return "An image point refers to a missing or duplicate item.";
      if (kind === "point" && (points.length > 1 || !review && points.length !== 1)) return "This image question needs exactly one point.";
      if (kind === "placements" && !review && points.length !== question.choices.length) return "Every image label needs a placement.";
      return null;
    }
    return "The question type is unsupported.";
  }
  function validateAnswer(question, answer) {
    const error = validateAnswerPayload(question, answer);
    if (error) return error;
    return answer.needsReview ? "The AI needs more information. Review the question manually." : null;
  }
  function normalizeSettings(value) {
    const settings2 = { ...DEFAULT_SETTINGS, ...value, selectors: { ...DEFAULT_SETTINGS.selectors, ...value.selectors } };
    settings2.bridgeToken = String(settings2.bridgeToken).trim();
    settings2.model = String(settings2.model).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(settings2.model)) throw new Error("Enter a valid model name.");
    if (settings2.mode !== "auto" && settings2.mode !== "suggest") throw new Error("Choose suggestion or automatic mode.");
    settings2.requestLimit = Number(settings2.requestLimit);
    if (!Number.isInteger(settings2.requestLimit) || settings2.requestLimit < 1 || settings2.requestLimit > 100) throw new Error("Request limit must be between 1 and 100.");
    settings2.captureImages = Boolean(settings2.captureImages);
    settings2.backgroundMode = settings2.backgroundMode === true;
    for (const key of ["question", "choices", "submit", "confirmation"]) {
      if (typeof settings2.selectors[key] !== "string" || settings2.selectors[key].length > 500) throw new Error("Selectors must be shorter than 500 characters.");
      settings2.selectors[key] = settings2.selectors[key].trim();
    }
    settings2.selectors.multiple = Boolean(settings2.selectors.multiple);
    settings2.selectors.choiceClickSubmits = Boolean(settings2.selectors.choiceClickSubmits);
    if (settings2.selectors.multiple && settings2.selectors.choiceClickSubmits) throw new Error("Click-to-submit is only supported for single-answer questions.");
    return settings2;
  }
  var QuestionLedger = class {
    keys;
    constructor(previous = []) {
      this.keys = new Set(previous);
    }
    has(key) {
      return this.keys.has(key);
    }
    claim(key) {
      if (this.keys.has(key)) return false;
      this.keys.add(key);
      return true;
    }
    serialize() {
      return [...this.keys];
    }
  };

  // src/content/structured.ts
  var inputSelector = 'input[type="text"], input[type="number"], input:not([type])';
  var blankSelector = `${inputSelector}, button[role="combobox"][aria-haspopup="listbox"]`;

  // src/content/advanced.ts
  var ADVANCED_TYPES = ".Rating, .Prioritization, .Brainstorm, .Framework, .LabelAnImage, .ShowOnImage, .DragAndDrop, .Concordance, .SCTJudgment";

  // src/content/wooclap.ts
  var participantSelector = `.MCQ, .Poll, .Sorting, .GuessNumber, .OpenQuestion, .WordCloud, .FillInTheBlanks, .Matching, ${ADVANCED_TYPES}`;

  // src/content/adapter.ts
  function sourceForUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && (url.hostname === "wooclap.com" || url.hostname.endsWith(".wooclap.com"))) return "wooclap";
      if (url.origin === "http://127.0.0.1:4318" && url.pathname === "/practice") return "practice";
    } catch {
    }
    return null;
  }

  // src/background-tab.ts
  var STORAGE_KEY = "backgroundTab";
  function bounded(promise, timeout, detail) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(detail)), timeout);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  var BackgroundTab = class {
    protection = null;
    connected = false;
    transition = Promise.resolve();
    queue(task) {
      const next = this.transition.catch(() => void 0).then(task);
      this.transition = next;
      return next;
    }
    owns(tabId) {
      return this.connected && this.protection?.tabId === tabId;
    }
    handleDetach(tabId) {
      if (!this.owns(tabId)) return false;
      this.connected = false;
      return true;
    }
    async recover() {
      return this.queue(async () => {
        const saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
        if (saved && Number.isInteger(saved.tabId) && typeof saved.autoDiscardable === "boolean") {
          this.protection = saved;
          this.connected = true;
          await this.cleanup();
        } else await chrome.storage.session.remove(STORAGE_KEY);
      });
    }
    acquire(tabId, assertActive) {
      return this.queue(async () => {
        assertActive();
        await this.cleanup();
        assertActive();
        if (!chrome.debugger || !await chrome.permissions.contains({ permissions: ["debugger"] })) {
          throw new Error("Background mode needs the updated extension debugger permission. Reload the extension in Edge.");
        }
        assertActive();
        const tab = await chrome.tabs.get(tabId);
        assertActive();
        this.protection = { tabId, autoDiscardable: tab.autoDiscardable };
        try {
          await chrome.storage.session.set({ [STORAGE_KEY]: this.protection });
          assertActive();
          await chrome.tabs.update(tabId, { autoDiscardable: false });
          assertActive();
          try {
            await chrome.debugger.attach({ tabId }, "1.3");
          } catch {
            throw new Error("Could not connect background mode. Close DevTools or another debugger on this tab, then press Start.");
          }
          this.connected = true;
          assertActive();
          await bounded(
            chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }),
            5e3,
            "The background tab did not become ready. Monitoring stopped."
          );
          assertActive();
        } catch (error) {
          await this.cleanup();
          throw error;
        }
      });
    }
    release() {
      return this.queue(() => this.cleanup());
    }
    async cleanup() {
      const saved = this.protection;
      if (!saved) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.protection = null;
      if (wasConnected) await chrome.debugger.detach({ tabId: saved.tabId }).catch(() => void 0);
      try {
        await chrome.tabs.update(saved.tabId, { autoDiscardable: saved.autoDiscardable });
      } catch {
        const exists = await chrome.tabs.get(saved.tabId).catch(() => null);
        if (exists) {
          this.protection = saved;
          throw new Error("Could not restore the monitored tab settings. Pause again before starting.");
        }
      }
      await chrome.storage.session.remove(STORAGE_KEY);
    }
    async capture(tabId) {
      if (!this.owns(tabId)) throw new Error("The background connection ended. Press Start to reconnect.");
      const original = this.protection;
      const result = await bounded(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      }), 1e4, "Background image capture timed out. Monitoring stopped.");
      if (!this.owns(tabId) || original !== this.protection) throw new Error("The background connection ended during image capture.");
      if (typeof result?.data !== "string" || !result.data || result.data.length > 4e7) throw new Error("The background screenshot was empty or too large.");
      return `data:image/png;base64,${result.data}`;
    }
  };

  // src/background.ts
  var settings = DEFAULT_SETTINGS;
  var state = { ...INITIAL_SESSION, log: [] };
  var ledger = new QuestionLedger();
  var answerCache = {};
  var budgetDocument = "";
  var runId = null;
  var generation = 0;
  var work = null;
  var currentDocument = "";
  var pendingKey = "";
  var eventKey = "";
  var submitting = false;
  var startInProgress = false;
  var startingTabId = null;
  var persistence = Promise.resolve();
  var backgroundTab = new BackgroundTab();
  var stopping = Promise.resolve();
  var initialized = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const saved = await chrome.storage.local.get("settings");
    if (saved.settings) {
      try {
        settings = normalizeSettings(saved.settings);
      } catch {
      }
    }
    const session = await chrome.storage.session.get(["session", "ledger", "answerCache", "budgetDocument"]);
    ledger = new QuestionLedger(session.ledger || []);
    answerCache = session.answerCache || {};
    for (const [key, pending] of Object.entries(answerCache)) {
      try {
        if (validateAnswerPayload(pending.question, pending.answer)) delete answerCache[key];
      } catch {
        delete answerCache[key];
      }
    }
    budgetDocument = session.budgetDocument || "";
    if (session.session) {
      state = { ...INITIAL_SESSION, ...session.session, running: false, pending: null };
      if (session.session.running) {
        state.phase = "paused";
        state.detail = "The background service restarted. Press Start to resume; previous requests will not be repeated.";
      }
    }
    await backgroundTab.recover();
  })();
  function persist() {
    const snapshot = structuredClone({ session: state, ledger: ledger.serialize(), answerCache, budgetDocument });
    persistence = persistence.catch(() => void 0).then(() => chrome.storage.session.set(snapshot));
    return persistence;
  }
  async function update(phase, detail, extra = {}) {
    const changed = state.phase !== phase || state.detail !== detail;
    state = { ...state, ...extra, phase, detail };
    if (changed) state.log = [{ time: Date.now(), message: detail }, ...state.log].slice(0, 20);
    await persist();
    await chrome.action.setBadgeText({ text: state.running ? state.mode === "auto" ? "AUTO" : "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  }
  function invalidate() {
    generation += 1;
    work?.abort();
    work = null;
    state.pending = null;
    pendingKey = "";
  }
  async function pause(detail = "Paused. Press Start when you are ready.") {
    invalidate();
    runId = null;
    state.running = false;
    const tabId = state.tabId;
    stopping = Promise.all([
      update("paused", detail),
      tabId !== null ? chrome.tabs.sendMessage(tabId, { type: "MONITOR_STOP" }).catch(() => void 0) : Promise.resolve(),
      backgroundTab.release()
    ]).then(() => void 0);
    await stopping;
  }
  async function bridge(path, body, signal) {
    if (!settings.bridgeToken) throw new Error("Add the local service pairing token in Settings first.");
    const timeout = AbortSignal.timeout(28e3);
    let response;
    try {
      response = await fetch(BRIDGE_URL + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${settings.bridgeToken}`, ...body ? { "Content-Type": "application/json" } : {} },
        ...body ? { body: JSON.stringify(body) } : {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(timeout.aborted ? "The AI request timed out. Check the page before trying again." : "Local service unavailable. Run npm start or npm run demo, then check Settings.");
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : typeof result?.error?.message === "string" ? result.error.message : `Local service returned HTTP ${response.status}.`);
    return result;
  }
  async function monitoredTab(tabId, requireForeground = !settings.backgroundMode) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !sourceForUrl(tab.url)) throw new Error("Open a Wooclap participant question or the local practice page.");
    if (tab.discarded) throw new Error("The monitored page was unloaded. Return to it and press Start.");
    if (requireForeground && (!tab.active || (await chrome.windows.get(tab.windowId)).state === "minimized")) {
      throw new Error("Keep the monitored tab visible, or enable background mode in Settings.");
    }
    return tab;
  }
  async function readCurrent() {
    if (state.tabId === null) throw new Error("No tab is selected.");
    await monitoredTab(state.tabId);
    if (settings.backgroundMode && !backgroundTab.owns(state.tabId)) throw new Error("The background connection ended. Press Start to reconnect.");
    const result = await chrome.tabs.sendMessage(state.tabId, { type: "READ_CURRENT" });
    if (!result?.ok) throw new Error("Could not read the question. Refresh the page and press Start.");
    return result;
  }
  function isCurrent(expectedRun, expectedGeneration) {
    return state.running && runId === expectedRun && generation === expectedGeneration;
  }
  async function capture(rect, tabId) {
    const captureRun = runId, captureGeneration = generation;
    const tab = await monitoredTab(tabId);
    if (!captureRun || !isCurrent(captureRun, captureGeneration)) throw new Error("Image capture was cancelled.");
    const { x, y, width, height, viewportWidth, viewportHeight } = rect;
    if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > viewportWidth + 1 || y + height > viewportHeight + 1) throw new Error("The entire question and its images must be visible. Adjust zoom or scroll, then restart.");
    let dataUrl;
    if (settings.backgroundMode) {
      try {
        dataUrl = await backgroundTab.capture(tabId);
      } catch (error) {
        if (captureRun && isCurrent(captureRun, captureGeneration)) await pause(error instanceof Error ? error.message : "Background capture failed.");
        throw error;
      }
    } else dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await monitoredTab(tabId);
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const pixelBytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([pixelBytes], { type: "image/png" }));
    try {
      const sx = bitmap.width / viewportWidth, sy = bitmap.height / viewportHeight;
      const canvas = new OffscreenCanvas(Math.ceil(width * sx), Math.ceil(height * sy));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not crop the screenshot.");
      context.drawImage(bitmap, x * sx, y * sy, width * sx, height * sy, 0, 0, canvas.width, canvas.height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      if (bytes.length > 4e6) throw new Error("Question screenshot is too large. Reduce the browser zoom.");
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return "data:image/png;base64," + btoa(binary);
    } finally {
      bitmap.close();
    }
  }
  async function start(tabId) {
    if (startInProgress) throw new Error("A session is already starting.");
    if (state.running) throw new Error("Pause the current session before starting another.");
    startInProgress = true;
    startingTabId = tabId;
    const startGeneration = generation;
    try {
      await stopping;
      const stillStarting = () => {
        if (generation !== startGeneration) throw new Error("Starting was cancelled. Press Start when ready.");
      };
      stillStarting();
      const tab = await monitoredTab(tabId);
      const health = await bridge("/health");
      if (health.protocolVersion !== PROTOCOL_VERSION) throw new Error("The local bridge needs an update. Restart it with npm start, then reload the extension.");
      if (generation !== startGeneration) throw new Error("Starting was cancelled. Press Start when ready.");
      if (!health.ready) throw new Error("Add OPENAI_API_KEY to .env and restart the local service, or run npm run demo for practice.");
      if (health.demo && sourceForUrl(tab.url) !== "practice") throw new Error("The demo service only answers the local practice page. Run npm start for Wooclap.");
      const latestTab = await monitoredTab(tabId);
      stillStarting();
      if (latestTab.url !== tab.url) throw new Error("The page changed while starting. Press Start on the new page.");
      invalidate();
      runId = crypto.randomUUID();
      eventKey = "";
      currentDocument = "";
      state = { ...state, running: true, tabId, mode: settings.mode, pending: null, bridgeMode: health.demo ? "demo" : "openai" };
      const expectedRun = runId, startedGeneration = generation;
      const guard = () => {
        if (!isCurrent(expectedRun, startedGeneration)) throw new Error("Starting was cancelled. Press Start when ready.");
      };
      if (settings.backgroundMode) await backgroundTab.acquire(tabId, guard);
      guard();
      await update("waiting", settings.backgroundMode ? "Background mode is watching the selected tab. You can switch tabs or minimize Edge." : health.demo ? "Practice mode. Waiting for a supported question." : "Watching this tab for a supported question.");
      guard();
      const message = { type: "MONITOR_START", runId, selectors: settings.selectors, backgroundMode: settings.backgroundMode };
      try {
        await chrome.tabs.sendMessage(tabId, message);
      } catch {
        guard();
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        guard();
        await chrome.tabs.sendMessage(tabId, message);
      }
      guard();
    } catch (error) {
      if (state.running) await pause("Could not start monitoring. Refresh the page and try again.");
      throw error;
    } finally {
      startInProgress = false;
      startingTabId = null;
    }
  }
  async function applyPending() {
    if (submitting) throw new Error("An answer is already being submitted.");
    const pending = state.pending;
    const expectedRun = runId;
    const expectedGeneration = generation;
    const submittedKey = pendingKey;
    if (!pending || !expectedRun || !state.running) throw new Error("There is no current answer to submit.");
    if (pending.question.application === "preview") throw new Error("This question currently supports answer previews. Apply the answer on the page.");
    submitting = true;
    try {
      const latest = await readCurrent();
      if (!isCurrent(expectedRun, expectedGeneration) || latest.runId !== expectedRun || latest.documentKey !== currentDocument || latest.occurrence !== pending.occurrence || !latest.observation.question || fingerprint(latest.observation.question) !== pending.fingerprint) {
        throw new Error("The question changed. The previous answer was discarded.");
      }
      const issue = validateAnswer(pending.question, pending.answer);
      if (issue) throw new Error(issue);
      if (pending.inputSignature !== void 0 && latest.observation.inputSignature !== pending.inputSignature) {
        throw new Error("The page inputs changed while the answer was being prepared. Your entries were left unchanged.");
      }
      await update("submitting", "Selecting the answer and submitting once.");
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      delete answerCache[submittedKey];
      await persist();
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      const result = await chrome.tabs.sendMessage(state.tabId, { type: "APPLY_ANSWER", runId: expectedRun, documentKey: currentDocument, pending });
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      if (!result?.ok) throw new Error(result?.error || "Could not submit the answer.");
      state.pending = null;
      if (result.confirmed) await update("submitted", result.detail);
      else await pause(result.detail);
    } catch (error) {
      if (isCurrent(expectedRun, expectedGeneration)) await pause(error instanceof Error ? error.message : "Could not submit this answer.");
    } finally {
      submitting = false;
    }
  }
  async function solve(observation, occurrence, documentKey) {
    const question = observation.question;
    if (!question || !runId || state.tabId === null) return;
    const solvingTabId = state.tabId;
    if (eventKey && question.eventKey !== eventKey) {
      await pause("The event changed. Press Start to monitor the new event.");
      return;
    }
    eventKey = question.eventKey;
    const fp = fingerprint(question);
    const key = JSON.stringify([state.bridgeMode, state.bridgeMode === "openai" ? settings.model : "local-demo", documentKey, occurrence, fp]);
    currentDocument = documentKey;
    pendingKey = key;
    const expectedRun = runId;
    const expectedGeneration = generation;
    if (budgetDocument !== documentKey) {
      budgetDocument = documentKey;
      state.requestCount = 0;
    }
    if (ledger.has(key)) {
      const cached = answerCache[key];
      if (cached) {
        await update(cached.answer.needsReview ? "review" : "suggestion", "Restored the answer for this question without another AI request.", { pending: cached });
        if (!cached.answer.needsReview && cached.question.application !== "preview" && settings.mode === "auto" && isCurrent(expectedRun, expectedGeneration)) await applyPending();
      } else await update("review", "This question was already requested or submitted. Waiting for the next question to avoid a duplicate.");
      return;
    }
    const controller = new AbortController();
    work = controller;
    try {
      if (state.requestCount >= settings.requestLimit) {
        await pause("The request limit was reached. Increase it in Settings to continue.");
        return;
      }
      await monitoredTab(solvingTabId);
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      if (settings.backgroundMode && !backgroundTab.owns(solvingTabId)) throw new Error("The background connection ended. Press Start to reconnect.");
      let screenshot;
      if (question.imageKeys.length) {
        if (!settings.captureImages) throw new Error("This question needs its image. Enable image capture in Settings.");
        if (!observation.rect) throw new Error("Could not locate all question images. Review this question manually.");
        screenshot = await capture(observation.rect, solvingTabId);
      }
      const latest = await readCurrent();
      if (!isCurrent(expectedRun, expectedGeneration) || latest.documentKey !== documentKey || latest.occurrence !== occurrence || !latest.observation.question || fingerprint(latest.observation.question) !== fp) return;
      if (screenshot && JSON.stringify(latest.observation.rect) !== JSON.stringify(observation.rect)) throw new Error("The question moved during image capture. Keep the entire question visible and restart.");
      if (!ledger.claim(key)) return;
      state.requestCount += 1;
      await update("solving", state.bridgeMode === "demo" ? "Preparing a local practice answer." : `Asking OpenAI (${settings.model}) for an answer.`);
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      const requestStarted = Date.now();
      const response = await bridge("/solve", { protocolVersion: PROTOCOL_VERSION, question, model: settings.model, ...screenshot ? { screenshot } : {} }, controller.signal);
      if (!isCurrent(expectedRun, expectedGeneration)) return;
      if (response.demo && question.source !== "practice") throw new Error("A demo answer cannot be used on Wooclap.");
      state.lastResponse = { model: response.model, usage: response.usage, elapsedMs: Date.now() - requestStarted, demo: response.demo };
      const issue = validateAnswer(question, response.answer);
      const pending = {
        question,
        answer: response.answer,
        fingerprint: fp,
        occurrence,
        demo: response.demo,
        ...observation.inputSignature !== void 0 ? { inputSignature: observation.inputSignature } : {}
      };
      if (issue) {
        if (response.answer.needsReview) answerCache[key] = pending;
        await update("review", issue, { pending: response.answer.needsReview ? pending : null });
        return;
      }
      answerCache[key] = pending;
      await update("suggestion", question.application === "preview" ? "Answer preview ready. Apply it on the Wooclap page." : response.demo ? "Practice answer ready. Review it below." : "Answer ready. Review it below.", { pending });
      if (question.application !== "preview" && settings.mode === "auto" && isCurrent(expectedRun, expectedGeneration)) await applyPending();
    } catch (error) {
      if (isCurrent(expectedRun, expectedGeneration)) await update("error", error instanceof Error ? error.message : "The answer request failed.", { pending: null });
    } finally {
      if (work === controller) work = null;
    }
  }
  async function handleContent(message, sender) {
    if (!state.running || sender.tab?.id !== state.tabId || sender.frameId !== 0 || message.runId !== runId) return { ok: true, stop: true };
    if (!sender.url || !sourceForUrl(sender.url)) return { ok: false, stop: true };
    if (message.type === "PAGE_DEPARTED") {
      await pause("The monitored page was left. Press Start on the new page.");
      return { ok: true };
    }
    if (message.type === "TAB_HIDDEN") {
      if (!settings.backgroundMode) await pause("The monitored tab became inactive. Return to it and press Start.");
      return { ok: true };
    }
    if (message.type === "CONTENT_DIRTY") {
      if (!submitting) {
        invalidate();
        await update("waiting", "The page changed. Waiting for the question to settle.");
      }
      return { ok: true };
    }
    if (message.type !== "OBSERVATION" || submitting) return { ok: true };
    const observation = message.observation;
    if (observation.state === "question" && observation.question) {
      void solve(observation, message.occurrence, message.documentKey);
    } else {
      invalidate();
      await update(observation.state === "submitted" ? "submitted" : observation.state === "unsupported" ? "review" : "waiting", observation.detail);
    }
    return { ok: true };
  }
  async function handle(message, sender) {
    await initialized;
    if (sender.id !== chrome.runtime.id) throw new Error("Unknown extension sender.");
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
      if (sender.tab) return handleContent(message, sender);
      throw new Error("Only the extension can change settings.");
    }
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, state, settings };
      case "CHECK_BRIDGE":
        return { ok: true, health: await bridge("/health") };
      case "SAVE_SETTINGS": {
        const next = normalizeSettings(message.settings);
        if (state.running || startInProgress) await pause("Settings changed. Press Start to apply them.");
        settings = next;
        state.mode = settings.mode;
        await chrome.storage.local.set({ settings });
        await persist();
        return { ok: true, state, settings };
      }
      case "START":
        await start(message.tabId);
        break;
      case "PAUSE":
        await pause();
        break;
      case "APPROVE": {
        if (message.answer !== void 0) {
          const pending = state.pending;
          if (!pending || state.phase !== "suggestion" || pending.answer.needsReview || message.fingerprint !== pending.fingerprint || message.occurrence !== pending.occurrence) throw new Error("The suggestion changed. Review the current answer.");
          const issue = validateAnswer(pending.question, message.answer);
          if (issue) throw new Error(issue);
          state.pending = { ...pending, answer: message.answer };
        }
        await applyPending();
        break;
      }
      case "SKIP":
        delete answerCache[pendingKey];
        await update("waiting", "Suggestion skipped. Waiting for the next question.", { pending: null });
        break;
      default:
        throw new Error("Unknown extension command.");
    }
    return { ok: true, state, settings };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    void handle(message, sender).then(reply).catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : "Extension request failed." }));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void initialized.then(() => {
      if (state.tabId === tabId && state.running || startingTabId === tabId) return pause("The monitored tab was closed.");
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" || change.discarded) void initialized.then(() => {
      if (state.tabId === tabId && state.running || startingTabId === tabId) return pause("The page navigated or was unloaded. Press Start on the new question page.");
    });
  });
  chrome.tabs.onActivated.addListener((info) => {
    void initialized.then(async () => {
      if (!state.running || settings.backgroundMode || state.tabId === null || info.tabId === state.tabId) return;
      const tab = await chrome.tabs.get(state.tabId).catch(() => null);
      if (!tab || tab.windowId === info.windowId) await pause("The monitored tab became inactive. Return to it and press Start.");
    });
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== void 0 && backgroundTab.handleDetach(source.tabId)) {
      void pause("The background connection was closed. Close DevTools if needed, then press Start to reconnect.");
    }
  });
})();
