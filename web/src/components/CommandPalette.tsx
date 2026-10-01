import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Plus, Search, Server } from 'lucide-react';
import type { Instance } from '../api';
import type { NavItem, Page } from './Sidebar';
import { StatusBadge, cx } from './ui';

interface Entry {
  key: string;
  label: string;
  hint: string;
  icon: ReactNode;
  extra?: ReactNode;
  run: () => void;
}

export function CommandPalette({
  items,
  instances,
  canCreate,
  onClose,
  onNavigate,
  onOpenInstance,
  onCreate,
}: {
  items: NavItem[];
  instances: Instance[];
  canCreate: boolean;
  onClose: () => void;
  onNavigate: (page: Page) => void;
  onOpenInstance: (id: number) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [];
    if (canCreate) {
      all.push({ key: 'create', label: 'New instance', hint: 'Action', icon: <Plus className="w-4 h-4" />, run: onCreate });
    }
    for (const item of items) {
      const Icon = item.icon;
      all.push({ key: `nav-${item.id}`, label: item.label, hint: 'Go to', icon: <Icon className="w-4 h-4" />, run: () => onNavigate(item.id) });
    }
    for (const inst of instances) {
      all.push({
        key: `inst-${inst.id}`,
        label: `${inst.slug} · ${inst.domain}`,
        hint: inst.bot_username ? `@${inst.bot_username}` : inst.provider,
        icon: <Server className="w-4 h-4" />,
        extra: <StatusBadge status={inst.status} />,
        run: () => onOpenInstance(inst.id),
      });
    }
    const q = query.trim().toLowerCase();
    return q ? all.filter((e) => `${e.label} ${e.hint}`.toLowerCase().includes(q)) : all;
  }, [items, instances, canCreate, query, onCreate, onNavigate, onOpenInstance]);

  useEffect(() => setCursor(0), [query]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg bg-panel border border-slate-800 rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-slate-800">
          <Search className="w-4 h-4 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, entries.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') choose(entries[cursor]);
            }}
            placeholder="Search instances or pages…"
            className="flex-1 bg-transparent py-3 text-sm text-white placeholder-slate-500 focus:outline-none"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {entries.length === 0 && <li className="px-3 py-6 text-center text-xs text-slate-500">No matches</li>}
          {entries.map((entry, i) => (
            <li key={entry.key}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(entry)}
                className={cx(
                  'w-full flex items-center gap-3 px-3 py-2 rounded-md text-left text-xs',
                  i === cursor ? 'bg-blue-600/15 text-white' : 'text-slate-300',
                )}
              >
                <span className="text-slate-400">{entry.icon}</span>
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.extra}
                <span className="text-[10px] text-slate-500 font-mono">{entry.hint}</span>
                {i === cursor && <CornerDownLeft className="w-3 h-3 text-slate-500" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
