export const DAY_MS = 86_400_000;
export const LEASE_MS = 60_000;

export interface Limits {
  dailyRequests: number;
  dailyInputBytes: number;
  ipPerMinute: number;
  ipPerDay: number;
  concurrency: number;
}

export interface BudgetTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Structural subset of the SQLite Durable Object storage API. */
export interface BudgetStorage extends BudgetTransaction {
  transaction<T>(callback: (transaction: BudgetTransaction) => Promise<T>): Promise<T>;
  setAlarm(time: number): Promise<void>;
}

export interface BudgetState {
  day: number;
  requests: number;
  inputBytes: number;
  clients: Record<string, { requests: number; recent: number[] }>;
  leases: Record<string, number>;
}

export type Reservation = { allowed: true; lease: string } | {
  allowed: false;
  code: 'HOSTED_DAILY_LIMIT' | 'HOSTED_RATE_LIMIT' | 'HOSTED_BUSY';
  retryAfter: number;
};

function currentState(previous: BudgetState | undefined, now: number): BudgetState {
  const day = Math.floor(now / DAY_MS);
  const leases = Object.fromEntries(Object.entries(previous?.leases ?? {}).filter(([, until]) => until > now));
  if (previous?.day === day) return { ...previous, leases };
  return { day, requests: 0, inputBytes: 0, clients: {}, leases };
}

/** All allowances are consumed atomically BEFORE calling NVIDIA and never refunded. */
export class PersistentBudget {
  constructor(private readonly storage: BudgetStorage, private readonly limits: Limits) {}

  async reserve(client: string, inputBytes: number, now: number): Promise<Reservation> {
    return this.storage.transaction(async transaction => {
      const state = currentState(await transaction.get<BudgetState>('budget'), now);
      const untilTomorrow = Math.max(1, Math.ceil(((state.day + 1) * DAY_MS - now) / 1000));
      const ip = state.clients[client] ?? { requests: 0, recent: [] };
      ip.recent = ip.recent.filter(time => time > now - 60_000);
      if (state.requests >= this.limits.dailyRequests || state.inputBytes + inputBytes > this.limits.dailyInputBytes) {
        return { allowed: false, code: 'HOSTED_DAILY_LIMIT', retryAfter: untilTomorrow };
      }
      if (ip.requests >= this.limits.ipPerDay) return { allowed: false, code: 'HOSTED_RATE_LIMIT', retryAfter: untilTomorrow };
      if (ip.recent.length >= this.limits.ipPerMinute) {
        return { allowed: false, code: 'HOSTED_RATE_LIMIT', retryAfter: Math.max(1, Math.ceil((ip.recent[0] + 60_000 - now) / 1000)) };
      }
      if (Object.keys(state.leases).length >= this.limits.concurrency) {
        return { allowed: false, code: 'HOSTED_BUSY', retryAfter: Math.max(1, Math.ceil((Math.min(...Object.values(state.leases)) - now) / 1000)) };
      }
      const lease = crypto.randomUUID();
      state.requests++;
      state.inputBytes += inputBytes;
      state.clients[client] = { requests: ip.requests + 1, recent: [...ip.recent, now] };
      state.leases[lease] = now + LEASE_MS;
      await transaction.put('budget', state);
      // Expire old client hashes even if the service receives no more traffic.
      await this.storage.setAlarm((state.day + 1) * DAY_MS + LEASE_MS);
      return { allowed: true, lease };
    });
  }

  async release(lease: string): Promise<void> {
    await this.storage.transaction(async transaction => {
      const state = await transaction.get<BudgetState>('budget');
      if (!state?.leases[lease]) return;
      delete state.leases[lease];
      await transaction.put('budget', state);
    });
  }

  async expire(now: number): Promise<void> {
    await this.storage.transaction(async transaction => {
      const previous = await transaction.get<BudgetState>('budget');
      if (!previous) return;
      const state = currentState(previous, now);
      if (state.day !== previous.day && !Object.keys(state.leases).length) await transaction.delete('budget');
      else await transaction.put('budget', state);
    });
  }
}
