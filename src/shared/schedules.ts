import { eventKeyForUrl } from '../content/wooclap';

export interface ScheduledSession {
  id: string;
  url: string;
  startsAt: number;
  endsAt: number;
  mode: 'suggest' | 'auto';
  status: 'pending' | 'starting' | 'running' | 'completed' | 'cancelled' | 'missed' | 'failed';
  detail: string;
  hasTab?: boolean;
}

export function scheduleUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a Wooclap participant link.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a full HTTPS Wooclap link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'wooclap.com' || url.hostname.endsWith('.wooclap.com'))) {
    throw new Error('Use an HTTPS link on wooclap.com without embedded credentials or a custom port.');
  }
  if (!eventKeyForUrl(url.href)) throw new Error('Use a Wooclap participant event link, such as https://app.wooclap.com/ABCDEF.');
  return url.href;
}

export function sameScheduledEvent(first: string, second: string | undefined): boolean {
  try {
    const event = (value: string) => eventKeyForUrl(scheduleUrl(value))?.split('/event/')[1];
    return second !== undefined && event(first) === event(second);
  } catch { return false; }
}

export function newSchedule(input: any, now: number, id: string): ScheduledSession {
  const url = scheduleUrl(input?.url);
  if (!Number.isSafeInteger(input.startsAt) || input.startsAt <= now || input.startsAt > now + 366 * 86400000) {
    throw new Error('Choose a future start time within the next year.');
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 480) {
    throw new Error('Duration must be a whole number from 1 to 480 minutes.');
  }
  if (input.mode !== 'auto' && input.mode !== 'suggest') throw new Error('Choose an answer mode.');
  return { id, url, startsAt: input.startsAt, endsAt: input.startsAt + input.durationMinutes * 60000,
    mode: input.mode, status: 'pending', detail: 'Scheduled. Uses the connection and provider saved at start time.' };
}
