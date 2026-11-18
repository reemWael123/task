import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { Observable, Subject, defer, of, throwError, timer } from 'rxjs';
import { delay, map, switchMap } from 'rxjs/operators';

import {
  Agent,
  CustomerTier,
  DeskEvent,
  Priority,
  Region,
  Ticket,
  TicketAssigned,
  TicketCreated,
  TicketStatus,
  TicketStatusChanged
} from '../domain/models';
import { PaginatedTickets, TicketGateway } from '../application/ticket-gateway.interface';

/**
 * Configuration options for MockGateway simulation behavior.
 */
export interface MockGatewayConfig {
  readonly totalTickets?: number;
  readonly pageSize?: number;
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  readonly failureRate?: number; // e.g. 0.05 for 5% failure
  readonly deterministic?: boolean; // Set true for test environments to disable random latency/failures
  readonly autoEmitEvents?: boolean; // Auto-generate background stream events
  readonly autoEmitIntervalMs?: number;
}

export const MOCK_GATEWAY_CONFIG = new InjectionToken<MockGatewayConfig>('MOCK_GATEWAY_CONFIG');

/**
 * Standard list of mock agents across all supported regions and shifts.
 */
export const DEFAULT_MOCK_AGENTS: readonly Agent[] = [
  {
    id: 'agent-alice',
    name: 'Alice Smith',
    skills: ['billing', 'vip'],
    status: 'online',
    maxLoad: 5,
    shift: { start: '08:00', end: '16:00', tz: 'Europe/London' }
  },
  {
    id: 'agent-bob',
    name: 'Bob Jones',
    skills: ['tech', 'network'],
    status: 'online',
    maxLoad: 4,
    shift: { start: '09:00', end: '17:00', tz: 'Europe/London' }
  },
  {
    id: 'agent-charlie',
    name: 'Charlie Brown',
    skills: ['billing', 'security'],
    status: 'busy',
    maxLoad: 5,
    shift: { start: '08:00', end: '16:00', tz: 'Africa/Cairo' }
  },
  {
    id: 'agent-dana',
    name: 'Dana White',
    skills: ['escalations', 'vip'],
    status: 'online',
    maxLoad: 3,
    shift: { start: '08:00', end: '16:00', tz: 'Asia/Riyadh' }
  },
  {
    id: 'agent-elena',
    name: 'Elena Rostova',
    skills: ['tech', 'cloud'],
    status: 'online',
    maxLoad: 6,
    shift: { start: '08:00', end: '16:00', tz: 'Asia/Dubai' }
  },
  {
    id: 'agent-farooq',
    name: 'Farooq Al-Mansoor',
    skills: ['billing', 'arabic'],
    status: 'offline',
    maxLoad: 5,
    shift: { start: '08:00', end: '16:00', tz: 'Asia/Riyadh' }
  }
];

/**
 * Generates the deterministic 5,000 ticket dataset required by the TDD.
 */
export function generateMockTickets(count = 5000): Ticket[] {
  const regions: Region[] = ['EG', 'AE', 'SA', 'EU'];
  const priorities: Priority[] = ['P1', 'P2', 'P3', 'P4'];
  const statuses: TicketStatus[] = ['open', 'pending_customer', 'on_hold', 'resolved'];
  const tiers: CustomerTier[] = ['standard', 'vip'];
  const skillsPool = ['billing', 'tech', 'network', 'security', 'escalations', 'vip'];

  const baseTime = new Date('2026-11-18T06:00:00.000Z').getTime();
  const tickets: Ticket[] = [];

  for (let i = 1; i <= count; i++) {
    const id = `ticket-${i}`;
    const priority = priorities[(i - 1) % priorities.length];
    const region = regions[(i - 1) % regions.length];
    const customerTier = tiers[(i - 1) % tiers.length];
    const status = statuses[(i - 1) % statuses.length];

    // Creation timestamp spread over previous 48 hours
    const createdOffsetMs = ((i * 37) % (48 * 3600)) * 1000;
    const createdAt = new Date(baseTime - createdOffsetMs).toISOString();

    const ticketSkills = [skillsPool[(i - 1) % skillsPool.length]];
    if (i % 3 === 0) {
      ticketSkills.push(skillsPool[(i + 1) % skillsPool.length]);
    }

    const statusHistory = [{ status, at: createdAt }];
    let assigneeId: string | undefined;

    // Distribute some initial assignments
    if (status !== 'resolved' && i % 4 !== 0) {
      const agentIndex = (i - 1) % DEFAULT_MOCK_AGENTS.length;
      assigneeId = DEFAULT_MOCK_AGENTS[agentIndex].id;
    }

    tickets.push({
      id,
      version: 1,
      priority,
      status,
      customerTier,
      region,
      skills: ticketSkills,
      createdAt,
      assigneeId,
      statusHistory
    });
  }

  return tickets;
}

