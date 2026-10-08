"use strict";
(() => {
  // src/shared/types.ts
  var BRIDGE_URL = "http://127.0.0.1:4318";

  // src/shared/core.ts
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
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

  // src/ui/answer-editor.ts
  function renderAnswerEditor(container, question, answer, onChange) {
    container.replaceChildren();
    const doc = container.ownerDocument;
    const add = (label, value, change, options) => {
      const row = doc.createElement("li");
      const wrapper = doc.createElement("label");
      wrapper.className = "answer-field";
      const caption = doc.createElement("span");
      caption.textContent = label;
      wrapper.append(caption);
      if (change) {
        const input = options ? doc.createElement("select") : doc.createElement("textarea");
        if (input.tagName === "SELECT") {
          for (const option of options) {
            const item = doc.createElement("option");
            item.value = option.id;
            item.textContent = option.text;
            input.append(item);
          }
        } else input.rows = 2;
        input.value = value;
        input.addEventListener("input", () => {
          change(input.value);
          onChange();
        });
        wrapper.append(input);
      } else {
        const text = doc.createElement("span");
        text.textContent = value;
        wrapper.append(text);
      }
      row.append(wrapper);
      container.append(row);
    };
    const editable = !answer.needsReview && question.application !== "preview";
    if (answer.value !== void 0) add(
      question.kind === "numeric" ? "Number to submit" : "Response to submit",
      answer.value,
      editable ? (value) => {
        answer.value = value;
      } : void 0
    );
    for (const entry of answer.values ?? []) {
      const field = question.fields?.find((field2) => field2.id === entry.id);
      const label = field?.label || question.choices.find((choice) => choice.id === entry.id)?.text || entry.id;
      const options = field?.kind === "select" ? field.options : void 0;
      add(label, entry.value, editable ? (value) => {
        entry.value = value;
      } : void 0, options);
    }
    for (const point of answer.points ?? []) {
      const label = question.choices.find((choice) => choice.id === point.id)?.text || point.id;
      add(label, `${(point.x * 100).toFixed(1)}% from left, ${(point.y * 100).toFixed(1)}% from top of the image`);
    }
    for (const [index, id] of answer.selectedChoiceIds.entries()) {
      add(question.kind === "sorting" ? String(index + 1) : "\u2713", question.choices.find((choice) => choice.id === id)?.text ?? `Unknown choice: ${id}`);
    }
  }

  // src/ui/popup.ts
  function element(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing UI element: ${id}`);
    return found;
  }
  var startButton = element("start-button");
  var pauseButton = element("pause-button");
  var approveButton = element("approve-button");
  var skipButton = element("skip-button");
  var errorMessage = element("error-message");
  var busy = false;
  var lastState;
  var lastSettings;
  var polling = false;
  var requestSequence = 0;
  var latestResponseSequence = 0;
  var draftKey = "";
  var draftAnswer;
  function updateApproval() {
    const pending = lastState?.pending;
    approveButton.disabled = busy || !pending || lastState?.phase !== "suggestion" || pending.question.application === "preview" || !draftAnswer || Boolean(validateAnswer(pending.question, draftAnswer));
  }
  var phaseLabels = {
    idle: "Ready to begin",
    waiting: "Watching for questions",
    solving: "Preparing an answer",
    suggestion: "Answer ready",
    submitting: "Submitting answer",
    submitted: "Answer submitted",
    review: "Needs your review",
    error: "Something needs attention",
    paused: "Session paused"
  };
  function showError(error) {
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    errorMessage.hidden = false;
  }
  function render(state, settings) {
    lastState = state;
    lastSettings = settings;
    const phase = element("phase");
    phase.textContent = phaseLabels[state.phase] ?? state.phase;
    phase.dataset.phase = state.phase;
    const answerMode = (state.running ? state.mode : settings.mode) === "auto" ? "Auto-submit mode" : "Suggestion mode";
    element("mode").textContent = `${answerMode}${settings.backgroundMode ? " \xB7 Background" : ""}`;
    element("session-detail").textContent = state.detail;
    element("request-count").textContent = `${state.requestCount} / ${settings.requestLimit} requests`;
    const bridgeMode = element("bridge-mode");
    bridgeMode.hidden = !state.bridgeMode;
    bridgeMode.textContent = state.bridgeMode === "demo" ? "Session source: local demo \xB7 no AI requests" : state.bridgeMode === "openai" ? "Session source: OpenAI via local bridge" : "";
    const response = state.lastResponse;
    element("response-metadata").hidden = !response;
    if (response) {
      element("response-source").textContent = response.demo ? "Local demo" : "OpenAI response received";
      element("response-model").textContent = response.model;
      element("response-model").title = response.model;
      element("response-latency").textContent = Number.isFinite(response.elapsedMs) && response.elapsedMs >= 0 ? `${response.elapsedMs < 1e3 ? `${Math.round(response.elapsedMs)} ms` : `${(response.elapsedMs / 1e3).toFixed(1)} s`} response time` : "Response time unavailable";
      element("response-tokens").textContent = response.usage ? `${response.usage.inputTokens.toLocaleString()} input / ${response.usage.outputTokens.toLocaleString()} output tokens` : response.demo ? "No API tokens used" : "Token usage unavailable";
    }
    startButton.disabled = busy || state.running;
    startButton.firstChild.textContent = state.running ? "Session running " : "Start on this tab ";
    pauseButton.disabled = busy || !state.running;
    const pending = state.pending;
    element("answer-card").hidden = !pending;
    element("empty-state").hidden = Boolean(pending);
    if (pending) {
      element("question-text").textContent = pending.question.text;
      element("answer-explanation").textContent = pending.answer.explanation;
      element("demo-badge").hidden = !pending.demo;
      element("review-note").hidden = state.phase !== "review" && !pending.answer.needsReview && pending.question.application !== "preview";
      element("review-note").textContent = pending.question.application === "preview" ? "Answer preview. Apply this answer on the Wooclap page; automatic interaction is not yet verified for this layout." : "This answer needs review. Answer on the page yourself, or skip this question.";
      const choices = element("answer-choices");
      const key = JSON.stringify([pending.fingerprint, pending.occurrence, pending.answer]);
      if (key !== draftKey) {
        draftKey = key;
        draftAnswer = JSON.parse(JSON.stringify(pending.answer));
        renderAnswerEditor(choices, pending.question, draftAnswer, updateApproval);
      }
      const actionable = state.phase === "suggestion" || state.phase === "review";
      element("suggestion-actions").hidden = !actionable;
      updateApproval();
      skipButton.disabled = busy;
    } else {
      draftKey = "";
      draftAnswer = void 0;
    }
    const entry = state.log[0];
    element("last-log").textContent = entry ? `${new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} \xB7 ${entry.message}` : "No activity yet.";
  }
  async function send(message) {
    const sequence = ++requestSequence;
    const response = await chrome.runtime.sendMessage(message);
    if (sequence < latestResponseSequence) return;
    latestResponseSequence = sequence;
    if (!response?.ok) throw new Error(response?.error || "The extension did not respond. Reload it from Edge\u2019s extensions page.");
    if (response.state && (response.settings || lastSettings)) render(response.state, response.settings || lastSettings);
  }
  async function action(callback) {
    if (busy) return;
    busy = true;
    if (lastState && lastSettings) render(lastState, lastSettings);
    errorMessage.hidden = true;
    try {
      await callback();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (lastState && lastSettings) render(lastState, lastSettings);
    }
  }
  startButton.addEventListener("click", () => void action(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === void 0) throw new Error("Open a Wooclap tab or the practice page first.");
    await send({ type: "START", tabId: tab.id });
  }));
  pauseButton.addEventListener("click", () => void action(() => send({ type: "PAUSE" })));
  approveButton.addEventListener("click", () => void action(() => send({
    type: "APPROVE",
    answer: draftAnswer,
    fingerprint: lastState?.pending?.fingerprint,
    occurrence: lastState?.pending?.occurrence
  })));
  skipButton.addEventListener("click", () => void action(() => send({ type: "SKIP" })));
  element("settings-button").addEventListener("click", () => void chrome.runtime.openOptionsPage().catch(showError));
  element("practice-button").addEventListener("click", () => void chrome.tabs.create({ url: `${BRIDGE_URL}/practice` }).catch(showError));
  async function refresh() {
    if (polling || busy) return;
    polling = true;
    try {
      await send({ type: "GET_STATE" });
    } catch (error) {
      showError(error);
    } finally {
      polling = false;
    }
  }
  void refresh();
  var timer = window.setInterval(() => void refresh(), 1e3);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
