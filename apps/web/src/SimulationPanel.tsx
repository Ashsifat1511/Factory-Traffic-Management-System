import { useEffect, useState } from 'react';
import { api, ApiError, type Status } from './api';

const DIRS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const TYPES = ['EMPLOYEE_VEHICLE', 'FORKLIFT', 'TRUCK', 'MATERIAL_CARRIER', 'EMERGENCY'];

interface SimState { aspects: Record<string, string>; latency_ms: number; faults: Record<string, boolean>; local_failsafe?: boolean; log?: string[] }

/** Spec §14.8: simulate sensors, device status and controller behaviour without hardware. */
export function SimulationPanel({ junctionId, status }: { junctionId: string; status: Status }) {
  const [dir, setDir] = useState('NORTH');
  const [type, setType] = useState('EMPLOYEE_VEHICLE');
  const [vehicle, setVehicle] = useState(() => `VH-${Math.floor(Math.random() * 900 + 100)}`);
  const [eventId, setEventId] = useState('');
  const [seq, setSeq] = useState('');
  const [offset, setOffset] = useState('0');
  const [log, setLog] = useState<string[]>([]);
  const [sim, setSim] = useState<SimState | null>(null);
  const [raw, setRaw] = useState('{"command_id":"cmd-unknown","junction_id":"A","status":"ACK","actual_state":"GREEN"}');

  const note = (t: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${t}`, ...l].slice(0, 12));
  const fail = (e: unknown) => note(e instanceof ApiError ? `refused ${e.problem.status} ${e.problem.code}${e.problem.detail ? `: ${e.problem.detail}` : ''}` : 'error');

  const loadSim = () => api<SimState>(`/api/sim/controllers/${junctionId}`).then(setSim).catch(() => setSim(null));
  useEffect(() => { void loadSim(); const t = setInterval(loadSim, 3000); return () => clearInterval(t); }, [junctionId]);

  const sensor = async (eventType: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED', times = 1) => {
    const body = {
      junction_id: junctionId, direction: dir, event_type: eventType, vehicle_id: vehicle,
      ...(eventType === 'VEHICLE_ARRIVED' ? { vehicle_type: type } : {}),
      event_id: eventId || `sim-${crypto.randomUUID()}`,
      ...(seq ? { sequence_no: Number(seq) } : {}), timestamp: new Date(Date.now() + (Number(offset) || 0) * 1000).toISOString(),
    };
    for (let i = 0; i < times; i++) {
      try {
        const r = await api<{ outcome: string; duplicate?: boolean }>('/api/sim/sensor-events', { method: 'POST', body });
        note(`${eventType} ${vehicle} ${dir}: ${r.duplicate ? 'DUPLICATE (' + r.outcome + ')' : r.outcome}`);
      } catch (e) { fail(e); }
    }
  };
  const setFaults = async (patch: Record<string, unknown>) => {
    try { setSim(await api<SimState>(`/api/sim/controllers/${junctionId}`, { method: 'PUT', body: patch })); note(`controller: ${JSON.stringify(patch)}`); } catch (e) { fail(e); }
  };
  const sendRaw = async () => {
    try { const body = JSON.parse(raw); const r = await api<{ outcome: string }>('/api/sim/controller-events', { method: 'POST', body }); note(`controller event: ${r.outcome}`); }
    catch (e) { e instanceof SyntaxError ? note('raw event is not valid JSON') : fail(e); }
  };
  const queued = Object.values(status.queue_details).length ? Object.entries(status.queue_details).flatMap(([d, q]) => (q.count ? [d] : [])) : [];

  return (
    <section className="card">
      <h3>Simulation</h3>
      <div className="row">
        <label>Direction <select value={dir} onChange={(e) => setDir(e.target.value)}>{DIRS.map((d) => <option key={d}>{d}</option>)}</select></label>
        <label>Type <select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Vehicle <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} size={9} /></label>
        <button onClick={() => setVehicle(`VH-${Math.floor(Math.random() * 900 + 100)}`)}>New id</button>
      </div>
      <div className="row">
        <label>event_id <input value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="auto" size={10} /></label>
        <label>sequence <input value={seq} onChange={(e) => setSeq(e.target.value)} placeholder="auto" size={6} /></label>
        <label>time offset (s) <input value={offset} onChange={(e) => setOffset(e.target.value)} size={5} /></label>
      </div>
      <div className="row">
        <button onClick={() => sensor('VEHICLE_ARRIVED')}>Vehicle arrives</button>
        <button onClick={() => sensor('VEHICLE_CLEARED')}>Vehicle clears</button>
        <button onClick={() => sensor('VEHICLE_ARRIVED', 2)} title="Uses the same event_id twice">Send arrival twice</button>
        <button onClick={async () => { for (const d of DIRS) for (let i = 0; i < 2; i++) { try { await api('/api/sim/sensor-events', { method: 'POST', body: { junction_id: junctionId, direction: d, event_type: 'VEHICLE_ARRIVED', vehicle_id: `R-${crypto.randomUUID().slice(0, 6)}`, vehicle_type: TYPES[Math.floor(Math.random() * 4)] } }); } catch (e) { fail(e); } } note('random burst sent'); }}>Random burst</button>
      </div>
      {queued.length > 0 && <p className="muted">Directions with queued vehicles: {queued.join(', ')}</p>}

      <h4>Controller ({sim ? `lights ${Object.entries(sim.aspects).map(([k, v]) => `${k[0]}:${v[0]}`).join(' ')}` : 'simulator unreachable'})</h4>
      {sim && (
        <>
          <div className="row">
            <label>ACK latency {sim.latency_ms} ms <input type="range" min={0} max={5000} step={100} value={sim.latency_ms} onChange={(e) => setFaults({ latency_ms: Number(e.target.value) })} /></label>
          </div>
          <div className="row">
            {['dropNextAck', 'dropAcks', 'nackNext', 'wrongStateNext', 'offline', 'unsafeHeartbeat'].map((f) => (
              <label key={f} className="toggle"><input type="checkbox" checked={!!sim.faults[f]} onChange={(e) => setFaults({ faults: { [f]: e.target.checked } })} /> {f}</label>
            ))}
          </div>
          <div className="row">
            <button onClick={() => setFaults({ device_status: { device_type: 'SENSOR', direction: dir, status: 'OFFLINE' } })}>Sensor {dir} offline</button>
            <button onClick={() => setFaults({ device_status: { device_type: 'SENSOR', direction: dir, status: 'ONLINE' } })}>Sensor {dir} online</button>
            <button onClick={() => setFaults({ device_status: { device_type: 'SIGNAL_HEAD', direction: dir, status: 'FAULT' } })}>Head {dir} fault</button>
            <button onClick={() => setFaults({ device_status: { device_type: 'SIGNAL_HEAD', direction: dir, status: 'ONLINE' } })}>Head {dir} online</button>
          </div>
        </>
      )}
      <label className="block">Raw controller event (ACK / heartbeat / device status)
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={2} />
      </label>
      <button onClick={sendRaw}>Send raw controller event</button>
      <ul className="simlog">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </section>
  );
}
