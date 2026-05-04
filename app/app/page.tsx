'use client'

import { useState, useEffect, useCallback } from 'react'

interface LicensePayload { e?: string; p?: string; i?: string; v?: string; m?: string }
interface LicenseRow { id: string; key_hash: string; payload: LicensePayload; created_at: string }
interface RevokedRow { id: string; key_hash: string; reason: string; revoked_at: string }
interface KeyData { licenses: LicenseRow[]; revoked: RevokedRow[] }
interface GenerateResult { email: string; plan: string; issued: string; expires: string; keyHash: string; key: string }

function fmtDate(iso: string | undefined | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('vi-VN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function daysUntil(iso: string | undefined | null) {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

function statusBadge(row: LicenseRow) {
  const days = daysUntil(row.payload.v ?? '')
  if (days === null) return null
  if (days < 0) return <span className="badge badge-red">Het han</span>
  if (days <= 14) return <span className="badge badge-yellow">Con {days} ngay</span>
  return <span className="badge badge-green">Active</span>
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'Sai thong tin dang nhap'); return }
      onLogin()
    } catch { setError('Loi ket noi') }
    finally { setLoading(false) }
  }

  return (
    <div className="login-page">
      <div className="login-card animate-fade-in">
        <div className="login-logo">
          <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="url(#lg)"/>
            <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4f8ef7"/><stop offset="1" stopColor="#a78bfa"/>
            </linearGradient></defs>
            <path d="M8 22 L16 10 L24 22 M11 18 H21" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h1 className="login-title">9BizClaw</h1>
        <p className="login-sub">License Manager</p>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field">
            <label className="field-label">Username</label>
            <input type="text" className="input" placeholder="peterbui85" value={username}
              onChange={e => setUsername(e.target.value)} autoComplete="username" required/>
          </div>
          <div className="field">
            <label className="field-label">Password</label>
            <input type="password" className="input" placeholder="••••••••••" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="current-password" required/>
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? <span className="spinner"/> : null}
            {loading ? 'Dang nhap...' : 'Dang nhap'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Toast({ msg, type, onDone }: { msg: string; type: 'success'|'error'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t) }, [onDone])
  return (
    <div className={`toast ${type} show`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        {type === 'success'
          ? <polyline points="20 6 9 17 4 12"/>
          : <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>
        }
      </svg>
      {msg}
    </div>
  )
}

