import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { HttpError } from '../errors.js';
import { run } from '../system/exec.js';

/** Largest database backup the panel accepts (the panel's nginx site allows the same). */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** A gzip or zip expands; cap the dump so a crafted archive cannot fill the disk. */
const MAX_DUMP_BYTES = 4 * 1024 * 1024 * 1024;

/** Writes an upload to disk, refusing more than `max` bytes. */
export async function saveUpload(body: Readable, dest: string, max = MAX_IMPORT_BYTES): Promise<number> {
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > max) done(new HttpError(413, 'upload_too_large', `The file is larger than ${Math.round(max / 1048576)} MB.`));
      else done(null, chunk);
    },
  });
  await pipeline(body, limit, createWriteStream(dest, { mode: 0o600 }));
  if (size === 0) throw new HttpError(400, 'empty_upload', 'The uploaded file is empty.');
  return size;
}

const CLIENT_COMMAND = /^\s*(\\|system\s)/i;
const DATABASE_SWITCH = /^\s*(CREATE\s+DATABASE\b|USE\s+[`\w])/i;
const DEFINER = /\/\*!\d+\s+DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*\*\/|\bDEFINER\s*=\s*`[^`]*`@`[^`]*`/gi;
const SQL_CONTENT = /^\s*(CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE)\b/i;

/**
 * Rewrites a mysqldump stream line by line so it can be imported into the bot's own database
 * by the bot's own (unprivileged) database user:
 *  - mysql client commands (\! cmd, system cmd) are refused: they would run on this server;
 *  - CREATE DATABASE / USE lines are dropped: the import always goes into the bot's database
 *    (dumps made with --databases name the original one);
 *  - DEFINER clauses are removed: setting another definer needs privileges the bot does not have.
 */
async function sanitizeDump(input: Readable, output: string): Promise<void> {
  const out = createWriteStream(output, { mode: 0o600 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  // A read or decompression error must end the loop, not leave it waiting for more lines.
  input.on('error', (err) => lines.emit('error', err));
  let lineNo = 0;
  let bytes = 0;
  let looksLikeSql = false;
  try {
    for await (const line of lines) {
      lineNo += 1;
      if (CLIENT_COMMAND.test(line)) {
        throw new HttpError(400, 'unsafe_dump', `The dump contains a mysql client command on line ${lineNo}; refusing to import it.`);
      }
      if (DATABASE_SWITCH.test(line)) continue;
      if (!looksLikeSql && SQL_CONTENT.test(line)) looksLikeSql = true;
      const clean = `${line.replace(DEFINER, '')}\n`;
      bytes += clean.length;
      if (bytes > MAX_DUMP_BYTES) throw new HttpError(413, 'dump_too_large', 'The database dump is larger than 4 GB.');
      if (!out.write(clean)) await new Promise<void>((resolve) => out.once('drain', resolve));
    }
  } finally {
    lines.close();
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  if (!looksLikeSql) throw new HttpError(400, 'not_a_dump', 'The file does not look like a MySQL/MariaDB dump (no CREATE TABLE or INSERT INTO).');
}

/** The single .sql file inside a zip (the bots' own backups are zips with one dump). */
async function zipEntry(zip: string): Promise<string> {
  let listing: string;
  try {
    listing = (await run('unzip', ['-Z1', zip], { timeoutMs: 120_000 })).stdout;
  } catch {
    throw new HttpError(400, 'bad_zip', 'The zip file could not be read.');
  }
  const sql = listing.split('\n').filter((e) => /\.sql$/i.test(e.trim()) && !e.endsWith('/'));
  if (sql.length === 0) throw new HttpError(400, 'no_sql_in_zip', 'The zip contains no .sql file.');
  if (sql.length > 1) throw new HttpError(400, 'several_sql_in_zip', `The zip contains several .sql files (${sql.slice(0, 5).join(', ')}); upload just one.`);
  return sql[0] as string;
}

/** Turns an upload (.sql, .sql.gz or .zip with one .sql) into a sanitized dump file; returns its path. */
export async function prepareDump(upload: string, work: string): Promise<string> {
  const handle = await fs.open(upload, 'r');
  const magic = Buffer.alloc(4);
  try {
    await handle.read(magic, 0, 4, 0);
  } finally {
    await handle.close();
  }
  const output = path.join(work, 'import.sql');

  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const gunzip = createGunzip();
    createReadStream(upload).pipe(gunzip);
    try {
      await sanitizeDump(gunzip, output);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'bad_gzip', 'The .gz file could not be decompressed.');
    }
    return output;
  }

  if (magic.toString('latin1') === 'PK\u0003\u0004') {
    const entry = await zipEntry(upload);
    // unzip treats the name as a pattern: escape wildcard characters so only this entry matches.
    const child = spawn('unzip', ['-p', upload, entry.replace(/([[\]*?\\])/g, '\\$1')], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    await sanitizeDump(child.stdout, output);
    if ((await exited) !== 0) throw new HttpError(400, 'bad_zip', 'The .sql file could not be extracted from the zip.');
    return output;
  }

  await sanitizeDump(createReadStream(upload), output);
  return output;
}
