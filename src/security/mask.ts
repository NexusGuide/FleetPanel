const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens: 123456789:AA... -> 123456789:***
  [/\b(\d{5,15}):[A-Za-z0-9_-]{30,64}\b/g, '$1:***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  // key=value / key: value / "key":"value" style secrets
  [/((?:password|passwd|secret|token|api_?key|api_?hash)["']?\s*[:=]\s*)["']?[^"'\s,;&}]+["']?/gi, '$1***'],
  // Credentials in connection URLs: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1***@'],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function maskToken(token: string): string {
  const colon = token.indexOf(':');
  return colon > 0 ? `${token.slice(0, colon)}:***` : '***';
}
