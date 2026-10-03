import { HttpError } from '../errors.js';

/** Where backups go: a private chat, group or channel, optionally one topic of a forum group. */
export interface TelegramTarget {
  token: string;
  chatId: string;
  threadId?: string;
}

export interface TelegramClient {
  getMe(token: string): Promise<{ id: number; username: string }>;
  setWebhook(token: string, url: string, secretToken: string): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  sendMessage(target: TelegramTarget, text: string): Promise<void>;
  sendDocument(target: TelegramTarget, file: { name: string; data: Buffer }, caption: string): Promise<void>;
}

interface TelegramResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

export class TelegramApi implements TelegramClient {
  private async call<T>(token: string, method: string, body: Record<string, unknown> | FormData = {}, timeoutMs = 10_000): Promise<T> {
    let data: TelegramResponse<T> | null = null;
    try {
      const form = body instanceof FormData;
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: form ? undefined : { 'content-type': 'application/json' },
        body: form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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

  async sendMessage(target: TelegramTarget, text: string): Promise<void> {
    await this.call(target.token, 'sendMessage', {
      chat_id: target.chatId,
      ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      text,
      disable_notification: true,
    });
  }

  async sendDocument(target: TelegramTarget, file: { name: string; data: Buffer }, caption: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', target.chatId);
    if (target.threadId) form.set('message_thread_id', target.threadId);
    form.set('caption', caption);
    form.set('disable_notification', 'true');
    form.set('document', new Blob([new Uint8Array(file.data)], { type: 'application/octet-stream' }), file.name);
    await this.call(target.token, 'sendDocument', form, 120_000);
  }
}
