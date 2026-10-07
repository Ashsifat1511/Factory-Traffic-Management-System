# Factory Traffic Management System

Supervisory traffic-signal control for the internal roads of a garment factory (CSI Smart Tech Backend Developer Intern Assessment V2).
Sensors report vehicles, the backend keeps per-direction queues, chooses the next safe phase, drives the junction controller through
GREEN → YELLOW → ALL_RED → GREEN, handles emergencies, manual overrides and device failures, and records a tamper-evident audit log
that survives restarts. A React dashboard shows backend state and sends operator intents.

The full design (architecture, state machine, threat model, schema, roadmap) is in [`plan.md`](plan.md). This README is the short version.

## Quick start

Prerequisites: Node.js 24, Docker.

```bash
cp .env.example .env
npm install
docker compose up -d db                 # PostgreSQL on localhost:5433
npm run seed -w @ftms/server            # migrations, Junction A, users, device keys (.sim-keys.env)
npm start -w @ftms/server               # API on http://localhost:8080
npm start -w @ftms/controller-sim       # controller simulator on :8090 (separate process, like real hardware)
npm run dev -w @ftms/web                # dashboard on http://127.0.0.1:3000
```

Demo users (from `.env`): `operator` / `operator-password-123` (can control and simulate), `admin` / `admin-password-123`,
`viewer` / `viewer-password-123` (read-only).

| Command | What it does |
|---|---|
| `npm test` | Domain unit, scenario and property-based tests (Vitest + fast-check) |
| `npx vitest run packages/domain/test/domain.test.ts -t "preempts"` | Run a single test |
| `npx tsx scripts/scenarios.ts <1..9 or all>` | Demonstrate the spec §15 scenarios against the running stack |
| `npm run audit:verify -w @ftms/server` | Recompute the audit hash chains and report tampering |
| `npx tsc -p packages/domain --noEmit` | Typecheck (also `apps/server`, `apps/controller-sim`, `apps/web`) |

## Architecture

A modular monolith with ports and adapters (plan §2):

```
REST / (MQTT)  →  HTTP adapter (Fastify)  →  Application: one actor (mailbox) per junction  →  Domain decide()  (pure)
                                                  │                                              │
                                                  ├── PostgreSQL store (snapshot + hash-chained audit, one transaction per decision)
                                                  └── ControllerGateway port → REST controller simulator (MQTT adapter is roadmap M6)
```

| Path | Role |
|---|---|
| `packages/domain` | The traffic engine. No dependencies, no I/O, no clock: `decide(ctx, state, input)` returns the new state, effects, audit records and an outcome. Contains config validation, the independent safety guard, the scheduler and the state machine. |
| `packages/sim-core` | Physical controller model with its own conflict monitor and local SAFE_STOP clearance. Used by the simulator and by the property tests as "the physical world". |
| `apps/server` | Application layer (actors, runtime, status view) and adapters (HTTP, PostgreSQL, security, REST controller gateway). |
| `apps/controller-sim` | Controller simulator process with fault switches (drop ACKs, NACK, wrong state, offline, unsafe heartbeat, device status). |
| `apps/web` | React dashboard: live view over SSE, intersection diagram (desired vs confirmed), controls, simulation panel, activity feed. |

Why not microservices: each junction is a single-writer safety state machine. Splitting "decide" from "command" across services
would add dual writes and ordering hazards that threaten the invariants, and the load (about one decision per second per junction)
does not need it. Every external concern is behind a port, so services can be extracted later (plan §2.1, §19).

## Traffic-control algorithm

Decisions happen at the end of each 30 s green block, on gap-out (the green phase has no demand after the 10 s minimum while another
phase waits), at 90 s maximum green, at the end of all-red clearance, and when an overlay changes. The decision ladder:

1. **HOLD** (operator all-red hold) → go to and stay in ALL_RED.
2. **EMERGENCY** → the phase of the first emergency (first come, first served; conflicting emergencies take 30 s turns).
3. **MANUAL** → the operator's phase (10-minute renewable lease).
4. **AUTOMATIC** → starvation guard (any vehicle waiting ≥ 120 s), then max green, then gap-out, then score with hysteresis:

```
score(phase) = Σ weight(type) × (1 + wait_s / 60)      weights: TRUCK 5, FORKLIFT 3, MATERIAL_CARRIER 3, EMPLOYEE_VEHICLE 1, UNKNOWN 1
switch only if score(other) > 1.25 × score(current)    an approach whose sensor is offline counts as always having demand ("recall")
```

