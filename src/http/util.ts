import type { Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors.js';
import type { AuthContext } from './sessions.js';

/** Forwards rejected promises to Express' error handler (Express 4 does not). */
export function ah(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}

export function intParam(req: Request, name: string): number {
  const raw = req.params[name] ?? '';
  if (!/^\d{1,10}$/.test(raw)) throw new HttpError(400, 'invalid_id', `Invalid ${name}.`);
  return Number(raw);
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'authentication_required');
  return req.auth;
}
