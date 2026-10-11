import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { Brand } from '@/components/portfolio';
import { Button } from '@/components/ui/button';
import { Studio } from '@/components/studio';
import { ApiError, studioApi, type AdminContent, type Revision } from '@/lib/studio-client';

type Phase =
  | { kind: 'loading' }
  | { kind: 'login'; message?: string }
  | { kind: 'unconfigured'; missing: string[] }
  | { kind: 'error' }
  | { kind: 'ready'; admin: AdminContent; revisions: Revision[] };

export function StudioGate() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function enter() {
    try {
      const [admin, list] = await Promise.all([studioApi.content(), studioApi.revisions()]);
      setPhase({ kind: 'ready', admin, revisions: list.revisions });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setPhase({ kind: 'login' });
      else if (e instanceof ApiError && e.status === 503) setPhase({ kind: 'unconfigured', missing: Array.isArray(e.body['missing']) ? (e.body['missing'] as string[]) : [] });
      else setPhase({ kind: 'error' });
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await studioApi.session();
        if (cancelled) return;
        if (!info.configured) setPhase({ kind: 'unconfigured', missing: info.missing ?? [] });
        else if (!info.authenticated) setPhase({ kind: 'login' });
        else await enter();
      } catch {
        if (!cancelled) setPhase({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await studioApi.login(password);
      setPassword('');
      await enter();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setError('Too many attempts. Please wait about 15 minutes and try again.');
      else if (e instanceof ApiError && e.status === 401) {
        const left = e.body['attemptsLeft'];
        setError(typeof left === 'number' ? `Incorrect password. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect password.');
      } else if (e instanceof ApiError && e.status === 503) setPhase({ kind: 'unconfigured', missing: Array.isArray(e.body['missing']) ? (e.body['missing'] as string[]) : [] });
      else setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === 'ready') {
    return <Studio initial={phase.admin} initialRevisions={phase.revisions} onLogout={() => setPhase({ kind: 'login' })} onExpired={() => { setError(''); setPhase({ kind: 'login', message: 'Your session expired. Please sign in again.' }); }} />;
  }

  return <div className="login-page"><Link to="/"><Brand/></Link>
    {phase.kind === 'loading' && <p className="login-note" role="status">Checking your session…</p>}
    {phase.kind === 'error' && <div className="login-form"><p className="form-error" role="alert">The studio could not load. Refresh the page to try again.</p></div>}
    {phase.kind === 'unconfigured' && <div className="login-form" role="alert"><p className="form-error">The studio is locked until the server is set up.</p><p className="login-note">Missing: {phase.missing.length ? phase.missing.join('; ') : 'configuration'}. See DEPLOY.md, section “Admin setup”.</p></div>}
    {phase.kind === 'login' && <form className="login-form" onSubmit={submit}>
      <label className="editor-field"><span>Admin password</span><input type="password" autoComplete="current-password" autoFocus value={password} maxLength={512} onChange={e => setPassword(e.target.value)} aria-invalid={!!error}/></label>
      {phase.message && !error && <p className="login-note" role="status">{phase.message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form>}
  </div>;
}
