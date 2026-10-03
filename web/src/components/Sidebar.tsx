import type { ElementType } from 'react';
import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Plus,
  Server,
  Settings,
  UserCog,
  Users,
} from 'lucide-react';
import type { Me, Permission } from '../api';
import { cx } from './ui';

export type Page = 'dashboard' | 'instances' | 'backups' | 'admins' | 'audit' | 'settings' | 'account';

export interface NavItem {
  id: Page;
  label: string;
  icon: ElementType;
  /** Hidden unless the signed-in role has this permission. */
  permission?: Permission;
  section: 'main' | 'manage';
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, section: 'main' },
  { id: 'instances', label: 'Instances', icon: Server, permission: 'instances.read', section: 'main' },
  { id: 'backups', label: 'Backups', icon: Archive, permission: 'backups.read', section: 'main' },
  { id: 'admins', label: 'Administrators', icon: Users, permission: 'admins.manage', section: 'manage' },
  { id: 'audit', label: 'Audit log', icon: ClipboardList, permission: 'audit.read', section: 'manage' },
  { id: 'settings', label: 'Settings', icon: Settings, permission: 'settings.manage', section: 'manage' },
  { id: 'account', label: 'My account', icon: UserCog, section: 'manage' },
];

export function Sidebar({
  items,
  current,
  me,
  collapsed,
  instanceCount,
  canCreate,
  onCreate,
  onToggleCollapse,
  onLogout,
}: {
  items: NavItem[];
  current: Page;
  me: Me;
  collapsed: boolean;
  instanceCount: number;
  canCreate: boolean;
  onCreate: () => void;
  onToggleCollapse?: () => void;
  onLogout: () => void;
}) {
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = item.id === current;
    return (
      <a
        key={item.id}
        href={`#/${item.id}`}
        title={collapsed ? item.label : undefined}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors',
          active
            ? 'bg-blue-600/15 text-blue-300 border-blue-500/30'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border-transparent',
        )}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <Icon className={cx('w-4 h-4 shrink-0', active ? 'text-blue-400' : 'text-slate-500')} />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </span>
        {!collapsed && item.id === 'instances' && instanceCount > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/60">
            {instanceCount}
          </span>
        )}
      </a>
    );
  };

  const section = (name: NavItem['section'], label: string) => {
    const list = items.filter((i) => i.section === name);
    if (list.length === 0) return null;
    return (
      <div>
        {!collapsed && (
          <span className="px-2.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 block mb-1">{label}</span>
        )}
        <div className="space-y-0.5">{list.map(renderItem)}</div>
      </div>
    );
  };

  return (
    <aside
      className={cx(
        collapsed ? 'w-16' : 'w-60',
        'bg-base border-r border-slate-800/80 flex flex-col h-screen sticky top-0 transition-[width] duration-150',
      )}
    >
      <div className="h-14 flex items-center gap-2.5 px-3.5 border-b border-slate-800/80 shrink-0">
        <div className="w-8 h-8 rounded-md bg-blue-600/20 border border-blue-500/40 text-blue-400 flex items-center justify-center shrink-0">
          <Bot className="w-4 h-4" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="block text-sm font-semibold text-white tracking-tight">FleetPanel</span>
            <span className="block text-[10px] text-slate-500 font-mono">Control plane</span>
          </div>
        )}
      </div>

      {canCreate && (
        <div className="p-2.5 border-b border-slate-800/60 shrink-0">
          <button
            type="button"
            onClick={onCreate}
            title={collapsed ? 'New instance' : undefined}
            className="w-full py-1.5 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-xs font-medium flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            {!collapsed && <span>New instance</span>}
          </button>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {section('main', 'Main')}
        {section('manage', 'Manage')}
      </nav>

      <div className="border-t border-slate-800/80 p-2 space-y-2 shrink-0">
        <div className="p-1.5 rounded-md bg-slate-900/60 border border-slate-800 flex items-center justify-between gap-2">
          <a href="#/account" className="flex items-center gap-2 min-w-0" title="My account">
            <span className="w-7 h-7 rounded bg-slate-800 border border-slate-700 text-slate-300 flex items-center justify-center font-bold text-xs font-mono shrink-0">
              {me.username.charAt(0).toUpperCase()}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block text-xs font-medium text-slate-200 truncate">{me.username}</span>
                <span className="block text-[10px] font-mono text-slate-500 uppercase">{me.role}</span>
              </span>
            )}
          </a>
          {!collapsed && (
            <button
              type="button"
              onClick={onLogout}
              title="Sign out"
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-full flex justify-end p-1 text-slate-500 hover:text-slate-300"
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </aside>
  );
}
