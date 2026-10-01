import type { ReactNode } from 'react';
import { Activity, AlertTriangle, Archive, Cpu, HardDrive, MemoryStick, Plus, Server } from 'lucide-react';
import { api, type Instance, type Permission } from '../api';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  PageHeader,
  StatusBadge,
  Time,
  cx,
  formatBytes,
  formatDuration,
  useResource,
} from '../components/ui';

function Meter({ label, value, total, detail }: { label: string; value: number; total: number; detail: ReactNode }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-mono">
        <span>{label}</span>
        <span className="text-white font-medium">{pct}%</span>
      </div>
      <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={cx('h-full rounded-full transition-all', pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-blue-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-slate-500 font-mono mt-1 block">{detail}</span>
    </div>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: number | string; tone?: string; hint: string }) {
  return (
    <Card className="p-3.5">
      <span className="text-[11px] text-slate-400 font-medium block">{label}</span>
      <div className="flex items-baseline justify-between mt-1.5">
        <span className={cx('text-xl font-bold font-mono', tone ?? 'text-white')}>{value}</span>
        <span className="text-[10px] text-slate-500 font-mono">{hint}</span>
      </div>
    </Card>
  );
}

export function DashboardPage({
  instances,
  loadError,
  can,
  onCreate,
  onOpenInstance,
}: {
  instances: Instance[];
  loadError: string | null;
  can: (p: Permission) => boolean;
  onCreate: () => void;
  onOpenInstance: (id: number) => void;
}) {
  const canRead = can('instances.read');
  const system = useResource(() => (canRead ? api.system() : Promise.resolve(null)), [canRead], 15000);
  const audit = useResource(() => (can('audit.read') ? api.auditLogs(undefined, 8) : Promise.resolve(null)), [], 30000);

  const count = (s: Instance['status']) => instances.filter((i) => i.status === s).length;
  const errors = instances.filter((i) => i.status === 'error');
  const sys = system.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        description="Live state of this server and the bots it hosts."
        actions={
          can('instances.create') && (
            <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={onCreate}>
              New instance
            </Button>
          )
        }
      />

      {loadError && <ErrorBanner error={loadError} />}

      {errors.length > 0 && (
        <div className="p-3 rounded-md bg-rose-950/30 border border-rose-900/60 text-xs text-rose-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-px" />
          <div className="space-y-1">
            <p className="font-medium">
              {errors.length} instance{errors.length > 1 ? 's need' : ' needs'} attention
            </p>
            {errors.slice(0, 3).map((i) => (
              <button key={i.id} type="button" onClick={() => onOpenInstance(i.id)} className="block text-left hover:text-white">
                <span className="font-mono">{i.slug}</span>: <span className="text-rose-300/80">{i.last_error ?? 'unknown error'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Instances" value={instances.length} hint="total" />
        <Kpi label="Running" value={count('running')} tone="text-emerald-400" hint="online" />
        <Kpi label="Stopped" value={count('stopped')} tone="text-slate-300" hint="disabled" />
        <Kpi label="In progress" value={count('provisioning') + count('deleting')} tone="text-blue-400" hint="working" />
        <Kpi label="Errors" value={errors.length} tone={errors.length ? 'text-rose-400' : 'text-slate-300'} hint="failed" />
      </div>

      {canRead && (
        <Card>
          <CardHeader
            title="Server"
            icon={<Cpu className="w-4 h-4 text-blue-400" />}
            actions={
              sys && (
                <span className="text-[11px] text-slate-400 font-mono truncate">
                  {sys.hostname} · {sys.platform}
                </span>
              )
            }
          />
          <div className="p-4">
            {system.error && !sys && <ErrorBanner error={system.error} onRetry={() => void system.reload()} />}
            {!sys && !system.error && <div className="h-14 animate-pulse bg-slate-800/40 rounded" />}
            {sys && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                <Meter
                  label="CPU load (1m)"
                  value={sys.cpu.load_avg[0] ?? 0}
                  total={sys.cpu.cores}
                  detail={`${sys.cpu.cores} cores · load ${sys.cpu.load_avg.map((l) => l.toFixed(2)).join(' / ')}`}
                />
                <Meter
                  label="Memory"
                  value={sys.memory.total_bytes - sys.memory.free_bytes}
                  total={sys.memory.total_bytes}
                  detail={`${formatBytes(sys.memory.total_bytes - sys.memory.free_bytes)} / ${formatBytes(sys.memory.total_bytes)}`}
                />
                {sys.disk ? (
                  <Meter
                    label="Disk"
                    value={sys.disk.total_bytes - sys.disk.free_bytes}
                    total={sys.disk.total_bytes}
                    detail={`${formatBytes(sys.disk.free_bytes)} free of ${formatBytes(sys.disk.total_bytes)}`}
                  />
                ) : (
                  <div className="text-[11px] text-slate-500 font-mono">Disk usage unavailable</div>
                )}
                <div className="text-xs font-mono space-y-1">
                  <div className="flex justify-between text-slate-400">
                    <span>Server uptime</span>
                    <span className="text-white">{formatDuration(sys.uptime_seconds)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Fleetbot</span>
                    <span className="text-white">v{sys.version}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Node.js</span>
                    <span className="text-white">{sys.node}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Backups</span>
                    <span className="text-white">
                      {sys.backups.count} · {formatBytes(sys.backups.total_bytes)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader
            title="Instances"
            icon={<Server className="w-4 h-4 text-blue-400" />}
            actions={
              <a href="#/instances" className="text-[11px] text-blue-400 hover:text-blue-300">
                View all
              </a>
            }
          />
          {instances.length === 0 ? (
            <EmptyState icon={<Server className="w-8 h-8" />} title="No bots yet">
              Create an instance to deploy MirzaBot or Faoxima with its own database, PHP pool, nginx site and TLS
              certificate.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {instances.slice(0, 8).map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => onOpenInstance(i.id)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-800/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-white font-mono truncate">{i.slug}</p>
                      <p className="text-[11px] text-slate-500 truncate">
                        {i.domain}
                        {i.bot_username && ` · @${i.bot_username}`}
                      </p>
                    </div>
                    <span className="hidden sm:block text-[11px] text-slate-500 font-mono">{i.provider}</span>
                    <StatusBadge status={i.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Recent activity"
            icon={<Activity className="w-4 h-4 text-blue-400" />}
            actions={
              can('audit.read') && (
                <a href="#/audit" className="text-[11px] text-blue-400 hover:text-blue-300">
                  Audit log
                </a>
              )
            }
          />
          {!can('audit.read') ? (
            <EmptyState icon={<Archive className="w-7 h-7" />} title="Not available for your role" />
          ) : audit.error ? (
            <div className="p-4">
              <ErrorBanner error={audit.error} />
            </div>
          ) : !audit.data ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map((k) => (
                <div key={k} className="h-6 animate-pulse bg-slate-800/40 rounded" />
              ))}
            </div>
          ) : audit.data.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {audit.data.map((e) => (
                <li key={e.id} className="px-4 py-2 text-[11px] flex items-center gap-2">
                  <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', e.status === 'SUCCESS' ? 'bg-emerald-400' : 'bg-rose-400')} />
                  <span className="font-mono text-slate-200 truncate flex-1">
                    {e.action.toLowerCase().replace(/_/g, ' ')}
                    {e.resource_id && <span className="text-slate-500"> #{e.resource_id}</span>}
                  </span>
                  <span className="text-slate-500 shrink-0">{e.actor}</span>
                  <span className="text-slate-600 shrink-0">
                    <Time value={e.ts} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {sys && (
        <p className="text-[11px] text-slate-600 font-mono flex items-center gap-1.5">
          <HardDrive className="w-3 h-3" /> Data root {sys.disk?.path ?? '—'}
          <MemoryStick className="w-3 h-3 ml-3" /> Panel process up {formatDuration(sys.process_uptime_seconds)}
        </p>
      )}
    </div>
  );
}
