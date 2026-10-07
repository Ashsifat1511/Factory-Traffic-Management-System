import type { Aspect, Status } from './api';

const COLORS: Record<Aspect, string> = { RED: '#d33', YELLOW: '#e6b800', GREEN: '#2a2', UNKNOWN: '#888' };
const POS: Record<string, { x: number; y: number; qx: number; qy: number }> = {
  NORTH: { x: 150, y: 40, qx: 150, qy: 12 },
  SOUTH: { x: 150, y: 260, qx: 150, qy: 292 },
  WEST: { x: 40, y: 150, qx: 40, qy: 120 },
  EAST: { x: 260, y: 150, qx: 260, qy: 120 },
};

/**
 * Filled lamp = actual (controller-confirmed) aspect; outer ring = desired aspect.
 * A dashed outline marks a mismatch. Every lamp also has a text label, so colour is never the only cue.
 */
export function Intersection({ status: s }: { status: Status }) {
  return (
    <svg viewBox="0 0 300 300" className="intersection" role="img" aria-label={`Junction ${s.junction_id} signals`}>
      <rect x="110" y="0" width="80" height="300" fill="#444" />
      <rect x="0" y="110" width="300" height="80" fill="#444" />
      {s.emergencies.length > 0 && <rect x="2" y="2" width="296" height="296" fill="none" stroke="#e00" strokeWidth="4" className="pulse" />}
      {Object.entries(POS).map(([dir, p]) => {
        const actual = s.actual_signals[dir] ?? 'UNKNOWN';
        const desired = s.desired_signals[dir] ?? 'UNKNOWN';
        const mismatch = actual !== desired;
        return (
          <g key={dir}>
            <circle cx={p.x} cy={p.y} r="22" fill="none" stroke={COLORS[desired]} strokeWidth="5" />
            <circle cx={p.x} cy={p.y} r="15" fill={COLORS[actual]} />
            {mismatch && <circle cx={p.x} cy={p.y} r="28" fill="none" stroke="#e00" strokeDasharray="4 3" />}
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="8" fill="#fff">{actual === 'UNKNOWN' ? '?' : actual[0]}</text>
            <text x={p.qx} y={p.qy} textAnchor="middle" fontSize="11" fill="#111">{dir} {actual}{mismatch ? ` (want ${desired})` : ''} · q{s.queues[dir] ?? 0}</text>
          </g>
        );
      })}
      <text x="150" y="146" textAnchor="middle" fontSize="12" fill="#fff">{s.mode}</text>
      <text x="150" y="162" textAnchor="middle" fontSize="10" fill="#ddd">{s.phase}</text>
    </svg>
  );
}
