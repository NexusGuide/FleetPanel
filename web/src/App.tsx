import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Menu, RefreshCw, Search, X } from 'lucide-react';
import { api, setUnauthorizedHandler, type Instance, type Me, type Permission } from './api';
import { ConfirmProvider, ToastProvider, Spinner, cx, useResource } from './components/ui';
import { Sidebar, NAV_ITEMS, type Page } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { InstancesPage } from './pages/InstancesPage';
import { BackupsPage } from './pages/BackupsPage';
import { AdminsPage } from './pages/AdminsPage';
import { AuditPage } from './pages/AuditPage';
import { AccountPage } from './pages/AccountPage';
import { CreateInstanceWizard } from './pages/CreateInstanceWizard';
import { InstanceDrawer } from './pages/InstanceDrawer';

export interface Route {
  page: Page;
  instanceId: number | null;
}

const PAGES = new Set<Page>(NAV_ITEMS.map((n) => n.id));

function parseHash(hash: string): Route {
  const [page = 'dashboard', id] = hash.replace(/^#\/?/, '').split('/');
  const instanceId = page === 'instances' && id && /^\d+$/.test(id) ? Number(id) : null;
  return { page: PAGES.has(page as Page) ? (page as Page) : 'dashboard', instanceId };
}

export function navigate(page: Page, instanceId?: number | null): void {
  window.location.hash = instanceId ? `#/${page}/${instanceId}` : `#/${page}`;
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthGate />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AuthGate() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    // Any 401 from the API means the session ended (idle timeout, revoked, password changed).
    setUnauthorizedHandler(() => {
      setMe((current) => {
        if (current) setExpired(true);
        return null;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <Spinner label="Checking session…" />
      </div>
    );
  }

  if (!me) {
    return (
      <LoginPage
        notice={expired ? 'Your session ended. Please sign in again.' : null}
        onLogin={(user) => {
          setExpired(false);
          setMe(user);
        }}
      />
    );
  }

  return (
    <Shell
      me={me}
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        setMe(null);
      }}
    />
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => Promise<void> }) {
  const route = useRoute();
  const can = useCallback((p: Permission) => me.permissions.includes(p), [me.permissions]);
  const [createOpen, setCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('fleetpanel.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });

  const instancesRes = useResource(api.instances, [], undefined);
  const instances = useMemo(() => instancesRes.data ?? [], [instancesRes.data]);
  const busy = instances.some((i) => i.status === 'provisioning' || i.status === 'deleting');
  const { reload: reloadInstances } = instancesRes;

  // Poll quickly while something is provisioning/deleting, slowly otherwise.
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void reloadInstances();
      },
      busy ? 3000 : 15000,
    );
    return () => window.clearInterval(timer);
  }, [busy, reloadInstances]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem('fleetpanel.sidebar', c ? 'expanded' : 'collapsed');
      } catch {
        /* storage unavailable: keep the in-memory value */
      }
      return !c;
    });
  };

  const visibleNav = NAV_ITEMS.filter((n) => !n.permission || can(n.permission));
  const page: Page = visibleNav.some((n) => n.id === route.page) ? route.page : 'dashboard';
  const title = NAV_ITEMS.find((n) => n.id === page)?.label ?? '';
  const selected: Instance | null = route.instanceId ? (instances.find((i) => i.id === route.instanceId) ?? null) : null;

  const openInstance = (id: number) => navigate('instances', id);
  const onInstanceChanged = (inst: Instance) => {
    instancesRes.setData((all) => (all ? all.map((i) => (i.id === inst.id ? inst : i)) : all));
    void reloadInstances();
  };

  return (
    <div className="min-h-screen bg-base text-slate-100 flex">
      <div className="hidden md:flex shrink-0">
        <Sidebar
          items={visibleNav}
          current={page}
          me={me}
          collapsed={collapsed}
          instanceCount={instances.length}
          canCreate={can('instances.create')}
          onCreate={() => setCreateOpen(true)}
          onToggleCollapse={toggleCollapsed}
          onLogout={onLogout}
        />
      </div>

      {mobileNav && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/70" onClick={() => setMobileNav(false)} />
          <div className="relative" onClick={() => setMobileNav(false)}>
            <Sidebar
              items={visibleNav}
              current={page}
              me={me}
              collapsed={false}
              instanceCount={instances.length}
              canCreate={can('instances.create')}
              onCreate={() => setCreateOpen(true)}
              onLogout={onLogout}
            />
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col bg-canvas">
        <header className="h-14 px-4 sm:px-5 border-b border-slate-800/80 bg-base flex items-center justify-between gap-3 sticky top-0 z-30">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="md:hidden p-1.5 rounded text-slate-300 hover:bg-slate-800"
              onClick={() => setMobileNav((v) => !v)}
              aria-label="Menu"
            >
              {mobileNav ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <span className="md:hidden flex items-center gap-1.5 text-xs font-semibold text-white">
              <Bot className="w-4 h-4 text-blue-400" /> FleetPanel
            </span>
            <span className="hidden md:inline text-xs text-slate-500 font-mono">FleetPanel</span>
            <span className="hidden md:inline text-slate-700">/</span>
            <span className="hidden md:inline text-xs text-slate-200 font-mono truncate">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md bg-panel border border-slate-800 hover:border-slate-700 text-slate-400 text-xs"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search…</span>
              <kbd className="px-1 text-[10px] font-mono text-slate-500 bg-slate-800 rounded">Ctrl K</kbd>
            </button>
            <button
              type="button"
              onClick={() => void reloadInstances()}
              title="Refresh"
              className="p-2 rounded-md bg-panel border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            >
              <RefreshCw className={cx('w-3.5 h-3.5', busy && 'animate-spin')} />
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 w-full max-w-7xl mx-auto">
          {page === 'dashboard' && (
            <DashboardPage
              instances={instances}
              loadError={instancesRes.error}
              can={can}
              onCreate={() => setCreateOpen(true)}
              onOpenInstance={openInstance}
            />
          )}
          {page === 'instances' && (
            <InstancesPage
              instances={instances}
              loading={instancesRes.loading}
              loadError={instancesRes.error}
              onRetry={() => void reloadInstances()}
              can={can}
              onCreate={() => setCreateOpen(true)}
              onOpenInstance={openInstance}
              onChanged={onInstanceChanged}
              onRemoved={() => void reloadInstances()}
            />
          )}
          {page === 'backups' && <BackupsPage can={can} instances={instances} onChanged={() => void reloadInstances()} />}
          {page === 'admins' && <AdminsPage me={me} />}
          {page === 'audit' && <AuditPage />}
          {page === 'account' && <AccountPage me={me} onLoggedOut={onLogout} />}
        </main>
      </div>

      {createOpen && (
        <CreateInstanceWizard
          onClose={() => setCreateOpen(false)}
          onCreated={(inst) => {
            setCreateOpen(false);
            void reloadInstances();
            openInstance(inst.id);
          }}
        />
      )}

      {route.instanceId !== null && (
        <InstanceDrawer
          instanceId={route.instanceId}
          instance={selected}
          can={can}
          onClose={() => navigate('instances')}
          onChanged={onInstanceChanged}
          onRemoved={() => {
            navigate('instances');
            void reloadInstances();
          }}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          items={visibleNav}
          instances={instances}
          canCreate={can('instances.create')}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(p) => navigate(p)}
          onOpenInstance={openInstance}
          onCreate={() => setCreateOpen(true)}
        />
      )}
    </div>
  );
}
