import type { CredentialStatus, CredentialStatuses, Provider } from './shared/types';

type StorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
export function validProvider(value: unknown): value is Provider { return value === 'openai' || value === 'anthropic' || value === 'nvidia'; }

/** Keys are never part of Settings, session state, logs, or content messages. */
export class CredentialVault {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly session: StorageArea, private readonly local: StorageArea) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.catch(() => undefined).then(operation).catch(() => {
      throw new Error('Could not update API key storage. Try again before starting a session.');
    });
    this.writes = result;
    return result;
  }

  save(provider: unknown, value: unknown, remember: unknown, consent: unknown): Promise<void> {
    if (!validProvider(provider)) throw new Error('Choose NVIDIA, OpenAI, or Claude.');
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value.trim())) throw new Error('Enter a valid API key without spaces.');
    if (remember !== undefined && typeof remember !== 'boolean') throw new Error('Choose whether to remember this API key.');
    if (remember === true && consent !== true) throw new Error('Permission is required before remembering an API key on this device.');
    const key = `apiKey.${provider}`, apiKey = value.trim();
    return this.enqueue(async () => {
      if (remember === true) {
        await this.local.set({ [key]: apiKey });
        await this.session.remove(key);
      } else {
        // Replacing a remembered key with a session key revokes persistence.
        await this.local.remove(key);
        await this.session.set({ [key]: apiKey });
      }
    });
  }

  clear(provider: unknown): Promise<void> {
    if (!validProvider(provider)) throw new Error('Choose NVIDIA, OpenAI, or Claude.');
    return this.enqueue(async () => {
      await this.local.remove(`apiKey.${provider}`);
      await this.session.remove(`apiKey.${provider}`);
    });
  }

  private async entry(provider: Provider): Promise<{ apiKey?: string; status: CredentialStatus }> {
    await this.writes.catch(() => undefined);
    const key = `apiKey.${provider}`;
    for (const [storage, area] of [['session', this.session], ['local', this.local]] as const) {
      const value = (await area.get(key))[key];
      if (typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value)) return { apiKey: value, status: { configured: true, storage } };
    }
    return { status: { configured: false, storage: 'none' } };
  }

  async read(provider: Provider): Promise<string | undefined> { return (await this.entry(provider)).apiKey; }
  async status(): Promise<CredentialStatuses> {
    const [openai, anthropic, nvidia] = await Promise.all([this.entry('openai'), this.entry('anthropic'), this.entry('nvidia')]);
    return { openai: openai.status, anthropic: anthropic.status, nvidia: nvidia.status };
  }
}
