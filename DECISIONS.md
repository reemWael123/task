# Architectural Decisions & Production Integration Blueprint

This document details the architectural decisions, domain contracts, mathematical models, and production backend integration blueprint for the **SLA Command Center – Support Desk Live Operations** application.

---

## 1. Domain Architecture & Layer Separation

The application adheres to clean architecture principles with strict layer boundaries:

```
┌────────────────────────────────────────────────────────┐
│                      Angular UI                        │
│  (TicketBoard, Header, EscalationQueue, DetailDrawer)  │
└──────────────────────────┬─────────────────────────────┘
                           │ (observables / actions)
┌──────────────────────────▼─────────────────────────────┐
│                 Application Facade                     │
│                   (DeskFacade)                         │
│  - In-flight optimistic mutations & rollback           │
│  - Undo reassignment history with concurrency check    │
│  - SLA performance caching & benchmark telemetry       │
└────────────┬─────────────────────────────┬─────────────┘
             │ (events / snapshot)         │ (REST API)
┌────────────▼─────────────┐ ┌─────────────▼─────────────┐
│      EventPipeline       │ │      TicketGateway        │
│  - Epoch validation      │ │  - Paginated GET /tickets │
│  - Sequence gap buffer   │ │  - GET /agents            │
│  - Reset cursor tracking │ │  - POST /assign           │
│  - Replay / Parked queue │ │  - Event stream transport │
└────────────┬─────────────┘ └───────────────────────────┘
             │ (pure state transitions)
┌────────────▼─────────────┐
│       EventReducer       │
│  - Immutable state tree  │
│  - Invariant validation  │
└──────────────────────────┘
```

### Key Responsibilities:
1. **EventReducer** (`src/app/domain/event-reducer/`): Pure functional state reducer. Given `(currentState, event, now)`, computes the next `ReducerDeskState`. Enforces strict domain invariants (e.g. `agentLoad` never drops below 0, idempotent duplicate discard).
2. **EventPipeline** (`src/app/domain/event-pipeline/`): Coordinates real-time transport sequencing. Handles sequence monotonicity, out-of-order buffering, duplicate event detection, stream reset boundaries, and atomic snapshot publication.
3. **DeskFacade** (`src/app/application/desk.facade.ts`): Coordinates application-level state. Manages in-flight optimistic mutations, overlays pending API updates on confirmed pipeline state, records reassignment history for undo, and computes SLA benchmarks.
4. **TicketGateway** (`src/app/application/ticket-gateway.interface.ts`): Formal contract for backend REST endpoints and event stream transport.

---

## 2. Real-Time Transport & Event Sequencing Contract

### Connection Epochs & Lifecycle
Real-time connections (WebSocket / Server-Sent Events) are inherently ephemeral. When network disruptions occur or the backend triggers a `StreamReset`, stream sequencing restarts.

To prevent stale connection events from polluting new stream epochs:
1. **Immutable Epoch Capture**:
   - `EventPipeline` tracks `_currentEpoch` (starts at 1).
   - Upon connection, `DeskFacade` reads `pipeline.getEpoch()` and calls `gateway.getEventStream(epoch)`.
   - The connection subscription tags every received event payload with that immutable connection epoch for its entire lifetime: `{ event, epoch }`.
   - `EventPipeline.handleEvent(event, epoch)` discards any event where `epoch !== this._currentEpoch`.
2. **Reconnection on StreamReset**:
   - When a `StreamReset(seq)` event arrives, `EventPipeline` enters `resyncing` status and increments `_currentEpoch`.
   - `DeskFacade` observes `pipeline.syncStatus$ === 'resyncing'`.
   - `DeskFacade.connectEventStream()` unsubscribes and closes the old transport connection, captures the newly incremented epoch, and establishes the fresh subscription.
   - Exactly one active subscription exists (`_streamSubscription`).

