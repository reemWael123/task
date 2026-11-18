# SLA Command Center – Support Desk Live Operations

An enterprise-grade, real-time Angular 19 command center for mission-critical support desk operations. Built with pure TypeScript, an event-driven domain architecture, regional timezone-aware business calendars, and high-performance DOM virtualization handling 5,000+ live tickets.

---

## ⚡ Quick Start (Under 5 Commands)

```bash
# 1. Install dependencies
npm install

# 2. Run comprehensive unit test suite (277 tests, 100% passing)
npm test -- --watch=false --browsers=ChromeHeadless

# 3. Start local development server
npm start
```
Navigate to `http://localhost:4200` to launch the live operations dashboard.

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────┐
│                      Angular UI                        │
│   • TicketBoard (Virtual Windowing: 5,000 tickets)     │
│   • Header (Stream Status, SLA Benchmark, Controls)    │
│   • EscalationQueue (Breached, At-Risk, P2 > 2h alerts)│
│   • TicketDetailDrawer (Metadata, SLA audit, Statuses) │
│   • AgentsPanel (Capacity meters, Live status toggles) │
│   • SlaSimulator (Day 2 Interactive Sandbox)           │
└──────────────────────────┬─────────────────────────────┘
                           │ (read-only observables / commands)
┌──────────────────────────▼─────────────────────────────┐
│                 Application Facade                     │
│                   (DeskFacade)                         │
│   • In-flight optimistic mutations & HTTP 409/500 roll │
│   • Undo reassignment history & concurrency checks     │
│   • SLA batch computation telemetry & cache            │
└────────────┬─────────────────────────────┬─────────────┘
             │ (events / snapshot)         │ (REST API)
┌────────────▼─────────────┐ ┌─────────────▼─────────────┐
│      EventPipeline       │ │      MockGateway /        │
│   • Monotonic sequence   │ │   Production Backend      │
│   • Epoch capture        │ │   • 5,000 tickets         │
│   • Reset cursor buffer  │ │   • 200/page pagination   │
│   • Gap overflow defense │ │   • Simulated latency     │
└────────────┬─────────────┘ └───────────────────────────┘
             │ (pure transitions)
┌────────────▼─────────────┐
│       EventReducer       │
│   • Immutable state tree │
│   • Invariant validation │
└──────────────────────────┘
```

---

## 🎯 Feature Highlights

1. **High-Performance Windowing Virtualization**:
   - Renders 5,000 tickets smoothly at 60 FPS without external libraries.
   - Computes visible slices based on scroll position with buffer zones.
2. **Event-Driven Resilience & Epoch Safety**:
   - Every connection captures its epoch immutably; stale callbacks from severed connections are rejected.
   - Stream reset advances cursor and safely buffers out-of-order events until atomic snapshot publication.
3. **Optimistic Mutations with Rollback**:
   - Assignments update the UI immediately with consistent agent load increments.
   - Failed requests (HTTP 409 Conflict, HTTP 500) roll back gracefully without polluting confirmed pipeline state.
   - Reconciles seamlessly with authoritative server events.
4. **Undo Reassignment with Concurrency Check**:
   - Reverts manual assignments to previous agents.
   - Validates that the ticket has not been concurrently modified by another operator or background event.
5. **Regional Business Calendars & Timezone Math**:
   - **Saudi Arabia (SA)**: Sunday–Thursday working days, `Asia/Riyadh` (UTC+3, no DST), bridging weekend shifts.
   - **Egypt (EG)**: Sunday–Thursday working days, `Africa/Cairo` with DST handling.
   - **Europe (EU)**: Monday–Friday working days, `Europe/London`.
   - **UAE (AE)**: Configurable workdays and shifts, `Asia/Dubai` (UTC+4).
6. **Day 2 SLA Policy Simulator**:
   - Interactive sandbox to test hypothetical ticket policies, shifts, weekend bridges, and 24/7 VIP rules without mutating live application state.

---

## 🧪 MockGateway Configuration

The included `MockGateway` (`src/app/data/mock-gateway.service.ts`) simulates enterprise REST APIs and real-time event streaming:

```typescript
const gateway = new MockGateway({
  totalTickets: 5000,         // Default: 5,000 tickets
  pageSize: 200,              // 25 paginated pages
  minLatencyMs: 300,          // 300-1200ms realistic network latency
  maxLatencyMs: 1200,
  failureRate: 0.05,          // 5% random failure rate
  deterministic: false,       // Set to true in unit tests for 0 latency / 0 failures
  autoEmitEvents: false       // Background stream emission
});
```

---

## 🎬 45-Minute Live Technical Review Demo Script

Use this structured walkthrough during the live technical evaluation:

### Part 1: Live Dashboard & Scale (00:00 – 08:00)
1. **Open Dashboard**: Launch `http://localhost:4200`. Observe initial hydration of 5,000 tickets across 25 paginated pages.
2. **Telemetry Header**: Show the **Stream Status** (`SYNCED`, current sequence number) and the **SLA Engine Benchmark** (`~1.2 ms` across 5,000 tickets).
3. **Smooth Virtual Scrolling**: Scroll quickly through the 5,000 tickets. Note smooth 60 FPS scrolling and low DOM element count.
4. **Multi-Facet Filtering**: Filter by `Priority: P1`, `Region: SA`, and type a search term. Notice instantaneous reactivity.

