import { useState } from 'react';
import { ApiError, api, type Backup, type Instance } from '../api';
import { errorText, useConfirm, useToast } from '../components/ui';

export type ActionName = 'start' | 'stop' | 'backup' | 'reprovision' | 'delete';

/**
 * Every lifecycle action for an instance, with confirmation and honest feedback:
 * the UI only reports success after the server confirmed it, and failures show the
 * server's own reason instead of pretending the state changed.
 */
export function useInstanceActions(opts: {
  onChanged: (inst: Instance) => void;
  onRemoved: (id: number) => void;
  onBackup?: (backup: Backup) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = useState<{ id: number; action: ActionName } | null>(null);

  /** After a failure the server may have moved the instance to another state (e.g. error): show the real one. */
  const resync = (inst: Instance) => {
    api.instance(inst.id).then(opts.onChanged, () => undefined);
  };

  const run = async <T,>(inst: Instance, action: ActionName, fn: () => Promise<T>): Promise<T | undefined> => {
    setPending({ id: inst.id, action });
    try {
      return await fn();
    } catch (err) {
      toast.error(`${inst.slug}: ${errorText(err)}`);
      resync(inst);
      return undefined;
    } finally {
      setPending(null);
    }
  };

  const start = async (inst: Instance) => {
    const updated = await run(inst, 'start', () => api.startInstance(inst.id));
    if (updated) {
      opts.onChanged(updated);
      toast.success(`${inst.slug} started.`);
    }
  };

  const stop = async (inst: Instance) => {
    const ok = await confirm({
      title: `Stop ${inst.slug}?`,
      body: (
        <p>
          The nginx site and PHP pool are disabled, so Telegram updates to <b>{inst.domain}</b> will fail until you start
          it again. Data is kept.
        </p>
      ),
      confirmLabel: 'Stop instance',
      danger: true,
    });
    if (!ok) return;
    const updated = await run(inst, 'stop', () => api.stopInstance(inst.id));
    if (updated) {
      opts.onChanged(updated);
      toast.success(`${inst.slug} stopped.`);
    }
  };

  const backup = async (inst: Instance) => {
    const created = await run(inst, 'backup', () => api.createBackup(inst.id));
    if (created) {
      opts.onBackup?.(created);
      toast.success(`Backup of ${inst.slug} created.`);
    }
  };

  const reprovision = async (inst: Instance) => {
    const ok = await confirm({
      title: `Reprovision ${inst.slug}?`,
      body: (
        <>
          <p>
            The instance files, nginx site and PHP pool are removed and rebuilt from a fresh copy of the bot's code, then
            the install steps run again. The <b>database and stored secrets are kept</b>. Use this to recover from a failed
            install or a bot that does not respond.
          </p>
          {inst.status !== 'error' && (
            <p className="text-amber-300">
              Files the bot saved inside its own folder are replaced. Take a backup first if you are unsure.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Reprovision',
    });
    if (!ok) return;
    const updated = await run(inst, 'reprovision', () => api.reprovision(inst.id));
    if (updated) {
      opts.onChanged(updated);
      toast.success(`Reprovisioning ${inst.slug}…`);
    }
  };

  const remove = async (inst: Instance) => {
    const ok = await confirm({
      title: `Delete ${inst.slug}?`,
      body: (
        <>
          <p>
            This removes the bot's files, nginx site, PHP pool, Linux user, database and Telegram webhook. A{' '}
            <b>pre-delete backup</b> is taken first; if it fails, nothing is deleted.
          </p>
          <p className="text-slate-400">The TLS certificate for {inst.domain} is left in place.</p>
        </>
      ),
      confirmLabel: 'Delete instance',
      danger: true,
      typeToConfirm: inst.slug,
    });
    if (!ok) return;

    setPending({ id: inst.id, action: 'delete' });
    try {
      await api.deleteInstance(inst.id, true);
      opts.onRemoved(inst.id);
      toast.success(`${inst.slug} deleted. A pre-delete backup was kept.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'backup_failed') {
        const force = await confirm({
          title: 'Backup failed',
          body: (
            <>
              <p className="text-rose-300 whitespace-pre-line">{err.message}</p>
              <p>
                This is common when an instance never finished installing. Delete <b>without</b> a backup? Everything
                listed before is removed permanently.
              </p>
            </>
          ),
          confirmLabel: 'Delete without backup',
          danger: true,
          typeToConfirm: inst.slug,
        });
        if (force) {
          try {
            await api.deleteInstance(inst.id, false);
            opts.onRemoved(inst.id);
            toast.success(`${inst.slug} deleted.`);
          } catch (err2) {
            toast.error(`${inst.slug}: ${errorText(err2)}`);
            resync(inst);
          }
        }
      } else {
        toast.error(`${inst.slug}: ${errorText(err)}`);
        resync(inst);
      }
    } finally {
      setPending(null);
    }
  };

  const isPending = (id: number, action?: ActionName) =>
    pending !== null && pending.id === id && (action === undefined || pending.action === action);

  return { start, stop, backup, reprovision, remove, isPending };
}
