import { run } from './exec.js';
import type { WebhookAuth } from '../providers/index.js';

/** Everything that needs root. Implemented by deploy/fleetpanel-helper. */
export interface PrivilegedOps {
  createDatabase(dbName: string, dbUser: string, password: string): Promise<void>;
  dropDatabase(dbName: string, dbUser: string): Promise<void>;
  fixPermissions(slug: string): Promise<void>;
  createInstance(slug: string, domain: string, webhookPath: string, webhookAuth: WebhookAuth, webhookSecret: string): Promise<void>;
  issueCertificate(domain: string): Promise<void>;
  enableInstance(slug: string): Promise<void>;
  disableInstance(slug: string): Promise<void>;
  removeInstance(slug: string): Promise<void>;
  /** `composer install` (no scripts, no plugins) as the instance's own Linux user. */
  runComposer(slug: string): Promise<void>;
  /** Runs one of the bot's PHP scripts with the CLI as the instance's own Linux user. */
  runPhp(slug: string, script: string): Promise<void>;
}

export class SudoHelper implements PrivilegedOps {
  constructor(private readonly helperPath: string) {}

  private async call(args: string[], stdin?: string, timeoutMs = 300_000): Promise<void> {
    await run('sudo', ['-n', this.helperPath, ...args], {
      input: stdin === undefined ? undefined : `${stdin}\n`,
      timeoutMs,
    });
  }

  runComposer(slug: string): Promise<void> {
    return this.call(['instance-run', slug, 'composer'], undefined, 960_000);
  }

  runPhp(slug: string, script: string): Promise<void> {
    return this.call(['instance-run', slug, 'php', script], undefined, 960_000);
  }

  createDatabase(dbName: string, dbUser: string, password: string): Promise<void> {
    return this.call(['db-create', dbName, dbUser], password);
  }

  dropDatabase(dbName: string, dbUser: string): Promise<void> {
    return this.call(['db-drop', dbName, dbUser]);
  }

  fixPermissions(slug: string): Promise<void> {
    return this.call(['instance-perms', slug]);
  }

  createInstance(slug: string, domain: string, webhookPath: string, webhookAuth: WebhookAuth, webhookSecret: string): Promise<void> {
    return this.call(['instance-create', slug, domain, webhookPath, webhookAuth], webhookSecret);
  }

  issueCertificate(domain: string): Promise<void> {
    return this.call(['cert-issue', domain]);
  }

  enableInstance(slug: string): Promise<void> {
    return this.call(['instance-enable', slug]);
  }

  disableInstance(slug: string): Promise<void> {
    return this.call(['instance-disable', slug]);
  }

  removeInstance(slug: string): Promise<void> {
    return this.call(['instance-remove', slug]);
  }
}