### Sequence Gap Detection During Pending Reset
When a `StreamReset(pendingResetSeq)` arrives:
- `EventPipeline` captures `pendingResetSeq`.
- Incoming events with `seq <= pendingResetSeq` are immediately discarded.
- Incoming events with `seq > pendingResetSeq` are held in `sequenceBuffer`.
- Gap detection while resync is pending uses `expectedSeq = Math.max(lastBufferedSeq + 1, pendingResetSeq + 1)`.
- If a sequence gap exceeds `maxGapDistance` (100) or buffer exceeds `maxBufferSize` (1,000), a `GapOverflow` event is emitted.
- When `syncSnapshot(snapshot)` arrives, the cursor advances to `snapshot.lastSeq`, events covered by the snapshot (`seq <= snapshot.lastSeq`) are discarded, and contiguous buffered events drain atomically into `EventReducer`.

---

## 3. Optimistic Mutations, Rollback, and Authoritative Reconciliation

### Problem Statement
In high-throughput support desks, dispatchers cannot wait 300–1200ms for network roundtrips to see ticket assignment changes. However, concurrent mutations or server rejections (HTTP 409 Conflict, HTTP 500 Server Error) must never leave the UI in an inconsistent state.

### Implementation Strategy
1. **Pending Mutation Layer**:
   - Optimistic mutations are held exclusively in `DeskFacade._mutations`, completely isolated from `EventPipeline.state`.
   - Each mutation receives a monotonic `mutationId`.
   - `DeskFacade.recomputeState()` overlays active mutations on top of authoritative pipeline state:
     - Updates ticket assignee and version (`version = previousVersion + 1`).
     - Adjusts `agentLoad` by exactly 1 per ticket relative to `baseTicket`, avoiding double-counting.
2. **Authoritative Reconciliation**:
   - When HTTP 200 returns, mutation transitions to `status: 'api-confirmed'` with the server's returned ticket.
   - When authoritative `TicketAssigned` stream event arrives from the backend, `EventPipeline` updates `state.tickets[ticketId].version`.
   - In `recomputeState()`, once `baseTicket.version >= mutation.optimisticVersion`, the overlay is retired (`_mutations.delete(ticketId)`).
   - If no stream event arrives, the API-confirmed overlay remains active without leaving the mutation stuck in 'pending'.
3. **Rollback & Concurrency Protection**:
   - On HTTP 409 or 500, `DeskFacade` deletes the mutation and recomputes state, automatically restoring the previous assignee and agent loads.
   - If a newer mutation occurred for the same ticket while the first request was in-flight, the stale response is ignored (`active.mutationId !== mutationId`), preventing older failures from reverting newer assignments.

---

## 4. Undo Reassignment with Concurrency Check

### Requirement
Allow the operator to undo the most recent manual reassignment for a ticket, with optimistic concurrency check ensuring the ticket hasn't been modified since.

### Solution
- When `assignTicket(ticketId, agentId)` is called:
  - If `previousAssignee` exists and differs from `agentId`, a `ReassignmentRecord` is created:
    ```ts
    { ticketId, previousAssignee, targetAgentId, assignedVersion: optimisticVersion, timestamp }
    ```
- `canUndoReassignment(ticketId)`:
  - Verifies record exists.
  - Verifies `currentTicket.version === record.assignedVersion`.
  - Verifies `currentTicket.assigneeId === record.targetAgentId`.
  - Returns `false` if an external event (status change, server edit) bumped the version.
- `undoReassignment(ticketId)`:
  - Validates concurrency check.
  - Deletes history record.
  - Calls `assignTicket(ticketId, record.previousAssignee)`.

---

## 5. Regional Business Calendars & Timezone Math

Four regional calendars are configured:
1. **Egypt (EG)**:
   - Workweek: Sunday – Thursday.
   - Weekend: Friday & Saturday.
   - Timezone: `Africa/Cairo` (UTC+2 in winter, UTC+3 in summer with DST).
2. **Saudi Arabia (SA)**:
   - Workweek: Sunday – Thursday.
   - Weekend: Friday & Saturday.
   - Timezone: `Asia/Riyadh` (UTC+3, no DST).
   - Verified bridging across Thursday 15:00 to Sunday 09:00 Riyadh time.
