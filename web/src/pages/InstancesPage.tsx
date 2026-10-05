import { useMemo, useState } from 'react';
import { Archive, ExternalLink, Play, Plus, RotateCcw, Search, Server, Square, Trash2 } from 'lucide-react';
import { api, instanceWebUrl, isOutdated, type Instance, type InstanceStatus, type Permission, type Provider } from '../api';
import { Button, Card, EmptyState, ErrorBanner, Input, Notice, PageHeader, Pill, Select, Spinner, StatusBadge, Time, cx, errorText, useResource, useToast } from '../components/ui';
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
      {/* Prominent after a failure; in the detail panel it is also offered as a repair for working instances. */}
      {can('instances.create') && (inst.status === 'error' || (!compact && !transitional)) && (
        <Button
          size={size}
          variant={inst.status === 'error' ? 'primary' : 'secondary'}
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={busy}
          loading={actions.isPending(inst.id, 'reprovision')}
          onClick={() => void actions.reprovision(inst)}
        >
          {inst.status === 'error' ? 'Reprovision' : 'Repair'}
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
  const providerInfo = useResource(api.providers, []);
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
        description="Each instance is an isolated bot: its own Linux user, MySQL database, nginx site, certificate and PHP pool or service."
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

      {providerInfo.data && (
        <BotUpdates
          providers={providerInfo.data}
          instances={instances}
          canUpdate={can('instances.create')}
          onUpdate={(insts, version) => void actions.upgrade(insts, version)}
          onChecked={() => void providerInfo.reload()}
        />
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
                      {i.last_error && (
                        <p
                          className={cx(
                            'mt-1 text-[11px] line-clamp-2 break-words',
                            i.status === 'error' ? 'text-rose-300/90' : 'text-amber-300/90',
                          )}
                        >
                          {i.last_error}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell font-mono text-slate-300">{i.provider}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusBadge status={i.status} />
                        {isOutdated(i, providerInfo.data) && <Pill tone="blue">update</Pill>}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-400">
                      <Time value={i.updated_at} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <InstanceActionButtons inst={i} can={can} actions={actions} compact />
                        <a
                          href={instanceWebUrl(i, providerInfo.data)}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={`Open ${instanceWebUrl(i, providerInfo.data)}`}
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

/**
 * New bot versions: reviewed ones (pinned by this FleetPanel) can be installed on outdated bots, one
 * by one or all at once; newer upstream releases are only announced until they are reviewed.
 */
function BotUpdates({
  providers,
  instances,
  canUpdate,
  onUpdate,
  onChecked,
}: {
  providers: Provider[];
  instances: Instance[];
  canUpdate: boolean;
  onUpdate: (insts: Instance[], version: string) => void;
  onChecked: () => void;
}) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const ready = providers
    .map((p) => ({ p, outdated: instances.filter((i) => i.provider === p.id && isOutdated(i, providers)) }))
    .filter((x) => x.outdated.length > 0);
  const announced = providers.filter((p) => p.upstream?.newer && instances.some((i) => i.provider === p.id));

  const check = async () => {
    setChecking(true);
    try {
      await api.checkUpstream();
      onChecked();
      toast.success('Checked the bots for new versions.');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  if (ready.length === 0 && announced.length === 0) {
    return canUpdate ? (
      <div className="mb-3 flex justify-end">
        <Button size="sm" loading={checking} onClick={() => void check()}>
          Check for bot updates
        </Button>
      </div>
    ) : null;
  }

  return (
    <div className="mb-4 space-y-2">
      {ready.map(({ p, outdated }) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-blue-900/60 bg-blue-950/30 text-xs text-blue-100">
          <span>
            <b>{p.name} {p.version}</b> is available for {outdated.length === 1 ? outdated[0]?.slug : `${outdated.length} bots`}.
            <span className="text-blue-200/70"> Reviewed for FleetPanel; data is kept.</span>
          </span>
          {canUpdate && (
            <Button size="sm" variant="primary" onClick={() => onUpdate(outdated, `${p.name} ${p.version}`)}>
              {outdated.length === 1 ? 'Update' : `Update all ${outdated.length}`}
            </Button>
          )}
        </div>
      ))}
      {announced.map((p) => (
        <Notice key={p.id}>
          <b>{p.name}</b> published a newer version
          {p.upstream?.latest ? (
            <>
              {' '}
              (
              {p.upstream.url ? (
                <a href={p.upstream.url} target="_blank" rel="noreferrer noopener" className="underline hover:text-white">
                  {p.upstream.latest}
                </a>
              ) : (
                p.upstream.latest
              )}
              )
            </>
          ) : null}
          . It can be installed once it has been reviewed and arrives with a FleetPanel update.
        </Notice>
      ))}
      {canUpdate && (
        <div className="flex justify-end">
          <Button size="sm" loading={checking} onClick={() => void check()}>
            Check for bot updates
          </Button>
        </div>
      )}
    </div>
  );
}
