import { z } from 'zod';
import { ROLES } from './rbac.js';
import { PROVIDER_IDS } from '../providers/index.js';

// Keep these in sync with deploy/fleetbot-helper, which re-validates as root.
export const SLUG_RE = /^[a-z][a-z0-9-]{1,27}[a-z0-9]$/;
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_ID_RE = /^\d{1,20}$/;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export const createInstanceSchema = z
  .object({
    slug: z
      .string()
      .regex(SLUG_RE, 'slug: 3-29 chars, lowercase letters, digits and hyphens, starting with a letter'),
    provider: z.enum(PROVIDER_IDS),
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(DOMAIN_RE, 'domain must be a hostname such as bot.example.com'),
    bot_token: z.string().trim().regex(BOT_TOKEN_RE, 'bot_token is not a valid Telegram bot token'),
    admin_telegram_id: z
      .union([z.string(), z.number().int().nonnegative()])
      .transform((v) => String(v).trim())
      .pipe(z.string().regex(TELEGRAM_ID_RE, 'admin_telegram_id must be a numeric Telegram user id')),
  })
  .strict();
export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;

export const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(256),
    new_password: z.string().min(1).max(256),
  })
  .strict();

export const createAdminSchema = z
  .object({
    username: z.string().regex(USERNAME_RE, 'username: 3-32 chars of letters, digits, dot, dash, underscore'),
    password: z.string().min(1).max(256),
    role: z.enum(ROLES),
  })
  .strict();

export const updateAdminSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.is_active !== undefined, 'Nothing to update');
