import { useMemo, useState } from 'react';
import { Archive, ExternalLink, Play, Plus, RotateCcw, Search, Server, Square, Trash2 } from 'lucide-react';
import type { Instance, InstanceStatus, Permission } from '../api';
import { Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Select, Spinner, StatusBadge, Time, cx } from '../components/ui';
import { useInstanceActions } from './instanceActions';

const FILTERS: Array<{ id: InstanceStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'provisioning', label: 'Provisioning' },
  { id: 'error', label: 'Error' },
];

export function InstanceActionButtons({
  inst,
  can,
  actions,
  compact = false,
}: {
  inst: Instance;
  can: (p: Permission) => boolean;
  actions: ReturnType<typeof useInstanceActions>;
  compact?: boolean;
}) {
  const transitional = inst.status === 'provisioning' || inst.status === 'deleting';
  const busy = actions.isPending(inst.id) || transitional;
  const size = compact ? 'sm' : 'md';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {can('instances.control') && inst.status === 'stopped' && (
        <Button size={size} icon={<Play className="w-3.5 h-3.5" />} disabled={busy} loading={actions.isPending(inst.id, 'start')} onClick={() => void actions.start(inst)}>
          Start
        </Button>
      )}
      {can('instances.control') && inst.status === 'running' && (
        <Button size={size} icon={<Square className="w-3.5 h-3.5" />} disabled={busy} loading={actions.isPending(inst.id, 'stop')} onClick={() => void actions.stop(inst)}>
          Stop
        </Button>
      )}
      {can('instances.create') && inst.status === 'error' && (
        <Button
          size={size}
          variant="primary"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={busy}
          loading={actions.isPending(inst.id, 'reprovision')}
          onClick={() => void actions.reprovision(inst)}
        >
          Reprovision
        </Button>
      )}
      {can('backups.create') && (inst.status === 'running' || inst.status === 'stopped') && (
        <Button size={size} icon={<Archive className="w-3.5 h-3.5" />} disabled={busy} loading={actions.isPending(inst.id, 'backup')} onClick={() => void actions.backup(inst)}>
          Backup
        </Button>
      )}
      {can('instances.delete') && (
        <Button
          size={size}
          variant="ghost"
          className="text-rose-400 hover:text-rose-300"
          icon={<Trash2 className="w-3.5 h-3.5" />}
          disabled={busy}
          loading={actions.isPending(inst.id, 'delete')}
          onClick={() => void actions.remove(inst)}
          title="Delete"
        >
          {compact ? null : 'Delete'}
        </Button>
      )}
    </div>
  );
}

export function InstancesPage({
  instances,
  loading,
  loadError,
  onRetry,
  can,
  onCreate,
  onOpenInstance,
  onChanged,
  onRemoved,
}: {
  instances: Instance[];
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  can: (p: Permission) => boolean;
  onCreate: () => void;
  onOpenInstance: (id: number) => void;
  onChanged: (inst: Instance) => void;
  onRemoved: (id: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InstanceStatus | 'all'>('all');
  const [provider, setProvider] = useState('all');
  const actions = useInstanceActions({ onChanged, onRemoved });

  const providers = useMemo(() => [...new Set(instances.map((i) => i.provider))].sort(), [instances]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return instances.filter(
      (i) =>
        (filter === 'all' || i.status === filter) &&
        (provider === 'all' || i.provider === provider) &&
        (!q || `${i.slug} ${i.domain} ${i.bot_username ?? ''}`.toLowerCase().includes(q)),
    );
  }, [instances, query, filter, provider]);

  return (
    <div>
      <PageHeader
        title="Instances"
        description="Each instance is an isolated bot: its own Linux user, PHP-FPM pool, MySQL database, nginx site and certificate."
        actions={
          can('instances.create') && (
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={onCreate}>
              New instance
            </Button>
          )
        }
      />

      {loadError && (
        <div className="mb-4">
          <ErrorBanner error={loadError} onRetry={onRetry} />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search slug, domain or bot…" className="pl-8 py-1.5 text-xs" />
        </div>
        <div className="flex gap-1 p-0.5 rounded-md bg-slate-950 border border-slate-800 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cx(
                'px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap',
                filter === f.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {f.label}
              {f.id !== 'all' && <span className="ml-1 text-slate-500">{instances.filter((i) => i.status === f.id).length}</span>}
            </button>
          ))}
        </div>
        {providers.length > 1 && (
          <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="sm:w-40 text-xs">
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        )}
      </div>

      <Card className="overflow-hidden">
        {loading && instances.length === 0 ? (
          <Spinner />
        ) : instances.length === 0 ? (
          <EmptyState icon={<Server className="w-8 h-8" />} title="No instances yet">
            {can('instances.create') ? (
              <>
                Point a domain's DNS at this server, then create an instance.
                <div className="mt-4">
                  <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={onCreate}>
                    New instance
                  </Button>
                </div>
              </>
            ) : (
              'Ask an administrator to create one.'
            )}
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="Nothing matches these filters" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-2.5 font-medium">Instance</th>
                  <th className="px-4 py-2.5 font-medium hidden md:table-cell">Provider</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Updated</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {visible.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3 max-w-[18rem]">
                      <button type="button" onClick={() => onOpenInstance(i.id)} className="text-left group">
                        <span className="block font-mono font-medium text-white group-hover:text-blue-300 truncate">{i.slug}</span>
                        <span className="block text-[11px] text-slate-500 truncate">
                          {i.domain}
                          {i.bot_username && ` · @${i.bot_username}`}
                        </span>
                      </button>
                      {i.status === 'error' && i.last_error && (
                        <p className="mt-1 text-[11px] text-rose-300/90 line-clamp-2 break-words">{i.last_error}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell font-mono text-slate-300">{i.provider}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-400">
                      <Time value={i.updated_at} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <InstanceActionButtons inst={i} can={can} actions={actions} compact />
                        <a
                          href={`https://${i.domain}/`}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={`Open https://${i.domain}`}
                          className="p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
