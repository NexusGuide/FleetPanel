import { useState, type FormEvent } from 'react';
import { Info, Plus, Users } from 'lucide-react';
import { ROLES, USERNAME_RE, api, passwordProblems, type Admin, type Me, type Role } from '../api';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PageHeader,
  Pill,
  Select,
  Spinner,
  Time,
  errorText,
  useConfirm,
  useResource,
  useToast,
} from '../components/ui';

const ROLE_HELP: Record<Role, string> = {
  Owner: 'Everything, including managing administrators',
  Admin: 'Everything except managing administrators',
  Manager: 'Create and control instances, take backups, read the audit log',
  Support: 'Start and stop instances, read-only otherwise',
  Viewer: 'Read instances and backups',
};

function CreateAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Admin) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('Viewer');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const problems = passwordProblems(password);
  const usernameOk = USERNAME_RE.test(username);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!usernameOk || problems.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.createAdmin(username, password, role));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New administrator"
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!usernameOk || problems.length > 0} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner error={error} />}
        <Field label="Username" error={username && !usernameOk ? '3–32 characters: letters, digits, dot, dash, underscore.' : null}>
          <Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field
          label="Initial password"
          hint="Share it securely; they can change it under My account."
          error={password && problems.length ? `Needs ${problems.join(', ')}.` : null}
        >
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" autoComplete="new-password" />
        </Field>
        <Field label="Role" hint={ROLE_HELP[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

export function AdminsPage({ me }: { me: Me }) {
  const res = useResource(api.admins, []);
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const replace = (a: Admin) => res.setData((all) => (all ? all.map((x) => (x.id === a.id ? a : x)) : all));

  const changeRole = async (a: Admin, role: Role) => {
    if (role === a.role) return;
    setBusy(a.id);
    try {
      replace(await api.updateAdmin(a.id, { role }));
      toast.success(`${a.username} is now ${role}.`);
    } catch (err) {
      toast.error(errorText(err));
      void res.reload();
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (a: Admin) => {
    const activate = !a.is_active;
    if (!activate) {
      const ok = await confirm({
        title: `Disable ${a.username}?`,
        body: <p>They are signed out everywhere immediately and cannot sign in until re-enabled.</p>,
        confirmLabel: 'Disable account',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(a.id);
    try {
      replace(await api.updateAdmin(a.id, { is_active: activate }));
      toast.success(`${a.username} ${activate ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Administrators"
        description="Who can sign in to this panel, and what each role may do."
        actions={
          <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreating(true)}>
            New administrator
          </Button>
        }
      />
      {res.error && (
        <div className="mb-4">
          <ErrorBanner error={res.error} onRetry={() => void res.reload()} />
        </div>
      )}
      <Card className="overflow-hidden mb-5">
        {!res.data ? (
          res.loading ? <Spinner /> : null
        ) : res.data.length === 0 ? (
          <EmptyState icon={<Users className="w-7 h-7" />} title="No administrators" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium hidden md:table-cell">Last sign-in</th>
                  <th className="px-4 py-2.5 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {res.data.map((a) => {
                  const self = a.username.toLowerCase() === me.username.toLowerCase();
                  return (
                    <tr key={a.id} className={a.is_active ? '' : 'opacity-60'}>
                      <td className="px-4 py-3">
                        <span className="font-mono text-white">{a.username}</span>
                        {self && (
                          <span className="ml-2">
                            <Pill tone="blue">you</Pill>
                          </span>
                        )}
                        <span className="block text-[11px] text-slate-500">
                          created <Time value={a.created_at} />
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          value={a.role}
                          disabled={self || busy === a.id}
                          title={self ? 'You cannot change your own role' : ROLE_HELP[a.role]}
                          onChange={(e) => void changeRole(a, e.target.value as Role)}
                          className="w-32 text-xs py-1"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-400">
                        <Time value={a.last_login} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant={a.is_active ? 'ghost' : 'secondary'}
                          className={a.is_active ? 'text-rose-400 hover:text-rose-300' : ''}
                          loading={busy === a.id}
                          disabled={busy !== null || self}
                          title={self ? 'You cannot disable your own account' : undefined}
                          onClick={() => void toggleActive(a)}
                        >
                          {a.is_active ? 'Disable' : 'Enable'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="text-xs font-semibold text-white flex items-center gap-1.5 mb-3">
          <Info className="w-3.5 h-3.5 text-blue-400" /> Roles
        </h3>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
          {ROLES.map((r) => (
            <div key={r} className="flex gap-2">
              <dt className="w-16 shrink-0 font-mono text-slate-200">{r}</dt>
              <dd className="text-slate-400">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-slate-500 mt-3">
          At least one active Owner must always remain. Locked out? Run{' '}
          <code className="font-mono text-slate-300">sudo fleetpanel reset-password &lt;user&gt;</code> on the server.
        </p>
      </Card>

      {creating && (
        <CreateAdminModal
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            res.setData((all) => [...(all ?? []), a]);
            toast.success(`Administrator ${a.username} created.`);
          }}
        />
      )}
    </div>
  );
}
