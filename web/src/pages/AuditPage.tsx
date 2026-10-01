import { Fragment, useMemo, useState } from 'react';
import { ClipboardList, Search } from 'lucide-react';
import { api, type AuditEntry } from '../api';
import { Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Pill, Spinner, cx, errorText, formatDate, useResource } from '../components/ui';

const PAGE = 100;

export function AuditPage() {
  const first = useResource(() => api.auditLogs(undefined, PAGE), []);
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const entries = useMemo(() => {
    const seen = new Set<number>();
    return [...(first.data ?? []), ...older].filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [first.data, older]);

  const visible = entries.filter((e) => {
    if (onlyFailed && e.status !== 'FAILED') return false;
    const q = query.trim().toLowerCase();
    return !q || `${e.action} ${e.actor} ${e.resource} ${e.resource_id ?? ''} ${e.ip ?? ''}`.toLowerCase().includes(q);
  });

  const loadMore = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.auditLogs(last.id, PAGE);
      setOlder((o) => [...o, ...page]);
      if (page.length < PAGE) setExhausted(true);
    } catch (err) {
      setMoreError(errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const canLoadMore = !exhausted && (first.data?.length ?? 0) >= PAGE;

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every sign-in, change and denied request, newest first. Entries cannot be edited or deleted, even by Owners."
        actions={
          <Button
            onClick={() => {
              setOlder([]);
              setExhausted(false);
              void first.reload();
            }}
          >
            Refresh
          </Button>
        }
      />
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by action, user, resource or IP…" className="pl-8 py-1.5 text-xs" />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300 px-2">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} className="accent-blue-500" />
          Failures only
        </label>
      </div>

      {first.error && (
        <div className="mb-4">
          <ErrorBanner error={first.error} onRetry={() => void first.reload()} />
        </div>
      )}

      <Card className="overflow-hidden">
        {!first.data ? (
          first.loading ? <Spinner /> : null
        ) : visible.length === 0 ? (
          <EmptyState icon={<ClipboardList className="w-7 h-7" />} title={entries.length ? 'Nothing matches' : 'No entries yet'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium hidden md:table-cell">Target</th>
                  <th className="px-4 py-2.5 font-medium hidden lg:table-cell">IP</th>
                  <th className="px-4 py-2.5 font-medium text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {visible.map((e) => (
                  <Fragment key={e.id}>
                    <tr
                      onClick={() => setExpanded((x) => (x === e.id ? null : e.id))}
                      className={cx('cursor-pointer hover:bg-slate-800/20', e.status === 'FAILED' && 'bg-rose-950/10')}
                    >
                      <td className="px-4 py-2 text-slate-400 whitespace-nowrap font-mono text-[11px]">{formatDate(e.ts)}</td>
                      <td className="px-4 py-2 font-mono text-slate-100">{e.action}</td>
                      <td className="px-4 py-2 font-mono text-slate-300">{e.actor}</td>
                      <td className="px-4 py-2 hidden md:table-cell font-mono text-slate-400 max-w-[16rem] truncate">
                        {e.resource}
                        {e.resource_id && ` #${e.resource_id}`}
                      </td>
                      <td className="px-4 py-2 hidden lg:table-cell font-mono text-slate-500">{e.ip ?? '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <Pill tone={e.status === 'SUCCESS' ? 'green' : 'red'}>{e.status === 'SUCCESS' ? 'ok' : 'failed'}</Pill>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr className="bg-slate-950/60">
                        <td colSpan={6} className="px-4 py-3">
                          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">
                            {JSON.stringify(
                              { id: e.id, resource: e.resource, resource_id: e.resource_id, ip: e.ip, metadata: e.metadata },
                              null,
                              2,
                            )}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {moreError && (
        <div className="mt-3">
          <ErrorBanner error={moreError} />
        </div>
      )}
      {canLoadMore && (
        <div className="flex justify-center mt-4">
          <Button loading={loadingMore} onClick={() => void loadMore()}>
            Load older entries
          </Button>
        </div>
      )}
    </div>
  );
}
