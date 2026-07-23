'use client';
import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const res = await fetch('/auth/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    setLoading(false);

    if (data.ok) {
      router.push(from);
      router.refresh();
    } else {
      setError('Incorrect username or password.');
      setPassword('');
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>⚡</span>
          <h1 style={styles.title}>TorBox<span style={styles.accent}>Manager</span></h1>
          <p style={styles.subtitle}>Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          {error && <div style={styles.error}>{error}</div>}

          <div style={styles.field}>
            <label style={styles.label}>Username</label>
            <input
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={e => setUsername(e.target.value)}
              style={styles.input}
              placeholder="Enter username"
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              placeholder="Enter password"
            />
          </div>

          <button type="submit" disabled={loading} style={loading ? { ...styles.btn, opacity: 0.7 } : styles.btn}>
            {loading ? 'Signing in…' : 'Sign In →'}
          </button>
        </form>

        <p style={styles.hint}>
          Set <code>WEB_USERNAME</code> and <code>WEB_PASSWORD</code> in your environment to change credentials.
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0a0a12 0%, #0f0f1e 50%, #0a0a12 100%)',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  card: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 20,
    padding: '40px 36px',
    width: 380,
    boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(20px)',
  },
  logo: { textAlign: 'center', marginBottom: 32 },
  logoIcon: { fontSize: 40, display: 'block', marginBottom: 8 },
  title: { fontSize: 26, fontWeight: 700, color: '#f1f5f9', margin: 0 },
  accent: { color: '#7c3aed' },
  subtitle: { color: '#64748b', fontSize: 14, marginTop: 6 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: '#94a3b8' },
  input: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10,
    padding: '11px 14px',
    fontSize: 14,
    color: '#f1f5f9',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  error: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#f87171',
    fontSize: 13,
  },
  btn: {
    background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '12px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
    transition: 'opacity 0.15s, transform 0.1s',
    letterSpacing: '0.01em',
  },
  hint: {
    marginTop: 24,
    fontSize: 12,
    color: '#475569',
    textAlign: 'center',
    lineHeight: 1.6,
  },
};
