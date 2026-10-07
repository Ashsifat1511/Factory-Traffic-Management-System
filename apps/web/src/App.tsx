import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type AuditEntry, type Me, type Status } from './api';
import { Intersection } from './Intersection';
import { SimulationPanel } from './SimulationPanel';

const DIRS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api<Me>('/api/auth/me').then(setMe).catch(() => setMe(null)); }, []);
  if (me === undefined) return <p className="pad">Loading…</p>;
  if (me === null) return <Login onLogin={setMe} />;
  return <Dashboard me={me} onLogout={() => setMe(null)} />;
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [username, setU] = useState('operator');
  const [password, setP] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      onLogin(await api<Me>('/api/auth/me'));
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.code === 'ACCOUNT_LOCKED' ? 'Account locked for 15 minutes.' : err.problem.status === 0 ? 'Backend unreachable.' : 'Invalid username or password.') : 'Login failed.');
    }
  };
  return (
    <form className="login card" onSubmit={submit}>
      <h1>Factory Traffic Control</h1>
      <label>Username <input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" /></label>
      <label>Password <input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}

/** Live junction state from SSE, with polling as a fallback when the stream is down. */
function useLive() {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [feed, setFeed] = useState<{ junction_id: string; entry: { type: string; severity: string; direction?: string; correlationId?: string; details?: Record<string, unknown> }; at: string }[]>([]);
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const open = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('status', (ev) => {
        const s = JSON.parse((ev as MessageEvent).data) as Status;
        setStatuses((prev) => ({ ...prev, [s.junction_id]: s }));
        setLastUpdate(Date.now());
        setConnected(true);
      });
      es.addEventListener('audit', (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { junction_id: string; entries: never[] };
        const at = new Date().toISOString();
        setFeed((prev) => [...d.entries.map((entry) => ({ junction_id: d.junction_id, entry, at })).reverse(), ...prev].slice(0, 200));
      });
      es.onerror = () => {
        setConnected(false);
        if (!poll) poll = setInterval(async () => {
          try {
            const list = await api<{ junction_id: string }[]>('/api/junctions');
            for (const j of list) {
              const s = await api<Status>(`/api/junctions/${j.junction_id}/status`);
              setStatuses((prev) => ({ ...prev, [s.junction_id]: s }));
            }
            setLastUpdate(Date.now());
          } catch { /* banner shows staleness */ }
        }, 2000);
      };
      es.onopen = () => { if (poll) { clearInterval(poll); poll = null; } };
    };
    open();
    return () => { es?.close(); if (poll) clearInterval(poll); };
  }, []);
  return { statuses, lastUpdate, connected, feed };
}

function Dashboard({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { statuses, lastUpdate, connected, feed } = useLive();
  const [selected, setSelected] = useState<string | null>(null);
  const ids = Object.keys(statuses).sort();
  const current = selected && statuses[selected] ? selected : ids[0] ?? null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const stale = lastUpdate === null || now - lastUpdate > 12_000;

  return (
    <div className="layout">
      <header>
        <h1>Factory Traffic Control</h1>
        <span className="muted">{me.username} ({me.role})</span>
        <button className="link" onClick={async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); onLogout(); }}>Sign out</button>
      </header>
      {(!connected || stale) && (
        <div className="banner" role="alert">
          {connected ? 'No update for a while.' : 'Live connection lost; polling the backend.'} Data may be stale
          {lastUpdate ? ` (last update ${new Date(lastUpdate).toLocaleTimeString()})` : ''}.
        </div>
      )}
      {me.simulation_mode && <div className="banner sim">Simulation mode is ON. Never enable it in production.</div>}
      <nav className="cards">
        {ids.length === 0 && <p className="muted">No junctions yet.</p>}
        {ids.map((id) => {
          const s = statuses[id]!;
          return (
            <button key={id} className={`card junction ${id === current ? 'active' : ''}`} onClick={() => setSelected(id)}>
              <strong>Junction {id}</strong>
              <span className={`badge mode-${s.mode}`}>{s.mode}</span>
              <span className={`badge health-${s.health}`}>health {s.health}</span>
              <span>{s.phase} · controller {s.controller_status}</span>
              <span>Queues {DIRS.map((d) => `${d[0]}:${s.queues[d] ?? 0}`).join(' ')}</span>
              {s.emergencies.length > 0 && <span className="badge mode-EMERGENCY">EMERGENCY {s.emergencies.map((e) => e.direction).join(', ')}</span>}
              {s.health === 'FAILED' && <span className="badge health-FAILED">FAILURE</span>}
            </button>
          );
        })}
      </nav>
      {current && statuses[current] && (
        <JunctionDetail status={statuses[current]!} me={me} now={now} feed={feed.filter((f) => f.junction_id === current)} />
      )}
    </div>
  );
}