### Part 2: Urgent Escalations & Alerting (08:00 – 15:00)
1. **Escalation Queue**: View the top escalation carousel displaying breached tickets, at-risk tickets, and P2 tickets older than 2 hours without resolution.
2. **Auto-Assignment**: Click **Auto-Assign** on an unassigned escalation ticket. Point out that the best eligible agent (matching skills, shift, timezone, lowest load) is automatically assigned.

### Part 3: Optimistic Mutations, Error Rollback & Concurrency (15:00 – 25:00)
1. **Manual Reassignment**: In the ticket table, reassign a ticket from Agent Alice to Agent Bob. Notice the ticket updates immediately and Bob's load bar increments.
2. **Simulate HTTP 500 Rollback**:
   - Click the **⚠️ Force 500** toggle in the header.
   - Attempt to reassign a ticket.
   - Observe error notification: `HTTP 500: Server error`.
   - Point out that the ticket immediately rolls back to its original assignee, and agent loads are restored.
   - Toggle **Force 500** off.
3. **Simulate HTTP 409 Conflict**:
   - Click **⚡ Force 409**.
   - Attempt an assignment.
   - Observe rejection: `HTTP 409 Conflict: Version mismatch`. Rollback verified.
   - Toggle **Force 409** off.

### Part 4: Undo Reassignment with Concurrency Check (25:00 – 32:00)
1. **Successful Reassignment**: Reassign a ticket to a new agent. Notice the **↩ Undo** button appears for that ticket.
2. **Undo Action**: Click **↩ Undo**. The ticket is safely reassigned back to its original agent, and the undo button disappears.
3. **Concurrency Protection**: Reassign another ticket. Open Ticket Details and change its status (bumping version). Notice the Undo action is disabled because the ticket version changed since reassignment.

### Part 5: Stream Reset & Best-Effort Resynchronization (32:00 – 38:00)
1. **Trigger Stream Reset**: Click **🔄 Resync Stream** in the header.
2. **Epoch Transition**:
   - Header status transitions to `RESYNCING` (yellow).
   - Old stream transport is closed; pipeline epoch increments.
   - Paginated tickets and agents are fetched and validated.
   - Snapshot is published atomically; stream status returns to `SYNCED` (green).

### Part 6: Day 2 SLA Policy Simulator (38:00 – 45:00)
1. **Open Simulator**: Click **🧪 Simulator** in the header.
2. **Standard Saudi Arabia Shift**: Select `SA`, `P2`, `Standard`. Show business hours calculation in `Asia/Riyadh` (UTC+3) bridging Friday/Saturday weekend.
3. **VIP P1 24/7 Rule (Option 2B)**:
   - Change Priority to `P1` and Customer Tier to `VIP`.
   - Notice the badge: `⚡ 24/7 VIP Clock (Option 2B Active)`.
   - Set status to `pending_customer`.
   - Note that the SLA clock **never pauses** for VIP P1 tickets, demonstrating exact compliance with the TDD specifications.
