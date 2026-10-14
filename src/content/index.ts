import { observePage, selectAnswer, submitAnswer, hasSubmissionConfirmation } from './adapter';
import { fingerprint, validateAnswer } from '../shared/core';
import { DEFAULT_SETTINGS, type PendingAnswer, type SelectorConfig, type Observation } from '../shared/types';
import { prepareStructured } from './structured';
import { prepareRemaining } from './remaining';

// An injected copy must not create a second observer after a service-worker wakeup.
const host = globalThis as typeof globalThis & { __wooclapAutoLoaded?: boolean };
if (!host.__wooclapAutoLoaded) {
  host.__wooclapAutoLoaded = true;
  install();
}

function install(): void {
  const documentKey = crypto.randomUUID();
  let runId: string | null = null;
  let backgroundMode = false;
  let selectors: SelectorConfig = DEFAULT_SETTINGS.selectors;
  let occurrence = 0;
  let candidate = '';
  let candidateAt = 0;
  let lastSent = '';
  let observedQuestion = '';
  let waitingSinceQuestion = false;
  let applying = false;
  let preparing = false;
  let completedContribution = '';
  let completedContributionType = '';
  let userRevision = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;

  const send = async (message: object) => {
    const expectedRun = runId;
    try {
      const reply = await chrome.runtime.sendMessage({ ...message, runId: expectedRun, documentKey });
      if (reply?.stop && runId === expectedRun) runId = null;
    } catch { if (runId === expectedRun) runId = null; }
  };

  function inspect(): Observation {
    try {
      const observation = observePage(selectors);
      // A controlled input may briefly restore its old DOM value before the
      // framework commits a human edit. Preserve that edit's revision too.
      if (observation.inputSignature !== undefined) observation.inputSignature = JSON.stringify([observation.inputSignature, userRevision]);
      return observation;
    }
    catch (error) { return { question: null, state: 'unsupported', detail: error instanceof Error ? error.message : 'Could not read this question.' }; }
  }

  function schedule(delay = 80): void {
    if (!runId || applying || preparing || scheduled) return;
    scheduled = setTimeout(() => { scheduled = undefined; void prepareAndScan(); }, delay);
  }

  async function prepareAndScan(): Promise<void> {
    if (!runId || applying || preparing) return;
    const expectedRun = runId;
    const expectedRevision = userRevision;
    preparing = true;
    try {
      const guard = () => {
        if (runId !== expectedRun || (!backgroundMode && document.visibilityState !== 'visible')) throw new Error('Session paused or tab inactive.');
        if (userRevision !== expectedRevision) throw new Error('You interacted with the page. Question preparation stopped.');
      };
      await prepareStructured(document, guard);
      await prepareRemaining(document, guard);
      preparing = false;
      if (runId === expectedRun) scan();
    } catch (error) {
      if (runId === expectedRun) void send({ type: 'OBSERVATION', occurrence, observation: {
        question: null, state: 'unsupported', detail: error instanceof Error ? error.message : 'Could not read the question options.'
      } });
    } finally { preparing = false; }
  }

  function scan(): void {
    if (!runId || applying) return;
    const observation = inspect();
    const fp = observation.question ? fingerprint(observation.question) : '';
    if (completedContribution) {
      // A receipt or cleared text box is not a new question. Collaborative
      // boards may keep accepting contributions indefinitely.
      if (fp === completedContribution || (observation.state === 'submitted'
        && document.getElementsByClassName(completedContributionType).length)) return;
      if (fp || (observation.state === 'waiting' && !document.getElementsByClassName(completedContributionType).length)) {
        completedContribution = '';
        completedContributionType = '';
      }
    }
    const signature = observation.state + ':' + fp;
    if (signature !== candidate) {
      candidate = signature;
      candidateAt = Date.now();
      lastSent = '';
      // Invalidate pending work immediately; publish a new question only after it settles.
      void send({ type: 'CONTENT_DIRTY' });
    }
    if (Date.now() - candidateAt < 700) { schedule(720); return; }
    if (signature === lastSent) return;
    if (observation.state === 'waiting' || observation.state === 'submitted') waitingSinceQuestion = true;
    if (observation.question && (fp !== observedQuestion || waitingSinceQuestion)) {
      occurrence += 1;
      observedQuestion = fp;
      waitingSinceQuestion = false;
    }
    lastSent = signature;
    void send({ type: 'OBSERVATION', observation, occurrence });
  }

  async function apply(pending: PendingAnswer, expectedRun: string): Promise<{ confirmed: boolean; detail: string }> {
    if (applying) throw new Error('An answer is already being submitted.');
    const preparationDeadline = Date.now() + 5000;
    while (preparing && runId === expectedRun && Date.now() < preparationDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (preparing) throw new Error('The question options are still loading. Review the page before continuing.');
    const check = () => {
      if (runId !== expectedRun || (!backgroundMode && document.visibilityState !== 'visible')) throw new Error('Session paused or tab inactive.');
      const current = inspect();
      if (!current.question || current.state !== 'question' || occurrence !== pending.occurrence
        || fingerprint(current.question) !== pending.fingerprint) throw new Error('The question changed. The previous answer was discarded.');
      const issue = validateAnswer(current.question, pending.answer);
      if (issue) throw new Error(issue);
      return current;
    };
    const initial = check();
    if (pending.inputSignature !== undefined && initial.inputSignature !== pending.inputSignature) throw new Error('The page inputs changed. Your entries were left unchanged.');
    const initialRevision = userRevision;
    if (pending.question.application === 'preview') throw new Error('This type currently supports answer previews only.');
    applying = true;
    try {
      const result = await selectAnswer(pending.question, pending.answer, selectors, document, () => {
        if (runId !== expectedRun || (!backgroundMode && document.visibilityState !== 'visible')) throw new Error('Session paused or tab inactive.');
        if (userRevision !== initialRevision) throw new Error('You edited the page while the answer was being applied. Automatic submission stopped.');
      });
      if (!result.submittedBySelection) {
        check();
        if (userRevision !== initialRevision) throw new Error('Page inputs changed before submission.');
        await submitAnswer(selectors, document, () => {
          check();
          if (userRevision !== initialRevision) throw new Error('Page inputs changed before submission.');
        });
      }
      // Poll for a positive receipt. Never repeat an uncertain submit action.
      for (let count = 0; count < 20; count++) {
        if (runId !== expectedRun) throw new Error('Session paused during submission. Check the page before continuing.');
        if (hasSubmissionConfirmation(selectors)) {
          if (pending.question.responseMode === 'contribution') {
            completedContribution = pending.fingerprint;
            completedContributionType = pending.question.wooclapType || '';
          } else {
            waitingSinceQuestion = true;
            lastSent = '';
          }
          return { confirmed: true, detail: 'Answer submitted and confirmed on the page.' };
        }
        const current = inspect();
        if (current.question && fingerprint(current.question) !== pending.fingerprint) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return { confirmed: false, detail: 'Submission was attempted once, but no confirmation appeared. Check the page; automatic answering is paused.' };
    } finally { applying = false; schedule(100); }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'MONITOR_START') {
      runId = message.runId;
      backgroundMode = message.backgroundMode === true;
      selectors = message.selectors;
      lastSent = '';
      candidate = '';
      schedule();
      reply({ ok: true, documentKey });
    } else if (message.type === 'MONITOR_STOP') {
      runId = null;
      backgroundMode = false;
      reply({ ok: true });
    } else if (message.type === 'READ_CURRENT') {
      reply({ ok: true, observation: inspect(), occurrence, documentKey, runId });
    } else if (message.type === 'APPLY_ANSWER') {
      if (message.runId !== runId || message.documentKey !== documentKey) { reply({ ok: false, error: 'The monitored page changed.' }); return; }
      void apply(message.pending, message.runId).then(result => reply({ ok: true, ...result })).catch(error => reply({ ok: false, error: error.message }));
      return true;
    }
  });
  new MutationObserver(() => schedule()).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  // Native checkbox/radio activation can emit trusted input/change events even
  // when initiated by our .click(). Track human intent instead; rendered values
  // are checked separately. beforeinput also covers paste and text insertion.
  for (const eventName of ['beforeinput', 'pointerdown', 'keydown', 'click', 'paste', 'cut', 'drop']) document.addEventListener(eventName, event => {
    if (event.isTrusted) userRevision += 1;
  }, true);
  setInterval(() => schedule(), 5_000);
  document.addEventListener('visibilitychange', () => {
    if (runId && !backgroundMode && document.visibilityState !== 'visible') void send({ type: 'TAB_HIDDEN' });
    schedule();
  });
  window.addEventListener('pagehide', () => {
    if (runId) { void send({ type: 'PAGE_DEPARTED' }); runId = null; }
  });
}
