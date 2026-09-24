import { z } from 'zod';
import { PROTOCOL_VERSION, type Answer, type Question } from '../src/shared/types.js';
import { validateAnswerPayload } from '../src/shared/core.js';

const choiceSchema = z.object({
  id: z.string().min(1).max(256),
  text: z.string().max(8_000),
}).strict();

const uniqueChoices = z.array(choiceSchema).max(60)
  .refine(choices => new Set(choices.map(choice => choice.id)).size === choices.length, 'Choice IDs must be unique.');
const fieldSchema = z.object({
  id: z.string().min(1).max(256), label: z.string().max(8_000),
  kind: z.enum(['text', 'number', 'select']), required: z.boolean(), options: uniqueChoices.optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().finite().positive().optional(),
  maxLength: z.number().int().min(1).max(20_000).optional(),
}).strict().superRefine((field, context) => {
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) context.addIssue({ code: 'custom', message: 'Field bounds are reversed.' });
  if (field.kind === 'select' && !field.options?.length) context.addIssue({ code: 'custom', message: 'A select field needs options.' });
  if (field.kind !== 'select' && field.options !== undefined) context.addIssue({ code: 'custom', message: 'Only select fields have options.' });
  if (field.kind !== 'number' && [field.min, field.max, field.step].some(value => value !== undefined)) context.addIssue({ code: 'custom', message: 'Only number fields have numeric bounds.' });
});
const constraintsSchema = z.object({
  min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().finite().positive().optional(),
  maxLength: z.number().int().min(1).max(20_000).optional(), total: z.number().finite().nonnegative().optional(),
  maxEntries: z.number().int().min(1).max(60).optional(), uniqueTargets: z.boolean().optional(),
}).strict().superRefine((constraints, context) => {
  if (constraints.min !== undefined && constraints.max !== undefined && constraints.min > constraints.max) context.addIssue({ code: 'custom', message: 'Question bounds are reversed.' });
});

export const questionSchema = z.object({
    source: z.enum(['wooclap', 'practice']),
    kind: z.enum(['choice', 'sorting', 'numeric', 'text', 'fields', 'matching', 'rating', 'allocation', 'categorized', 'point', 'placements', 'scenario']).optional(),
    wooclapType: z.string().min(1).max(100).optional(),
    eventKey: z.string().min(1).max(512),
    questionId: z.string().min(1).max(512).nullable(),
    text: z.string().trim().min(1).max(20_000),
    choices: uniqueChoices,
    multiple: z.boolean(),
    imageKeys: z.array(z.string().max(2_048)).max(16),
    fields: z.array(fieldSchema).min(1).max(60).refine(fields => new Set(fields.map(field => field.id)).size === fields.length, 'Field IDs must be unique.').optional(),
    constraints: constraintsSchema.optional(),
    responseMode: z.enum(['single', 'contribution']).optional(),
    application: z.enum(['automatic', 'preview']).optional(),
}).strict().superRefine((question, context) => {
  const kind = question.kind ?? 'choice';
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (['choice', 'sorting', 'scenario'].includes(kind) && (question.choices.length < 2 || question.choices.length > 30)) fail('This question needs between two and thirty choices.');
  if (['fields', 'matching', 'rating', 'allocation'].includes(kind)) {
    if (!question.fields?.length) fail('This question needs field definitions.');
    if (question.choices.length) fail('Field questions store available options in their fields.');
    if (kind === 'matching' && question.fields?.some(field => field.kind !== 'select')) fail('Matching requires select fields.');
    if (['rating', 'allocation'].includes(kind) && question.fields?.some(field => field.kind !== 'number')) fail('Rating and allocation require numeric fields.');
    if (kind === 'allocation' && question.constraints?.total === undefined) fail('Allocation requires a visible total.');
  } else if (question.fields !== undefined) fail('This question type does not accept field definitions.');
  if (['numeric', 'text'].includes(kind) && question.choices.length) fail('Text and numeric questions do not accept choices.');
  if (['categorized', 'placements'].includes(kind) && !question.choices.length) fail('Categories or placement labels are required.');
  if (kind === 'point' && question.choices.length !== 1) fail('Point questions need one point identity.');
  if (['point', 'placements'].includes(kind) && !question.imageKeys.length) fail('Image questions need an image identity.');
});

export const solveRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION).optional(),
  question: questionSchema,
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),
  screenshot: z.string().max(5_600_000).optional(),
}).strict();

// Keep this schema simple: the same schema is supplied to Structured Outputs.
// Length and question-specific constraints are enforced after model parsing.
export const answerSchema = z.object({
  selectedChoiceIds: z.array(z.string()),
  explanation: z.string(),
  needsReview: z.boolean(),
}).strict();

const scalarAnswerSchema = z.object({ value: z.string().nullable(), explanation: z.string(), needsReview: z.boolean() }).strict();
const fieldsAnswerSchema = z.object({
  values: z.array(z.object({ id: z.string(), value: z.string() }).strict()),
  explanation: z.string(), needsReview: z.boolean(),
}).strict();
const pointsAnswerSchema = z.object({
  points: z.array(z.object({ id: z.string(), x: z.number(), y: z.number() }).strict()),
  explanation: z.string(), needsReview: z.boolean(),
}).strict();

/** One strict output object per family; unrelated payload keys are never offered. */
export function modelAnswerSchema(question: Question) {
  const kind = question.kind ?? 'choice';
  if (kind === 'numeric' || kind === 'text') return scalarAnswerSchema;
  if (['fields', 'matching', 'rating', 'allocation', 'categorized'].includes(kind)) return fieldsAnswerSchema;
  if (kind === 'point' || kind === 'placements') return pointsAnswerSchema;
  return answerSchema;
}

/** Convert the model-specific payload to the backwards-compatible bridge shape. */
export function normalizeModelAnswer(question: Question, input: unknown): Answer | null {
  const parsed = modelAnswerSchema(question).safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  if ('selectedChoiceIds' in value) return value;
  const common = { selectedChoiceIds: [], explanation: value.explanation, needsReview: value.needsReview };
  if ('value' in value) return value.value === null ? common : { ...common, value: value.value };
  if ('values' in value) return { ...common, values: value.values };
  return { ...common, points: value.points };
}

export function validScreenshot(screenshot: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(screenshot);
  if (!match || match[2].length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function validAnswer(answer: Answer, question: Question): boolean {
  return validateAnswerPayload(question, answer) === null;
}
