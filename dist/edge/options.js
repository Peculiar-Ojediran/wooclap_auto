"use strict";
(() => {
  // src/shared/types.ts
  var PROVIDER_MODELS = { openai: "gpt-4.1-mini", anthropic: "claude-sonnet-5-5", nvidia: "deepseek-ai/deepseek-v4.1-flash" };
  var PROVIDER_LABELS = { openai: "OpenAI", anthropic: "Claude (Anthropic)", nvidia: "NVIDIA (DeepSeek)" };
  var BRIDGE_URL = "http://127.0.0.1:4318";
  var DEFAULT_SETTINGS = {
    connectionMode: "direct",
    provider: "nvidia",
    bridgeToken: "",
    model: PROVIDER_MODELS.nvidia,
    mode: "suggest",
    requestLimit: 25,
    captureImages: true,
    backgroundMode: false,
    selectors: { question: "", choices: "", submit: "", confirmation: "", multiple: false, choiceClickSubmits: false }
  };

  // src/shared/hosted-config.ts
  var HOSTED_FALLBACK_URL = true ? "" : "";

  // src/content/structured.ts
  var inputSelector = 'input[type="text"], input[type="number"], input:not([type])';
  var blankSelector = `${inputSelector}, button[role="combobox"][aria-haspopup="listbox"]`;

  // src/content/advanced.ts
  var ADVANCED_TYPES = ".Rating, .Prioritization, .Brainstorm, .Framework, .LabelAnImage, .ShowOnImage, .DragAndDrop, .Concordance, .SCTJudgment";

  // src/content/wooclap.ts
  var participantSelector = `.MCQ, .Poll, .Sorting, .GuessNumber, .OpenQuestion, .WordCloud, .FillInTheBlanks, .Matching, ${ADVANCED_TYPES}`;
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

  // src/shared/schedules.ts
  function scheduleUrl(value) {
    if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a Wooclap participant link.");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Enter a full HTTPS Wooclap link.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname === "wooclap.com" || url.hostname.endsWith(".wooclap.com"))) {
      throw new Error("Use an HTTPS link on wooclap.com without embedded credentials or a custom port.");
    }
    if (!eventKeyForUrl(url.href)) throw new Error("Use a Wooclap participant event link, such as https://app.wooclap.com/ABCDEF.");
    return url.href;
  }

  // src/ui/options.ts
  function element(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing UI element: ${id}`);
    return found;
  }
  function input(id) {
    return element(id);
  }
  var form = element("settings-form");
  var providerSelect = element("provider");
  var connectionSelect = element("connection-mode");
  var errorMessage = element("error-message");
  var controls = ["save-settings", "check-bridge", "save-api-key", "forget-api-key", "provider", "api-key", "remember-api-key", "connection-mode"];
  var models = { ...PROVIDER_MODELS };
  var credentials = {
    openai: { configured: false, storage: "none" },
    anthropic: { configured: false, storage: "none" },
    nvidia: { configured: false, storage: "none" }
  };
  var currentProvider = DEFAULT_SETTINGS.provider;
  var busy = false;
  var initialized = false;
  function provider() {
    return providerSelect.value === "openai" || providerSelect.value === "anthropic" ? providerSelect.value : "nvidia";
  }
  function connectionMode() {
    return connectionSelect.value === "bridge" ? "bridge" : connectionSelect.value === "demo" ? "demo" : "direct";
  }
  function renderConnection() {
    const connection = connectionMode();
    element("bridge-settings").hidden = connection !== "bridge";
    input("bridge-token").disabled = connection !== "bridge";
    input("model").required = connection !== "demo";
    element("connection-help").textContent = connection === "bridge" ? "Run the optional local service and enter its pairing token below." : connection === "demo" ? "Try the bundled practice questions without an API key. Demo answers work only on practice pages." : "With your own API key, the extension sends requests directly to your selected provider. Without one, it uses the shared NVIDIA DeepSeek service when available.";
    element("connection-check-help").textContent = connection === "bridge" ? "This checks your local bridge and key configuration. Provider access is checked when answering." : connection === "demo" ? "Demo mode uses built-in answers for the practice page. No AI requests are sent." : "This checks your saved key or the shared NVIDIA service. Provider access is checked when answering.";
    element("api-key-help").textContent = connection === "bridge" ? "The extension sends your key through the paired local bridge to your selected AI provider. Wooclap pages cannot read it. No cookies are used." : connection === "demo" ? "No API key is needed for demo mode. You can manage keys here for your next AI session. No cookies are used." : "The extension sends your key directly to your selected AI provider. Wooclap pages cannot read it. No cookies are used.";
    element("hosted-fallback-help").hidden = connection !== "direct";
    element("hosted-fallback-help").textContent = HOSTED_FALLBACK_URL ? "Shared fallback: when your selected provider has no saved key, questions and included screenshots pass through the hosted service to NVIDIA. The service uses DeepSeek V4.1 Flash and its own API key; your personal keys are never sent to it." : "Shared fallback is unavailable in this build because no hosted service has been configured. Save your own API key to answer questions, or use the local practice demo.";
    element("practice-link").href = connection === "bridge" ? `${BRIDGE_URL}/practice` : chrome.runtime.getURL("practice.html");
    renderCredentials();
  }
  function showError(error) {
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    errorMessage.hidden = false;
  }
  function updateControls() {
    for (const id of controls) {
      element(id).disabled = busy || !initialized;
    }
    element("forget-api-key").disabled = busy || !initialized || !credentials[provider()].configured;
  }
  function renderCredentials() {
    const name = PROVIDER_LABELS[provider()];
    const credential = credentials[provider()];
    element("api-key-label").textContent = `${name} API key`;
    input("api-key").placeholder = credential.configured ? "Paste a replacement key" : `Paste your ${name} API key`;
    element("credential-status").textContent = credential.configured ? credential.storage === "local" ? `${name} key remembered on this device.` : `${name} key available for this browser session only.` : `No ${name} key saved in the extension.${connectionMode() === "bridge" ? " The bridge can also use a key from its environment settings." : connectionMode() === "direct" ? HOSTED_FALLBACK_URL ? " The shared NVIDIA DeepSeek service will be used." : " Shared fallback is unavailable in this build." : ""}`;
    element("credential-status").dataset.state = credential.configured ? "success" : "pending";
    updateControls();
  }
  function acceptCredentials(response) {
    if (response.credentials) credentials = response.credentials;
    renderCredentials();
  }
  function populate(settings) {
    currentProvider = settings.provider === "anthropic" || settings.provider === "openai" ? settings.provider : "nvidia";
    connectionSelect.value = settings.connectionMode === "bridge" || settings.connectionMode === "demo" ? settings.connectionMode : "direct";
    providerSelect.value = currentProvider;
    models[currentProvider] = settings.model;
    input("bridge-token").value = settings.bridgeToken;
    input("model").value = settings.model;
    input("mode-auto").checked = settings.mode === "auto";
    input("mode-suggest").checked = settings.mode === "suggest";
    input("request-limit").value = String(settings.requestLimit);
    input("capture-images").checked = settings.captureImages;
    input("background-mode").checked = settings.backgroundMode === true;
    input("selector-question").value = settings.selectors.question;
    input("selector-choices").value = settings.selectors.choices;
    input("selector-submit").value = settings.selectors.submit;
    input("selector-confirmation").value = settings.selectors.confirmation;
    input("selector-multiple").checked = settings.selectors.multiple;
    input("selector-choice-submits").checked = settings.selectors.choiceClickSubmits;
    renderConnection();
  }
  function readSettings() {
    return {
      connectionMode: connectionMode(),
      bridgeToken: input("bridge-token").value.trim(),
      provider: provider(),
      model: input("model").value.trim() || (connectionMode() === "demo" ? PROVIDER_MODELS[provider()] : ""),
      mode: input("mode-auto").checked ? "auto" : "suggest",
      requestLimit: Number(input("request-limit").value),
      captureImages: input("capture-images").checked,
      backgroundMode: input("background-mode").checked,
      selectors: {
        question: input("selector-question").value.trim(),
        choices: input("selector-choices").value.trim(),
        submit: input("selector-submit").value.trim(),
        confirmation: input("selector-confirmation").value.trim(),
        multiple: input("selector-multiple").checked,
        choiceClickSubmits: input("selector-choice-submits").checked
      }
    };
  }
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "The extension did not respond. Reload it from Edge\u2019s extensions page.");
    return response;
  }
  async function save() {
    const response = await send({ type: "SAVE_SETTINGS", settings: readSettings() });
    if (response.settings) populate(response.settings);
    acceptCredentials(response);
    element("save-status").textContent = "Settings saved. Start a session from the extension.";
    element("save-status").dataset.state = "success";
  }
  async function action(callback, validateForm = true) {
    if (busy || !initialized || validateForm && !form.reportValidity()) return;
    busy = true;
    updateControls();
    errorMessage.hidden = true;
    try {
      await callback();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      updateControls();
    }
  }
  function connectionChanged() {
    element("bridge-status").textContent = "Connection not checked with these settings.";
    element("bridge-status").removeAttribute("data-state");
  }
  function settingsChanged() {
    element("save-status").textContent = "You have unsaved changes.";
    element("save-status").dataset.state = "unsaved";
    connectionChanged();
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(save);
  });
  form.addEventListener("input", (event) => {
    if (event.target.closest("#credentials-controls")) return;
    settingsChanged();
  });
  providerSelect.addEventListener("change", () => {
    models[currentProvider] = input("model").value;
    currentProvider = provider();
    input("model").value = models[currentProvider];
    input("api-key").value = "";
    input("remember-api-key").checked = false;
    element("credential-action-status").textContent = "";
    renderCredentials();
    settingsChanged();
  });
  connectionSelect.addEventListener("change", () => {
    renderConnection();
    settingsChanged();
  });
  async function saveApiKey() {
    const selectedProvider = provider();
    const apiKey = input("api-key").value.trim();
    if (!apiKey) throw new Error("Paste an API key before saving it.");
    const remember = input("remember-api-key").checked;
    if (remember && !window.confirm(`Remember your ${PROVIDER_LABELS[selectedProvider]} API key on this device?

The extension will store it locally without encryption, until you forget or replace it. It will remain after Edge exits. Cancel to leave it unsaved.`)) {
      element("credential-action-status").textContent = "Permission declined. The new key was not saved.";
      return;
    }
    const response = await send({ type: "SAVE_API_KEY", provider: selectedProvider, apiKey, remember, consent: remember });
    input("api-key").value = "";
    input("remember-api-key").checked = false;
    acceptCredentials(response);
    element("credential-action-status").textContent = remember ? "API key remembered with your permission. Use Forget key to remove it." : "API key saved for this browser session only. Any previously remembered copy was removed.";
    connectionChanged();
  }
  element("save-api-key").addEventListener("click", () => void action(saveApiKey, false));
  input("api-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void action(saveApiKey, false);
    }
  });
  element("forget-api-key").addEventListener("click", () => void action(async () => {
    const response = await send({ type: "CLEAR_API_KEY", provider: provider() });
    input("api-key").value = "";
    input("remember-api-key").checked = false;
    acceptCredentials(response);
    element("credential-action-status").textContent = `API key removed from the extension.${connectionMode() === "bridge" ? " A key configured in the bridge environment remains separate." : ""}`;
    connectionChanged();
  }, false));
  element("check-bridge").addEventListener("click", () => void action(async () => {
    await save();
    const status = element("bridge-status");
    status.textContent = connectionMode() === "bridge" ? "Connecting to your local bridge\u2026" : "Checking your settings\u2026";
    status.removeAttribute("data-state");
    try {
      const response = await send({ type: "CHECK_CONNECTION" });
      if (!response.health) throw new Error("The extension returned an incomplete connection status.");
      const health = response.health;
      const name = PROVIDER_LABELS[health.provider ?? provider()];
      const connection = health.connectionMode ?? connectionMode();
      status.textContent = health.demo ? "Ready \xB7 Local practice demo enabled. No API key needed." : connection === "hosted" ? health.ready ? `Shared NVIDIA service available \xB7 ${health.model}. No personal API key needed. Provider access is checked when answering.` : health.detail || "Shared NVIDIA service unavailable. Save your own API key to enable AI answers." : health.ready ? `${connection === "bridge" ? "Bridge connected" : "Direct API"} \xB7 API key configured. ${name} access is checked when answering.` : health.detail || `Add an API key for ${name} here${connection === "bridge" ? " or configure it on the bridge" : ""} to enable AI answers.`;
      status.dataset.state = health.ready || health.demo ? "success" : "pending";
    } catch (error) {
      status.textContent = connectionMode() === "bridge" ? "Unable to connect. Check that the bridge is running and the token is correct." : "Unable to check your settings. See the error below.";
      status.dataset.state = "error";
      throw error;
    }
  }));
  updateControls();
  void send({ type: "GET_STATE" }).then((response) => {
    if (!response.settings) throw new Error("Could not read extension settings.");
    populate(response.settings);
    initialized = true;
    acceptCredentials(response);
  }).catch(showError);
  var scheduleForm = element("schedule-form");
  var scheduleActionStatus = element("schedule-action-status");
  var scheduleLoadStatus = element("schedule-load-status");
  var scheduleList = element("schedule-list");
  var scheduleStatuses = {
    pending: "Scheduled",
    starting: "Starting",
    running: "Running",
    completed: "Completed",
    cancelled: "Cancelled",
    missed: "Missed",
    failed: "Needs attention"
  };
  var sessionDate = new Intl.DateTimeFormat(void 0, { dateStyle: "medium", timeStyle: "short" });
  var scheduleBusy = false;
  var scheduleInitialized = false;
  var schedulePolling = false;
  var scheduleSequence = 0;
  var scheduleListKey = "";
  function localDateInput(date) {
    const part = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
  }
  function scheduleUrl2(value) {
    return new URL(scheduleUrl(value.trim()));
  }
  function updateScheduleControls() {
    element("add-schedule").disabled = scheduleBusy || !scheduleInitialized;
    element("refresh-schedules").disabled = scheduleBusy || schedulePolling;
    for (const button of scheduleList.querySelectorAll("button")) button.disabled = scheduleBusy;
  }
  function updateSchedulePreview() {
    const startsAt = new Date(input("schedule-start").value).getTime();
    const duration = Number(input("schedule-duration").value);
    const preview = element("schedule-window-preview");
    preview.textContent = Number.isFinite(startsAt) && Number.isInteger(duration) && duration >= 1 && duration <= 480 ? `The event tab closes at ${sessionDate.format(new Date(startsAt + duration * 6e4))}.` : "";
  }
  function renderSchedules(schedules) {
    scheduleInitialized = true;
    scheduleLoadStatus.textContent = "";
    const key = JSON.stringify(schedules);
    if (key !== scheduleListKey) {
      scheduleListKey = key;
      const items = schedules.map((schedule) => {
        const item = document.createElement("li");
        item.className = "schedule-item";
        const heading = document.createElement("div");
        heading.className = "schedule-item-heading";
        const status = document.createElement("span");
        status.className = "schedule-status";
        status.dataset.status = schedule.status;
        status.textContent = scheduleStatuses[schedule.status] ?? "Unknown";
        const mode = document.createElement("span");
        mode.className = "schedule-item-mode";
        mode.textContent = schedule.mode === "auto" ? "Automatic submission" : "Review suggestions";
        heading.append(status, mode);
        const link = document.createElement("a");
        link.className = "schedule-event-link";
        link.textContent = schedule.url;
        try {
          link.href = scheduleUrl2(schedule.url).href;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
        } catch {
        }
        const times = document.createElement("p");
        times.className = "schedule-item-times";
        times.textContent = `${sessionDate.format(new Date(schedule.startsAt))} \u2013 ${sessionDate.format(new Date(schedule.endsAt))}`;
        const detail = document.createElement("p");
        detail.className = "field-help";
        detail.textContent = schedule.detail;
        item.append(heading, link, times, detail);
        if (schedule.hasTab || schedule.status === "pending" || schedule.status === "starting" || schedule.status === "running") {
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "button button-quiet schedule-cancel";
          cancel.textContent = schedule.status === "pending" && !schedule.hasTab ? "Cancel schedule" : "Stop & close tab";
          cancel.setAttribute("aria-label", `${cancel.textContent}: ${schedule.url}`);
          cancel.addEventListener("click", () => void scheduleAction(async () => {
            await changeSchedules({ type: "CANCEL_SCHEDULE", id: schedule.id });
            scheduleActionStatus.textContent = "Schedule cancelled. Its status below shows whether the event tab was closed.";
          }));
          item.append(cancel);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-quiet schedule-remove";
        const active = schedule.hasTab || schedule.status === "starting" || schedule.status === "running";
        remove.textContent = active ? "Stop & remove" : "Remove";
        remove.title = active ? "Stop this scheduled session, close only its created event tab, and remove it from the list. A tab navigated away from its event is left open." : "Permanently remove this session from the schedule and history.";
        remove.setAttribute("aria-label", `${remove.textContent}: ${schedule.url}`);
        remove.addEventListener("click", () => void scheduleAction(async () => {
          await changeSchedules({ type: "REMOVE_SCHEDULE", id: schedule.id });
          scheduleActionStatus.textContent = "Session removed from the schedule and history.";
        }));
        item.append(remove);
        return item;
      });
      scheduleList.replaceChildren(...items);
    }
    element("schedule-empty").hidden = schedules.length !== 0;
    updateScheduleControls();
  }
  async function changeSchedules(message) {
    const response = await send(message);
    if (!Array.isArray(response.schedules)) throw new Error("Could not read schedules. Reload the extension and try again.");
    renderSchedules(response.schedules);
  }
  async function refreshSchedules() {
    if (schedulePolling || scheduleBusy) return;
    schedulePolling = true;
    const sequence = ++scheduleSequence;
    updateScheduleControls();
    try {
      const response = await send({ type: "GET_SCHEDULES" });
      if (sequence !== scheduleSequence) return;
      if (!Array.isArray(response.schedules)) throw new Error("Schedules are unavailable. Reload the extension and refresh this page.");
      renderSchedules(response.schedules);
    } catch (error) {
      if (sequence === scheduleSequence) {
        scheduleLoadStatus.textContent = error instanceof Error ? error.message : "Could not refresh schedules.";
      }
    } finally {
      schedulePolling = false;
      updateScheduleControls();
    }
  }
  async function scheduleAction(callback) {
    if (scheduleBusy || !scheduleInitialized) return;
    scheduleBusy = true;
    ++scheduleSequence;
    updateScheduleControls();
    scheduleActionStatus.textContent = "";
    scheduleActionStatus.removeAttribute("data-state");
    try {
      await callback();
      scheduleActionStatus.dataset.state = "success";
    } catch (error) {
      scheduleActionStatus.textContent = error instanceof Error ? error.message : "Could not update the schedule.";
      scheduleActionStatus.dataset.state = "error";
    } finally {
      scheduleBusy = false;
      updateScheduleControls();
    }
  }
  scheduleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!scheduleForm.reportValidity()) return;
    void scheduleAction(async () => {
      const url = scheduleUrl2(input("schedule-url").value).href;
      const startValue = input("schedule-start").value;
      const start = new Date(startValue);
      const startsAt = start.getTime();
      if (!Number.isFinite(startsAt) || startsAt <= Date.now() || localDateInput(start) !== startValue) {
        throw new Error("Choose a future date and a valid local time. Times skipped by daylight saving cannot be scheduled.");
      }
      const durationMinutes = Number(input("schedule-duration").value);
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
        throw new Error("Choose a whole number of minutes between 1 and 480.");
      }
      const mode = element("schedule-mode").value === "auto" ? "auto" : "suggest";
      await changeSchedules({ type: "ADD_SCHEDULE", url, startsAt, durationMinutes, mode });
      scheduleActionStatus.textContent = "Session scheduled. Keep Edge running and your computer awake.";
    });
  });
  scheduleForm.addEventListener("input", updateSchedulePreview);
  element("refresh-schedules").addEventListener("click", () => void refreshSchedules());
  input("schedule-start").value = localDateInput(new Date(Date.now() + 30 * 6e4));
  element("schedule-timezone").textContent = `All schedule times use this browser's local time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
  updateSchedulePreview();
  updateScheduleControls();
  void refreshSchedules();
  var scheduleTimer = window.setInterval(() => void refreshSchedules(), 5e3);
  window.addEventListener("pagehide", () => window.clearInterval(scheduleTimer));
})();
