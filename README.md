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

**Full stack in containers** (server, simulator and dashboard behind nginx on http://localhost:8088), after the seed step above:

```bash
docker compose --profile app up -d --build
```

**MQTT transport** (TLS on 8883, per-device users and ACLs, plan §13):

```bash
npm run certs:dev                        # dev CA + broker certificate (OpenSSL runs in a container)
npm run mqtt:users                       # broker users, passwords and ACLs from the device registry -> .mqtt-creds.env
docker compose --profile mqtt up -d mosquitto
CONTROLLER_TRANSPORT=mqtt npm start -w @ftms/controller-sim
CONTROLLER_TRANSPORT=mqtt npm start -w @ftms/server
npx tsx scripts/mqtt-check.ts            # ACL denial, topic binding and command expiry checks
```

Demo users (from `.env`): `operator` / `operator-password-123` (can control and simulate), `admin` / `admin-password-123`,
`viewer` / `viewer-password-123` (read-only).

| Command | What it does |
|---|---|
| `npm test` | Domain unit, rule, scenario and property-based tests (Vitest + fast-check) |
| `npm run test:coverage` | The same with the domain coverage gate (>= 90 % lines and branches) |
| `npm run test:integration` | Server integration tests on a throwaway PostgreSQL (Testcontainers; needs Docker) |
| `npx vitest run packages/domain/test/domain.test.ts -t "preempts"` | Run a single test |
| `npm run scenario -- <1..9 or all>` | Demonstrate the spec §15 scenarios against the running stack |
| `npm run traffic -- [per minute] [truck share]` | Background traffic: random arrivals, and clearances on green approaches |
| `npm run postman` | Regenerate the Postman collection and environment in `docs/` |
| `npm run openapi:export -w @ftms/server` | Write `docs/openapi.json` (Swagger UI is served at http://localhost:8080/docs) |
| `FTMS_NEW_PASSWORD=... npm run create-user -w @ftms/server -- <name> <ROLE> [--simulation]` | Create or update an operator account |
| `npm run create-device-key -w @ftms/server -- <device_id> <SENSOR\|CONTROLLER> <junction> [approach]` | Issue or rotate a device key (printed once) |
| `npm run lint` | oxlint (with the domain purity bans) and the architecture rules (dependency-cruiser) |
| `npm run typecheck` | Typecheck every package |
| `npm run audit:verify -w @ftms/server` | Recompute the audit hash chains and report tampering |

## Architecture

A modular monolith with ports and adapters (plan §2):

```
REST / MQTT    →  HTTP / MQTT adapters   →  Application: one actor (mailbox) per junction  →  Domain decide()  (pure)
                                                  │                                              │
                                                  ├── PostgreSQL store (snapshot + hash-chained audit, one transaction per decision)
                                                  └── ControllerGateway port → REST or MQTT (CONTROLLER_TRANSPORT) → controller simulator
```

| Path | Role |
|---|---|
| `packages/domain` | The traffic engine. No dependencies, no I/O, no clock: `decide(ctx, state, input)` returns the new state, effects, audit records and an outcome. Contains config validation, the independent safety guard, the scheduler and the state machine. |
| `packages/sim-core` | Physical controller model with its own conflict monitor and local SAFE_STOP clearance. Used by the simulator and by the property tests as "the physical world". |
| `apps/server` | `application/` (actors, runtime, status view, ports), `contracts/` (zod schemas and wire mappers shared by HTTP and MQTT), `adapters/` (HTTP, PostgreSQL, security, REST and MQTT controller transports). |
| `apps/controller-sim` | Controller simulator process with fault switches (drop ACKs, NACK, wrong state, offline, unsafe heartbeat, device status), over REST or MQTT. |
| `apps/web` | React dashboard: live view over SSE, intersection diagram (desired vs confirmed), controls, simulation panel, activity feed. |

The layer rules of plan §2.3 are enforced by `npm run lint`: the domain may not import anything (and may not use `Date`, timers or
`Math.random`), the application may not import adapters, `pg`, Fastify or MQTT, and adapters may not depend on each other at runtime.

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
| GET | `/api/junctions/:id/history?limit&before&type&direction&from&to`, `/api/junctions/:id/alerts` | VIEWER | audit log, newest first |
| GET | `/api/junctions/:id/explain` | VIEWER | why the junction is in its current state: the last confirmed command, the decision that requested it (rule, scores) and its trigger; also the "Why this state?" button on the dashboard |
| GET | `/api/stream` | VIEWER | Server-Sent Events: `status` (bursts merged to 5/s) and `audit` with `id: <junction>:<seq>`; a reconnect with `Last-Event-ID` replays missed audit entries. At most 5 streams per session and 200 in total |
| POST | `/api/sensor-events` | sensor device key | 201 first time, 200 `duplicate:true` for an identical repeat, 409 if the same `event_id` has a different payload, 403 if the device is not bound to that junction/direction, 422 invalid |
| POST | `/api/controller-events` | controller device key | ACK / NACK / FAILED / HEARTBEAT / DEVICE_STATUS (type inferred if omitted; the spec's `actual_state` ACK shorthand is accepted) |
| POST | `/api/admin/users` | ADMIN | create a user (409 if it exists) |
| POST | `/api/admin/devices`, DELETE `/api/admin/devices/:id` | ADMIN | issue (shown once) and revoke device keys |
| GET | `/docs` | public in development, ADMIN in production | Swagger UI generated from the zod contracts |
| * | `/api/sim/*` | OPERATOR with simulation permission | only registered when `SIMULATION_MODE=true` |
| GET | `/api/health/live`, `/api/health/ready` | public | readiness is false until recovery has run (and, with MQTT, while the broker is disconnected) |

State-changing operator requests must send `x-ftms-request: 1` (CSRF protection). Devices authenticate with
`Authorization: Bearer <key>` (keys for the demo are in `.sim-keys.env`). The controller contract (commands with `seq`, `epoch`,
`expires_at`; ACKs with full aspects) is in plan §8.2.

**Postman:** import `docs/ftms.postman_collection.json` and `docs/ftms.postman_environment.json`, paste the device keys from
`.sim-keys.env` into the environment, and run "00 Setup" first. There is one folder per spec §15 scenario; every request has a
status-code test, and the whole collection runs green with `npx newman run docs/ftms.postman_collection.json -e <env>`.

**MQTT topics** (`CONTROLLER_TRANSPORT=mqtt`, plan §13): `ftms/v1/junctions/{id}/controller/{commands|acks|heartbeat|status}`,
`ftms/v1/junctions/{id}/devices/status`, `ftms/v1/junctions/{id}/sensors/{approach}/events` and the retained
`ftms/v1/backend/status`. Payloads are the same JSON as the REST bodies and are validated the same way; a payload whose junction or
direction does not match its topic is dead-lettered. Commands are QoS 1, never retained, and carry an MQTT 5 message expiry; clients
use clean sessions, so nothing is replayed after a reconnect. The controller's last will (`OFFLINE`) marks it offline at once.

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

`npm test` runs 78 domain tests: config validation (V-1..V-8), the safety guard, rule tests for controller messages (shorthand, NACK,
unsafe report, duplicate/late ACKs, heartbeat mismatch), device status, sensor streams (sequence resets and gaps, clock skew,
capacity, moved vehicles), emergencies (refresh, stale, cooldown, limit, rotation, timeout), operator commands and leases, the
scheduler (rest, starvation, max green), the state machine scenarios (startup, restart mid-transition, gap-out, emergency, manual,
stale versions, missing ACKs, offline/reconnect, wrong state + operator resume, concurrency) and
**property-based tests** that throw hundreds of random sequences of events, commands, controller faults and time jumps at the domain
running against the physical controller model, and assert after every physical change that conflicting directions were never
permissive together, clearance and yellow durations were respected, the guard never tripped, queues stayed consistent, and processing
is deterministic. Domain coverage is 99.8 % of lines and 95.6 % of branches (`npm run test:coverage` fails below 90 %).

`npm run test:integration` runs 26 tests against a real PostgreSQL in a container: the authentication and authorization matrix (401,
viewer 403, CSRF, device binding, controller key on the sensor route), sensor de-duplication (201/200/409), validation (422),
unknown-command ACKs, stale versions, strict command schemas, emergency vs manual, `Idempotency-Key` replay, the database guarantees
(the app role cannot UPDATE or DELETE `audit_log`, one PENDING command per junction, tamper detection by the hash chain), restart
recovery with a command pending (ABANDONED, higher epoch, SAFE_STOP first), simulation routes returning 404 when disabled, admin user and device-key management (a revoked key gets 401), history filters,
the explain endpoint, the OpenAPI document, and SSE streaming with `Last-Event-ID` replay over a real socket.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, the coverage gate, the web build, `npm audit --audit-level=high`, the
integration tests and the container image builds.

## Security notes

Built: operator login (argon2id, server-side sessions, lockout after 5 failures, role checks), CSRF header + Origin check, per-device
keys stored as HMAC and bound to junction and direction, rate limits, strict validation for operator commands, dead-letter for
rejected device events, simulation routes only in simulation mode (and refused in production), an append-only hash-chained audit log
with a verification script, a single-instance database lock and epoch fencing for controller commands. The full STRIDE threat register
and residual risks are in plan §14.