3. **Europe (EU)**:
   - Workweek: Monday – Friday.
   - Weekend: Saturday & Sunday.
   - Timezone: `Europe/London` (or customizable).
4. **United Arab Emirates (AE)**:
   - Configurable workdays (supports modern Mon–Fri public sector or Sun–Thu private sector).
   - Timezone: `Asia/Dubai` (UTC+4, no DST).

Shifts are defined explicitly as `{ start: '08:00', end: '16:00' }` or `{ start: '09:00', end: '17:00' }`. Calendar calculations calculate elapsed business minutes by iterating minute-precise active shift intervals across working days, fully excluding weekends and holidays.

---

## 6. SLA Policy Engine & VIP Rules

### Policy Configuration:
- **P1**: First Response 15m, Resolution 120m, VIP Multiplier 0.5.
- **P2**: First Response 30m, Resolution 240m, VIP Multiplier 0.75.
- **P3**: First Response 60m, Resolution 480m, VIP Multiplier 1.0.
- **P4**: First Response 120m, Resolution 960m, VIP Multiplier 1.0.

### SLA Rules & State Machine:
- **States**: `ok` (elapsed < 70%), `at_risk` (elapsed ≥ 70% and ≤ 100%), `breached` (elapsed > 100%), `paused`.
- **Paused Intervals**: Non-VIP tickets in `pending_customer` or `on_hold` pause the SLA clock. Paused intervals are summed and deducted from elapsed time, extending `dueAt`.
- **Day 2 P1 VIP 24/7 Rule (Option 2B)**:
  - Critical VIP tickets (P1 VIP) are emergency 24/7 events.
  - Target time is calculated in continuous wall-clock minutes (ignoring calendar shifts and weekends).
  - SLA clock **never pauses**, even if status is set to `pending_customer`.

---

## 7. High-Volume Performance: Virtual Windowing & SLA Telemetry

### Scale Challenge: 5,000 Tickets
Rendering 5,000 table rows with badges and actions causes severe browser DOM bloat (~50,000 DOM nodes), leading to frame drops during scrolling and streaming updates.

### Pure Angular Windowing Virtualization:
- Row height: `48px`.
- Viewport tracks container `scrollTop` and `clientHeight`.
- Only renders visible slice (`~18-25` rows) plus 8 buffer rows above and below.
- Top and bottom spacers match `totalVirtualHeight = filteredTickets.length * 48px`, providing smooth native browser scrollbar behavior without third-party dependencies.

### SLA Recomputation Benchmark:
- Resolved tickets have static SLA results. `DeskFacade` caches calculated SLA results by `ticketId + version`.
- Execution time measured via `performance.now()`.
- State exposes `slaBenchmark: { executionTimeMs, ticketCount, timestamp }`.
- Header displays live engine speed (typically `< 2 ms` for 5,000 tickets).

---

## 8. Production Backend Integration Blueprint

When replacing `MockGateway` with a real enterprise backend:

### A. Transport Protocol
- **Transport**: Server-Sent Events (SSE) or WebSocket via STOMP/WAMP.
- **Header**: `Authorization: Bearer <token>` and `X-Client-Epoch: <epoch>`.
- **Heartbeat**: 15-second ping/pong. If no heartbeat within 30 seconds, close transport and trigger reconnection.
- **Backoff**: Exponential backoff (1s, 2s, 4s, 8s, up to 30s) on disconnection.

### B. Endpoints Specification
- `GET /api/v1/tickets?page={page}&pageSize=200`: Paginated ticket query with total count.
- `GET /api/v1/agents`: Full agent roster with current status and shifts.
- `POST /api/v1/tickets/{id}/assign`: Body `{ agentId, expectedVersion }`. Returns HTTP 200 with updated ticket, HTTP 409 on version conflict, or HTTP 404/500.
- `PATCH /api/v1/tickets/{id}/status`: Body `{ status }`.
- `PATCH /api/v1/agents/{id}/status`: Body `{ status }`.
- `GET /api/v1/events/stream`: Real-time stream delivering JSON events with monotonic sequence numbers.