function GenerateForm({ onGenerated }: { onGenerated: () => void }) {
  const [email, setEmail] = useState('')
  const [months, setMonths] = useState('12')
  const [plan, setPlan] = useState('premium')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GenerateResult|null>(null)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) { setError('Email khong hop le'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/keys/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, months: parseInt(months), plan }),
      })
      const data = await res.json()
      if (data.error) { setError(data.error); return }
      setResult(data); onGenerated()
    } catch (e: any) { setError(e.message ?? 'Loi ket noi') }
    finally { setLoading(false) }
  }

  function copyKey() { if (result?.key) navigator.clipboard.writeText(result.key).then(() => {}) }

  return (
    <div className="card">
      <h2 className="card-title">Tao license key moi</h2>
      <p className="card-desc">Key se duoc insert vao Supabase ngay khi tao. Khach nhan key va kich hoat tren app.</p>
      <form onSubmit={submit} className="form-stack">
        <div className="form-row">
          <div className="field" style={{ flex: 2 }}>
            <label className="field-label">Email khach hang</label>
            <input type="email" className="input" placeholder="customer@company.com"
              value={email} onChange={e => setEmail(e.target.value)} required/>
          </div>
          <div className="field">
            <label className="field-label">Thoi han</label>
            <select className="input" value={months} onChange={e => setMonths(e.target.value)}>
              <option value="1">1 thang</option><option value="3">3 thang</option>
              <option value="6">6 thang</option><option value="12" selected>12 thang</option>
              <option value="24">24 thang</option><option value="36">36 thang</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">Goi</label>
            <select className="input" value={plan} onChange={e => setPlan(e.target.value)}>
              <option value="premium">Premium</option><option value="enterprise">Enterprise</option>
            </select>
          </div>
        </div>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? <span className="spinner"/> : null}
          {loading ? 'Dang tao…' : 'Tao license key'}
        </button>
      </form>
      {error && <div className="alert alert-error">{error}</div>}
      {result && (
        <div className="result-box animate-fade-in">
          <div className="result-meta">{result.email} — {result.plan} — {fmtDate(result.issued)} → {fmtDate(result.expires)}</div>
          <div className="result-key" onClick={copyKey}>{result.key}</div>
          <div className="result-actions">
            <button className="btn-sm btn-outline" onClick={copyKey}>Copy key</button>
            <span className="result-hash">Hash: {result.keyHash}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function KeysTable({ licenses, revoked, onRevoke, onRefresh }: {
  licenses: LicenseRow[]; revoked: RevokedRow[]; onRevoke: (h: string) => void; onRefresh: () => void
}) {
  const all = [
    ...licenses.map(l => ({ type: 'active' as const, row: l })),
    ...revoked.map(r => ({ type: 'revoked' as const, row: r })),
  ]
  return (
    <div className="card">
      <div className="card-header-row">
        <div>
          <h2 className="card-title">Danh sach license keys</h2>
          <p className="card-desc">{licenses.length} key active · {revoked.length} da thu hoi</p>
        </div>
        <button className="btn-sm btn-ghost" onClick={onRefresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Refresh
        </button>
      </div>
      {all.length === 0 ? (
        <div className="empty-state">
          <p>Chua co key nao. Tao key dau tien ben tren.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th><th>Goi</th><th>Ngay tao</th><th>Het han</th><th>Trang thai</th><th>Hash</th><th></th>
              </tr>
            </thead>
            <tbody>
              {all.map(({ type, row }) => {
                if (type === 'revoked') {
                  const r = row as RevokedRow
                  return (
                    <tr key={r.id} className="row-revoked">
                      <td colSpan={3}><span className="badge badge-red">Da thu hoi</span></td>
                      <td colSpan={2}>{r.reason}</td>
                      <td style={{fontSize:'11px',fontFamily:'monospace',color:'var(--text-tertiary)'}}>{r.key_hash}</td>
                      <td/>
                    </tr>
                  )
                }
                const l = row as LicenseRow
                return (
                  <tr key={l.id}>
                    <td className="td-email">{l.payload.e ?? '—'}</td>
                    <td><span className={`badge ${l.payload.p === 'enterprise' ? 'badge-purple' : 'badge-blue'}`}>{l.payload.p ?? 'premium'}</span></td>
                    <td>{fmtDate(l.payload.i)}</td>
                    <td>{fmtDate(l.payload.v)}</td>
                    <td>{statusBadge(l)}</td>
                    <td style={{fontSize:'11px',fontFamily:'monospace',color:'var(--text-tertiary)'}}>{l.key_hash}</td>
                    <td className="td-actions">
                      <button className="btn-sm btn-danger" onClick={() => onRevoke(l.key_hash)}>Thu hoi</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  const [data, setData] = useState<KeyData|null>(null)
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [toast, setToast] = useState<{msg:string;type:'success'|'error'}|null>(null)

  const fetchKeys = useCallback(async () => {
    setLoadingKeys(true)
    try {
      // First check session validity via /api/auth/check
      const checkRes = await fetch('/api/auth/check')
      if (checkRes.status !== 200) { setAuthenticated(false); return }
      const checkData = await checkRes.json()
      if (!checkData.ok) { setAuthenticated(false); return }

      // Session valid — fetch license keys
      const res = await fetch('/api/keys/list')
      if (res.status === 401) { setAuthenticated(false); return }
      const json = await res.json()
      // Handle backend error (e.g. Supabase unreachable)
      if (json.error) {
        setToast({ msg: json.error + ' (kiem tra Supabase env var tren Vercel)', type: 'error' })
        setData({ licenses: [], revoked: [] })
      } else {
        setData(json)
      }
      setAuthenticated(true)
    } catch { setAuthenticated(false) }
    finally { setLoadingKeys(false); setChecking(false) }
  }, [])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  async function handleRevoke(hash: string) {
    if (!confirm('Thu hoi key nay? App khach se bi chan trong ~1 gio.')) return
    try {
      const res = await fetch('/api/keys/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyHash: hash }),
      })
      const json = await res.json()
      if (json.error) { setToast({ msg: json.error, type: 'error' }); return }
      setToast({ msg: 'Da thu hoi. App khach se bi chan trong ~1 gio.', type: 'success' })
      fetchKeys()
    } catch (e: any) { setToast({ msg: e.message ?? 'Loi', type: 'error' }) }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthenticated(false); setData(null)
  }

  if (checking) return (
    <div className="login-page"><span className="spinner lg"/></div>
  )

  if (!authenticated) return (
    <LoginScreen onLogin={() => { setAuthenticated(true); fetchKeys() }}/>
  )

  return (
    <div className="page">
      <header className="header">
        <div className="header-brand">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="url(#hg)"/>
            <defs><linearGradient id="hg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4f8ef7"/><stop offset="1" stopColor="#a78bfa"/>
            </linearGradient></defs>
            <path d="M8 22 L16 10 L24 22 M11 18 H21" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div><div className="brand-name">9BizClaw</div><div className="brand-sub">License Manager</div></div>
        </div>
        <div className="header-right">
          <div className="supabase-badge"><span className="sb-dot"/>Supabase connected</div>
          <button className="btn-sm btn-ghost" onClick={handleLogout}>Dang xuat</button>
        </div>
      </header>
      <main className="main">
        <div className="container">
          <GenerateForm onGenerated={fetchKeys}/>
          {loadingKeys && !data ? (
            <div className="loading-row"><span className="spinner"/>Dang tai…</div>
          ) : data ? (
            <KeysTable licenses={data.licenses} revoked={data.revoked} onRevoke={handleRevoke} onRefresh={fetchKeys}/>
          ) : null}
        </div>
      </main>
      <footer className="footer">
        9BizClaw License System — Supabase backend — Ed25519-signed + hardware-bound keys.
      </footer>
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)}/>}
    </div>
  )
}
