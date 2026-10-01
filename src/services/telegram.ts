import { HttpError } from '../errors.js';

export interface TelegramClient {
  getMe(token: string): Promise<{ id: number; username: string }>;
  setWebhook(token: string, url: string, secretToken: string): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
}

interface TelegramResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

export class TelegramApi implements TelegramClient {
  private async call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    let data: TelegramResponse<T> | null = null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      data = (await res.json().catch(() => null)) as TelegramResponse<T> | null;
    } catch {
      throw new HttpError(502, 'telegram_unreachable', 'Could not reach the Telegram Bot API from this server.');
    }
    if (!data?.ok || data.result === undefined) {
      throw new HttpError(400, 'telegram_error', `Telegram ${method} failed: ${data?.description ?? 'unknown error'}`);
    }
    return data.result;
  }

  getMe(token: string): Promise<{ id: number; username: string }> {
    return this.call(token, 'getMe');
  }

  async setWebhook(token: string, url: string, secretToken: string): Promise<void> {
    await this.call<boolean>(token, 'setWebhook', { url, secret_token: secretToken, drop_pending_updates: true });
  }

  async deleteWebhook(token: string): Promise<void> {
    await this.call<boolean>(token, 'deleteWebhook', { drop_pending_updates: false });
  }
}
