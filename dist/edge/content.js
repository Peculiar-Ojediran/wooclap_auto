"use strict";
(() => {
  // src/shared/types.ts
  var DEFAULT_SETTINGS = {
    bridgeToken: "",
    model: "gpt-4.1-mini",
    mode: "suggest",
    requestLimit: 25,
    captureImages: true,
    backgroundMode: false,
    selectors: { question: "", choices: "", submit: "", confirmation: "", multiple: false, choiceClickSubmits: false }
  };

  // src/shared/core.ts
  function normalizeText(text4) {
    return text4.replace(/\s+/g, " ").trim();
  }
  function fingerprint(question) {
    const identity2 = {
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
    return JSON.stringify({ ...identity2, ...extended });
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
  function validateNumericValue(value, bounds5 = {}) {
    if (typeof value !== "string" || value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return "Enter a finite decimal number without units or separators.";
    const parsed = decimal(value);
    if (bounds5.min !== void 0 && (!Number.isFinite(bounds5.min) || compareDecimals(value, String(bounds5.min)) < 0)) return "The number is below the allowed minimum.";
    if (bounds5.max !== void 0 && (!Number.isFinite(bounds5.max) || compareDecimals(value, String(bounds5.max)) > 0)) return "The number exceeds the allowed maximum.";
    if (bounds5.step !== void 0) {
      if (!Number.isFinite(bounds5.step) || bounds5.step <= 0) return "The question has an invalid numeric step.";
      const step = decimal(String(bounds5.step));
      const origin = decimal(String(bounds5.min ?? 0));
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
    if (!answer || typeof answer.needsReview !== "boolean" || typeof answer.explanation !== "string" || answer.explanation.length > 4e3 || !Array.isArray(answer.selectedChoiceIds) || answer.selectedChoiceIds.length > 60 || answer.selectedChoiceIds.some((id) => typeof id !== "string" || id.length > 256) || Object.keys(answer).some((key2) => !["selectedChoiceIds", "value", "values", "points", "explanation", "needsReview"].includes(key2))) return "The AI returned an invalid answer.";
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
      if (values.length > 60 || values.some((item) => !item || typeof item.id !== "string" || item.id.length > 256 || typeof item.value !== "string" || item.value.length > 2e4 || Object.keys(item).some((key2) => key2 !== "id" && key2 !== "value"))) return "The answer contains invalid field values.";
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
      if (points.length > 60 || points.some((point) => !point || typeof point.id !== "string" || point.id.length > 256 || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || Object.keys(point).some((key2) => !["id", "x", "y"].includes(key2)))) return "Image points must be inside the image.";
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

  // src/content/structured.ts
  var titleSelector = '[data-test-id="Question.participant.title"]';
  var inputSelector = 'input[type="text"], input[type="number"], input:not([type])';
  var blankSelector = `${inputSelector}, button[role="combobox"][aria-haspopup="listbox"]`;
  var compact = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  var unsupported = (detail) => ({ question: null, state: "unsupported", detail });
  var waiting = (detail) => ({ question: null, state: "waiting", detail });
  var dropdownCache = /* @__PURE__ */ new WeakMap();
  var preparations = /* @__PURE__ */ new WeakMap();
  function visible(element) {
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
    }
    return true;
  }
  function query(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter(visible);
  }
  function label(element) {
    const read = (node) => {
      if (node.nodeType === 3) return node.textContent ?? "";
      if (node.nodeType !== 1) return "";
      const el = node;
      if (!visible(el) || el.matches('script, style, svg, [role="img"], i[class*="fa-"], label')) return "";
      return Array.from(node.childNodes).map(read).join("");
    };
    return compact(read(element));
  }
  function bounds(elements, doc) {
    const boxes = elements.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    const left = boxes.length ? Math.min(...boxes.map((box) => box.left)) : 0;
    const top = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
    const right = boxes.length ? Math.max(...boxes.map((box) => box.right)) : 0;
    const bottom = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    };
  }
  function disabled(control) {
    return control.matches(':disabled, [readonly], [aria-disabled="true"], [aria-readonly="true"]');
  }
  function numericAttribute(control, name) {
    const raw = control.getAttribute(name);
    if (raw === null || !raw.trim()) return void 0;
    const result = Number(raw);
    return Number.isFinite(result) ? result : void 0;
  }
  function limits(control) {
    const result = {};
    for (const [attribute, key2] of [["min", "min"], ["max", "max"], ["step", "step"], ["maxlength", "maxLength"]]) {
      const value = numericAttribute(control, attribute);
      if (value !== void 0 && (key2 !== "maxLength" || value >= 0) && (key2 !== "step" || value > 0)) result[key2] = value;
    }
    return result;
  }
  function blankText(scope, title, controls) {
    const indices = new Map(controls.map((control, index) => [control, index + 1]));
    const read = (node) => {
      if (node.nodeType === 3) return node.textContent ?? "";
      if (node.nodeType !== 1) return "";
      const el = node;
      if (el === title || !visible(el)) return "";
      const index = indices.get(el);
      if (index) return ` [blank-${index}] `;
      if (el.matches('button, input, textarea, select, nav, script, style, svg, [role="img"], [role="alert"], [role="listbox"], [role="timer"]')) return "";
      const text4 = Array.from(el.childNodes).map(read).join("");
      return el.matches("p, div, section, br") ? ` ${text4} ` : text4;
    };
    return compact(read(scope));
  }
  function blankContext(scope, title, controls) {
    return JSON.stringify([
      scope.ownerDocument.URL,
      label(title),
      blankText(scope, title, controls),
      controls.map((control) => [control.tagName, control.getAttribute("aria-label")])
    ]);
  }
  function dropdownOptions(control) {
    if (control.getAttribute("aria-expanded") !== "true") return null;
    const owner = control.parentElement;
    if (!owner) return null;
    const lists = query(owner, '[role="listbox"]').filter((list) => list.id === control.getAttribute("aria-controls"));
    if (lists.length !== 1) return null;
    const elements = query(lists[0], '[role="option"]');
    if (elements.length < 1 || elements.length > 50 || elements.some((el) => disabled(el) || query(el, "img, svg, audio, video, canvas").length)) return null;
    const options2 = elements.map((element, index) => ({ id: `option-${index + 1}`, text: label(element) }));
    if (options2.some((option) => !option.text) || new Set(options2.map((option) => option.text)).size !== options2.length) return null;
    return { elements, options: options2 };
  }
  async function waitFor(read, assertActive, detail) {
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      assertActive();
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(detail);
  }
  function prepareStructured(doc, assertActive = () => {
  }) {
    const running = preparations.get(doc);
    if (running) return running;
    const operation = (async () => {
      const titles = query(doc, titleSelector);
      if (titles.length !== 1) return;
      const title = titles[0];
      const scope = title.closest(".FillInTheBlanks");
      if (!scope || query(scope, '[data-test-id="participant-feedback-banner"]').length) return;
      const controls = query(scope, blankSelector);
      const context2 = blankContext(scope, title, controls);
      const current = () => scope.isConnected && title.isConnected && blankContext(scope, title, query(scope, blankSelector)) === context2;
      for (const control of controls.filter((item) => item.matches('button[role="combobox"]'))) {
        assertActive();
        if (!current()) return;
        if (disabled(control)) continue;
        const cache2 = dropdownCache.get(control);
        if (cache2?.context === context2 && Date.now() - cache2.capturedAt < 3e4) continue;
        const wasOpen = control.getAttribute("aria-expanded") === "true";
        try {
          if (!wasOpen) control.click();
          const rendered = await waitFor(() => current() && dropdownOptions(control), assertActive, "Blank dropdown options could not be read.");
          dropdownCache.set(control, { context: context2, options: rendered.options, capturedAt: Date.now() });
        } catch (error) {
          dropdownCache.delete(control);
          assertActive();
          if (!current()) return;
        } finally {
          if (!wasOpen && control.isConnected && control.getAttribute("aria-expanded") === "true") control.click();
        }
      }
    })();
    preparations.set(doc, operation);
    void operation.finally(() => preparations.delete(doc)).catch(() => {
    });
    return operation;
  }
  function extractStructured(scope, title, eventKey2, doc) {
    const type = ["GuessNumber", "OpenQuestion", "WordCloud", "FillInTheBlanks", "Matching"].find((name) => scope.classList.contains(name));
    if (!type) return null;
    if (!label(title)) return unsupported("The question title is empty.");
    if (query(scope, '[data-test-id="Participant.Submit"]').length !== 1) return waiting("Wooclap is not accepting a submission for this question.");
    const question = {
      kind: "text",
      wooclapType: type,
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      text: label(title),
      choices: [],
      multiple: false,
      imageKeys: [],
      application: "automatic",
      responseMode: "single"
    };
    const controls = /* @__PURE__ */ new Map();
    if (type === "GuessNumber") {
      const inputs = query(scope, 'input[aria-live="polite"]');
      if (inputs.length !== 1 || query(scope, 'input:not([type="hidden"])').length !== 1 || query(scope, 'textarea, select, [contenteditable="true"]').length) return unsupported("The numeric answer field is missing or ambiguous.");
      if (disabled(inputs[0])) return waiting("The numeric answer field is closed.");
      if (!inputs[0].matches(inputSelector)) return unsupported("The numeric answer control is not a supported input.");
      controls.set("answer", inputs[0]);
      question.kind = "numeric";
      question.constraints = limits(inputs[0]);
      const descriptions = query(scope, "p").filter((el) => !el.closest('nav, [role="alert"], [aria-live], [role="status"]') && !title.contains(el)).map(label).filter(Boolean);
      if (descriptions.length) question.text += `
${descriptions.join("\n")}`;
    } else if (type === "OpenQuestion" || type === "WordCloud") {
      const inputs = query(scope, 'textarea#send-message-textarea[data-test-id="TextareaAnswerQuestion"]');
      if (inputs.length !== 1 || query(scope, "textarea").length !== 1 || query(scope, 'input:not([type="hidden"]), select, [contenteditable="true"]').length) return unsupported("The text answer field is missing or ambiguous.");
      if (disabled(inputs[0])) return waiting("The text answer field is closed.");
      controls.set("answer", inputs[0]);
      question.constraints = limits(inputs[0]);
      question.responseMode = "contribution";
    } else if (type === "FillInTheBlanks") {
      const inputs = query(scope, blankSelector);
      if (!inputs.length || inputs.length > 30 || query(scope, 'input:not([type="hidden"])').some((input) => !inputs.includes(input)) || query(scope, 'textarea, select, [contenteditable="true"]').length) return unsupported("The blank answer controls are missing or ambiguous.");
      if (inputs.some(disabled)) return waiting("The blank answer fields are closed.");
      const context2 = blankContext(scope, title, inputs);
      const fields = [];
      for (const [index, control] of inputs.entries()) {
        const id = `blank-${index + 1}`;
        controls.set(id, control);
        if (control.matches('button[role="combobox"]')) {
          const cache2 = dropdownCache.get(control);
          if (!cache2 || cache2.context !== context2) return unsupported("A closed-choice blank needs its visible dropdown options to be read first.");
          fields.push({ id, label: `Blank ${index + 1}`, kind: "select", required: true, options: cache2.options });
        } else fields.push({ id, label: `Blank ${index + 1}`, kind: "text", required: true, ...limits(control) });
      }
      question.kind = "fields";
      question.fields = fields;
      question.text += `
${blankText(scope, title, inputs)}`;
    } else {
      const inputs = query(scope, 'select[name="answer"][aria-labelledby]');
      if (inputs.length < 2 || inputs.length > 30 || query(scope, "select").length !== inputs.length || query(scope, 'input:not([type="hidden"]), textarea, [contenteditable="true"]').length) return unsupported("The matching answer controls are missing or ambiguous.");
      if (inputs.some(disabled)) return waiting("The matching answer fields are closed.");
      const fields = [];
      for (const control of inputs) {
        const labelledBy = control.getAttribute("aria-labelledby") ?? "";
        const source = query(scope, "[id]").filter((el) => el.id === labelledBy);
        const id = labelledBy.startsWith("choice-text-") ? labelledBy.slice("choice-text-".length) : "";
        const options2 = Array.from(control.options).filter((option) => option.value !== "none").map((option) => ({
          id: option.value,
          text: compact(option.textContent).replace(/^✓\s*/, "")
        }));
        if (!id || id.length > 256 || source.length !== 1 || !label(source[0]) || controls.has(id) || options2.length < 2 || options2.length > 50 || options2.some((option) => !option.id || !option.text) || new Set(options2.map((option) => option.id)).size !== options2.length) return unsupported("The matching labels or destinations are missing or ambiguous.");
        controls.set(id, control);
        fields.push({ id, label: label(source[0]), kind: "select", required: true, options: options2 });
      }
      question.kind = "matching";
      question.fields = fields;
      question.constraints = { uniqueTargets: true };
    }
    return { question, scope, controls, rect: bounds([title, ...controls.values()], doc) };
  }
  function setInputValue(control, value) {
    const win = control.ownerDocument.defaultView;
    if (!win) throw new Error("The answer document is unavailable.");
    const prototype = control.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : control.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("The answer control cannot accept a value.");
    control.focus();
    setter.call(control, value);
    control.dispatchEvent(new win.Event("input", { bubbles: true }));
    control.dispatchEvent(new win.Event("change", { bubbles: true }));
    control.blur();
  }
  function expectedEntries(question, answer) {
    if (question.kind === "numeric" || question.kind === "text") return [{ id: "answer", value: answer.value ?? "" }];
    return answer.values ?? [];
  }
  function currentValue(control) {
    return control.matches('button[role="combobox"]') ? label(control) : control.value;
  }
  function expectedValue(question, id, value, control) {
    if (!control.matches('button[role="combobox"]')) return value;
    return question.fields?.find((field) => field.id === id)?.options?.find((option) => option.id === value)?.text ?? "";
  }
  function decimalKey(value) {
    const match = value.trim().replace(",", ".").match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
    if (!match || !match[2] && !match[3]) return null;
    const integer = (match[2] || "0").replace(/^0+(?=\d)/, "");
    const fraction = (match[3] || "").replace(/0+$/, "");
    const sign = match[1] === "-" && (integer !== "0" || fraction) ? "-" : "";
    return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
  }
  function numericValuesEqual(actual, expected) {
    const value = decimalKey(expected);
    return value !== null && decimalKey(actual) === value;
  }
  function numericValueRoundTrips(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return false;
    let rendered = String(numeric);
    const scientific = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(rendered);
    if (scientific) {
      const digits = scientific[2] + (scientific[3] ?? "");
      const position = scientific[2].length + Number(scientific[4]);
      rendered = scientific[1] + (position <= 0 ? `0.${"0".repeat(-position)}${digits}` : position >= digits.length ? digits + "0".repeat(position - digits.length) : `${digits.slice(0, position)}.${digits.slice(position)}`);
    }
    return numericValuesEqual(rendered, value);
  }
  function structuredResponseSnapshot(live) {
    return JSON.stringify(Array.from(live.controls, ([id, control]) => [id, currentValue(control)]));
  }
  function verifyStructured(live, answer) {
    const entries = expectedEntries(live.question, answer);
    if (entries.length !== live.controls.size) return false;
    return entries.every(({ id, value }) => {
      const control = live.controls.get(id);
      if (!control || disabled(control)) return false;
      const expected = expectedValue(live.question, id, value, control);
      const actual = currentValue(control);
      if (live.question.kind === "numeric") return numericValuesEqual(actual, value);
      return actual === expected;
    });
  }
  async function applyStructured(question, answer, readCurrent, assertActive = () => {
  }) {
    const entries = expectedEntries(question, answer);
    const initial = readCurrent();
    if (!entries.length || entries.length !== initial.controls.size || new Set(entries.map((entry) => entry.id)).size !== entries.length || entries.some((entry) => !entry.value || !initial.controls.has(entry.id))) throw new Error("The answer does not cover every current field.");
    if (question.kind === "numeric" && !numericValueRoundTrips(entries[0].value)) {
      throw new Error("Wooclap would round this number. Review the required precision before submitting.");
    }
    if (question.kind === "matching" && question.constraints?.uniqueTargets && new Set(entries.map((entry) => entry.value)).size !== entries.length) {
      throw new Error("This matching layout requires a different destination for each source.");
    }
    for (const entry of entries) {
      const field = question.fields?.find((item) => item.id === entry.id);
      if (field?.kind === "select" && !field.options?.some((option) => option.id === entry.value)) throw new Error("An answer destination is no longer available.");
    }
    for (const entry of entries) {
      assertActive();
      const live = readCurrent();
      const control = live.controls.get(entry.id);
      if (!control || disabled(control)) throw new Error("An answer field is no longer available.");
      if (control.matches('button[role="combobox"]')) {
        const wasOpen = control.getAttribute("aria-expanded") === "true";
        try {
          if (!wasOpen) control.click();
          const rendered = await waitFor(() => dropdownOptions(control), assertActive, "The blank dropdown did not open.");
          const expected = question.fields?.find((field) => field.id === entry.id)?.options;
          if (JSON.stringify(rendered.options) !== JSON.stringify(expected)) throw new Error("Blank dropdown options changed after the answer was prepared.");
          assertActive();
          readCurrent();
          const index = rendered.options.findIndex((option) => option.id === entry.value);
          if (index < 0) throw new Error("The blank option is no longer available.");
          rendered.elements[index].click();
        } finally {
          if (control.isConnected && control.getAttribute("aria-expanded") === "true") control.click();
        }
      } else setInputValue(control, entry.value);
      await waitFor(() => {
        const current = readCurrent();
        const updated = current.controls.get(entry.id);
        if (!updated) return false;
        const actual = currentValue(updated);
        const expected = expectedValue(question, entry.id, entry.value, updated);
        return question.kind === "numeric" ? numericValuesEqual(actual, entry.value) : actual === expected;
      }, assertActive, "Wooclap did not retain the answer value.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertActive();
    if (!verifyStructured(readCurrent(), answer)) throw new Error("The answer values changed before submission.");
  }

  // src/content/advanced.ts
  var ADVANCED_TYPES = ".Rating, .Prioritization, .Brainstorm, .Framework, .LabelAnImage, .ShowOnImage, .DragAndDrop, .Concordance, .SCTJudgment";
  var compact2 = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  var unsupported2 = (detail) => ({ question: null, state: "unsupported", detail });
  var waiting2 = (detail) => ({ question: null, state: "waiting", detail });
  function visible2(element) {
    for (let node = element; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (node.hasAttribute("hidden") || style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
    }
    return true;
  }
  function query2(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter(visible2);
  }
  function text(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    for (const ignored of clone.querySelectorAll('script,style,input,textarea,button,[hidden],[aria-hidden="true"]')) ignored.remove();
    return compact2(clone.textContent);
  }
  function bounds2(elements, doc) {
    const boxes = elements.map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    const x = boxes.length ? Math.min(...boxes.map((b) => b.left)) : 0;
    const y = boxes.length ? Math.min(...boxes.map((b) => b.top)) : 0;
    return {
      x,
      y,
      width: boxes.length ? Math.max(...boxes.map((b) => b.right)) - x : 0,
      height: boxes.length ? Math.max(...boxes.map((b) => b.bottom)) - y : 0,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    };
  }
  function assetKey(value) {
    if (value.length < 1900) return value;
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `asset:${value.length}:${(hash >>> 0).toString(16)}`;
  }
  function numericAttribute2(element, name) {
    const value = element.getAttribute(name);
    if (value === null || !value.trim()) return void 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : void 0;
  }
  function disabled2(element) {
    return element.matches(':disabled,[aria-disabled="true"]') || !!element.closest("[inert]");
  }
  function typeOf(scope) {
    return ADVANCED_TYPES.split(", ").map((s) => s.slice(1)).find((type) => scope.classList.contains(type));
  }
  function pinDecoration(svg) {
    if (!svg.closest(".LabelAnImage") || svg.getAttribute("viewBox") !== "0 0 160 160") return false;
    const sibling = svg.parentElement?.querySelector(":scope > button[aria-label]");
    if (!sibling || !/^[1-9]\d*$/.test(compact2(sibling.textContent)) || ![1, 2].includes(svg.children.length)) return false;
    return Array.from(svg.children).every((circle) => circle.tagName.toLowerCase() === "circle" && circle.getAttribute("cx") === "80" && circle.getAttribute("cy") === "80" && circle.getAttribute("r") === "80" && circle.getAttribute("stroke-dasharray") === "565");
  }
  function extractAdvanced(scope, title, eventKey2, doc) {
    const type = typeOf(scope);
    if (!type) return null;
    const prompt = text(title);
    if (!prompt) return unsupported2("The question title is empty.");
    if (query2(scope, "audio,video,canvas").length) return unsupported2("This question contains unsupported audio, video, or canvas content.");
    const diagrams = query2(scope, "svg").filter((svg) => !svg.matches("[data-icon],.svg-inline--fa") && !pinDecoration(svg));
    if (diagrams.length) return unsupported2("Inline SVG diagrams require manual review; their image capture is not supported yet.");
    const images3 = query2(scope, "img").filter((img) => !img.matches('[data-decorative],.icon,[data-icon],[role="presentation"]'));
    if (images3.some((img) => !img.complete || img.naturalWidth === 0)) return waiting2("Waiting for question images to load.");
    if (images3.length > 16) return unsupported2("This question contains too many images to capture.");
    const controls = /* @__PURE__ */ new Map();
    const base = {
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      wooclapType: type,
      text: prompt,
      choices: [],
      multiple: false,
      imageKeys: images3.map((img) => assetKey(`${img.currentSrc || img.src}|${compact2(img.alt)}`)),
      application: "preview",
      responseMode: "single"
    };
    const result = (question, elements = [scope]) => ({ question, scope, controls, rect: bounds2([title, ...elements, ...images3], doc) });
    const hasSubmit = query2(scope, '[data-test-id="Participant.Submit"]').length === 1;
    if (type === "Rating") {
      if (!hasSubmit) return waiting2("Rating is not accepting submissions.");
      if (query2(scope, "input,textarea,select").length) return unsupported2("Rating contains an unexpected additional answer field.");
      const sliders = query2(scope, '[role="slider"][aria-labelledby]');
      if (!sliders.length || sliders.length > 30) return unsupported2("Rating propositions are missing or ambiguous.");
      const fields = [];
      for (const slider of sliders) {
        const labelId = slider.getAttribute("aria-labelledby") ?? "";
        const label3 = doc.getElementById(labelId);
        const min = numericAttribute2(slider, "aria-valuemin"), max = numericAttribute2(slider, "aria-valuemax");
        const options2 = query2(slider, "ul > li").map((row) => text(row));
        if (!/^choice-text-.+/.test(labelId) || !label3 || !scope.contains(label3) || !text(label3) || min !== 1 || !Number.isInteger(max) || max < 4 || max > 10 || options2.length !== max || options2.some((value, i) => value !== String(i + 1))) {
          return unsupported2("The visible rating scale or proposition labels could not be read completely.");
        }
        const id = labelId.slice("choice-text-".length);
        if (controls.has(id) || disabled2(slider)) return unsupported2("Rating controls are duplicated or unavailable.");
        controls.set(id, slider);
        fields.push({ id, label: text(label3), kind: "number", required: true, min, max, step: 1 });
      }
      return result({ ...base, kind: "rating", fields, application: "automatic" }, [title, ...sliders.map((s) => s.closest("li") ?? s)]);
    }
    if (type === "Prioritization") {
      if (!hasSubmit) return waiting2("Prioritization is not accepting submissions.");
      const inputs = query2(scope, 'input[type="number"][id^="choice-"]');
      if (!inputs.length || inputs.length > 30 || query2(scope, 'input:not([type="hidden"]),textarea,select').length !== inputs.length) return unsupported2("Prioritization fields are missing or ambiguous.");
      const list = inputs[0].closest("ul");
      if (!list || inputs.some((input) => input.closest("ul") !== list)) return unsupported2("Prioritization fields do not share one list.");
      const instruction = text(list.previousElementSibling?.firstElementChild ?? null);
      const numbers = instruction.match(/\d+/g) ?? [];
      const total = numbers.length === 1 ? Number(numbers[0]) : NaN;
      if (!Number.isSafeInteger(total) || total <= 0 || total > 1e5) return unsupported2("The displayed allocation budget could not be read unambiguously.");
      const fields = [];
      for (const input of inputs) {
        const id = input.id.slice("choice-".length), label3 = doc.getElementById(`choice-text-${id}`);
        if (!id || controls.has(id) || !label3 || !scope.contains(label3) || !text(label3) || disabled2(input)) return unsupported2("Allocation labels or controls are unavailable.");
        controls.set(id, input);
        fields.push({ id, label: text(label3), kind: "number", required: true, min: 0, max: total, step: 1 });
      }
      return result({ ...base, kind: "allocation", text: `${prompt}
${instruction}`, fields, constraints: { total }, application: "automatic" }, [title, list]);
    }
    if (type === "Brainstorm") {
      const inputs = query2(scope, "textarea");
      if (inputs.length !== 1 || disabled2(inputs[0])) return waiting2("Open the brainstorming contribution form to generate a draft.");
      const menus = query2(scope, '[aria-haspopup="listbox"]');
      if (menus.length !== 1) return unsupported2("The brainstorming category chooser is missing or ambiguous.");
      const category = compact2(menus[0].textContent);
      if (!category) return unsupported2("Choose a brainstorming category before generating a draft.");
      const id = "category-current";
      controls.set(id, inputs[0]);
      const footer = inputs[0].parentElement?.nextElementSibling;
      const counter = footer?.firstElementChild;
      const counterText = counter && !counter.matches("button") ? text(counter) : "";
      const counts = counterText.match(/\d+/g) ?? [];
      const used = inputs[0].value.length + (inputs[0].value.match(/\r\n|\r|\n/g)?.length ?? 0);
      const displayedLimit = counts.length === 1 ? Number(counts[0]) + used : void 0;
      const maxLength = inputs[0].maxLength > 0 ? inputs[0].maxLength : displayedLimit !== void 0 && displayedLimit > 0 && displayedLimit <= 2e4 ? displayedLimit : 180;
      return result({
        ...base,
        kind: "categorized",
        responseMode: "contribution",
        choices: [{ id, text: category }],
        text: `${prompt}
Draft one contribution for the currently selected category: ${category}.`,
        constraints: { maxEntries: 1, maxLength }
      }, [title, menus[0], inputs[0]]);
    }
    if (type === "Framework") {
      const labels = query2(scope, 'h3[id^="category-"]');
      const choices = labels.map((label3) => ({ id: label3.id, text: text(label3) }));
      if (!images3.length || !choices.length || choices.length > 30 || choices.some((c) => !c.text) || new Set(choices.map((c) => c.id)).size !== choices.length) return unsupported2("The framework image and category labels could not be read completely.");
      if (!query2(scope, "button[aria-label]").length) return waiting2("The framework contribution controls are closed.");
      return result({
        ...base,
        kind: "categorized",
        responseMode: "contribution",
        choices,
        text: `${prompt}
Draft one contribution for one displayed framework category.`,
        constraints: { maxEntries: 1, maxLength: 180 }
      });
    }
    if (type === "LabelAnImage") {
      const pins2 = query2(scope, "button[aria-label]").filter((pin) => /^[1-9]\d*$/.test(compact2(pin.textContent)));
      const numbers = pins2.map((pin) => Number(compact2(pin.textContent)));
      if (!images3.length || !pins2.length || pins2.length > 30 || numbers.some((n, i) => n !== i + 1)) return unsupported2("The image caption markers could not be read completely.");
      const fields = pins2.map((pin, i) => {
        const id = `marker-${i + 1}`;
        controls.set(id, pin);
        return { id, label: `Image marker ${i + 1}: ${pin.getAttribute("aria-label")}`, kind: "text", required: true, maxLength: 500 };
      });
      return result({ ...base, kind: "fields", fields, text: `${prompt}
Give a caption for every numbered image marker.` });
    }
    if (type === "ShowOnImage") {
      if (!hasSubmit) return waiting2("Find on image is not accepting submissions.");
      if (images3.length !== 1) return unsupported2("Find on image needs one unambiguous target image.");
      return result({
        ...base,
        kind: "point",
        choices: [{ id: "point-1", text: "One point on the target image" }],
        constraints: { maxEntries: 1 },
        text: `${prompt}
Return one point relative to the image content: x is left-to-right and y is top-to-bottom, each from 0 to 1.`
      });
    }
    if (type === "DragAndDrop") {
      if (!images3.length) return unsupported2("The drag-and-drop target image is missing.");
      const headings = query2(scope, "h6").filter((heading) => /^[1-9]\d*$/.test(text(heading.previousElementSibling)));
      if (!headings.length || headings.length > 30 || headings.some((heading, i) => Number(text(heading.previousElementSibling)) !== i + 1 || !text(heading))) return unsupported2("Drag-and-drop labels are missing or ambiguous.");
      const choices = headings.map((heading, i) => ({ id: `item-${i + 1}`, text: text(heading) }));
      return result({
        ...base,
        kind: "placements",
        choices,
        text: `${prompt}
Place every numbered label on the target image using x/y coordinates from 0 to 1 relative to the image content.`
      });
    }
    if (type === "Concordance" || type === "SCTJudgment") {
      if (!hasSubmit) return waiting2("The scenario question is not accepting submissions.");
      const sliders = query2(scope, '[role="slider"]');
      if (sliders.length !== 1) return unsupported2("The scenario scale is missing or ambiguous.");
      const slider = sliders[0], min = numericAttribute2(slider, "aria-valuemin"), max = numericAttribute2(slider, "aria-valuemax");
      const positions = query2(slider, "ul > li");
      if (min !== -2 || max !== 2 || ![4, 5].includes(positions.length)) return unsupported2("The scenario scale bounds are not recognized.");
      const container = slider.parentElement;
      const contextRows = container?.matches("ul") ? query2(container, ":scope > li") : [];
      if (contextRows.length !== 1) return unsupported2("The full scenario context could not be isolated.");
      const context2 = text(contextRows[0]);
      if (!context2) return unsupported2("The full case and additional information are missing.");
      const values = positions.length === 5 ? [-2, -1, 0, 1, 2] : [-2, -1, 1, 2];
      const choices = values.map((value, i) => ({ id: `scale-${value}`, text: `Scale position ${i + 1} of ${values.length} (${value})` }));
      const visibleLabels = positions.map((position) => text(position));
      return result({
        ...base,
        kind: "scenario",
        choices,
        text: `${prompt}
${context2}
Displayed scale: ${visibleLabels.join(" | ") || "unlabelled positions"}. Exact custom scale descriptions are not all exposed in the participant form; do not assume their meaning. Review is required if the case does not establish the scale interpretation.`
      });
    }
    return null;
  }
  function numberValue(control) {
    return control.value ?? "";
  }
  function advancedResponseSnapshot(live) {
    return JSON.stringify(Array.from(live.controls, ([id, control]) => [id, control.matches('[role="slider"]') ? control.querySelector("[data-score]")?.getAttribute("data-score") ?? null : numberValue(control)]));
  }
  function verifyAdvanced(live, answer) {
    if (live.question.application !== "automatic") return false;
    if (validateAnswer(live.question, answer)) return false;
    if (!answer.values || answer.values.length !== live.question.fields?.length) return false;
    return answer.values.every(({ id, value }) => {
      const control = live.controls.get(id);
      if (!control || disabled2(control)) return false;
      if (live.question.kind === "rating") {
        const score = control.querySelector("[data-score]")?.getAttribute("data-score");
        return score !== null && score !== void 0 && Number(score) === Number(value) && Number(control.getAttribute("aria-valuenow")) === Number(value);
      }
      return live.question.kind === "allocation" && Number(numberValue(control) || "0") === Number(value);
    });
  }
  async function applyAdvanced(question, answer, readCurrent, assertActive) {
    if (question.application !== "automatic" || !["rating", "allocation"].includes(question.kind ?? "")) throw new Error("This question supports a preview only. Apply the suggested answer manually.");
    const error = validateAnswer(question, answer);
    if (error) throw new Error(error);
    const identity2 = fingerprint(question);
    const current = () => {
      assertActive?.();
      const live = readCurrent();
      if (!("controls" in live) || fingerprint(live.question) !== identity2) throw new Error("The question changed before the answer could be applied.");
      return live;
    };
    const waitFor3 = async (check) => {
      const deadline = Date.now() + 800;
      while (!check(current())) {
        if (Date.now() >= deadline) throw new Error("Wooclap did not accept the proposed field value.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    for (const entry of answer.values ?? []) {
      const live = current(), control = live.controls.get(entry.id);
      if (!control || disabled2(control)) throw new Error("An answer control is unavailable.");
      const win = control.ownerDocument.defaultView;
      if (question.kind === "rating") {
        const min = question.fields.find((field) => field.id === entry.id).min;
        control.focus();
        control.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
        await waitFor3((next) => next.controls.get(entry.id)?.querySelector("[data-score]")?.getAttribute("data-score") === String(min));
        for (let value = min + 1; value <= Number(entry.value); value += 1) {
          const slider = current().controls.get(entry.id);
          slider.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
          await waitFor3((next) => next.controls.get(entry.id)?.querySelector("[data-score]")?.getAttribute("data-score") === String(value));
        }
      } else {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("The numeric input cannot be updated.");
        control.focus();
        setter.call(control, entry.value);
        control.dispatchEvent(new win.Event("input", { bubbles: true }));
        control.dispatchEvent(new win.Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        await waitFor3((next) => Number(numberValue(next.controls.get(entry.id)) || "0") === Number(entry.value));
      }
    }
    await waitFor3((live) => verifyAdvanced(live, answer) && query2(live.scope, '[data-test-id="Participant.Submit"]').some((button) => !disabled2(button)));
  }

  // src/content/contributions.ts
  var compact3 = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  var waiting3 = (detail) => ({ question: null, state: "waiting", detail });
  var unsupported3 = (detail) => ({ question: null, state: "unsupported", detail });
  var categoryCache = /* @__PURE__ */ new WeakMap();
  var preparations2 = /* @__PURE__ */ new WeakMap();
  var receipts = /* @__PURE__ */ new WeakMap();
  function visible3(el) {
    for (let node = el; node; node = node.parentElement) {
      const css = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (node.hasAttribute("hidden") || css?.display === "none" || css?.visibility === "hidden" || css?.opacity === "0") return false;
    }
    return true;
  }
  function query3(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter(visible3);
  }
  function disabled3(el) {
    return el.matches(':disabled,[readonly],[aria-disabled="true"],[aria-readonly="true"]') || !!el.closest("[inert]");
  }
  function text2(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,svg,i[class*="fa-"],input,textarea,[hidden]').forEach((node) => node.remove());
    return compact3(clone.textContent);
  }
  var context = (scope) => `${scope.ownerDocument.URL}|${text2(scope.querySelector('[data-test-id="Question.participant.title"]'))}`;
  var closed = (scope) => query3(scope, '[data-test-id="participant-feedback-banner"]').length > 0;
  function brainstormInput(scope) {
    const inputs = query3(scope, "textarea").filter((el) => !el.closest('[id^="answer-"]'));
    return inputs.length === 1 ? inputs[0] : null;
  }
  function brainstormMenu(scope) {
    const input = brainstormInput(scope);
    if (!input) return null;
    const menus = query3(scope, 'button[role="combobox"][aria-haspopup="listbox"]').filter((menu) => Boolean(menu.compareDocumentPosition(input) & 4));
    return menus.length === 1 ? menus[0] : null;
  }
  function displayCategory(menu) {
    const clone = menu.parentElement?.cloneNode(true);
    if (!clone) return "";
    clone.querySelectorAll('label,[role="listbox"],svg,i[class*="fa-"]').forEach((el) => el.remove());
    return text2(clone);
  }
  function options(menu) {
    if (menu.getAttribute("aria-expanded") !== "true" || !menu.parentElement) return null;
    const lists = query3(menu.parentElement, '[role="listbox"]').filter((el) => el.id === menu.getAttribute("aria-controls"));
    if (lists.length !== 1) return null;
    const elements = query3(lists[0], '[role="option"]');
    if (!elements.length || elements.length > 30 || elements.some(disabled3)) return null;
    const choices = elements.map((el, index) => ({ id: `category-${index}`, text: text2(el) }));
    return choices.some((choice) => !choice.text) || new Set(choices.map((choice) => choice.text)).size !== choices.length ? null : { choices, elements };
  }
  async function waitFor2(read, guard, failure) {
    const deadline = Date.now() + 1400;
    while (Date.now() < deadline) {
      guard();
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(failure);
  }
  async function prepareContributions(doc, assertActive = () => {
  }) {
    const running = preparations2.get(doc);
    if (running) return running;
    const pending = (async () => {
      const scopes = query3(doc, ".Brainstorm").filter((scope2) => scope2.querySelector('[data-test-id="Question.participant.title"]'));
      if (scopes.length !== 1 || closed(scopes[0])) return;
      const scope = scopes[0], menu = brainstormMenu(scope), cached = categoryCache.get(scope), key2 = context(scope);
      if (!menu || disabled3(menu) || disabled3(brainstormInput(scope))) return;
      if (cached?.context === key2 && Date.now() - cached.capturedAt < 3e4) return;
      const wasOpen = menu.getAttribute("aria-expanded") === "true";
      const guard = () => {
        assertActive();
        if (!scope.isConnected || context(scope) !== key2 || closed(scope)) throw new Error("The contribution question changed.");
      };
      try {
        guard();
        if (!wasOpen) menu.click();
        const rendered = await waitFor2(() => options(menu), guard, "Brainstorm categories could not be read.");
        categoryCache.set(scope, { context: key2, choices: rendered.choices, capturedAt: Date.now() });
      } finally {
        if (!wasOpen && menu.isConnected && menu.getAttribute("aria-expanded") === "true") {
          guard();
          menu.click();
        }
      }
    })();
    preparations2.set(doc, pending);
    try {
      await pending;
    } finally {
      preparations2.delete(doc);
    }
  }
  function submitControl(scope, input) {
    for (let parent = input.parentElement; parent && parent !== scope; parent = parent.parentElement) {
      const sends = query3(parent, "button[aria-label]").filter((button) => button.querySelector('.fa-paper-plane,[data-icon="paper-plane"]') || disabled3(button) && button.querySelector('.fa-sync,.fa-spinner,[data-icon="sync"],[data-icon="spinner"]'));
      if (sends.length === 1) return sends[0];
      if (sends.length > 1) return null;
    }
    return null;
  }
  function frameworkInput(scope) {
    const inputs = query3(scope, "input#framework-answer-input");
    return inputs.length === 1 ? inputs[0] : null;
  }
  function frameworkSelected(scope, choices) {
    const input = frameworkInput(scope);
    if (!input) return null;
    const label3 = query3(scope, 'label[for="framework-answer-input"]');
    const name = label3.length === 1 ? text2(label3[0]) : compact3(input.getAttribute("aria-label"));
    const match = choices.filter((choice) => choice.text === name);
    return match.length === 1 ? match[0].id : null;
  }
  function characterLimit(input) {
    if (input.maxLength > 0) return input.maxLength;
    const footer = input.parentElement?.nextElementSibling;
    const counter = footer?.firstElementChild;
    const counts = counter && !counter.matches("button") ? text2(counter).match(/\d+/g) : null;
    const used = input.value.length + (input.value.match(/\r\n|\r|\n/g)?.length ?? 0);
    const limit = counts?.length === 1 ? Number(counts[0]) + used : null;
    return limit !== null && limit > 0 && limit <= 2e4 ? limit : null;
  }
  function assetKey2(value) {
    if (value.length < 1900) return value;
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `asset:${value.length}:${(hash >>> 0).toString(16)}`;
  }
  function extractContributions(scope, title, eventKey2, doc) {
    const type = scope.matches(".Brainstorm") ? "Brainstorm" : scope.matches(".Framework") ? "Framework" : null;
    if (!type) return null;
    if (closed(scope)) return waiting3("The contribution question is closed.");
    if (!text2(title)) return unsupported3("The contribution title is missing.");
    if (query3(scope, 'audio,video,canvas,[contenteditable="true"]').length) return unsupported3("This contribution contains unsupported media or editable controls.");
    if (query3(scope, "svg").some((svg) => !svg.matches("[data-icon],.svg-inline--fa") && !svg.closest('[id^="answer-"]'))) return unsupported3("This contribution contains an unsupported SVG diagram.");
    const controls = /* @__PURE__ */ new Map();
    let choices, maxLength;
    if (type === "Brainstorm") {
      const input = brainstormInput(scope), menu = brainstormMenu(scope), cached = categoryCache.get(scope);
      if (!input || !menu) return unsupported3("The contribution form or category chooser is missing or ambiguous.");
      if (disabled3(input) || disabled3(menu)) return waiting3("Brainstorming is not accepting contributions.");
      if (query3(scope, 'input:not([type="hidden"]),textarea,select').length !== 1) return unsupported3("Close other answer editing fields before contributing.");
      if (!cached || cached.context !== context(scope)) return waiting3("Reading the available brainstorming categories.");
      choices = cached.choices;
      const limit = characterLimit(input);
      if (!limit) return unsupported3("The contribution character limit is not visible.");
      maxLength = limit;
      if (!submitControl(scope, input)) return unsupported3("The contribution send button is missing or ambiguous.");
      controls.set("input", input);
      controls.set("category", menu);
    } else {
      const labels = query3(scope, 'h3[id^="category-"]');
      choices = labels.map((label3) => ({ id: label3.id, text: text2(label3) }));
      if (!choices.length || choices.length > 30 || choices.some((choice, i) => choice.id !== `category-${i}` || !choice.text) || new Set(choices.map((choice) => choice.text)).size !== choices.length) return unsupported3("Framework category labels are missing, duplicated, or out of order.");
      for (const label3 of labels) {
        const pins2 = label3.parentElement ? query3(label3.parentElement, "button[aria-label]").filter((button) => compact3(button.getAttribute("aria-label")).endsWith(` ${text2(label3)}`)) : [];
        if (pins2.length !== 1 || disabled3(pins2[0])) return unsupported3("A framework category pin is missing or unavailable.");
        controls.set(label3.id, pins2[0]);
      }
      const input = frameworkInput(scope);
      if (query3(scope, 'input:not([type="hidden"]),textarea,select').length !== (input ? 1 : 0)) return unsupported3("Close other answer editing fields before contributing.");
      if (input && disabled3(input)) return waiting3("Framework is not accepting contributions.");
      if (input && (input.maxLength !== 180 || !submitControl(scope, input) || !frameworkSelected(scope, choices))) return unsupported3("The framework input category or send button is ambiguous.");
      if (input) controls.set("input", input);
      maxLength = 180;
    }
    const images3 = query3(scope, "img").filter((img) => !img.closest('[id^="answer-"]'));
    if (type === "Framework" && images3.length !== 1) return unsupported3("Framework requires one identifiable diagram.");
    if (images3.length > 16) return unsupported3("Too many contribution images.");
    if (images3.some((img) => !img.complete || !img.naturalWidth)) return waiting3("Waiting for contribution images.");
    const question = {
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      wooclapType: type,
      kind: "categorized",
      text: text2(title),
      choices,
      multiple: false,
      constraints: { maxEntries: 1, maxLength },
      application: "automatic",
      responseMode: "contribution",
      imageKeys: images3.map((img) => assetKey2(`${img.currentSrc || img.src}|${compact3(img.alt)}`))
    };
    if (type === "Framework") {
      const box = images3[0].getBoundingClientRect();
      if (box.width > 0 && box.height > 0) question.imageKeys.push(`categories:${JSON.stringify(choices.map((choice) => {
        const pin = controls.get(choice.id).getBoundingClientRect();
        return [choice.id, ...[(pin.left + pin.width / 2 - box.left) / box.width, (pin.top + pin.height / 2 - box.top) / box.height].map((value) => Math.round(value * 1e4) / 1e4)];
      }))}`);
    }
    const boxes = [title, ...images3, ...controls.values()].map((el) => el.getBoundingClientRect()).filter((rect) => rect.width && rect.height);
    const x = boxes.length ? Math.min(...boxes.map((rect) => rect.left)) : 0, y = boxes.length ? Math.min(...boxes.map((rect) => rect.top)) : 0;
    return { question, scope, controls, rect: {
      x,
      y,
      width: boxes.length ? Math.max(...boxes.map((rect) => rect.right)) - x : 0,
      height: boxes.length ? Math.max(...boxes.map((rect) => rect.bottom)) - y : 0,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    } };
  }
  function snapshotContributions(live) {
    const selected3 = live.question.wooclapType === "Brainstorm" ? displayCategory(live.controls.get("category")) : frameworkSelected(live.scope, live.question.choices);
    return JSON.stringify([selected3, live.controls.get("input")?.value ?? ""]);
  }
  function verifyContributions(live, answer) {
    if (answer.values?.length !== 1) return false;
    const entry = answer.values[0], category = live.question.choices.find((choice) => choice.id === entry.id);
    const input = live.controls.get("input");
    if (!category || !input || disabled3(input) || input.value !== entry.value) return false;
    return live.question.wooclapType === "Brainstorm" ? displayCategory(live.controls.get("category")) === category.text : frameworkSelected(live.scope, live.question.choices) === category.id;
  }
  async function applyContributions(question, answer, readCurrent, assertActive = () => {
  }) {
    const error = validateAnswer(question, answer);
    if (error) throw new Error(error);
    if (!["Brainstorm", "Framework"].includes(question.wooclapType ?? "") || answer.values?.length !== 1) throw new Error("Expected exactly one contribution.");
    const entry = answer.values[0], original = fingerprint(question);
    if (question.wooclapType === "Brainstorm" && entry.value.length + (entry.value.match(/\r\n|\r|\n/g)?.length ?? 0) > (question.constraints?.maxLength ?? 0)) throw new Error("The contribution exceeds the character limit including line breaks.");
    const current = () => {
      assertActive();
      const live2 = readCurrent();
      if (!("controls" in live2) || fingerprint(live2.question) !== original) throw new Error("The contribution question changed or is no longer available.");
      return live2;
    };
    let live = current();
    if (question.wooclapType === "Brainstorm") {
      const menu = live.controls.get("category");
      try {
        if (menu.getAttribute("aria-expanded") !== "true") menu.click();
        const rendered = await waitFor2(() => options(menu), () => {
          current();
        }, "The category chooser did not open.");
        if (JSON.stringify(rendered.choices) !== JSON.stringify(question.choices)) throw new Error("The contribution categories changed after generation.");
        current();
        rendered.elements[rendered.choices.findIndex((choice) => choice.id === entry.id)].click();
      } finally {
        if (menu.isConnected && menu.getAttribute("aria-expanded") === "true") {
          current();
          menu.click();
        }
      }
      await waitFor2(
        () => displayCategory(current().controls.get("category")) === question.choices.find((choice) => choice.id === entry.id).text,
        assertActive,
        "Wooclap did not retain the selected category."
      );
    } else {
      const pin = live.controls.get(entry.id);
      if (!pin || disabled3(pin)) throw new Error("The framework category is unavailable.");
      pin.click();
      await waitFor2(() => {
        const fresh = current();
        return frameworkSelected(fresh.scope, question.choices) === entry.id && fresh.controls.get("input");
      }, assertActive, "The selected framework contribution input did not open.");
    }
    live = current();
    const input = live.controls.get("input");
    if (input.value && input.value !== entry.value) throw new Error("This category contains an existing draft. Review it before replacing it.");
    const win = input.ownerDocument.defaultView;
    const prototype = input.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    input.focus();
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, entry.value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    input.blur();
    await waitFor2(() => verifyContributions(current(), answer), assertActive, "Wooclap did not retain the contribution.");
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (!verifyContributions(current(), answer)) throw new Error("The contribution changed before submission.");
  }
  async function submitContributions(live, answer, assertActive = () => {
  }) {
    assertActive();
    if (!live.scope.isConnected || closed(live.scope) || !verifyContributions(live, answer)) throw new Error("The contribution changed before submission.");
    const input = live.controls.get("input");
    const button = submitControl(live.scope, input);
    if (!button || disabled3(button)) throw new Error("The contribution send button is not ready.");
    const doc = live.scope.ownerDocument, entry = answer.values[0];
    receipts.set(doc, {
      scope: live.scope,
      title: live.scope.querySelector('[data-test-id="Question.participant.title"]'),
      question: live.question,
      previous: new Set(query3(live.scope, '[id^="answer-"]').map((el) => el.id)),
      value: entry.value,
      category: live.question.choices.find((choice) => choice.id === entry.id),
      confirmed: false
    });
    assertActive();
    button.click();
  }
  function hasContributionsConfirmation(doc) {
    const receipt = receipts.get(doc);
    if (!receipt || !receipt.scope.isConnected || !receipt.title?.isConnected || context(receipt.scope) !== `${doc.URL}|${receipt.question.text}`) return false;
    if (receipt.confirmed) return true;
    const input = receipt.question.wooclapType === "Brainstorm" ? brainstormInput(receipt.scope) : frameworkInput(receipt.scope);
    if (!input || input.value !== "") return false;
    const rows = query3(receipt.scope, '[id^="answer-"]').filter((el) => !receipt.previous.has(el.id) && text2(el) === compact3(receipt.value));
    const found = rows.some((row) => {
      const parent = row.parentElement;
      if (!parent) return false;
      const ownerMenus = query3(parent, '[aria-label][tabindex="0"]').filter((el) => el.querySelector('.fa-ellipsis-v,[data-icon="ellipsis-v"]') && compact3(el.getAttribute("aria-label")).endsWith(` - ${receipt.category.text}`));
      if (ownerMenus.length !== 1) return false;
      return receipt.question.wooclapType !== "Framework" || query3(parent, "[aria-labelledby]").some((el) => el.getAttribute("aria-labelledby") === receipt.category.id);
    });
    if (found) receipt.confirmed = true;
    return found;
  }

  // src/content/image-interactions.ts
  var IMAGE_TYPES = ["LabelAnImage", "ShowOnImage", "DragAndDrop"];
  var clean = (text4) => (text4 ?? "").replace(/\s+/g, " ").trim();
  var unavailable = (detail) => ({ question: null, state: "unsupported", detail });
  var pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
  var visible4 = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (node.hasAttribute("hidden") || style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") return false;
    }
    return true;
  };
  var query4 = (scope, selector) => Array.from(scope.querySelectorAll(selector)).filter(visible4);
  var disabled4 = (element) => element.matches(':disabled,[aria-disabled="true"]') || !!element.closest("[inert]");
  function key(value) {
    if (value.length < 1800) return value;
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `image:${value.length}:${(hash >>> 0).toString(16)}`;
  }
  function image(live) {
    return live.controls.get("@image");
  }
  function rectKey(element) {
    const r = element.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100);
  }
  function geometryError(img, type) {
    const r = img.getBoundingClientRect(), win = img.ownerDocument.defaultView;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight || r.width <= 0 || r.height <= 0) return "The target image has not finished laying out.";
    const style = win.getComputedStyle(img);
    const fit = style.objectFit || "fill";
    if (fit !== "fill" && Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight) > 1e-3) return "Cropped or letterboxed target images need manual placement.";
    for (const p of ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth"]) {
      if (parseFloat(style[p]) > 0) return "Image padding or borders make the placement geometry ambiguous.";
    }
    for (let parent = img; parent; parent = parent.parentElement) {
      const transform = win.getComputedStyle(parent).transform;
      if (transform && transform !== "none") return "Transformed image layouts need manual placement.";
    }
    if (type !== "LabelAnImage") {
      const wrapper = type === "ShowOnImage" ? img.parentElement?.parentElement : img.parentElement;
      if (!wrapper) return "The image interaction wrapper is missing.";
      const b = wrapper.getBoundingClientRect();
      if (Math.abs(b.left - r.left) > 1 || Math.abs(b.top - r.top) > 1 || Math.abs(b.width - r.width) > 1) return "The image and interaction origins do not match.";
    }
    return null;
  }
  function pins(live) {
    const img = image(live), type = live.question.wooclapType;
    const scope = type === "ShowOnImage" ? img.parentElement?.parentElement : img.parentElement;
    const result = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    if (!scope) return result;
    for (const node of query4(scope, "span,button")) {
      const value = clean(node.textContent), parent = node.parentElement;
      if (!parent || !/^(?:\+|[1-9]\d*)$/.test(value)) continue;
      const style = img.ownerDocument.defaultView.getComputedStyle(parent);
      if (style.position !== "absolute" || !Number.isFinite(parseFloat(style.left)) || !Number.isFinite(parseFloat(style.top))) continue;
      if (node.parentElement?.matches("span,button")) continue;
      if (type === "ShowOnImage" && (value !== "+" || !parent.querySelector('button [data-icon="times"],button .fa-times,button .fa-xmark'))) continue;
      const id = type === "ShowOnImage" ? "point-1" : `item-${value}`;
      if (seen.has(id)) {
        result.delete(id);
        continue;
      }
      seen.add(id);
      result.set(id, parent);
    }
    return result;
  }
  function pinPoint(pin, img) {
    const r = pin.getBoundingClientRect(), b = img.getBoundingClientRect();
    return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height];
  }
  function captionInput(live) {
    const inputs = query4(live.scope, 'input:not([type="hidden"])');
    if (inputs.length !== 1 || !["text", ""].includes(inputs[0].type)) return null;
    const input = inputs[0], label3 = input.previousElementSibling;
    const number = clean(label3?.textContent);
    return label3?.matches("span") && /^[1-9]\d*$/.test(number) ? { marker: `marker-${number}`, input } : null;
  }
  var verifiedCaptions = /* @__PURE__ */ new WeakMap();
  function extractImageInteraction(scope, title, eventKey2, doc) {
    const type = IMAGE_TYPES.find((type2) => scope.classList.contains(type2));
    if (!type) return null;
    const prompt = clean(title.textContent), images3 = query4(scope, "img").filter((img2) => !img2.matches('[data-icon],[data-decorative],.icon,[role="presentation"]'));
    if (!prompt || images3.length !== 1) return unavailable("Image questions require one visible target image and a readable title.");
    if (query4(scope, "textarea,select,audio,video,canvas").length) return unavailable("Unexpected additional answer fields or media need manual review.");
    if (query4(scope, "svg").some((svg) => !svg.matches("[data-icon],.svg-inline--fa") && !pinDecoration(svg))) return unavailable("Additional SVG diagrams require manual review.");
    if (images3.some((img2) => !img2.complete || !img2.naturalWidth || !img2.naturalHeight)) return { question: null, state: "waiting", detail: "Waiting for the target image to load." };
    const img = images3[0], error = geometryError(img, type);
    if (error) return unavailable(error);
    const buttons = query4(scope, '[data-test-id="Participant.Submit"]');
    if (buttons.length !== 1) return unavailable("The image question submit control is missing or ambiguous.");
    const controls = /* @__PURE__ */ new Map([["@image", img]]);
    const base = {
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      wooclapType: type,
      text: prompt,
      choices: [],
      multiple: false,
      imageKeys: [key(`${img.currentSrc || img.src}|${img.alt}`)],
      application: "automatic",
      responseMode: "single"
    };
    const sr = scope.getBoundingClientRect();
    const result = (question) => ({ question, scope, controls, rect: {
      x: sr.left,
      y: sr.top,
      width: sr.width,
      height: sr.height,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    } });
    if (type === "LabelAnImage") {
      const markers = query4(scope, "button[aria-label]").filter((button) => /^[1-9]\d*$/.test(clean(button.textContent)));
      if (!markers.length || markers.length > 30 || markers.some((button, i) => clean(button.textContent) !== String(i + 1) || disabled4(button))) return unavailable("The numbered caption markers could not be read completely.");
      for (const [i, marker] of markers.entries()) controls.set(`marker-${i + 1}`, marker);
      const q = result({
        ...base,
        kind: "fields",
        fields: markers.map((marker, i) => ({ id: `marker-${i + 1}`, label: `Image marker ${i + 1}: ${marker.getAttribute("aria-label")}`, kind: "text", required: true, maxLength: 500 })),
        text: `${prompt}
Give a caption for every numbered image marker.`
      });
      const inputs = query4(scope, 'input:not([type="hidden"])');
      if (inputs.length && (!captionInput(q) || inputs.length !== 1 || !controls.has(captionInput(q).marker))) return unavailable("The selected caption field does not identify its marker.");
      q.question.imageKeys.push(`markers:${JSON.stringify(markers.map((marker) => {
        const r = marker.getBoundingClientRect(), b = img.getBoundingClientRect();
        return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height].map((v) => Math.round(v * 1e4) / 1e4);
      }))}`);
      return q;
    }
    if (query4(scope, 'input:not([type="hidden"])').length) return unavailable("Unexpected additional input needs manual review.");
    if (type === "ShowOnImage") {
      if (!img.parentElement?.matches("button") || disabled4(img.parentElement)) return unavailable("The point-selection image button is unavailable.");
      controls.set("@surface", img.parentElement);
      return result({
        ...base,
        kind: "point",
        responseMode: "contribution",
        choices: [{ id: "point-1", text: "One point on the target image" }],
        constraints: { maxEntries: 1 },
        text: `${prompt}
Return one point relative to the image content: x is left-to-right and y is top-to-bottom, each from 0 to 1.`
      });
    }
    if (img.draggable !== false || !img.parentElement?.matches("div")) return unavailable("The image placement surface is not recognized.");
    controls.set("@surface", img.parentElement);
    const headings = query4(scope, "h6");
    if (!headings.length || headings.length > 30 || headings.some((h, i) => !clean(h.textContent) || clean(h.previousElementSibling?.textContent) !== String(i + 1) || !h.parentElement?.matches("div") || disabled4(h.parentElement))) return unavailable("Drag-and-drop item labels are missing or ambiguous.");
    headings.forEach((h, i) => controls.set(`item-${i + 1}`, h.parentElement));
    return result({
      ...base,
      kind: "placements",
      choices: headings.map((h, i) => ({ id: `item-${i + 1}`, text: clean(h.textContent) })),
      text: `${prompt}
Place every numbered label on the target image using x/y coordinates from 0 to 1 relative to the image content.`
    });
  }
  function snapshotImageInteraction(live) {
    const img = image(live), caption = captionInput(live);
    return JSON.stringify({
      image: rectKey(img),
      natural: [img.naturalWidth, img.naturalHeight],
      pins: Array.from(pins(live), ([id, pin]) => [id, ...pinPoint(pin, img)]),
      caption: caption ? [caption.marker, caption.input.value] : null
    });
  }
  function verifyImageInteraction(live, answer) {
    if (validateAnswer(live.question, answer) || geometryError(image(live), live.question.wooclapType)) return false;
    if (live.question.wooclapType === "LabelAnImage") {
      const saved = verifiedCaptions.get(live.scope), current2 = captionInput(live);
      return !!saved && saved.identity === fingerprint(live.question) && saved.values === JSON.stringify(answer.values) && !!current2 && current2.marker === saved.marker && current2.input === saved.input && !disabled4(current2.input) && snapshotImageInteraction(live) === saved.snapshot;
    }
    const current = pins(live), img = image(live), rect = img.getBoundingClientRect();
    return current.size === answer.points?.length && answer.points.every((point) => {
      const pin = current.get(point.id);
      if (!pin) return false;
      const [x, y] = pinPoint(pin, img);
      return Math.abs(x - point.x) * rect.width <= 1.5 && Math.abs(y - point.y) * rect.height <= 1.5;
    });
  }
  async function applyImageInteraction(question, answer, readCurrent, assertActive) {
    const error = validateAnswer(question, answer);
    if (error) throw new Error(error);
    if (question.application !== "automatic" || !IMAGE_TYPES.includes(question.wooclapType ?? "")) throw new Error("This image question does not support automatic application.");
    const identity2 = fingerprint(question);
    let initialGeometry;
    const current = () => {
      assertActive?.();
      const live = readCurrent();
      if (!("controls" in live) || fingerprint(live.question) !== identity2) throw new Error("The image question changed while applying the answer.");
      const error2 = geometryError(image(live), question.wooclapType);
      if (error2) throw new Error(error2);
      const geometry = JSON.stringify(rectKey(image(live)));
      if (initialGeometry && question.wooclapType !== "LabelAnImage" && geometry !== initialGeometry) throw new Error("The image geometry changed during placement.");
      initialGeometry ??= geometry;
      return live;
    };
    const waitFor3 = async (predicate, detail) => {
      const deadline = Date.now() + 1400;
      while (!predicate(current())) {
        if (Date.now() >= deadline) throw new Error(detail);
        await pause();
      }
    };
    current();
    if (question.wooclapType === "LabelAnImage") {
      verifiedCaptions.delete(current().scope);
      const open = async (id) => {
        const pin = current().controls.get(id);
        if (!pin || disabled4(pin)) throw new Error("The caption marker is unavailable.");
        pin.click();
        await waitFor3((live2) => captionInput(live2)?.marker === id, "Wooclap did not open the requested caption.");
        const input2 = captionInput(current()).input;
        if (disabled4(input2)) throw new Error("The caption field is unavailable.");
        return input2;
      };
      for (const entry of answer.values ?? []) {
        const input2 = await open(entry.id), win = input2.ownerDocument.defaultView;
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("The caption cannot be updated.");
        setter.call(input2, entry.value);
        input2.dispatchEvent(new win.Event("input", { bubbles: true }));
        input2.dispatchEvent(new win.Event("change", { bubbles: true }));
        await pause(80);
        await waitFor3((live2) => captionInput(live2)?.marker === entry.id && captionInput(live2)?.input.value === entry.value, "Wooclap did not retain the caption.");
      }
      for (const entry of answer.values ?? []) {
        await open(entry.id);
        await waitFor3((live2) => captionInput(live2)?.input.value === entry.value, "A previously entered caption was not retained.");
      }
      const live = current(), input = captionInput(live);
      verifiedCaptions.set(live.scope, { identity: identity2, values: JSON.stringify(answer.values), input: input.input, marker: input.marker, snapshot: snapshotImageInteraction(live) });
    } else {
      for (const point of answer.points ?? []) {
        if (point.x <= 0 || point.y <= 0 || point.x >= 1 || point.y >= 1) throw new Error("Place image answers inside the image, away from the exact boundary.");
        if (question.wooclapType === "DragAndDrop") {
          const item = current().controls.get(point.id);
          if (!item || disabled4(item)) throw new Error("The requested image label is unavailable.");
          item.click();
          await pause(80);
          current();
        }
        const live = current(), img = image(live), r = img.getBoundingClientRect(), surface = live.controls.get("@surface");
        const win = img.ownerDocument.defaultView, init = { clientX: r.left + point.x * r.width, clientY: r.top + point.y * r.height, bubbles: true, cancelable: true, button: 0 };
        if (question.wooclapType === "ShowOnImage") surface.dispatchEvent(new win.MouseEvent("click", init));
        else {
          surface.dispatchEvent(new win.MouseEvent("mousedown", { ...init, buttons: 1 }));
          await pause(80);
          current();
          win.dispatchEvent(new win.MouseEvent("mouseup", { ...init, buttons: 0 }));
        }
        await waitFor3((next) => {
          const pin = pins(next).get(point.id);
          if (!pin) return false;
          const [x, y] = pinPoint(pin, image(next)), b = image(next).getBoundingClientRect();
          return Math.abs(x - point.x) * b.width <= 1.5 && Math.abs(y - point.y) * b.height <= 1.5;
        }, "Wooclap did not retain the requested image position.");
      }
    }
    await waitFor3((live) => verifyImageInteraction(live, answer) && query4(live.scope, '[data-test-id="Participant.Submit"]').some((button) => !disabled4(button)), "The completed image answer is not ready to submit.");
  }

  // src/content/scenarios.ts
  var cache = /* @__PURE__ */ new WeakMap();
  var inFlight = /* @__PURE__ */ new WeakMap();
  var compact4 = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  var visible5 = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = el.ownerDocument.defaultView?.getComputedStyle(node);
      if (node.hasAttribute("hidden") || style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") return false;
    }
    return true;
  };
  var query5 = (scope, selector) => Array.from(scope.querySelectorAll(selector)).filter(visible5);
  function text3(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,input,textarea,button,[hidden],[aria-hidden="true"]').forEach((node) => node.remove());
    return compact4(clone.textContent);
  }
  function structure(scope, title) {
    if (!scope.matches(".Concordance,.SCTJudgment")) return null;
    const sliders = query5(scope, '[role="slider"]');
    const submits = query5(scope, '[data-test-id="Participant.Submit"]');
    if (sliders.length !== 1 || submits.length !== 1) return null;
    const slider = sliders[0];
    if (slider.matches('[aria-disabled="true"],[inert]') || slider.closest("[inert]")) return null;
    const positions = query5(slider, "ul > li");
    const values = scope.matches(".SCTJudgment") ? [-2, -1, 1, 2] : [-2, -1, 0, 1, 2];
    const contextRows = slider.parentElement?.matches("ul") ? query5(slider.parentElement, ":scope > li") : [];
    const handles = query5(slider, 'span[draggable="false"]');
    const label3 = slider.previousElementSibling;
    const comments = query5(scope, "textarea");
    if (slider.getAttribute("aria-valuemin") !== "-2" || slider.getAttribute("aria-valuemax") !== "2" || positions.length !== values.length || contextRows.length !== 1 || handles.length !== 1 || !label3?.matches("p") || comments.length > 1 || comments.some((c) => c.required || c.getAttribute("aria-required") === "true") || query5(scope, 'input:not([type="hidden"]),select,[contenteditable="true"]').length) return null;
    if (scope.matches(".Concordance") && positions.some((position, index) => text3(position) !== String(values[index]))) return null;
    if (!text3(title) || !text3(contextRows[0])) return null;
    return {
      scope,
      title,
      slider,
      handle: handles[0],
      label: label3,
      context: contextRows[0],
      values,
      comment: comments[0]
    };
  }
  function identity(s) {
    return JSON.stringify([
      s.scope.ownerDocument.URL,
      s.scope.matches(".Concordance") ? "Concordance" : "SCTJudgment",
      text3(s.title),
      text3(s.context),
      s.values,
      query5(s.scope, "img").map((img) => [img.currentSrc || img.src, img.getAttribute("alt")]),
      s.comment ? [s.comment.getAttribute("aria-label"), s.comment.required, s.comment.maxLength] : null
    ]);
  }
  function selected(s) {
    if (!compact4(s.label.textContent)) return null;
    const value = s.handle.getAttribute("data-score");
    if (s.scope.matches(".Concordance")) return value !== null && s.values.includes(Number(value)) ? Number(value) : null;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(s.handle.style.left);
    if (!percent) return null;
    const index = s.values.findIndex((_, i) => Math.abs(i / (s.values.length - 1) * 100 - Number(percent[1])) < 0.5);
    const score = s.values[index];
    return score !== void 0 && Number(s.slider.getAttribute("aria-valuenow")) === score ? score : null;
  }
  function liveStructure(initial, expected, assertActive) {
    assertActive();
    const next = structure(initial.scope, initial.title);
    if (!initial.scope.isConnected || !next || next.slider !== initial.slider || identity(next) !== expected || query5(initial.scope, '[data-test-id="participant-feedback-banner"]').length) throw new Error("The scenario changed or closed while reading its scale.");
    return next;
  }
  async function move(s, target, guard) {
    const win = s.scope.ownerDocument.defaultView;
    const step = async (key2, value) => {
      guard().slider.dispatchEvent(new win.KeyboardEvent("keydown", { key: key2, bubbles: true, cancelable: true }));
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const next = guard();
        if (selected(next) === value && compact4(next.label.textContent)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The scenario scale did not retain its selected position.");
    };
    guard().slider.focus();
    if (selected(guard()) === s.values[0]) await step("End", s.values[s.values.length - 1]);
    await step("Home", s.values[0]);
    for (let index = 1; index <= s.values.indexOf(target); index++) await step("ArrowRight", s.values[index]);
    return guard();
  }
  function prepareScenarios(doc, assertActive = () => {
  }) {
    const previous = inFlight.get(doc);
    if (previous) return previous;
    const work = (async () => {
      const titles = query5(doc, '[data-test-id="Question.participant.title"]');
      if (titles.length !== 1) return;
      const scope = titles[0].closest(".Concordance,.SCTJudgment");
      if (!scope || query5(scope, '[data-test-id="participant-feedback-banner"]').length) return;
      const initial = structure(scope, titles[0]);
      if (!initial) return;
      const key2 = identity(initial), remembered = cache.get(initial.slider);
      const original = selected(initial);
      const currentLabel = compact4(initial.label.textContent);
      if (remembered?.identity === key2 && Date.now() - remembered.at < 3e4 && (original === null || remembered.choices.find((c) => c.id === `scale-${original}`)?.text === currentLabel)) return;
      cache.delete(initial.slider);
      const originalComment = initial.comment?.value;
      const guard = () => {
        const next = liveStructure(initial, key2, assertActive);
        if (next.comment?.value !== originalComment) throw new Error("The scenario comment changed. Scale preparation stopped.");
        return next;
      };
      const choices = [];
      try {
        for (const value of initial.values) {
          const next = await move(initial, value, guard);
          choices.push({ id: `scale-${value}`, text: compact4(next.label.textContent) });
        }
        await move(initial, original ?? initial.values[0], guard);
        if (choices.some((choice) => !choice.text || choice.text.length > 8e3)) throw new Error("The scenario scale descriptions are incomplete.");
        cache.set(initial.slider, { identity: key2, choices, at: Date.now() });
      } catch (error) {
        cache.delete(initial.slider);
        throw error;
      }
    })();
    inFlight.set(doc, work);
    void work.finally(() => inFlight.delete(doc)).catch(() => {
    });
    return work;
  }
  function extractScenarios(scope, title, eventKey2, doc) {
    const s = structure(scope, title);
    if (!s) return null;
    const remembered = cache.get(s.slider);
    if (!remembered || remembered.identity !== identity(s)) return null;
    const unsupported4 = (detail) => ({ question: null, state: "unsupported", detail });
    if (query5(scope, "audio,video,canvas").length || query5(scope, "svg").some((el) => !el.matches("[data-icon],.svg-inline--fa"))) return unsupported4("The scenario contains unsupported media.");
    const images3 = query5(scope, "img").filter((el) => !el.matches('[data-decorative],.icon,[role="presentation"]'));
    if (images3.length > 16) return unsupported4("The scenario contains too many images.");
    if (images3.some((img) => !img.complete || !img.naturalWidth)) return { question: null, state: "waiting", detail: "Waiting for scenario images." };
    const imageKeys = images3.map((img) => {
      const value = `${img.currentSrc || img.src}|${img.alt}`;
      if (value.length < 1900) return value;
      let hash = 2166136261;
      for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return `scenario-image:${value.length}:${hash >>> 0}`;
    });
    const box = scope.getBoundingClientRect();
    const controls = /* @__PURE__ */ new Map([["scale", s.slider]]);
    if (s.comment) controls.set("comment", s.comment);
    return {
      question: {
        kind: "scenario",
        wooclapType: scope.matches(".Concordance") ? "Concordance" : "SCTJudgment",
        source: "wooclap",
        eventKey: eventKey2,
        questionId: null,
        text: `${text3(title)}
${text3(s.context)}
Choose using the supplied full scale descriptions. Any optional participant comment will be preserved.`,
        choices: remembered.choices.map((choice) => ({ ...choice })),
        multiple: false,
        imageKeys,
        application: "automatic",
        responseMode: "single"
      },
      scope,
      controls,
      rect: {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        viewportWidth: doc.defaultView?.innerWidth ?? 0,
        viewportHeight: doc.defaultView?.innerHeight ?? 0
      }
    };
  }
  function fromLive(live) {
    const titles = query5(live.scope, '[data-test-id="Question.participant.title"]');
    return titles.length === 1 ? structure(live.scope, titles[0]) : null;
  }
  function snapshotScenarios(live) {
    const s = fromLive(live);
    return JSON.stringify(s ? [selected(s), compact4(s.label.textContent), s.comment?.value ?? null] : null);
  }
  function verifyScenarios(live, answer) {
    if (live.question.application !== "automatic" || validateAnswer(live.question, answer)) return false;
    const s = fromLive(live), choice = live.question.choices.find((c) => c.id === answer.selectedChoiceIds[0]);
    return Boolean(s && choice && `scale-${selected(s)}` === choice.id && compact4(s.label.textContent) === choice.text);
  }
  async function applyScenarios(question, answer, readCurrent, assertActive = () => {
  }) {
    const error = validateAnswer(question, answer);
    if (error || question.application !== "automatic") throw new Error(error || "This scenario needs manual review.");
    const expected = fingerprint(question), initial = readCurrent(), s = fromLive(initial);
    if (!s) throw new Error("The scenario controls are unavailable.");
    const key2 = identity(s), comment = s.comment?.value;
    const guard = () => {
      const next = liveStructure(s, key2, assertActive);
      const current = readCurrent();
      if (fingerprint(current.question) !== expected || next.comment?.value !== comment) throw new Error("The scenario or comment changed. Submission stopped.");
      return next;
    };
    const target = Number(answer.selectedChoiceIds[0].slice("scale-".length));
    if (!s.values.includes(target)) throw new Error("The scenario answer has an unavailable scale position.");
    await move(s, target, guard);
    guard();
    if (!verifyScenarios(readCurrent(), answer)) throw new Error("The selected scenario description changed. Review it before submitting.");
  }

  // src/content/remaining.ts
  var contributions = (q) => ["Brainstorm", "Framework"].includes(q.wooclapType ?? "");
  var images = (q) => IMAGE_TYPES.includes(q.wooclapType ?? "");
  var isRemaining = (q) => q.application === "automatic" && (contributions(q) || images(q) || ["Concordance", "SCTJudgment"].includes(q.wooclapType ?? ""));
  function extractRemaining(scope, title, eventKey2, doc) {
    const result = extractContributions(scope, title, eventKey2, doc) ?? extractImageInteraction(scope, title, eventKey2, doc) ?? extractScenarios(scope, title, eventKey2, doc);
    return result && "state" in result && result.state === "unsupported" ? null : result;
  }
  async function prepareRemaining(doc, guard) {
    await prepareContributions(doc, guard);
    await prepareScenarios(doc, guard);
  }
  function snapshotRemaining(live) {
    return contributions(live.question) ? snapshotContributions(live) : images(live.question) ? snapshotImageInteraction(live) : snapshotScenarios(live);
  }
  function verifyRemaining(live, answer) {
    return contributions(live.question) ? verifyContributions(live, answer) : images(live.question) ? verifyImageInteraction(live, answer) : verifyScenarios(live, answer);
  }
  async function applyRemaining(q, answer, read, guard) {
    if (contributions(q)) await applyContributions(q, answer, read, guard);
    else if (images(q)) await applyImageInteraction(q, answer, read, guard);
    else await applyScenarios(q, answer, read, guard);
  }
  async function submitRemaining(live, answer, guard) {
    if (!contributions(live.question)) return false;
    await submitContributions(live, answer, guard);
    return true;
  }

  // src/content/wooclap.ts
  function extractSorting(scope, title, eventKey2, doc) {
    const unsupported4 = (detail) => ({ question: null, state: "unsupported", detail });
    const lists = query6(scope, '[data-rbd-droppable-id="sorting"]');
    if (lists.length !== 1) return unsupported4("The sorting list is missing or ambiguous.");
    const rows = query6(lists[0], "[data-rbd-draggable-id]");
    if (rows.length < 2 || rows.length > 30) return unsupported4("Sorting needs between two and thirty items.");
    if (query6(scope, '[data-test-id="Participant.Submit"]').length !== 1) return { question: null, state: "waiting", detail: "Sorting is closed." };
    if (query6(scope, "img, audio, video, canvas", true).length || query6(scope, "svg", true).some((svg) => !svg.matches("[data-icon], .icon, [data-decorative]") && !svg.closest("button"))) {
      return unsupported4("Sorting with media requires manual review.");
    }
    const controls = /* @__PURE__ */ new Map();
    const choices = rows.map((row) => {
      const id = row.getAttribute("data-rbd-draggable-id");
      const textElement = Array.from(row.querySelectorAll("[id]")).find((el) => el.id === `choice-text-${id}`);
      controls.set(id, row);
      return { id, text: textElement ? label2(textElement) : "" };
    });
    if (controls.size !== rows.length || choices.some((c) => !c.id || c.id.length > 256 || !c.text) || !label2(title)) return unsupported4("Sorting item labels or identifiers are missing or duplicated.");
    if (rows.some((row) => !query6(row, "button[aria-controls]").length)) return unsupported4("Sorting movement controls are unavailable.");
    return { question: {
      kind: "sorting",
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      text: label2(title),
      choices,
      multiple: false,
      imageKeys: []
    }, scope, controls, rect: bounds3([title, lists[0]], doc) };
  }
  var titleSelector2 = '[data-test-id="Question.participant.title"]';
  var feedbackSelector = '[data-test-id="participant-feedback-banner"]';
  var participantSelector = `.MCQ, .Poll, .Sorting, .GuessNumber, .OpenQuestion, .WordCloud, .FillInTheBlanks, .Matching, ${ADVANCED_TYPES}`;
  var presentationSelector = ".Video, .Slide, .Timer, .SpinTheWheel, .Instructions";
  var choiceSelector = 'button[data-idx][role="radio"], button[data-idx][role="checkbox"]';
  var reservedRoutes = /* @__PURE__ */ new Set([
    "public",
    "auth",
    "login",
    "signin",
    "signup",
    "register",
    "events",
    "event",
    "participant",
    "features",
    "pricing",
    "about",
    "blog",
    "logout",
    "blocked-locked-plan",
    "trial"
  ]);
  var compact5 = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  function eventKeyForUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !(url.hostname === "wooclap.com" || url.hostname.endsWith(".wooclap.com"))) return null;
      const match = url.pathname.match(/^\/([a-z\d_-]+)(?:\/(?:questionnaires|presentations)\/[a-z\d_-]+|\/(?:wall|report)(?:\/votes)?)?\/?$/i);
      if (!match || reservedRoutes.has(match[1].toLowerCase())) return null;
      return `${url.origin}/event/${match[1].toUpperCase()}`;
    } catch {
      return null;
    }
  }
  function visible6(element, visual = false) {
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || !visual && node.getAttribute("aria-hidden") === "true") return false;
      const style = element.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
    }
    return true;
  }
  function query6(scope, selector, visual = false) {
    return Array.from(scope.querySelectorAll(selector)).filter((element) => visible6(element, visual));
  }
  function label2(element) {
    const clone = element.cloneNode(true);
    for (const ignored of clone.querySelectorAll('script, style, [hidden], [aria-hidden="true"], button, [role="img"]')) ignored.remove();
    return compact5(clone.textContent);
  }
  function images2(scope) {
    return query6(scope, "img", true).filter((img) => !img.matches('[data-decorative], .icon, [data-icon], [role="presentation"]'));
  }
  function imageKey(value) {
    if (value.length <= 1900) return value;
    let first = 2166136261, second = 2654435769;
    for (let i = 0; i < value.length; i += 1) {
      first = Math.imul(first ^ value.charCodeAt(i), 16777619);
      second = Math.imul(second ^ value.charCodeAt(i), 2246822507);
    }
    return `asset:${value.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }
  function bounds3(elements, doc) {
    const boxes = elements.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    const left = boxes.length ? Math.min(...boxes.map((box) => box.left)) : 0;
    const top = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
    const right = boxes.length ? Math.max(...boxes.map((box) => box.right)) : 0;
    const bottom = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    };
  }
  function participantScope(doc) {
    const titles = query6(doc, titleSelector2);
    if (titles.length !== 1) return null;
    return titles[0].closest(participantSelector);
  }
  function hasWooclapConfirmation(doc) {
    if (!eventKeyForUrl(doc.URL)) return false;
    const scope = participantScope(doc);
    if (!scope) return false;
    const banners = query6(scope, feedbackSelector);
    if (banners.length !== 1 || !banners[0].closest('[role="alert"]')) return false;
    const banner = banners[0];
    if (banner.querySelector(".fa-hourglass-start, .fa-hourglass-end")) return false;
    return Boolean(banner.querySelector(".fa-paper-plane, .fa-stars, .fa-circle-xmark"));
  }
  function extractWooclap(doc) {
    const eventKey2 = eventKeyForUrl(doc.URL);
    if (!eventKey2) return { question: null, state: "unsupported", detail: "Open a Wooclap participant event, not the organizer or login page." };
    if (query6(doc, presentationSelector).length && !query6(doc, participantSelector).length) {
      return { question: null, state: "waiting", detail: "A presentation activity is visible. Waiting for the next answerable question." };
    }
    const titles = query6(doc, titleSelector2);
    if (!titles.length) return { question: null, state: "waiting", detail: "Waiting for a supported Wooclap participant question." };
    if (titles.length !== 1) return { question: null, state: "unsupported", detail: "Multiple participant question titles are visible." };
    const title = titles[0];
    const scope = title.closest(participantSelector);
    if (!scope) return { question: null, state: "unsupported", detail: "This participant question layout is not recognized." };
    if (hasWooclapConfirmation(doc)) return { question: null, state: "submitted", detail: "Wooclap confirms that your answer was submitted." };
    if (query6(scope, feedbackSelector).length) return { question: null, state: "waiting", detail: "The question is closed or displaying feedback. Waiting for the next question." };
    if (scope.matches(".Sorting") && query6(scope, 'textarea, input:not([type="hidden"]):not([type="button"]):not([type="submit"])').length) {
      return { question: null, state: "unsupported", detail: "This sorting question has additional input fields. Review it manually." };
    }
    if (scope.matches(".Sorting")) return extractSorting(scope, title, eventKey2, doc);
    const structured = extractStructured(scope, title, eventKey2, doc);
    if (structured) {
      if ("state" in structured) return structured;
      if (query6(scope, "audio,video,canvas", true).length) return { question: null, state: "unsupported", detail: "Audio, video, and canvas content requires manual review." };
      const meaningfulImages2 = images2(scope);
      if (meaningfulImages2.some((img) => !img.complete || !img.naturalWidth)) return { question: null, state: "waiting", detail: "Waiting for question images to load." };
      const diagrams = query6(scope, "svg", true).filter((svg) => !svg.matches('[data-icon],.icon,[data-decorative],[role="presentation"]') && !svg.closest("button"));
      if (meaningfulImages2.length + diagrams.length > 16) return { question: null, state: "unsupported", detail: "This question contains too many images." };
      structured.question.imageKeys = [
        ...meaningfulImages2.map((img) => imageKey(`${img.currentSrc || img.src}|${compact5(img.alt)}`)),
        ...diagrams.map((svg) => imageKey(svg.outerHTML))
      ];
      if (structured.question.imageKeys.length) structured.rect = bounds3([scope, title, ...meaningfulImages2, ...diagrams], doc);
      return structured;
    }
    const remaining = extractRemaining(scope, title, eventKey2, doc);
    if (remaining) return remaining;
    const advanced = extractAdvanced(scope, title, eventKey2, doc);
    if (advanced) return advanced;
    const groups = query6(scope, 'ul[aria-labelledby="question-title"][role="radiogroup"], ul[aria-labelledby="question-title"][role="group"]');
    if (groups.length !== 1) return { question: null, state: "unsupported", detail: "The Wooclap answer group is missing or ambiguous." };
    const group = groups[0];
    const controls = query6(group, choiceSelector);
    if (!controls.length && query6(group, 'div[data-idx][aria-disabled="true"]').length) {
      return { question: null, state: "waiting", detail: "Voting is closed. Waiting for the next question." };
    }
    if (controls.length < 2 || controls.length > 30) return { question: null, state: "unsupported", detail: "The question needs between two and thirty recognizable choices." };
    const multiple = group.getAttribute("role") === "group";
    if (controls.some((control) => control.getAttribute("role") !== (multiple ? "checkbox" : "radio") || !["true", "false"].includes(control.getAttribute("aria-checked") ?? ""))) {
      return { question: null, state: "unsupported", detail: "Wooclap choice selection states are missing or inconsistent." };
    }
    if (controls.some((control) => control.getAttribute("aria-disabled") === "true" || control.matches(":disabled"))) {
      return { question: null, state: "waiting", detail: "The answer controls are disabled. Waiting for the next question." };
    }
    const submit = query6(scope, '[data-test-id="Participant.Submit"]');
    if (submit.length !== 1) return { question: null, state: "waiting", detail: "Wooclap is not accepting a submission for this question." };
    if (query6(scope, "textarea").length) return { question: null, state: "unsupported", detail: "This question asks for an answer comment. Review it manually." };
    if (query6(scope, "audio, video, canvas").length) return { question: null, state: "unsupported", detail: "Audio, video, and canvas questions require manual review." };
    const text4 = label2(title);
    const meaningfulImages = images2(scope);
    if (meaningfulImages.some((img) => !img.complete || img.naturalWidth === 0)) return { question: null, state: "waiting", detail: "Waiting for the Wooclap question images to load." };
    if (meaningfulImages.length > 16) return { question: null, state: "unsupported", detail: "This question contains too many images to capture safely." };
    const controlMap = /* @__PURE__ */ new Map();
    const choices = controls.map((control) => {
      const idx = control.getAttribute("data-idx") ?? "";
      const id = `choice-${idx}`;
      controlMap.set(id, control);
      return { id, text: label2(control) || (images2(control).length ? `Image option ${idx}` : "") };
    });
    if (!text4 || choices.some((choice) => !choice.text || !/^choice-[1-9]\d*$/.test(choice.id)) || controlMap.size !== choices.length) {
      return { question: null, state: "unsupported", detail: "Question text or choice labels/indices are missing or ambiguous." };
    }
    const question = {
      source: "wooclap",
      eventKey: eventKey2,
      questionId: null,
      text: text4,
      choices,
      multiple,
      imageKeys: meaningfulImages.map((img) => imageKey(`${img.currentSrc || img.src}|${compact5(img.alt)}`))
    };
    return { question, scope, controls: controlMap, rect: bounds3([title, group, ...controls, ...meaningfulImages], doc) };
  }

  // src/content/adapter.ts
  var lastSelection = /* @__PURE__ */ new WeakMap();
  var structuredKind = (question) => ["numeric", "text", "fields", "matching"].includes(question.kind ?? "");
  var advancedKind = (question) => ["rating", "allocation", "categorized", "point", "placements", "scenario"].includes(question.kind ?? "");
  var nativeChoices = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
  var scopeSelector = '[data-wooclap-question], [data-question-id], form, fieldset, [role="radiogroup"], .MCQ, .Poll';
  var compact6 = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  function imageIdentity(value) {
    if (value.length <= 1900) return value;
    let first = 2166136261;
    let second = 2654435769;
    for (let i = 0; i < value.length; i += 1) {
      first = Math.imul(first ^ value.charCodeAt(i), 16777619);
      second = Math.imul(second ^ value.charCodeAt(i), 2246822507);
    }
    return `asset:${value.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }
  function sourceForUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && (url.hostname === "wooclap.com" || url.hostname.endsWith(".wooclap.com"))) return "wooclap";
      if (url.origin === "http://127.0.0.1:4318" && url.pathname === "/practice") return "practice";
    } catch {
    }
    return null;
  }
  function eventKey(doc, source) {
    const url = new URL(doc.URL);
    if (source === "practice") return `${url.origin}/practice`;
    const participantKey = eventKeyForUrl(doc.URL);
    if (participantKey) return participantKey;
    const route = url.pathname.match(/^\/(?:events?|participant)\/([a-z\d_-]+)(?:\/|$)/i) ?? url.pathname.match(/^\/([a-z\d]{6})(?:\/|$)/i);
    return route ? `${url.origin}/event/${route[1].toUpperCase()}` : null;
  }
  function visible7(element) {
    const view = element.ownerDocument.defaultView;
    for (let current = element; current; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
      const style = view?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
    }
    return true;
  }
  function query7(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter(visible7);
  }
  function textOf(element) {
    const clone = element.cloneNode(true);
    for (const ignored of clone.querySelectorAll('[hidden], [aria-hidden="true"], script, style')) ignored.remove();
    for (const img of clone.querySelectorAll("img[alt]")) img.replaceWith(img.getAttribute("alt") ?? "");
    return compact6(clone.textContent);
  }
  function accessibleLabel(element) {
    const labelledBy = compact6(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const labels = labelledBy.split(" ").map((id) => element.ownerDocument.getElementById(id));
      if (labels.every(Boolean)) return compact6(labels.map((label3) => textOf(label3)).join(" "));
    }
    const ariaLabel = compact6(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    if (element.tagName === "INPUT") {
      const labels = Array.from(element.labels ?? []).filter(visible7);
      if (labels.length) return compact6(labels.map(textOf).join(" "));
      return compact6(element.getAttribute("data-choice-text"));
    }
    return compact6(element.getAttribute("data-choice-text")) || textOf(element);
  }
  function disabled5(element) {
    return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || Boolean(element.closest('[inert], [aria-disabled="true"]'));
  }
  function selected2(element) {
    if (element.tagName === "INPUT") return element.checked;
    return element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-pressed") === "true" || element.getAttribute("data-selected") === "true";
  }
  function controlsIn(scope, config) {
    const selector = config.choices || `${nativeChoices}, [data-wooclap-choice]`;
    const matches = query7(scope, selector).map((element) => {
      if (element.matches(nativeChoices) || config.choices) return element;
      return element.querySelector(nativeChoices) ?? element;
    });
    return [...new Set(matches)];
  }
  function questionText(scope, questionElement) {
    if (questionElement && questionElement !== scope) return textOf(questionElement);
    const explicit = query7(scope, "[data-wooclap-question-text]");
    if (explicit.length === 1) return textOf(explicit[0]);
    if (explicit.length > 1) return "";
    if (scope.hasAttribute("aria-labelledby") || scope.hasAttribute("aria-label")) return accessibleLabel(scope);
    const headings = query7(scope, 'legend, h1, h2, h3, [role="heading"]').filter((element) => !element.closest('label, [role="radio"], [role="checkbox"]'));
    return headings.length === 1 ? textOf(headings[0]) : "";
  }
  function bounds4(elements, doc) {
    const rectangles = elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    const left = rectangles.length ? Math.min(...rectangles.map((rect) => rect.left)) : 0;
    const top = rectangles.length ? Math.min(...rectangles.map((rect) => rect.top)) : 0;
    const right = rectangles.length ? Math.max(...rectangles.map((rect) => rect.right)) : 0;
    const bottom = rectangles.length ? Math.max(...rectangles.map((rect) => rect.bottom)) : 0;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      viewportWidth: doc.defaultView?.innerWidth ?? 0,
      viewportHeight: doc.defaultView?.innerHeight ?? 0
    };
  }
  function extract(config, doc) {
    const source = sourceForUrl(doc.URL);
    if (!source) return { question: null, state: "unsupported", detail: "Open an HTTPS Wooclap page or the local practice page." };
    if (source === "wooclap" && !doc.querySelector("[data-wooclap-question]")) {
      if (!eventKeyForUrl(doc.URL)) return { question: null, state: "unsupported", detail: "Open a Wooclap participant event, not the organizer or login page." };
      if (!config.question && !config.choices) {
        if (config.choiceClickSubmits) return { question: null, state: "unsupported", detail: "Wooclap multiple-choice questions use a separate Submit button. Disable submit-on-choice." };
        return extractWooclap(doc);
      }
      if (!doc.querySelector('[data-test-id="Question.participant.title"]')) return { question: null, state: "waiting", detail: "Waiting for the Wooclap participant question interface." };
    }
    const key2 = eventKey(doc, source);
    if (!key2) return { question: null, state: "unsupported", detail: "This Wooclap event URL is not recognized." };
    if (hasSubmissionConfirmation(config, doc)) return { question: null, state: "submitted", detail: "The page confirms that an answer was submitted." };
    if (query7(doc, "[data-wooclap-waiting]").length) return { question: null, state: "waiting", detail: "Waiting for the next question." };
    let scopes;
    let questionElement;
    if (config.question) {
      const matches = query7(doc, config.question);
      if (matches.length !== 1) return { question: null, state: "unsupported", detail: "The question selector must match exactly one visible element." };
      questionElement = matches[0];
      const scope2 = questionElement.matches(scopeSelector) ? questionElement : questionElement.closest(scopeSelector);
      if (!scope2) return { question: null, state: "unsupported", detail: "The configured question needs a form or question container." };
      scopes = [scope2];
    } else {
      scopes = query7(doc, "[data-wooclap-question]");
      if (!scopes.length) {
        const candidates = query7(doc, scopeSelector).filter((scope2) => controlsIn(scope2, config).length >= 2);
        scopes = candidates.filter((scope2) => !candidates.some((other) => other !== scope2 && scope2.contains(other) && controlsIn(scope2, config).length === controlsIn(other, config).length));
      }
    }
    if (!scopes.length) return { question: null, state: "waiting", detail: "No supported question is visible yet." };
    if (scopes.length !== 1) return { question: null, state: "unsupported", detail: "More than one question or answer group is visible." };
    const scope = scopes[0];
    const text4 = questionText(scope, questionElement);
    if (!text4) return { question: null, state: "unsupported", detail: "Question text is missing or ambiguous." };
    const controls = controlsIn(scope, config);
    if (controls.length < 2) return { question: null, state: "unsupported", detail: "At least two labeled answer controls are required." };
    if (controls.every(disabled5)) return { question: null, state: "waiting", detail: "The question is closed or its answer controls are disabled." };
    if (controls.some(disabled5)) return { question: null, state: "unsupported", detail: "Some answer controls are unavailable." };
    const modes = new Set(controls.map((control) => control.getAttribute("role") || (control.tagName === "INPUT" ? control.getAttribute("type") : "custom")));
    let multiple;
    if (modes.size === 1 && modes.has("radio")) multiple = false;
    else if (modes.size === 1 && modes.has("checkbox")) multiple = true;
    else if (modes.size === 1 && modes.has("custom") && config.choices) multiple = config.multiple;
    else if (modes.size === 1 && modes.has("custom") && ["true", "false"].includes(scope.getAttribute("data-wooclap-multiple") ?? "")) {
      multiple = scope.getAttribute("data-wooclap-multiple") === "true";
    } else return { question: null, state: "unsupported", detail: "The answer selection mode is missing or ambiguous." };
    if (multiple && config.choiceClickSubmits) return { question: null, state: "unsupported", detail: "Submit-on-choice is only supported for single-answer questions." };
    const radioNames = new Set(controls.filter((control) => control.matches('input[type="radio"]')).map((control) => control.getAttribute("name") ?? ""));
    if (radioNames.size > 1 || radioNames.has("")) return { question: null, state: "unsupported", detail: "Radio controls need one unambiguous named group." };
    const choiceMap = /* @__PURE__ */ new Map();
    const choices = controls.map((control, index) => {
      const id = compact6(control.getAttribute("data-choice-id")) || control.id || `choice-${index + 1}`;
      const label3 = accessibleLabel(control);
      choiceMap.set(id, control);
      return { id, text: label3 };
    });
    if (choiceMap.size !== choices.length || choices.some((choice) => !choice.text)) {
      return { question: null, state: "unsupported", detail: "Answer labels or answer identifiers are missing or duplicated." };
    }
    const images3 = query7(scope, "img").filter((element) => element.getAttribute("role") !== "presentation" && element.getAttribute("alt") !== "" && !element.matches('[data-decorative], .icon, [class*="avatar"]'));
    if (images3.some((img) => !img.complete || img.naturalWidth === 0)) return { question: null, state: "waiting", detail: "Waiting for question images to load." };
    const visuals = query7(scope, "canvas, video, svg").filter((element) => element.getAttribute("role") !== "presentation" && element.getAttribute("aria-hidden") !== "true" && !element.matches(".icon, [data-decorative]"));
    if (visuals.some((element) => element.matches("canvas, video"))) return { question: null, state: "unsupported", detail: "Canvas and video questions require manual review." };
    const imageKeys = images3.map((img) => imageIdentity(`${img.currentSrc || img.src}|${compact6(img.alt)}`));
    imageKeys.push(...visuals.map((element) => imageIdentity(`${element.tagName.toLowerCase()}:${element.outerHTML}`)));
    const question = {
      source,
      eventKey: key2,
      questionId: compact6(scope.getAttribute("data-question-id")) || compact6(scope.closest("[data-question-id]")?.getAttribute("data-question-id")) || null,
      text: text4,
      choices,
      multiple,
      imageKeys
    };
    const labels = controls.flatMap((control) => control.tagName === "INPUT" ? Array.from(control.labels ?? []) : []);
    return { question, scope, controls: choiceMap, rect: bounds4([scope, ...controls, ...labels, ...images3], doc) };
  }
  function observePage(config, doc = document) {
    try {
      const result = extract(config, doc);
      if ("state" in result) return result;
      return {
        question: result.question,
        state: "question",
        detail: "A supported question is ready.",
        rect: result.rect,
        ...isRemaining(result.question) ? { inputSignature: snapshotRemaining(result) } : structuredKind(result.question) ? { inputSignature: structuredResponseSnapshot(result) } : advancedKind(result.question) ? { inputSignature: advancedResponseSnapshot(result) } : {}
      };
    } catch (error) {
      return { question: null, state: "unsupported", detail: `Could not read question: ${error instanceof Error ? error.message : "invalid page or selectors"}` };
    }
  }
  function currentQuestion(expected, config, doc) {
    const result = extract(config, doc);
    if ("state" in result || fingerprint(result.question) !== fingerprint(expected)) throw new Error("The question changed or is no longer available. No answer was submitted.");
    return result;
  }
  async function waitForSelection(question, id, desired, config, doc, assertActive) {
    const deadline = Date.now() + 800;
    do {
      assertActive?.();
      const latest = currentQuestion(question, config, doc);
      const control = latest.controls.get(id);
      if (!control || disabled5(control)) throw new Error("The answer control became unavailable before selection was confirmed.");
      if (selected2(control) === desired) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error("The page did not confirm the requested selection. Review the answer manually.");
  }
  async function arrangeSorting(question, ids, config, doc, assertActive) {
    for (let target = 0; target < ids.length; target++) {
      for (let moves = 0; moves < ids.length; moves++) {
        assertActive?.();
        const current = currentQuestion(question, config, doc);
        const order = [...current.controls.keys()];
        const index = order.indexOf(ids[target]);
        if (index === target) break;
        if (index < target) throw new Error("The sorting order changed unexpectedly.");
        const row = current.controls.get(ids[target]);
        const up = query7(row, "button[aria-controls]").filter((button) => button.getAttribute("aria-controls") === `choice-text-${ids[target]}` && button.querySelector(".fa-arrow-up"));
        if (up.length !== 1 || disabled5(up[0])) throw new Error("A unique sorting move-up control is unavailable.");
        const expectedOrder = [...order];
        [expectedOrder[index - 1], expectedOrder[index]] = [expectedOrder[index], expectedOrder[index - 1]];
        up[0].click();
        const deadline = Date.now() + 1800;
        let confirmed = false;
        do {
          await new Promise((resolve) => setTimeout(resolve, 50));
          assertActive?.();
          const actual = [...currentQuestion(question, config, doc).controls.keys()];
          if (JSON.stringify(actual) === JSON.stringify(expectedOrder)) {
            confirmed = true;
            break;
          }
          if (JSON.stringify(actual) !== JSON.stringify(order)) throw new Error("The sorting order changed unexpectedly.");
        } while (Date.now() < deadline);
        if (!confirmed) throw new Error("The page did not confirm the sorting move. Review manually.");
      }
    }
    assertActive?.();
    if (JSON.stringify([...currentQuestion(question, config, doc).controls.keys()]) !== JSON.stringify(ids)) throw new Error("The final sorting order could not be verified.");
  }
  async function selectAnswer(question, answer, config, doc = document, assertActive) {
    assertActive?.();
    lastSelection.delete(doc);
    if (answer.needsReview) throw new Error("This answer requires review and cannot be applied.");
    if (question.application === "preview") throw new Error("This layout supports answer previews only. Apply the answer on the page.");
    if (structuredKind(question) || advancedKind(question)) {
      const issue = validateAnswer(question, answer);
      if (issue) throw new Error(issue);
      const read = () => currentQuestion(question, config, doc);
      if (isRemaining(question)) await applyRemaining(question, answer, read, assertActive);
      else if (structuredKind(question)) await applyStructured(question, answer, read, assertActive);
      else await applyAdvanced(question, answer, read, assertActive);
      lastSelection.set(doc, { question, answer: structuredClone(answer) });
      return { submittedBySelection: false };
    }
    if (question.kind === "sorting") {
      const issue = validateAnswer(question, answer);
      if (issue) throw new Error(issue);
      await arrangeSorting(question, answer.selectedChoiceIds, config, doc, assertActive);
      lastSelection.set(doc, { question, answer: structuredClone(answer) });
      return { submittedBySelection: false };
    }
    const ids = answer.selectedChoiceIds;
    if (!ids.length || new Set(ids).size !== ids.length || !question.multiple && ids.length !== 1) throw new Error("The answer has an invalid number of choices.");
    const initial = currentQuestion(question, config, doc);
    if (ids.some((id) => !initial.controls.has(id))) throw new Error("The answer contains an unknown choice identifier.");
    const changes = [...initial.controls].filter(([id, control]) => question.multiple ? selected2(control) !== ids.includes(id) : ids.includes(id) && !selected2(control));
    let clicked = false;
    for (const [id] of changes) {
      assertActive?.();
      const latest = currentQuestion(question, config, doc);
      const control = latest.controls.get(id);
      if (!control || disabled5(control)) throw new Error("The requested answer control is unavailable.");
      if (selected2(control) === ids.includes(id)) continue;
      control.click();
      clicked = true;
      await Promise.resolve();
      if (config.choiceClickSubmits) return { submittedBySelection: true };
      await waitForSelection(question, id, ids.includes(id), config, doc, assertActive);
    }
    const after = currentQuestion(question, config, doc);
    if ([...after.controls].some(([id, control]) => selected2(control) !== ids.includes(id))) throw new Error("The page did not confirm the requested selections.");
    if (config.choiceClickSubmits && !clicked) throw new Error("The choice was already selected; submission cannot be confirmed safely.");
    lastSelection.set(doc, { question, answer: structuredClone(answer) });
    return { submittedBySelection: false };
  }
  async function submitAnswer(config, doc = document, assertActive = () => {
  }) {
    assertActive();
    const expected = lastSelection.get(doc);
    if (!expected) throw new Error("Select and verify an answer before submitting.");
    const current = currentQuestion(expected.question, config, doc);
    const valid = isRemaining(expected.question) ? verifyRemaining(current, expected.answer) : structuredKind(expected.question) ? verifyStructured(current, expected.answer) : advancedKind(expected.question) ? verifyAdvanced(current, expected.answer) : expected.question.kind === "sorting" ? JSON.stringify([...current.controls.keys()]) === JSON.stringify(expected.answer.selectedChoiceIds) : [...current.controls].every(([id, control]) => selected2(control) === expected.answer.selectedChoiceIds.includes(id));
    if (!valid) {
      lastSelection.delete(doc);
      throw new Error("The selected choices changed before submission. Review the answer before continuing.");
    }
    if (isRemaining(expected.question) && ["Brainstorm", "Framework"].includes(expected.question.wooclapType ?? "")) {
      lastSelection.delete(doc);
      await submitRemaining(current, expected.answer, assertActive);
      return;
    }
    const matches = config.submit ? query7(doc, config.submit) : query7(current.scope, '[data-wooclap-submit], [data-test-id="Participant.Submit"], button[type="submit"], input[type="submit"], button').filter((element) => element.matches('[data-wooclap-submit], [data-test-id="Participant.Submit"], [type="submit"]') || /^(submit|send|vote|validate)(?:\s+answer)?$/i.test(accessibleLabel(element)));
    const buttons = [...new Set(matches)].filter((element) => !disabled5(element));
    if (buttons.length !== 1) throw new Error("A unique enabled submit control was not found. Configure its selector or submit manually.");
    lastSelection.delete(doc);
    assertActive();
    buttons[0].click();
    await Promise.resolve();
  }
  function hasSubmissionConfirmation(config, doc = document) {
    if (sourceForUrl(doc.URL) === "wooclap" && hasContributionsConfirmation(doc)) return true;
    if (sourceForUrl(doc.URL) === "wooclap" && hasWooclapConfirmation(doc)) return true;
    const explicit = config.confirmation || "[data-wooclap-confirmation]";
    if (query7(doc, explicit).length === 1) return true;
    return query7(doc, '[role="status"]').some((element) => /^(?:your\s+)?(?:answer|response|vote|submission)\s+(?:(?:has been|was|is)\s+)?(?:submitted|recorded|saved|received|accepted)(?:\s+successfully)?[.!]?$/i.test(textOf(element)));
  }

  // src/content/index.ts
  var host = globalThis;
  if (!host.__wooclapAutoLoaded) {
    host.__wooclapAutoLoaded = true;
    install();
  }
  function install() {
    const documentKey = crypto.randomUUID();
    let runId = null;
    let backgroundMode = false;
    let selectors = DEFAULT_SETTINGS.selectors;
    let occurrence = 0;
    let candidate = "";
    let candidateAt = 0;
    let lastSent = "";
    let observedQuestion = "";
    let waitingSinceQuestion = false;
    let applying = false;
    let preparing = false;
    let completedContribution = "";
    let completedContributionType = "";
    let userRevision = 0;
    let scheduled;
    const send = async (message) => {
      const expectedRun = runId;
      try {
        const reply = await chrome.runtime.sendMessage({ ...message, runId: expectedRun, documentKey });
        if (reply?.stop && runId === expectedRun) runId = null;
      } catch {
        if (runId === expectedRun) runId = null;
      }
    };
    function inspect() {
      try {
        const observation = observePage(selectors);
        if (observation.inputSignature !== void 0) observation.inputSignature = JSON.stringify([observation.inputSignature, userRevision]);
        return observation;
      } catch (error) {
        return { question: null, state: "unsupported", detail: error instanceof Error ? error.message : "Could not read this question." };
      }
    }
    function schedule(delay = 80) {
      if (!runId || applying || preparing || scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = void 0;
        void prepareAndScan();
      }, delay);
    }
    async function prepareAndScan() {
      if (!runId || applying || preparing) return;
      const expectedRun = runId;
      const expectedRevision = userRevision;
      preparing = true;
      try {
        const guard = () => {
          if (runId !== expectedRun || !backgroundMode && document.visibilityState !== "visible") throw new Error("Session paused or tab inactive.");
          if (userRevision !== expectedRevision) throw new Error("You interacted with the page. Question preparation stopped.");
        };
        await prepareStructured(document, guard);
        await prepareRemaining(document, guard);
        preparing = false;
        if (runId === expectedRun) scan();
      } catch (error) {
        if (runId === expectedRun) void send({ type: "OBSERVATION", occurrence, observation: {
          question: null,
          state: "unsupported",
          detail: error instanceof Error ? error.message : "Could not read the question options."
        } });
      } finally {
        preparing = false;
      }
    }
    function scan() {
      if (!runId || applying) return;
      const observation = inspect();
      const fp = observation.question ? fingerprint(observation.question) : "";
      if (completedContribution) {
        if (fp === completedContribution || observation.state === "submitted" && document.getElementsByClassName(completedContributionType).length) return;
        if (fp || observation.state === "waiting" && !document.getElementsByClassName(completedContributionType).length) {
          completedContribution = "";
          completedContributionType = "";
        }
      }
      const signature = observation.state + ":" + fp;
      if (signature !== candidate) {
        candidate = signature;
        candidateAt = Date.now();
        lastSent = "";
        void send({ type: "CONTENT_DIRTY" });
      }
      if (Date.now() - candidateAt < 700) {
        schedule(720);
        return;
      }
      if (signature === lastSent) return;
      if (observation.state === "waiting" || observation.state === "submitted") waitingSinceQuestion = true;
      if (observation.question && (fp !== observedQuestion || waitingSinceQuestion)) {
        occurrence += 1;
        observedQuestion = fp;
        waitingSinceQuestion = false;
      }
      lastSent = signature;
      void send({ type: "OBSERVATION", observation, occurrence });
    }
    async function apply(pending, expectedRun) {
      if (applying) throw new Error("An answer is already being submitted.");
      const preparationDeadline = Date.now() + 5e3;
      while (preparing && runId === expectedRun && Date.now() < preparationDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (preparing) throw new Error("The question options are still loading. Review the page before continuing.");
      const check = () => {
        if (runId !== expectedRun || !backgroundMode && document.visibilityState !== "visible") throw new Error("Session paused or tab inactive.");
        const current = inspect();
        if (!current.question || current.state !== "question" || occurrence !== pending.occurrence || fingerprint(current.question) !== pending.fingerprint) throw new Error("The question changed. The previous answer was discarded.");
        const issue = validateAnswer(current.question, pending.answer);
        if (issue) throw new Error(issue);
        return current;
      };
      const initial = check();
      if (pending.inputSignature !== void 0 && initial.inputSignature !== pending.inputSignature) throw new Error("The page inputs changed. Your entries were left unchanged.");
      const initialRevision = userRevision;
      if (pending.question.application === "preview") throw new Error("This type currently supports answer previews only.");
      applying = true;
      try {
        const result = await selectAnswer(pending.question, pending.answer, selectors, document, () => {
          if (runId !== expectedRun || !backgroundMode && document.visibilityState !== "visible") throw new Error("Session paused or tab inactive.");
          if (userRevision !== initialRevision) throw new Error("You edited the page while the answer was being applied. Automatic submission stopped.");
        });
        if (!result.submittedBySelection) {
          check();
          if (userRevision !== initialRevision) throw new Error("Page inputs changed before submission.");
          await submitAnswer(selectors, document, () => {
            check();
            if (userRevision !== initialRevision) throw new Error("Page inputs changed before submission.");
          });
        }
        for (let count = 0; count < 20; count++) {
          if (runId !== expectedRun) throw new Error("Session paused during submission. Check the page before continuing.");
          if (hasSubmissionConfirmation(selectors)) {
            if (pending.question.responseMode === "contribution") {
              completedContribution = pending.fingerprint;
              completedContributionType = pending.question.wooclapType || "";
            } else {
              waitingSinceQuestion = true;
              lastSent = "";
            }
            return { confirmed: true, detail: "Answer submitted and confirmed on the page." };
          }
          const current = inspect();
          if (current.question && fingerprint(current.question) !== pending.fingerprint) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return { confirmed: false, detail: "Submission was attempted once, but no confirmation appeared. Check the page; automatic answering is paused." };
      } finally {
        applying = false;
        schedule(100);
      }
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.type === "MONITOR_START") {
        runId = message.runId;
        backgroundMode = message.backgroundMode === true;
        selectors = message.selectors;
        lastSent = "";
        candidate = "";
        schedule();
        reply({ ok: true, documentKey });
      } else if (message.type === "MONITOR_STOP") {
        runId = null;
        backgroundMode = false;
        reply({ ok: true });
      } else if (message.type === "READ_CURRENT") {
        reply({ ok: true, observation: inspect(), occurrence, documentKey, runId });
      } else if (message.type === "APPLY_ANSWER") {
        if (message.runId !== runId || message.documentKey !== documentKey) {
          reply({ ok: false, error: "The monitored page changed." });
          return;
        }
        void apply(message.pending, message.runId).then((result) => reply({ ok: true, ...result })).catch((error) => reply({ ok: false, error: error.message }));
        return true;
      }
    });
    new MutationObserver(() => schedule()).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    for (const eventName of ["beforeinput", "pointerdown", "keydown", "click", "paste", "cut", "drop"]) document.addEventListener(eventName, (event) => {
      if (event.isTrusted) userRevision += 1;
    }, true);
    setInterval(() => schedule(), 5e3);
    document.addEventListener("visibilitychange", () => {
      if (runId && !backgroundMode && document.visibilityState !== "visible") void send({ type: "TAB_HIDDEN" });
      schedule();
    });
    window.addEventListener("pagehide", () => {
      if (runId) {
        void send({ type: "PAGE_DEPARTED" });
        runId = null;
      }
    });
  }
})();