Waiting time uses server receipt time, so devices cannot backdate events to jump the queue. Every decision is audited as
`PHASE_DECISION` with the rule and the scores, so you can always see why a phase was chosen. Worked example: plan §4.3.

## State transitions

Signals follow an explicit interval state machine (plan §3.6):

```
UNKNOWN ──SAFE_STOP──▶ ALL_RED ──(3 s clearance)──▶ GREEN(q) ──(decision)──▶ YELLOW(q) ──(5 s)──▶ ALL_RED ──▶ …
```

- Each step is **one atomic command covering all four signals** and the next step waits for the controller's confirmation.
  Yellow and all-red are timed from the confirmation. A command without an ACK is never treated as executed.
- An **independent safety guard** checks every outgoing command: conflicting directions are never both GREEN or YELLOW, no
  GREEN→RED or YELLOW→GREEN, green only after confirmed all-red clearance, and no green while the state is unknown, failed, held
  or another command is pending. A guard trip raises a critical fault instead of sending the command.
- **Modes** are derived: control mode (AUTOMATIC / MANUAL / EMERGENCY / HOLD) from active overlays, health (OK / DEGRADED / FAILED /
  UNKNOWN) from active faults. The spec's `mode` field shows FAILURE when health is FAILED.
- **Failures**: no ACK in 2 s → retry the same `command_id` twice → FAILED + SAFE_STOP. 3 missed heartbeats → OFFLINE, actual state
  UNKNOWN. NACK, wrong state, unsafe report or a signal-head fault → FAILED until an operator sends `RESUME_AFTER_FAULT`.
  Communication-only faults resume automatically after a confirmed SAFE_STOP.
- **SAFE_STOP** asks the controller to bring every head to red through yellow using its own timers, because after a restart or lost
  ACK only the controller knows what the lights show.
- **Restart**: the backend never trusts the pre-restart physical state. It increments the fencing epoch, abandons pending commands,
  sends SAFE_STOP, and starts fresh from a confirmed ALL_RED. Queues, overrides, emergencies and history survive.

## API

