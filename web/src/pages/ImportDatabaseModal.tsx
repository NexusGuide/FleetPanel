import { useState } from 'react';
import { DatabaseBackup } from 'lucide-react';
import { api, type Instance } from '../api';
import { Button, ErrorBanner, Modal, Notice, errorText, useToast } from '../components/ui';

const MAX_BYTES = 512 * 1024 * 1024;

/** Replaces a bot's database with one of the bot's own backups (.sql, .sql.gz or .zip). */
export function ImportDatabaseModal({ inst, onClose, onDone }: { inst: Instance; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  const tooLarge = file !== null && file.size > MAX_BYTES;

  const start = async () => {
    if (!file || tooLarge) return;
    setError(null);
    setProgress(0);
    try {
      const res = await api.importDatabase(inst.id, file, setProgress);
      toast.success(`Database imported. The previous one is in safety backup ${res.safety_backup_id}.`);
      onDone();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Modal
      title={`Import database · ${inst.slug}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon={<DatabaseBackup className="w-3.5 h-3.5" />} loading={busy} disabled={!file || tooLarge} onClick={() => void start()}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs text-slate-300">
        <p>
          Upload a backup the bot made of its own database: a <span className="font-mono">.sql</span>,{' '}
          <span className="font-mono">.sql.gz</span> or <span className="font-mono">.zip</span> with one .sql file (512 MB at most).
        </p>
        <Notice tone="warn">
          The bot's current database is replaced. A safety backup is taken first, and the bot is offline for the
          import.
        </Notice>
        <input
          type="file"
          accept=".sql,.gz,.zip,application/sql,application/gzip,application/zip"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-1.5 file:text-slate-200"
        />
        {tooLarge && <ErrorBanner error="The file is larger than 512 MB." />}
        {busy && (
          <div className="space-y-1">
            <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <p className="text-[11px] text-slate-500">{(progress ?? 0) < 1 ? 'Uploading…' : 'Importing… this can take a few minutes.'}</p>
          </div>
        )}
        {error && <ErrorBanner error={error} />}
      </div>
    </Modal>
  );
}
