'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/terminal/meta';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel w-[min(92vw,360px)] p-6">
      <div className="mb-6 flex items-center gap-3">
        <Logo size={34} />
        <div>
          <div className="text-[15px] font-semibold">Sniper Terminal</div>
          <div className="label">operator sign-in</div>
        </div>
      </div>
      <label className="label mb-1 block" htmlFor="u">
        username
      </label>
      <Input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" className="mb-3" />
      <label className="label mb-1 block" htmlFor="p">
        password
      </label>
      <Input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus className="mb-4" />
      {error && <div className="mb-3 font-mono text-[11px] text-down">{error}</div>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy || !password}>
        {busy ? 'signing in…' : 'sign in'}
      </Button>
      <p className="mt-5 font-mono text-[10px] leading-relaxed text-ink-500">Paper mode is the default. Live trading requires server-side enablement, a configured execution adapter and an explicit in-app authorization.</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