All paths from the spec are kept. Errors are RFC 9457 problem details with a stable `code`.

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/login`, `/api/auth/logout`; GET `/api/auth/me` | public / session | httpOnly SameSite=Strict session cookie |
| GET | `/api/junctions`, `/api/junctions/:id`, `/api/junctions/:id/status` | VIEWER | status is a superset of spec §10.3 (desired vs actual, pending command, alerts, `allowed_commands`) |
| POST | `/api/junctions` | ADMIN | create a junction from a validated config (snake_case, like `config/junctions/A.json`) |
| POST | `/api/junctions/:id/commands` | OPERATOR | `MANUAL_GREEN_REQUEST`, `RETURN_TO_AUTOMATIC`, `EXTEND_MANUAL`, `ALL_RED_HOLD`, `RELEASE_HOLD`, `EMERGENCY_PREEMPT`, `EMERGENCY_CANCEL`, `RESUME_AFTER_FAULT`; optional `expected_version` (409 if stale) and `Idempotency-Key` header. 202 on acceptance. |
| GET | `/api/junctions/:id/history?limit&before&type&direction`, `/api/junctions/:id/alerts` | VIEWER | audit log, newest first |
| GET | `/api/stream` | VIEWER | Server-Sent Events: `status` and `audit` |
| POST | `/api/sensor-events` | sensor device key | 201 first time, 200 `duplicate:true` for an identical repeat, 409 if the same `event_id` has a different payload, 403 if the device is not bound to that junction/direction, 422 invalid |
| POST | `/api/controller-events` | controller device key | ACK / NACK / FAILED / HEARTBEAT / DEVICE_STATUS (type inferred if omitted; the spec's `actual_state` ACK shorthand is accepted) |
| POST | `/api/admin/devices`, DELETE `/api/admin/devices/:id` | ADMIN | issue (shown once) and revoke device keys |
| * | `/api/sim/*` | OPERATOR with simulation permission | only registered when `SIMULATION_MODE=true` |
| GET | `/api/health/live`, `/api/health/ready` | public | readiness is false until recovery has run |

State-changing operator requests must send `x-ftms-request: 1` (CSRF protection). Devices authenticate with
`Authorization: Bearer <key>` (keys for the demo are in `.sim-keys.env`). The controller contract (commands with `seq`, `epoch`,
`expires_at`; ACKs with full aspects) is in plan §8.2.

## Database schema

Migrations: [`apps/server/migrations`](apps/server/migrations). Main tables: `junctions`, `junction_configs` (immutable versions),
`junction_state` (domain snapshot with optimistic `version` and fencing `epoch`), `processed_events` (dedupe by
`(source_id, event_id)` + payload hash), `rejected_events` (dead-letter), `controller_commands` (partial unique index: one PENDING
command per junction), `operator_requests` (idempotency), `audit_log` + `audit_chain_heads` (SHA-256 hash chain per junction; the app
role cannot UPDATE or DELETE audit rows), `users`, `sessions`, `devices`.

## Demonstrating the scenarios

Start the stack (Quick start), open the dashboard as `operator`, then either use the dashboard's Simulation panel or run
`npx tsx scripts/scenarios.ts <n>`:

| # | Scenario | What to look for |
|---|---|---|
| 1 | Normal traffic | Arrivals on the red approach; after min green the junction gaps out through YELLOW and ALL_RED |
| 2 | Priority traffic | A TRUCK wins at the 30 s block boundary where employee cars would not; see the `PHASE_DECISION` scores |
| 3 | Emergency preemption | EMERGENCY arrival → YELLOW (confirmed) → ALL_RED (confirmed) → emergency phase GREEN, held until the vehicle clears |
| 4 | Manual override | 202, MANUAL badge with lease countdown; a request with an outdated version gets 409 STALE_VERSION; return to automatic |
| 5 | Duplicate event | 201 then 200 `duplicate:true`, queue unchanged; same id with another payload → 409 |
| 6 | Vehicle clearance | Arrive/clear changes the queue; a second clear is `ORPHAN_CLEAR`; a CLEARED delivered before its ARRIVED leaves no phantom |
| 7 | Controller failure | Drop ACKs → retries → FAILED; offline → UNKNOWN; reconnect → SAFE_STOP → automatic recovery |
| 8 | Restart | Stop the server mid-transition and start it again: state shows UNKNOWN, then SAFE_STOP and `RECOVERY_*` entries; queues, overrides and history survive |
| 9 | Concurrent events | Truck, emergency, manual request and duplicate within 12 ms → 201, 201, 409, 200; never conflicting greens |

## Tests

`npm test` runs 29 tests: config validation, the safety guard, the state machine scenarios (startup, restart mid-transition,
gap-out, emergency, manual, stale versions, missing ACKs, offline/reconnect, wrong state + operator resume, concurrency) and
**property-based tests** that throw hundreds of random sequences of events, commands, controller faults and time jumps at the domain
running against the physical controller model, and assert after every physical change that conflicting directions were never
permissive together, clearance and yellow durations were respected, the guard never tripped, queues stayed consistent, and processing
is deterministic.

## Security notes

Built: operator login (argon2id, server-side sessions, lockout after 5 failures, role checks), CSRF header + Origin check, per-device
keys stored as HMAC and bound to junction and direction, rate limits, strict validation for operator commands, dead-letter for
rejected device events, simulation routes only in simulation mode (and refused in production), an append-only hash-chained audit log
with a verification script, a single-instance database lock and epoch fencing for controller commands. The full STRIDE threat register
and residual risks are in plan §14.

## Assumptions / Questions / Requirement Issues

Key assumptions (plan §1.4): each physical controller has its own hardware conflict monitor and local fail-safe (the backend is a
supervisory layer, not the last line of safety); we define the controller protocol; one controller per junction; one sensor stream
per approach that identifies vehicles; devices deliver at least once; device clocks are synced but not trusted for scheduling;
turning vehicles yield within their phase; one site, ≤ 50 junctions; on-premises deployment.

Requirement issues and the decision taken for each (from plan §21):

| # | Issue | Type | Decision |
|---|---|---|---|
| RI-01 | What counts as a conflicting movement is undefined | Unclear | Conflicts are defined between phases; turns yield within a phase (A-07); the config has an explicit conflict list that is checked against the phases (V-6) |
| RI-02 | "Material-carrying vehicles" (spec §2) are missing from the supported types (spec §4) | Contradictory | Added `MATERIAL_CARRIER` with weight 3, configurable |
| RI-03 | Pedestrians are never mentioned, though factory roads carry many workers on foot | Missing, unsafe | Out of scope for the build and flagged; the config model can add pedestrian groups and an exclusive phase |
| RI-04 | The spec's controller command is per direction, so steps can be left half-applied | Unsafe | One atomic command per step carrying the full set of aspects; per-direction views kept in the API and audit (§8.2) |
| RI-05 | The safety rules name only GREEN conflicts | Missing | Conflicting groups may never both be GREEN or YELLOW (I-1) |
| RI-06 | GREEN → RED without YELLOW is not explicitly forbidden | Unsafe | Forbidden (I-3). SAFE_STOP is carried out locally by the controller as yellow then red. |
| RI-07 | The meaning of "normal GREEN ≈ 30 s" | Unclear | 30 s decision blocks; min 10 s and max 90 s under demand; rest in green with no demand (§4) |
| RI-08 | All-red duration is not given | Missing | 3 s default, configurable |
| RI-09 | How maximum waiting time is calculated | Unclear | From server receipt time; starvation guard at 120 s; bounded by max green (§4.4) |
| RI-10 | VEHICLE_CLEARED without a matching arrival | Unclear | `ORPHAN_CLEAR`: no queue change, a tombstone kept (§5.5) |
| RI-11 | Delayed events | Unclear | Staleness limits by type: emergency 30 s, arrival 5 min, clear subject to ordering (§5.3) |
| RI-12 | Out-of-order events | Unclear | Ordering per vehicle; `sequence_no` per source used for gap detection (§5.4) |
| RI-13 | Detecting duplicates; whether `event_id` or `sequence_no` is authoritative | Unclear | `event_id` scoped to the device, plus a payload hash; `sequence_no` is never used for de-duplication (§5.2) |
| RI-14 | Whether sensor or server time is authoritative | Unclear | Server time for decisions; sensor time for staleness and audit; more than 5 min in the future is rejected (§5.3) |
| RI-15 | Unknown vehicle types | Unclear | Accepted as UNKNOWN at the lowest weight, with a data-quality alert, because a real vehicle exists |
| RI-16 | Sensor events carry no device identity | Missing, security | Device authentication, with identity bound to junction and approach (§14.4) |
| RI-17 | How long manual control lasts, and whether it expires | Business | A 10-minute renewable lease, 60 minutes at most (§7.2) |
| RI-18 | Two administrators acting at once | Unclear | Serialized processing plus `expected_version`; the stale request gets 409 (§7.3) |
| RI-19 | The administrator disconnects | Unclear | Irrelevant with leases; control is never tied to the browser connection |
| RI-20 | Whether emergency overrides manual | Business | Emergency wins; manual resumes afterwards if the lease is still valid (§6.2) |
| RI-21 | Emergencies from conflicting directions | Business | First come, first served, with 30 s turns and a critical alert (E-5) |
| RI-22 | When an emergency counts as cleared | Unclear | CLEARED, 120 s without a new detection, or an operator cancel; absolute cap 300 s (E-6) |
| RI-23 | Emergency events are a valuable target for spoofing | Unsafe | Plausibility limits and per-device accountability; signed tokens in production (E-7, T-02) |
| RI-24 | How long to wait for an ACK, and whether to retry | Unclear | 2 s, then 2 retries with the same `command_id`, then FAILED and SAFE_STOP (§8.3) |
| RI-25 | Duplicate and late ACKs | Unclear | Duplicates are idempotent; a late ACK never revives a command but still updates the observed state (§8.3) |
| RI-26 | The controller reconnects | Unclear | SAFE_STOP, then automatic resume for communication-only faults (§8.4) |
| RI-27 | Desired and actual state disagree | Unclear | FAILED, with an operator resume required (§8.4) |
| RI-28 | The backend loses communication with the controller | Unclear | FAILED and no commands; relies on the controller's local fail-safe (A-01, C-6) |
| RI-29 | Timers after a restart, and a restart mid-transition | Unclear | Timers never resume; SAFE_STOP and a fresh start from ALL_RED (§9) |
| RI-30 | The status example puts a `direction` on a SIGNAL_CONTROLLER | Contradictory | Read as a fault on that head (A-03) |
| RI-31 | The ACK example reports a single `actual_state` | Technical | The full aspects are required (`actual_aspects`); the shorthand is accepted for compatibility and checked by the next heartbeat (§8.2) |
| RI-32 | An open simulation API (`/api/controller-events`) would let anyone spoof devices in production | Unsafe | Device-key authentication; simulation routes only with `SIMULATION_MODE` (§12.2, T-05) |
| RI-33 | Physical safety cannot rest on the backend alone | Unsafe, business | Stated assumption A-01: a conflict monitor in the controller |
| RI-34 | The spec has no fail-safe display state | Missing | The backend drives to steady ALL_RED; flashing exists only in the controller's local fail-safe; FLASHING aspects are a roadmap item |
| RI-35 | A 4–5 h budget against the full scope | Business | 3+ days chosen; cut lines in §18 |
| RI-36 | "Prevent queue = −1" suggests counters | Technical | Queues of individual vehicles make negative counts impossible by construction (I-7) |
| RI-37 | The HTTP code for duplicate events is not specified | Unclear | First submission 201, duplicate 200 with `duplicate: true`, conflicting reuse 409 (§5.6) |
| RI-38 | The spec's example timestamps (2026-10-05) are stale by the time they are replayed | Technical | Their outcome is `IGNORED_STALE` with an explanation; tools fill in the current time (§5.3) |

## Architecture decisions

| ADR | Decision | Context | Consequences |
|---|---|---|---|
| 001 | Modular monolith with ports and adapters | One writer per junction; tiny load; a review that values clarity | No distributed consistency problems; services can be extracted later behind the existing ports |
| 002 | Functional core (`decide`) inside an imperative shell | Safety logic must be testable without infrastructure | Deterministic, property-testable domain; effects run outside it |
| 003 | One actor (mailbox) per junction | Concurrent inputs must not produce conflicting decisions | Simple ordering per junction; a single instance until P2 |
| 004 | Atomic commands covering every signal, plus SAFE_STOP | Per-direction commands can be left half-applied; the physical state may be unknown | The contract departs from the spec's example (RI-04, RI-31); safer recovery |
| 005 | Each transition step waits for confirmation, and timing counts from the ACK | Sending a command does not prove it ran | Yellow and all-red are at least as long as configured; ACK latency stretches the cycle slightly |
| 006 | Never trust the physical state after a restart | Required by spec §12 | A restart always passes through all-red: a short pause in traffic, never an unsafe jump |
| 007 | PostgreSQL; state and audit in one transaction; commands written ahead | Consistency and recoverability | Every ACK refers to a recorded command; no dual writes |
| 008 | Hash-chained audit with INSERT-only rights for the app | "Why is the junction in this state?" must be answerable and trustworthy | Edits are detectable; full protection needs anchoring (P4) |
| 009 | Server time drives scheduling | Device clocks drift and can be manipulated | Fair waiting times; sensor time still used for staleness |
| 010 | `event_id` scoped to the source, plus a payload hash | Prevents double counting, using up another device's IDs, and silent payload changes | A clear 409 for reused IDs |
| 011 | Scoring with aging, hysteresis, starvation guard and recall | The spec asks for queue, priority, waiting time and starvation protection | Explainable decisions, audited with their scores |
| 012 | Emergency queue first come, first served, with contested turns; emergency beats manual; hold beats emergency | The spec leaves competing requests open | Bounded waiting for every emergency; humans can always stop the junction |
| 013 | Manual leases and optimistic concurrency | Disconnects and two administrators | No control flapping; stale decisions are rejected visibly |
| 014 | Mode derived from overlays and health | Avoid "previous mode" bookkeeping | Mode changes fall out of the data; fewer bugs |
| 015 | SSE for live updates | One-way updates; simplicity | Commands stay plain REST; polling as fallback |
| 016 | Server-side sessions rather than JWT for operators | Same-origin SPA; instant revocation | Session table; CSRF handled by SameSite plus a custom header |
| 017 | Per-device API keys now, mTLS later | Achievable now, upgradeable later | A clear path to P1 without changing the API |
| 018 | MQTT: QoS 1 commands, never retained, clean sessions, message expiry | Stale or replayed commands are dangerous | Reconnects rebuild state through SAFE_STOP |
| 019 | The controller simulator is a separate process | Restart and failure demos must be realistic | One more app to run; Compose handles it |

## Known limitations and next steps

- **MQTT (plan M6) is designed but not built yet**: the `ControllerGateway` port, topics, ACLs and payloads are specified in plan §13;
  only the REST simulator transport exists.
- The junction aggregate is stored as a JSONB snapshot rather than the normalized queue/emergency tables of plan §11.2 (safety
  constraints such as one pending command per junction are still real database constraints).
- No automated server integration tests yet (Testcontainers), no ESLint/dependency-cruiser rules, no CI workflow, no Dockerfiles for
  server/simulator/dashboard; the dashboard has no causal "explain" view.
- Production roadmap (plan §19): device certificates and signed commands, active/passive HA with fencing, metrics and alerting,
  IEC 62443 network zoning, SSO with MFA, analytics.

## AI / Tool Usage

Claude Code (Anthropic) was used to discuss requirements, write `plan.md`, and implement the code, tests and this README under my
direction and review. I am responsible for, and can explain, every part of the solution.
