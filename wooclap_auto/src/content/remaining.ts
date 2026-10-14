import type { Answer, Question } from '../shared/types';
import type { AdvancedQuestion } from './advanced';
import { applyContributions, extractContributions, hasContributionsConfirmation, prepareContributions,
  snapshotContributions, submitContributions, verifyContributions } from './contributions';
import { applyImageInteraction, extractImageInteraction, IMAGE_TYPES, snapshotImageInteraction, verifyImageInteraction } from './image-interactions';
import { applyScenarios, extractScenarios, prepareScenarios, snapshotScenarios, verifyScenarios } from './scenarios';

export { hasContributionsConfirmation };
const contributions = (q: Question) => ['Brainstorm', 'Framework'].includes(q.wooclapType ?? '');
const images = (q: Question) => IMAGE_TYPES.includes(q.wooclapType ?? '');
export const isRemaining = (q: Question) => q.application === 'automatic'
  && (contributions(q) || images(q) || ['Concordance', 'SCTJudgment'].includes(q.wooclapType ?? ''));
export function extractRemaining(scope: Element, title: Element, eventKey: string, doc: Document) {
  const result = extractContributions(scope, title, eventKey, doc) ?? extractImageInteraction(scope, title, eventKey, doc)
    ?? extractScenarios(scope, title, eventKey, doc);
  // Retain the older read-only previews when a layout cannot safely be driven.
  // They still pass their own completeness/media checks and cannot be applied.
  return result && 'state' in result && result.state === 'unsupported' ? null : result;
}
export async function prepareRemaining(doc: Document, guard: () => void): Promise<void> {
  await prepareContributions(doc, guard);
  await prepareScenarios(doc, guard);
}
export function snapshotRemaining(live: AdvancedQuestion): string {
  return contributions(live.question) ? snapshotContributions(live)
    : images(live.question) ? snapshotImageInteraction(live) : snapshotScenarios(live);
}
export function verifyRemaining(live: AdvancedQuestion, answer: Answer): boolean {
  return contributions(live.question) ? verifyContributions(live, answer)
    : images(live.question) ? verifyImageInteraction(live, answer) : verifyScenarios(live, answer);
}
export async function applyRemaining(q: Question, answer: Answer, read: () => AdvancedQuestion, guard?: () => void): Promise<void> {
  if (contributions(q)) await applyContributions(q, answer, read, guard);
  else if (images(q)) await applyImageInteraction(q, answer, read, guard);
  else await applyScenarios(q, answer, read, guard);
}
export async function submitRemaining(live: AdvancedQuestion, answer: Answer, guard: () => void): Promise<boolean> {
  if (!contributions(live.question)) return false;
  await submitContributions(live, answer, guard);
  return true;
}
