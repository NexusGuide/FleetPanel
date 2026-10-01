/**
 * Encodes a value as a PHP single-quoted string literal.
 *
 * Inside single quotes PHP only interprets two escapes: \\ and \'. Escaping the
 * backslash first and then the quote makes it impossible for the value to close
 * the literal and inject code. Control characters are rejected outright.
 */
export function phpString(value: string): string {
  if (/[-\u001f\u007f]/.test(value)) {
    throw new Error('Control characters are not allowed in generated PHP config values');
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
