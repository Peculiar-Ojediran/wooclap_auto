import { DEFAULT_SETTINGS, type Answer, type Question, type QuestionConstraints, type QuestionField, type Settings } from './types';

export function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

// Preserve option order: changing it must invalidate an in-flight answer.
export function fingerprint(question: Question): string {
  const identity = {
    source: question.source, event: question.eventKey, id: question.questionId,
    text: normalizeText(question.text), multiple: question.multiple, kind: question.kind ?? 'choice',
    choices: (question.kind === 'sorting' ? [...question.choices].sort((a, b) => a.id.localeCompare(b.id)) : question.choices).map(c => [c.id, normalizeText(c.text)]),
    images: question.imageKeys
  };
  // Do not change persisted choice/sorting ledger keys unless new context exists.
  // Field definitions describe the question, never the participant's input values.
  const extended: Record<string, unknown> = {};
  if (question.wooclapType !== undefined) extended.wooclapType = question.wooclapType;
  if (question.fields !== undefined) extended.fields = question.fields.map(field => ({
    id: field.id, label: normalizeText(field.label), kind: field.kind, required: field.required,
    options: field.options?.map(option => [option.id, normalizeText(option.text)]),
    min: field.min, max: field.max, step: field.step, maxLength: field.maxLength,
  }));
  if (question.constraints !== undefined) extended.constraints = {
    min: question.constraints.min, max: question.constraints.max, step: question.constraints.step,
    maxLength: question.constraints.maxLength, total: question.constraints.total, maxEntries: question.constraints.maxEntries,
    uniqueTargets: question.constraints.uniqueTargets,
  };
  if (question.responseMode !== undefined) extended.responseMode = question.responseMode;
  if (question.application !== undefined) extended.application = question.application;
  return JSON.stringify({ ...identity, ...extended });
}

// Decimal arithmetic keeps large integers and tiny steps exact. Numbers from DOM
// constraints may stringify in exponential notation; model answers may not.
function decimal(value: string): { coefficient: bigint; scale: number } | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match || value.length > 256) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 324) return null;
  let coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
  let scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function compareDecimals(left: string, right: string): number {
  const a = decimal(left)!;
  const b = decimal(right)!;
  const scale = Math.max(a.scale, b.scale);
  const difference = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function validateNumericValue(value: string, bounds: Pick<QuestionConstraints, 'min' | 'max' | 'step'> = {}): string | null {
  if (typeof value !== 'string' || value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    || !Number.isFinite(Number(value))) return 'Enter a finite decimal number without units or separators.';
  const parsed = decimal(value)!;
  if (bounds.min !== undefined && (!Number.isFinite(bounds.min) || compareDecimals(value, String(bounds.min)) < 0)) return 'The number is below the allowed minimum.';
  if (bounds.max !== undefined && (!Number.isFinite(bounds.max) || compareDecimals(value, String(bounds.max)) > 0)) return 'The number exceeds the allowed maximum.';
  if (bounds.step !== undefined) {
    if (!Number.isFinite(bounds.step) || bounds.step <= 0) return 'The question has an invalid numeric step.';
    const step = decimal(String(bounds.step))!;
    const origin = decimal(String(bounds.min ?? 0))!;
    const scale = Math.max(parsed.scale, step.scale, origin.scale);
    const offset = parsed.coefficient * 10n ** BigInt(scale - parsed.scale) - origin.coefficient * 10n ** BigInt(scale - origin.scale);
    if (offset % (step.coefficient * 10n ** BigInt(scale - step.scale)) !== 0n) return 'The number does not match the allowed step.';
  }
  return null;
}

function exactTotal(values: string[], total: number): boolean {
  const parts = values.map(value => decimal(value)!);
  const target = decimal(String(total));
  if (!target || !Number.isFinite(total)) return false;
  const scale = Math.max(target.scale, ...parts.map(part => part.scale));
  return parts.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale), 0n)
    === target.coefficient * 10n ** BigInt(scale - target.scale);
}