/**
 * MockGateway simulates the remote REST backend and real-time event streaming server.
 * Implements TicketGateway.
 */
@Injectable({
  providedIn: 'root'
})
export class MockGateway implements TicketGateway {
  private readonly _tickets = new Map<string, Ticket>();
  private readonly _agents = new Map<string, Agent>();
  private readonly _eventStream$ = new Subject<{ event: DeskEvent; epochOverride?: number }>();

  private readonly _config: Required<MockGatewayConfig>;
  private _nextSeq = 1;
  private _nextEventId = 1;
  private _streamActiveCount = 0;

  // Test control overrides
  public forceHttp500 = false;
  public forceHttp409 = false;

  constructor(@Optional() @Inject(MOCK_GATEWAY_CONFIG) config?: MockGatewayConfig) {
    this._config = {
      totalTickets: config?.totalTickets ?? 5000,
      pageSize: config?.pageSize ?? 200,
      minLatencyMs: config?.minLatencyMs ?? 300,
      maxLatencyMs: config?.maxLatencyMs ?? 1200,
      failureRate: config?.failureRate ?? 0.05,
      deterministic: config?.deterministic ?? false,
      autoEmitEvents: config?.autoEmitEvents ?? false,
      autoEmitIntervalMs: config?.autoEmitIntervalMs ?? 3000
    };

    // Populate initial agents
    for (const agent of DEFAULT_MOCK_AGENTS) {
      this._agents.set(agent.id, { ...agent });
    }

    // Populate mock tickets
    const generated = generateMockTickets(this._config.totalTickets);
    for (const t of generated) {
      this._tickets.set(t.id, t);
    }
  }

  /**
   * Returns current active connection count.
   */
  public get activeConnectionCount(): number {
    return this._streamActiveCount;
  }

  /**
   * Resets mock data to initial baseline.
   */
  public reset(count?: number): void {
    this._tickets.clear();
    const generated = generateMockTickets(count ?? this._config.totalTickets);
    for (const t of generated) {
      this._tickets.set(t.id, t);
    }
    this._nextSeq = 1;
    this._nextEventId = 1;
    this.forceHttp409 = false;
    this.forceHttp500 = false;
  }

  /**
   * Fetches paginated page of tickets with simulated latency and failure rate.
   */
  public getTickets(page = 1, pageSize = this._config.pageSize): Observable<PaginatedTickets> {
    return defer(() => {
      if (this.forceHttp500 || this.shouldSimulateFailure()) {
        return throwError(() => new Error(`HTTP 500: Failed to fetch tickets page ${page}`));
      }

      const allTickets = Array.from(this._tickets.values());
      const total = allTickets.length;
      const startIndex = (page - 1) * pageSize;
      const pageTickets = allTickets.slice(startIndex, startIndex + pageSize);
      const totalPages = Math.ceil(total / pageSize);

      const result: PaginatedTickets = {
        tickets: pageTickets,
        total,
        page,
        pageSize,
        totalPages
      };

      const latency = this.resolveLatency();
      return latency > 0 ? of(result).pipe(delay(latency)) : of(result);
    });
  }

  /**
   * Fetches all registered agents.
   */
  public getAgents(): Observable<readonly Agent[]> {
    return defer(() => {
      if (this.forceHttp500 || this.shouldSimulateFailure()) {
        return throwError(() => new Error('HTTP 500: Failed to fetch agents'));
      }

      const agentsList = Array.from(this._agents.values());
      const latency = this.resolveLatency();
      return latency > 0 ? of(agentsList).pipe(delay(latency)) : of(agentsList);
    });
  }

  /**
   * Connects to the real-time event stream.
   * Captures the connection epoch immutably at creation time.
   */
  public getEventStream(epoch = 1): Observable<{ event: DeskEvent; epoch: number }> {
    return new Observable(subscriber => {
      this._streamActiveCount++;

      // Forward stream events with the immutable connection epoch
      const sub = this._eventStream$.subscribe(payload => {
        // Tag with the captured epoch for this specific connection, unless explicitly overridden
        subscriber.next({
          event: payload.event,
          epoch: payload.epochOverride !== undefined ? payload.epochOverride : epoch
        });
      });

      // Teardown logic
      return () => {
        this._streamActiveCount = Math.max(0, this._streamActiveCount - 1);
        sub.unsubscribe();
      };
    });
  }

