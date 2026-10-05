import { run } from './exec.js';
import type { WebhookAuth } from '../providers/index.js';

/** Install steps of a Python bot, run by the helper as the bot's own Linux user. */
export type ServiceTask = 'python-deps' | 'webapp-build' | 'python-migrate';

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
  /**
   * For a PHP bot: runs its cron dispatcher every minute (systemd timer, as its own user), denies it
   * a crontab of its own and brings its nginx site up to date. Idempotent.
   */
  refreshInstance(slug: string, cronScript: string): Promise<void>;
  /** Installs the pinned Python toolchain (uv, Python, bun) and Redis once per server. */
  prepareRuntime(): Promise<void>;
  /** Stores a service bot's environment (KEY=value lines) where only root can read it. */
  writeEnv(slug: string, env: string): Promise<void>;
  /** Runs one install step of a service bot as its own Linux user. */
  runTask(slug: string, task: ServiceTask): Promise<void>;
  /** Creates and starts the bot's systemd services and its nginx reverse proxy. */
  createService(slug: string, domain: string, port: number): Promise<void>;
  /** Waits until the bot's web server answers on loopback; fails with the bot's last log lines. */
  waitForService(slug: string, port: number): Promise<void>;
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

  refreshInstance(slug: string, cronScript: string): Promise<void> {
    return this.call(['instance-refresh', slug, cronScript]);
  }

  prepareRuntime(): Promise<void> {
    return this.call(['runtime-python'], undefined, 1_260_000);
  }

  writeEnv(slug: string, env: string): Promise<void> {
    return this.call(['instance-env', slug], env);
  }

  runTask(slug: string, task: ServiceTask): Promise<void> {
    return this.call(['instance-run', slug, task], undefined, 1_860_000);
  }

  createService(slug: string, domain: string, port: number): Promise<void> {
    return this.call(['service-create', slug, domain, String(port)]);
  }

  waitForService(slug: string, port: number): Promise<void> {
    return this.call(['service-wait', slug, String(port)]);
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