function fieldValueError(field: QuestionField, value: string): string | null {
  if (field.kind === 'select') return field.options?.some(option => option.id === value) ? null : 'An answer refers to an unavailable field option.';
  if (field.kind === 'number') return validateNumericValue(value, field);
  if (!value.trim() || value.length > Math.min(field.maxLength ?? 20_000, 20_000)) return 'A text answer is empty or exceeds the allowed length.';
  return null;
}

/** Validate the transport payload, including a safe partial answer for review. */
export function validateAnswerPayload(question: Question, answer: Answer): string | null {
  if (!answer || typeof answer.needsReview !== 'boolean' || typeof answer.explanation !== 'string'
    || answer.explanation.length > 4_000 || !Array.isArray(answer.selectedChoiceIds)
    || answer.selectedChoiceIds.length > 60 || answer.selectedChoiceIds.some(id => typeof id !== 'string' || id.length > 256)
    || Object.keys(answer).some(key => !['selectedChoiceIds', 'value', 'values', 'points', 'explanation', 'needsReview'].includes(key))) return 'The AI returned an invalid answer.';
  const kind = question.kind ?? 'choice';
  const ids = answer.selectedChoiceIds;
  const review = answer.needsReview;
  const hasScalar = answer.value !== undefined;
  const hasValues = answer.values !== undefined;
  const hasPoints = answer.points !== undefined;
  if (kind === 'choice' || kind === 'sorting' || kind === 'scenario') {
    if (hasScalar || hasValues || hasPoints) return 'The answer contains data for a different question type.';
    if ((!review && !ids.length) || new Set(ids).size !== ids.length) return 'The answer has no choices or contains duplicates.';
    if (kind === 'sorting' && !review && ids.length !== question.choices.length) return 'Sorting requires every item exactly once.';
    if (kind !== 'sorting' && (kind === 'scenario' || !question.multiple) && (ids.length > 1 || (!review && ids.length !== 1))) return 'This question needs exactly one choice.';
    if (ids.some(id => !question.choices.some(c => c.id === id))) return 'The answer refers to a choice that is no longer available.';
    return null;
  }
  if (ids.length) return 'This question does not accept selected choices.';
  if (kind === 'numeric' || kind === 'text') {
    if (hasValues || hasPoints || (hasScalar && typeof answer.value !== 'string')) return 'The answer contains data for a different question type.';
    if (!hasScalar || answer.value === '') return review ? null : 'The answer is empty.';
    if (kind === 'numeric') return validateNumericValue(answer.value!, question.constraints);
    return !answer.value!.trim() || answer.value!.length > Math.min(question.constraints?.maxLength ?? 20_000, 20_000)
      ? 'The text answer is empty or exceeds the allowed length.' : null;
  }
  if (['fields', 'matching', 'rating', 'allocation', 'categorized'].includes(kind)) {
    if (hasScalar || hasPoints || (hasValues && !Array.isArray(answer.values))) return 'The answer contains data for a different question type.';
    const values = answer.values ?? [];
    if (values.length > 60 || values.some(item => !item || typeof item.id !== 'string' || item.id.length > 256
      || typeof item.value !== 'string' || item.value.length > 20_000 || Object.keys(item).some(key => key !== 'id' && key !== 'value'))) return 'The answer contains invalid field values.';
    if (kind === 'categorized') {
      if ((!review && values.length === 0) || values.length > (question.constraints?.maxEntries ?? 1)) return 'The answer has an invalid number of contributions.';
      if (new Set(values.map(item => `${item.id}\u0000${normalizeText(item.value)}`)).size !== values.length) return 'The answer contains duplicate contributions.';
      if (values.some(item => !question.choices.some(choice => choice.id === item.id)
        || !item.value.trim() || item.value.length > Math.min(question.constraints?.maxLength ?? 20_000, 20_000))) return 'A contribution has an unavailable category or invalid text.';
      return null;
    }
    const fields = question.fields ?? [];
    if (!fields.length || new Set(values.map(item => item.id)).size !== values.length) return 'The answer has missing fields or duplicate field IDs.';
    if ((kind === 'matching' && fields.some(field => field.kind !== 'select'))
      || (['rating', 'allocation'].includes(kind) && fields.some(field => field.kind !== 'number'))) return 'The question has incompatible field definitions.';
    for (const item of values) {
      const field = fields.find(candidate => candidate.id === item.id);
      if (!field) return 'The answer refers to an unavailable field.';
      const error = fieldValueError(field, item.value);
      if (error) return error;
      if (kind === 'allocation' && compareDecimals(item.value, '0') < 0) return 'Allocated points cannot be negative.';
    }
    if (!review && fields.some(field => field.required && !values.some(item => item.id === field.id))) return 'Every required field needs an answer.';
    if (kind === 'matching' && question.constraints?.uniqueTargets && new Set(values.map(item => item.value)).size !== values.length) return 'Each matching destination can only be used once.';
    if (!review && kind === 'allocation' && (question.constraints?.total === undefined || !exactTotal(values.map(item => item.value), question.constraints.total))) return 'Allocated points must equal the required total.';
    return null;
  }
  if (kind === 'point' || kind === 'placements') {
    if (hasScalar || hasValues || (hasPoints && !Array.isArray(answer.points))) return 'The answer contains data for a different question type.';
    const points = answer.points ?? [];
    if (points.length > 60 || points.some(point => !point || typeof point.id !== 'string' || point.id.length > 256
      || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || Object.keys(point).some(key => !['id', 'x', 'y'].includes(key)))) return 'Image points must be inside the image.';
    if (new Set(points.map(point => point.id)).size !== points.length
      || points.some(point => !question.choices.some(choice => choice.id === point.id))) return 'An image point refers to a missing or duplicate item.';
    if (kind === 'point' && (points.length > 1 || (!review && points.length !== 1))) return 'This image question needs exactly one point.';
    if (kind === 'placements' && !review && points.length !== question.choices.length) return 'Every image label needs a placement.';
    return null;
  }
  return 'The question type is unsupported.';
}

