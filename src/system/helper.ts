import { run } from './exec.js';

/** Everything that needs root. Implemented by deploy/fleetbot-helper. */
export interface PrivilegedOps {
  createDatabase(dbName: string, dbUser: string, password: string): Promise<void>;
  dropDatabase(dbName: string, dbUser: string): Promise<void>;
  fixPermissions(slug: string): Promise<void>;
  createInstance(slug: string, domain: string, webhookPath: string, webhookSecret: string): Promise<void>;
  issueCertificate(domain: string): Promise<void>;
  enableInstance(slug: string): Promise<void>;
  disableInstance(slug: string): Promise<void>;
  removeInstance(slug: string): Promise<void>;
}

export class SudoHelper implements PrivilegedOps {
  constructor(private readonly helperPath: string) {}

  private async call(args: string[], stdin?: string): Promise<void> {
    await run('sudo', ['-n', this.helperPath, ...args], {
      input: stdin === undefined ? undefined : `${stdin}\n`,
      timeoutMs: 300_000,
    });
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

  createInstance(slug: string, domain: string, webhookPath: string, webhookSecret: string): Promise<void> {
    return this.call(['instance-create', slug, domain, webhookPath], webhookSecret);
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