function JunctionDetail({ status: s, me, now, feed }: { status: Status; me: Me; now: number; feed: ReturnType<typeof useLive>['feed'] }) {
  const canOperate = me.role === 'OPERATOR' || me.role === 'ADMIN';
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const versionRef = useRef(s.version);
  versionRef.current = s.version;

  const loadHistory = useCallback(() => {
    api<AuditEntry[]>(`/api/junctions/${s.junction_id}/history?limit=40`).then(setHistory).catch(() => undefined);
  }, [s.junction_id]);
  useEffect(() => { loadHistory(); }, [loadHistory, feed.length]);

  const send = async (command: string, extra: Record<string, unknown> = {}) => {
    setMessage(null);
    try {
      const out = await api<{ request_id: string }>(`/api/junctions/${s.junction_id}/commands`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { command, expected_version: versionRef.current, ...(reason ? { reason } : command === 'ALL_RED_HOLD' || command.startsWith('EMERGENCY') || command === 'RESUME_AFTER_FAULT' ? { reason: 'operator action' } : {}), ...extra },
      });
      setMessage({ ok: true, text: `${command} accepted (${out.request_id})` });
    } catch (e) {
      const p = e instanceof ApiError ? e.problem : null;
      setMessage({ ok: false, text: p?.code === 'STALE_VERSION' ? 'The junction changed while you were deciding. Review the new state and retry.' : `${command} refused: ${p?.code ?? 'error'}${p?.detail ? ` – ${p.detail}` : ''}` });
    }
  };
  const allowed = (c: string) => canOperate && s.allowed_commands.includes(c);
  const remaining = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(iso) - now) / 1000)) : null);

  return (
    <main className="detail">
      <section className="card">
        <h2>Junction {s.junction_id}</h2>
        <div className="row">
          <span className={`badge mode-${s.mode}`}>mode {s.mode}</span>
          <span className={`badge health-${s.health}`}>health {s.health}</span>
          <span className="badge">controller {s.controller_status}</span>
          <span className="badge">version {s.version}</span>
        </div>
        <Intersection status={s} />
        <p>
          Interval <strong>{s.interval.kind}</strong> {s.interval.phase ?? ''}
          {s.interval.ends_at && <> · ends in {remaining(s.interval.ends_at)} s</>}
          {!s.actual_known && <span className="warn"> · physical state UNKNOWN (waiting for controller confirmation)</span>}
        </p>
        {s.pending_command && (
          <p className="muted">Pending command {s.pending_command.command_id.slice(0, 16)}… {s.pending_command.step} {s.pending_command.phase ?? ''} · attempt {s.pending_command.attempt} · ACK due in {remaining(s.pending_command.ack_deadline_at)} s</p>
        )}
        <table className="queues">
          <thead><tr><th>Direction</th><th>Desired</th><th>Actual</th><th>Queue</th><th>Types</th><th>Oldest wait</th></tr></thead>
          <tbody>
            {DIRS.map((d) => (
              <tr key={d} className={s.desired_signals[d] !== s.actual_signals[d] ? 'mismatch' : ''}>
                <td>{d}</td><td>{s.desired_signals[d]}</td><td>{s.actual_signals[d]}</td><td>{s.queues[d] ?? 0}</td>
                <td>{Object.entries(s.queue_details[d]?.by_type ?? {}).map(([t, n]) => `${t}×${n}`).join(', ') || '—'}</td>
                <td>{s.queue_details[d]?.oldest_wait_s ?? 0} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Overrides and alerts</h3>
        {s.manual ? <p>Manual: {s.manual.target_phase} by {s.manual.by} ({s.manual.reason}) · lease ends in {remaining(s.manual.lease_expires_at)} s</p> : <p className="muted">No manual override.</p>}
        {s.hold && <p className="warn">ALL-RED HOLD by {s.hold.by}: {s.hold.reason}</p>}
        {s.emergencies.map((e) => <p key={e.vehicle_id} className="emergency">Emergency {e.vehicle_id} from {e.direction} → {e.phase} · expires in {remaining(e.expires_at)} s</p>)}
        <ul className="alerts">
          {s.alerts.length === 0 && <li className="muted">No active alerts.</li>}
          {s.alerts.map((a, i) => <li key={i} className={`sev-${a.severity}`}>{a.severity}: {a.message}</li>)}
        </ul>
      </section>

      {canOperate && (
        <section className="card">
          <h3>Manual control</h3>
          <label>Reason <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you doing this?" /></label>
          <div className="row">
            {DIRS.map((d) => <button key={d} disabled={!allowed('MANUAL_GREEN_REQUEST')} onClick={() => send('MANUAL_GREEN_REQUEST', { direction: d })}>Green {d}</button>)}
          </div>
          <div className="row">
            <button disabled={!allowed('RETURN_TO_AUTOMATIC')} onClick={() => send('RETURN_TO_AUTOMATIC')}>Return to automatic</button>
            <button disabled={!allowed('EXTEND_MANUAL')} onClick={() => send('EXTEND_MANUAL')}>Extend manual</button>
            <button className="danger" disabled={!allowed('ALL_RED_HOLD') || !!s.hold} onClick={() => send('ALL_RED_HOLD')}>Hold all red</button>
            <button disabled={!allowed('RELEASE_HOLD')} onClick={() => send('RELEASE_HOLD')}>Release hold</button>
            <button disabled={!allowed('RESUME_AFTER_FAULT')} onClick={() => send('RESUME_AFTER_FAULT')}>Resume after fault</button>
            <button disabled={!allowed('EMERGENCY_CANCEL')} onClick={() => send('EMERGENCY_CANCEL')}>Cancel emergencies</button>
          </div>
          {message && <p className={message.ok ? 'ok' : 'error'} role="status">{message.text}</p>}
        </section>
      )}

      {me.simulation_mode && me.simulation_allowed && <SimulationPanel junctionId={s.junction_id} status={s} />}

      <section className="card wide">
        <h3>Recent activity</h3>
        <table className="history">
          <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Dir</th><th>Actor</th><th>Details</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.chain_seq} className={`sev-${h.severity}`}>
                <td>{h.chain_seq}</td><td>{new Date(h.occurred_at).toLocaleTimeString()}</td><td>{h.event_type}</td><td>{h.direction ?? ''}</td>
                <td>{h.actor_type}{h.actor_id ? `:${h.actor_id}` : ''}</td>
                <td className="details">{h.new_state ? `→ ${JSON.stringify(h.new_state)} ` : ''}{Object.keys(h.details ?? {}).length ? JSON.stringify(h.details) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