export function validateAnswer(question: Question, answer: Answer): string | null {
  const error = validateAnswerPayload(question, answer);
  if (error) return error;
  return answer.needsReview ? 'The AI needs more information. Review the question manually.' : null;
}

export function normalizeSettings(value: Partial<Settings>): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...value, selectors: { ...DEFAULT_SETTINGS.selectors, ...value.selectors } };
  settings.bridgeToken = String(settings.bridgeToken).trim();
  settings.model = String(settings.model).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(settings.model)) throw new Error('Enter a valid model name.');
  if (settings.mode !== 'auto' && settings.mode !== 'suggest') throw new Error('Choose suggestion or automatic mode.');
  settings.requestLimit = Number(settings.requestLimit);
  if (!Number.isInteger(settings.requestLimit) || settings.requestLimit < 1 || settings.requestLimit > 100) throw new Error('Request limit must be between 1 and 100.');
  settings.captureImages = Boolean(settings.captureImages);
  // Background attachment must be explicitly enabled, including for old settings.
  settings.backgroundMode = settings.backgroundMode === true;
  for (const key of ['question', 'choices', 'submit', 'confirmation'] as const) {
    if (typeof settings.selectors[key] !== 'string' || settings.selectors[key].length > 500) throw new Error('Selectors must be shorter than 500 characters.');
    settings.selectors[key] = settings.selectors[key].trim();
  }
  settings.selectors.multiple = Boolean(settings.selectors.multiple);
  settings.selectors.choiceClickSubmits = Boolean(settings.selectors.choiceClickSubmits);
  if (settings.selectors.multiple && settings.selectors.choiceClickSubmits) throw new Error('Click-to-submit is only supported for single-answer questions.');
  return settings;
}

export class QuestionLedger {
  private keys: Set<string>;
  constructor(previous: string[] = []) { this.keys = new Set(previous); }
  has(key: string): boolean { return this.keys.has(key); }
  claim(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  serialize(): string[] { return [...this.keys]; }
}