  /**
   * Programmatically emits an event through the mock event stream.
   */
  public emitEvent(event: DeskEvent, epochOverride?: number): void {
    this._eventStream$.next({
      event,
      epochOverride
    });
  }

  /**
   * Manually assigns a ticket to an agent with optimistic concurrency control (HTTP 409)
   * and simulated 500 server error handling.
   */
  public assignTicket(ticketId: string, agentId: string, version: number): Observable<Ticket> {
    return defer(() => {
      if (this.forceHttp500 || this.shouldSimulateFailure()) {
        return throwError(() => new Error(`HTTP 500: Server error while assigning ticket '${ticketId}'`));
      }

      const existing = this._tickets.get(ticketId);
      if (!existing) {
        return throwError(() => new Error(`HTTP 404: Ticket '${ticketId}' not found`));
      }

      // Concurrency check (HTTP 409 Conflict)
      if (this.forceHttp409 || existing.version !== version) {
        return throwError(
          () =>
            new Error(
              `HTTP 409 Conflict: Version mismatch for ticket '${ticketId}'. Expected version ${existing.version}, received ${version}.`
            )
        );
      }

      // Update mock storage
      const updatedTicket: Ticket = {
        ...existing,
        assigneeId: agentId,
        version: existing.version + 1
      };
      this._tickets.set(ticketId, updatedTicket);

      // Auto-broadcast TicketAssigned event on stream
      const assignEvent: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: `evt-assign-${this._nextEventId++}`,
        seq: this._nextSeq++,
        ticketId,
        agentId,
        version: updatedTicket.version
      };
      this.emitEvent(assignEvent);

      const latency = this.resolveLatency();
      return latency > 0 ? of(updatedTicket).pipe(delay(latency)) : of(updatedTicket);
    });
  }

  /**
   * Updates an agent's status (online, busy, offline) and broadcasts AgentStatusChanged event.
   */
  public updateAgentStatus(agentId: string, status: Agent['status']): Observable<Agent> {
    return defer(() => {
      const existing = this._agents.get(agentId);
      if (!existing) {
        return throwError(() => new Error(`HTTP 404: Agent '${agentId}' not found`));
      }

      const updatedAgent: Agent = {
        ...existing,
        status
      };
      this._agents.set(agentId, updatedAgent);

      this.emitEvent({
        type: 'AgentStatusChanged',
        eventId: `evt-agent-${this._nextEventId++}`,
        seq: this._nextSeq++,
        agentId,
        status
      });

      return of(updatedAgent);
    });
  }

  /**
   * Updates a ticket's status and broadcasts TicketStatusChanged event.
   */
  public updateTicketStatus(
    ticketId: string,
    status: TicketStatus,
    at = new Date().toISOString()
  ): Observable<Ticket> {
    return defer(() => {
      const existing = this._tickets.get(ticketId);
      if (!existing) {
        return throwError(() => new Error(`HTTP 404: Ticket '${ticketId}' not found`));
      }

      const updatedHistory = [...existing.statusHistory, { status, at }];
      const resolvedAt = status === 'resolved' ? at : existing.resolvedAt;

      const updatedTicket: Ticket = {
        ...existing,
        status,
        resolvedAt,
        statusHistory: updatedHistory,
        version: existing.version + 1
      };
      this._tickets.set(ticketId, updatedTicket);

      this.emitEvent({
        type: 'TicketStatusChanged',
        eventId: `evt-status-${this._nextEventId++}`,
        seq: this._nextSeq++,
        ticketId,
        status,
        at
      });

      return of(updatedTicket);
    });
  }

  /**
   * Emits a StreamReset event to test resynchronization.
   */
  public triggerStreamReset(seq: number, epoch?: number): void {
    this.emitEvent(
      {
        type: 'StreamReset',
        eventId: `evt-reset-${this._nextEventId++}`,
        seq
      },
      epoch
    );
  }

  private resolveLatency(): number {
    if (this._config.deterministic) {
      return 0;
    }
    const { minLatencyMs, maxLatencyMs } = this._config;
    return Math.floor(Math.random() * (maxLatencyMs - minLatencyMs + 1)) + minLatencyMs;
  }

  private shouldSimulateFailure(): boolean {
    if (this._config.deterministic) {
      return false;
    }
    return Math.random() < this._config.failureRate;
  }
}
