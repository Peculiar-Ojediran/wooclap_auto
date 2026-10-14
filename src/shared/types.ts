export interface Choice { id: string; text: string }
export type Provider = 'openai' | 'anthropic' | 'nvidia';
export type ConnectionMode = 'direct' | 'bridge' | 'demo';
export type ResponseTransport = ConnectionMode | 'hosted';
export const PROVIDER_MODELS: Record<Provider, string> = { openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-5-5', nvidia: 'deepseek-ai/deepseek-v4.1-flash' };
export const PROVIDER_LABELS: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Claude (Anthropic)', nvidia: 'NVIDIA (DeepSeek)' };
export const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99})?$/;
export interface CredentialStatus { configured: boolean; storage: 'session' | 'local' | 'none' }
export type CredentialStatuses = Record<Provider, CredentialStatus>;
export type QuestionKind = 'choice' | 'sorting' | 'numeric' | 'text' | 'fields' | 'matching'
  | 'rating' | 'allocation' | 'categorized' | 'point' | 'placements' | 'scenario';
export interface QuestionField {
  id: string;
  label: string;
  kind: 'text' | 'number' | 'select';
  required: boolean;
  options?: Choice[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
}
export interface QuestionConstraints {
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  total?: number;
  maxEntries?: number;
  uniqueTargets?: boolean;
}
export interface Question {
  kind?: QuestionKind;
  wooclapType?: string;
  source: 'wooclap' | 'practice';
  eventKey: string;
  questionId: string | null;
  text: string;
  choices: Choice[];
  multiple: boolean;
  imageKeys: string[];
  fields?: QuestionField[];
  constraints?: QuestionConstraints;
  responseMode?: 'single' | 'contribution';
  application?: 'automatic' | 'preview';
}
export interface Answer {
  selectedChoiceIds: string[];
  value?: string;
  values?: { id: string; value: string }[];
  points?: { id: string; x: number; y: number }[];
  explanation: string;
  needsReview: boolean;
}
export interface SolveRequest {
  provider?: Provider;
  protocolVersion?: typeof PROTOCOL_VERSION;
  question: Question;
  model: string;
  screenshot?: string;
}
export interface SolveResponse {
  provider?: Provider;
  answer: Answer;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  demo: boolean;
}
export interface SelectorConfig {
  question: string;
  choices: string;
  submit: string;
  confirmation: string;
  multiple: boolean;
  choiceClickSubmits: boolean;
}
export interface Settings {
  connectionMode: ConnectionMode;
  provider: Provider;
  bridgeToken: string;
  model: string;
  mode: 'suggest' | 'auto';
  requestLimit: number;
  captureImages: boolean;
  backgroundMode: boolean;
  selectors: SelectorConfig;
}
export interface CaptureRect {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number;
}
export interface Observation {
  question: Question | null;
  state: 'question' | 'waiting' | 'submitted' | 'unsupported';
  detail: string;
  rect?: CaptureRect;
  inputSignature?: string;
}
export interface PendingAnswer {
  question: Question;
  answer: Answer;
  fingerprint: string;
  occurrence: number;
  demo: boolean;
  inputSignature?: string;
}
export interface LogEntry { time: number; message: string }
export interface SessionState {
  running: boolean;
  tabId: number | null;
  phase: 'idle' | 'waiting' | 'solving' | 'suggestion' | 'submitting' | 'submitted' | 'review' | 'error' | 'paused';
  detail: string;
  mode: 'suggest' | 'auto';
  requestCount: number;
  pending: PendingAnswer | null;
  log: LogEntry[];
  bridgeMode?: 'demo' | Provider;
  connectionMode?: ResponseTransport;
  model?: string;
  lastResponse?: { connectionMode?: ResponseTransport; provider?: Provider; model: string; usage: SolveResponse['usage']; elapsedMs: number; demo: boolean };
}
export const BRIDGE_URL = 'http://127.0.0.1:4318';
export const PROTOCOL_VERSION = 2;
export const DEFAULT_SETTINGS: Settings = {
  connectionMode: 'direct', provider: 'nvidia', bridgeToken: '', model: PROVIDER_MODELS.nvidia, mode: 'suggest', requestLimit: 25,
  captureImages: true, backgroundMode: false,
  selectors: { question: '', choices: '', submit: '', confirmation: '', multiple: false, choiceClickSubmits: false }
};
export const INITIAL_SESSION: SessionState = {
  running: false, tabId: null, phase: 'idle', detail: 'Open a Wooclap question or the practice page to begin.',
  mode: 'suggest', requestCount: 0, pending: null, log: []
};
