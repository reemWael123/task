import { Inject, Injectable, InjectionToken, OnDestroy, Optional } from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  forkJoin,
  Observable,
  of,
  Subject,
  Subscription,
  throwError
} from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  map,
  switchMap,
  takeUntil
} from 'rxjs/operators';

import {
  Agent,
  BusinessCalendar,
  DeskEvent,
  DeskState,
  Priority,
  Region,
  ShiftWindow,
  SlaPolicy,
  Ticket,
  TicketStatus
} from '../domain/models';
import {
  DeskSnapshot,
  EventPipeline,
  PipelineSyncStatus
} from '../domain/event-pipeline';
import { calculateSla, SlaCalculationResult } from '../domain/sla';
import {
  assignTicket,
  AssignmentResult,
  findBestAgent
} from '../domain/assignment';
import {
  createEgyptCalendar,
  createEuropeCalendar,
  createSaudiCalendar,
  createUaeCalendar
} from '../domain/calendar/regional-calendars';

import {
  ApplicationState,
  createInitialApplicationState,
  SlaBenchmarkMetrics
} from './application-state';
import {
  PaginatedTickets,
  TICKET_GATEWAY,
  TicketGateway
} from './ticket-gateway.interface';

/**
 * Default SLA policies matching standard project specifications.
 */
export const DEFAULT_SLA_POLICIES: Readonly<Record<Priority, SlaPolicy>> = {
  P1: { priority: 'P1', firstResponseMins: 15, resolutionMins: 120, vipMultiplier: 0.5 },
  P2: { priority: 'P2', firstResponseMins: 30, resolutionMins: 240, vipMultiplier: 0.75 },
  P3: { priority: 'P3', firstResponseMins: 60, resolutionMins: 480, vipMultiplier: 1.0 },
  P4: { priority: 'P4', firstResponseMins: 120, resolutionMins: 960, vipMultiplier: 1.0 }
};

/**
 * Creates default regional business calendars with standard 08:00–16:00 shifts.
 */
export function createDefaultCalendars(): Readonly<Record<Region, BusinessCalendar>> {
  const defaultShifts: readonly ShiftWindow[] = [{ start: '08:00', end: '16:00' }];
  return {
    EG: createEgyptCalendar(defaultShifts),
    SA: createSaudiCalendar(defaultShifts),
    EU: createEuropeCalendar(defaultShifts),
    AE: createUaeCalendar([0, 1, 2, 3, 4], defaultShifts)
  };
}

/**
 * Configuration options for DeskFacade SLA calculation.
 */
export interface SlaConfig {
  readonly policies?: Readonly<Record<Priority, SlaPolicy>>;
  readonly calendars?: Readonly<Record<Region, BusinessCalendar>>;
  readonly clock?: () => Date;
}

export const SLA_CONFIG = new InjectionToken<SlaConfig>('SLA_CONFIG');

/**
 * Mutation lifecycle status.
 * 'pending': In-flight optimistic mutation awaiting API response.
 * 'api-confirmed': API responded successfully; awaiting or reconciled with authoritative stream event.
 */
export type MutationStatus = 'pending' | 'api-confirmed';

/**
 * Tracks an in-flight optimistic or API-confirmed assignment mutation.
 * Stored exclusively in DeskFacade to prevent polluting confirmed EventPipeline state.
 */
export interface AssignmentMutation {
  readonly mutationId: number;
  readonly ticketId: string;
  readonly previousAssignee?: string;
  readonly previousVersion: number;
  readonly targetAgentId: string;
  readonly optimisticVersion: number;
  readonly status: MutationStatus;
  readonly confirmedTicket?: Ticket;
}

/**
 * Historical record of a manual reassignment for concurrency-safe undo operations.
 */
export interface ReassignmentRecord {
  readonly ticketId: string;
  readonly previousAssignee: string;
  readonly targetAgentId: string;
  readonly assignedVersion: number;
  readonly assignedStatus: TicketStatus;
  readonly timestamp: number;
}

/**
 * DeskFacade coordinates application state, integrates with EventPipeline,
 * facilitates TicketGateway communication, and provides read-only reactive
 * observables for Angular UI components.
 */
@Injectable({
  providedIn: 'root'
})
export class DeskFacade implements OnDestroy {
  private readonly _destroy$ = new Subject<void>();
  private readonly _state$: BehaviorSubject<ApplicationState>;
  private readonly _clock: () => Date;
  private readonly _policies: Readonly<Record<Priority, SlaPolicy>>;
  private readonly _calendars: Readonly<Record<Region, BusinessCalendar>>;

  // Mutation tracking layer (isolated from EventPipeline)
  private readonly _mutations = new Map<string, AssignmentMutation>();
  private _nextMutationId = 0;

  // Historical reassignment log for undo operations
  private readonly _reassignmentHistory = new Map<string, ReassignmentRecord>();

  // Performance SLA cache for resolved tickets
  private readonly _slaCache = new Map<string, { version: number; result: SlaCalculationResult }>();

  // Single active stream subscription reference (duplicate prevention & lifecycle management)
  private _streamSubscription: Subscription | null = null;

  // Public Read-Only Observables (Selectors)
  public readonly state$: Observable<ApplicationState>;
  public readonly tickets$: Observable<readonly Ticket[]>;
  public readonly ticketMap$: Observable<Readonly<Record<string, Ticket>>>;
  public readonly agents$: Observable<readonly Agent[]>;
  public readonly agentMap$: Observable<Readonly<Record<string, Agent>>>;
  public readonly agentLoad$: Observable<Readonly<Record<string, number>>>;
  public readonly slaStatus$: Observable<Readonly<Record<string, SlaCalculationResult>>>;
  public readonly benchmark$: Observable<SlaBenchmarkMetrics | null>;
  public readonly isLoading$: Observable<boolean>;
  public readonly error$: Observable<string | null>;
  public readonly syncStatus$: Observable<PipelineSyncStatus>;
  public readonly lastSeq$: Observable<number>;

  private readonly pipeline: EventPipeline;

  constructor(
    @Optional() pipeline?: EventPipeline,
    @Optional() @Inject(TICKET_GATEWAY) private readonly gateway?: TicketGateway,
    @Optional() @Inject(SLA_CONFIG) config?: SlaConfig
  ) {
    this.pipeline = pipeline ?? new EventPipeline();
    this._clock = config?.clock ?? (() => new Date());
    this._policies = config?.policies ?? DEFAULT_SLA_POLICIES;
    this._calendars = config?.calendars ?? createDefaultCalendars();

    const initialState = createInitialApplicationState(this.pipeline.state.agents);
    this._state$ = new BehaviorSubject<ApplicationState>(initialState);
    this.state$ = this._state$.asObservable();

    // Derived granular selectors with distinct emissions
    this.tickets$ = this.state$.pipe(
      map(s => s.ticketList),
      distinctUntilChanged()
    );
    this.ticketMap$ = this.state$.pipe(
      map(s => s.tickets),
      distinctUntilChanged()
    );
    this.agents$ = this.state$.pipe(
      map(s => s.agentList),
      distinctUntilChanged()
    );
    this.agentMap$ = this.state$.pipe(
      map(s => s.agents),
      distinctUntilChanged()
    );
    this.agentLoad$ = this.state$.pipe(
      map(s => s.agentLoad),
      distinctUntilChanged()
    );
    this.slaStatus$ = this.state$.pipe(
      map(s => s.slaStatus),
      distinctUntilChanged()
    );
    this.benchmark$ = this.state$.pipe(
      map(s => s.slaBenchmark),
      distinctUntilChanged()
    );
    this.isLoading$ = this.state$.pipe(
      map(s => s.isLoading),
      distinctUntilChanged()
    );
    this.error$ = this.state$.pipe(
      map(s => s.error),
      distinctUntilChanged()
    );
    this.syncStatus$ = this.state$.pipe(
      map(s => s.syncStatus),
      distinctUntilChanged()
    );
    this.lastSeq$ = this.state$.pipe(
      map(s => s.lastSeq),
      distinctUntilChanged()
    );

    // Initialize pipeline subscriptions
    this.init();
  }

  /**
   * Initializes subscriptions to EventPipeline state and status streams.
   */
  public init(): void {
    // 1. Subscribe to domain state emissions from EventPipeline
    this.pipeline.state$.pipe(takeUntil(this._destroy$)).subscribe(() => {
      this.recomputeState();
    });

    // 2. Subscribe to synchronization status emissions
    this.pipeline.syncStatus$.pipe(takeUntil(this._destroy$)).subscribe(syncStatus => {
      const current = this._state$.value;
      if (current.syncStatus !== syncStatus) {
        this._state$.next({
          ...current,
          syncStatus
        });
      }

      // Reconnection Lifecycle on StreamReset:
      // When EventPipeline transitions to 'resyncing', close the old connection
      // and establish a new connection capturing the updated pipeline epoch.
      if (syncStatus === 'resyncing') {
        this.connectEventStream();
      }
    });

    // 3. Subscribe to error emissions
    this.pipeline.error$.pipe(takeUntil(this._destroy$)).subscribe(err => {
      const current = this._state$.value;
      this._state$.next({
        ...current,
        error: err.message
      });
    });

    // 4. Subscribe to gap overflow emissions
    this.pipeline.gapOverflow$.pipe(takeUntil(this._destroy$)).subscribe(gap => {
      const current = this._state$.value;
      this._state$.next({
        ...current,
        error: `Sequence gap overflow: missing sequence ${gap.missingSeq} while holding ${gap.bufferedCount} buffered events.`
      });
    });

    // 5. Establish initial event stream connection
    this.connectEventStream();
  }

  /**
   * Connects or reconnects to TicketGateway.getEventStream().
   *
   * Reconnection Lifecycle Contract:
   * 1. Closes any previous stream connection (preventing duplicate subscriptions/connections).
   * 2. Captures current pipeline epoch (updated after StreamReset).
   * 3. Establishes new stream subscription with the captured epoch.
   * 4. Handles stream connection/runtime errors gracefully.
   */
  public connectEventStream(): void {
    if (!this.gateway?.getEventStream) {
      return;
    }

    // Teardown previous subscription (closes old transport connection)
    if (this._streamSubscription) {
      this._streamSubscription.unsubscribe();
      this._streamSubscription = null;
    }

    try {
      const connectionEpoch = this.pipeline.getEpoch();
      this._streamSubscription = this.gateway
        .getEventStream(connectionEpoch)
        .pipe(takeUntil(this._destroy$))
        .subscribe({
          next: ({ event, epoch }) => {
            this.pipeline.handleEvent(event, epoch);
          },
          error: (err: Error) => {
            this.handleError(err);
          }
        });
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Recomputes application state by overlaying active assignment mutations (pending or API-confirmed)
   * on top of confirmed domain state from EventPipeline. Reconciles mutations that have been
   * authoritatively confirmed by EventPipeline (when pipeline version reaches optimisticVersion).
   */
  private recomputeState(): void {
    const deskState = this.pipeline.state;
    const current = this._state$.value;

    const tickets: Record<string, Ticket> = { ...deskState.tickets };
    const agentLoad: Record<string, number> = { ...deskState.agentLoad };

    // Process and overlay active mutations (pending or api-confirmed)
    for (const [ticketId, mutation] of Array.from(this._mutations.entries())) {
      const baseTicket = deskState.tickets[ticketId];
      if (!baseTicket) {
        continue;
      }

      // Reconcile: If EventPipeline domain state has reached or surpassed the mutation's target version,
      // the authoritative event/snapshot has arrived! Retire the mutation overlay.
      if (baseTicket.version >= mutation.optimisticVersion) {
        this._mutations.delete(ticketId);
        continue;
      }

      // Consistent agent load calculation:
      // Exactly ONE adjustment per ticket relative to baseTicket, regardless of mutation status.
      // Prevents duplicate agentLoad increments.
      if (baseTicket.status !== 'resolved' && baseTicket.assigneeId !== mutation.targetAgentId) {
        if (baseTicket.assigneeId) {
          const prevLoad = agentLoad[baseTicket.assigneeId] ?? 0;
          agentLoad[baseTicket.assigneeId] = Math.max(0, prevLoad - 1);
        }
        agentLoad[mutation.targetAgentId] = (agentLoad[mutation.targetAgentId] ?? 0) + 1;
      }

      // Overlay ticket:
      // If confirmed by API, use the server's confirmed ticket object merged onto base history;
      // otherwise use the optimistic ticket overlay.
      if (mutation.status === 'api-confirmed' && mutation.confirmedTicket) {
        tickets[ticketId] = {
          ...mutation.confirmedTicket,
          ...baseTicket,
          assigneeId: mutation.targetAgentId,
          version: mutation.optimisticVersion
        };
      } else {
        tickets[ticketId] = {
          ...baseTicket,
          assigneeId: mutation.targetAgentId,
          version: mutation.optimisticVersion
        };
      }
    }

    const ticketList = Object.values(tickets);
    const agentList = Object.values(deskState.agents);

    const t0 = performance.now();
    const slaStatus = this.calculateAllSla(tickets);
    const t1 = performance.now();
    const slaBenchmark: SlaBenchmarkMetrics = {
      executionTimeMs: Math.round((t1 - t0) * 100) / 100,
      ticketCount: ticketList.length,
      timestamp: this._clock().getTime()
    };

    this._state$.next({
      ...current,
      tickets,
      ticketList,
      agents: deskState.agents,
      agentList,
      agentLoad,
      slaStatus,
      slaBenchmark,
      lastSeq: deskState.lastSeq,
      lastUpdatedAt: deskState.lastUpdatedAt
    });
  }

  /**
   * Clean up all active subscriptions and clear mutations to prevent memory leaks.
   */
  public destroy(): void {
    this._destroy$.next();
    this._destroy$.complete();
    if (this._streamSubscription) {
      this._streamSubscription.unsubscribe();
      this._streamSubscription = null;
    }
    this._mutations.clear();
    this._reassignmentHistory.clear();
    this._slaCache.clear();
  }

  /**
   * Checks if a ticket has an in-flight unconfirmed mutation (status 'pending').
   */
  public isTicketMutating(ticketId: string): boolean {
    return this._mutations.get(ticketId)?.status === 'pending';
  }

  /**
   * Returns mutation details for a ticket if any active mutation exists.
   */
  public getTicketMutation(ticketId: string): AssignmentMutation | null {
    return this._mutations.get(ticketId) ?? null;
  }

  /**
   * Angular OnDestroy lifecycle hook.
   */
  public ngOnDestroy(): void {
    this.destroy();
  }

  /**
   * Synchronous snapshot of the current application state.
   */
  public get state(): ApplicationState {
    return this._state$.value;
  }

  public get tickets(): readonly Ticket[] {
    return this.state.ticketList;
  }

  public get agents(): readonly Agent[] {
    return this.state.agentList;
  }

  public get agentLoad(): Readonly<Record<string, number>> {
    return this.state.agentLoad;
  }

  public get syncStatus(): PipelineSyncStatus {
    return this.state.syncStatus;
  }

  public get isLoading(): boolean {
    return this.state.isLoading;
  }

  public get error(): string | null {
    return this.state.error;
  }

  public get lastSeq(): number {
    return this.state.lastSeq;
  }

  public get slaBenchmark(): SlaBenchmarkMetrics | null {
    return this.state.slaBenchmark;
  }

  /**
   * Updates loading flag in application state.
   */
  public setLoading(isLoading: boolean): void {
    const current = this._state$.value;
    if (current.isLoading !== isLoading) {
      this._state$.next({ ...current, isLoading });
    }
  }

  /**
   * Clears any active error in application state.
   */
  public clearError(): void {
    const current = this._state$.value;
    if (current.error !== null) {
      this._state$.next({ ...current, error: null });
    }
  }

  /**
   * Traverses pagination across TicketGateway to fetch all tickets and agents,
   * constructs a complete DeskSnapshot, and applies it to EventPipeline.
   *
   * Best-Effort Resynchronization:
   * Reconstructs snapshot from independent GET /tickets and GET /agents queries.
   * If any page or agent query fails, notifies EventPipeline of failure and aborts.
   */
  public resynchronize(resetSeq?: number): Observable<void> {
    if (!this.gateway) {
      return of(void 0);
    }

    this.setLoading(true);
    this.clearError();

    const targetResetSeq =
      resetSeq ?? this.pipeline.pendingResetSeq ?? this.pipeline.state.lastSeq;

    return forkJoin({
      agents: this.gateway.getAgents(),
      allTickets: this.fetchAllTicketPages()
    }).pipe(
      map(({ agents, allTickets }) => {
        // Construct agents map
        const agentsMap: Record<string, Agent> = {};
        for (const agent of agents) {
          agentsMap[agent.id] = agent;
        }

        // Construct tickets map
        const ticketsMap: Record<string, Ticket> = {};
        for (const ticket of allTickets) {
          ticketsMap[ticket.id] = ticket;
        }

        const snapshot: DeskSnapshot = {
          lastSeq: targetResetSeq,
          tickets: ticketsMap,
          agents: agentsMap
        };

        // Hand complete snapshot to EventPipeline for validation and atomic emission
        this.pipeline.syncSnapshot(snapshot, this._clock());
        this.setLoading(false);
      }),
      catchError(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.pipeline.notifySnapshotFailure(error);
        this.handleError(error);
        this.setLoading(false);
        return throwError(() => error);
      })
    );
  }

  /**
   * Finds the best eligible agent for a ticket using AssignmentEngine.
   */
  public findBestAgentForTicket(ticketId: string): Agent | null {
    const ticket = this.state.tickets[ticketId];
    if (!ticket) {
      return null;
    }

    return findBestAgent(ticket, this.state.agentList, this.state.agentLoad, this._clock());
  }

  /**
   * Coordinates auto-assignment of an unassigned ticket using AssignmentEngine.
   * Applies optimistic assignment immediately with consistent agent load updates,
   * rolls back on HTTP 409 or 500 failure, and reconciles with authoritative state.
   */
  public autoAssignTicket(
    ticketId: string,
    recordUndo = true
  ): Observable<AssignmentResult | null> {
    const currentTicket = this.state.tickets[ticketId];
    if (!currentTicket) {
      return of(null);
    }

    // Evaluate best candidate using current state (including active optimistic loads)
    const currentDeskState: DeskState = {
      ...this.pipeline.state,
      agentLoad: this.state.agentLoad
    };

    const assignment = assignTicket(currentTicket, currentDeskState, this._clock());
    if (!assignment) {
      return of(null);
    }

    const agentId = assignment.agentId;
    const previousAssignee = currentTicket.assigneeId;
    const previousVersion = currentTicket.version;
    const optimisticVersion = previousVersion + 1;
    const mutationId = ++this._nextMutationId;

    // Record pending in-flight mutation
    this._mutations.set(ticketId, {
      mutationId,
      ticketId,
      previousAssignee,
      previousVersion,
      targetAgentId: agentId,
      optimisticVersion,
      status: 'pending'
    });

    // Immediately apply optimistic state
    this.recomputeState();

    if (recordUndo && previousAssignee && previousAssignee !== agentId) {
      this._reassignmentHistory.set(ticketId, {
        ticketId,
        previousAssignee,
        targetAgentId: agentId,
        assignedVersion: optimisticVersion,
        assignedStatus: currentTicket.status,
        timestamp: this._clock().getTime()
      });
    }

    if (this.gateway?.assignTicket) {
      return this.gateway.assignTicket(ticketId, agentId, previousVersion).pipe(
        map(updatedTicket => {
          const active = this._mutations.get(ticketId);
          // Concurrent mutation protection: only transition if not superseded by a newer mutation
          if (active && active.mutationId === mutationId) {
            this._mutations.set(ticketId, {
              ...active,
              status: 'api-confirmed',
              confirmedTicket: updatedTicket
            });
            this.recomputeState();
          }
          return assignment;
        }),
        catchError(err => {
          const active = this._mutations.get(ticketId);
          if (active && active.mutationId === mutationId) {
            this._mutations.delete(ticketId);
            this.recomputeState();
          }
          this.handleError(err);
          return throwError(() => err);
        })
      );
    }

    // No gateway present: mark api-confirmed
    this._mutations.set(ticketId, {
      mutationId,
      ticketId,
      previousAssignee,
      previousVersion,
      targetAgentId: agentId,
      optimisticVersion,
      status: 'api-confirmed'
    });
    this.recomputeState();

    return of(assignment);
  }

  /**
   * Manually assigns a ticket to an agent via TicketGateway.
   * Applies optimistic assignment immediately with consistent agent load updates,
   * rolls back on HTTP 409 or 500 failure, and reconciles with authoritative state.
   * Handles concurrent mutations safely (older failed requests do not overwrite newer assignments).
   */
  public assignTicket(
    ticketId: string,
    agentId: string,
    recordUndo = true
  ): Observable<Ticket | null> {
    const currentTicket = this.state.tickets[ticketId];
    if (!currentTicket) {
      return of(null);
    }

    if (!this.state.agents[agentId]) {
      const err = new Error(`Cannot assign ticket '${ticketId}' to unknown agent '${agentId}'.`);
      this.handleError(err);
      return throwError(() => err);
    }

    const previousAssignee = currentTicket.assigneeId;
    const previousVersion = currentTicket.version;
    const optimisticVersion = previousVersion + 1;
    const mutationId = ++this._nextMutationId;

    // Record pending in-flight mutation
    this._mutations.set(ticketId, {
      mutationId,
      ticketId,
      previousAssignee,
      previousVersion,
      targetAgentId: agentId,
      optimisticVersion,
      status: 'pending'
    });

    // Immediately apply optimistic state
    this.recomputeState();

    if (recordUndo && previousAssignee && previousAssignee !== agentId) {
      this._reassignmentHistory.set(ticketId, {
        ticketId,
        previousAssignee,
        targetAgentId: agentId,
        assignedVersion: optimisticVersion,
        assignedStatus: currentTicket.status,
        timestamp: this._clock().getTime()
      });
    }

    if (this.gateway?.assignTicket) {
      return this.gateway.assignTicket(ticketId, agentId, previousVersion).pipe(
        map(updatedTicket => {
          const active = this._mutations.get(ticketId);
          // Concurrent mutation protection: only transition if not superseded by a newer mutation
          if (active && active.mutationId === mutationId) {
            this._mutations.set(ticketId, {
              ...active,
              status: 'api-confirmed',
              confirmedTicket: updatedTicket
            });
            this.recomputeState();
          }
          return updatedTicket;
        }),
        catchError(err => {
          const active = this._mutations.get(ticketId);
          if (active && active.mutationId === mutationId) {
            this._mutations.delete(ticketId);
            this._reassignmentHistory.delete(ticketId);
            this.recomputeState();
          }
          this.handleError(err);
          return throwError(() => err);
        })
      );
    }

    const localConfirmed: Ticket = {
      ...currentTicket,
      assigneeId: agentId,
      version: optimisticVersion
    };
    this._mutations.set(ticketId, {
      mutationId,
      ticketId,
      previousAssignee,
      previousVersion,
      targetAgentId: agentId,
      optimisticVersion,
      status: 'api-confirmed',
      confirmedTicket: localConfirmed
    });
    this.recomputeState();

    return of(localConfirmed);
  }

  /**
   * Checks whether the most recent manual reassignment for a ticket can be undone.
   * Concurrency check: Verifies the ticket has an undo record, has not been modified since
   * (current version matches assignedVersion), and is currently assigned to the target agent.
   */
  public canUndoReassignment(ticketId: string): boolean {
    const record = this._reassignmentHistory.get(ticketId);
    if (!record) {
      return false;
    }
    const currentTicket = this.state.tickets[ticketId];
    if (!currentTicket) {
      return false;
    }
    return (
      currentTicket.version === record.assignedVersion &&
      currentTicket.assigneeId === record.targetAgentId &&
      currentTicket.status === record.assignedStatus
    );
  }

  /**
   * Undoes the most recent manual reassignment for a ticket with optimistic concurrency control.
   * Restores the previous assignee.
   * Fails if the ticket has been concurrently modified or has no undo history.
   */
  public undoReassignment(ticketId: string): Observable<Ticket | null> {
    const record = this._reassignmentHistory.get(ticketId);
    if (!record || !this.canUndoReassignment(ticketId)) {
      const err = new Error(
        `Cannot undo reassignment for ticket '${ticketId}': Ticket has been concurrently modified or has no undo history.`
      );
      this.handleError(err);
      return throwError(() => err);
    }

    this._reassignmentHistory.delete(ticketId);
    return this.assignTicket(ticketId, record.previousAssignee, false);
  }

  /**
   * Calculates SLA state and deadlines for a specific ticket.
   */
  public getTicketSla(ticketId: string): SlaCalculationResult | null {
    const ticket = this.state.tickets[ticketId];
    if (!ticket) {
      return null;
    }

    return this.calculateSingleTicketSla(ticket);
  }

  /**
   * Fetches all pages of tickets from TicketGateway.
   */
  private fetchAllTicketPages(): Observable<readonly Ticket[]> {
    if (!this.gateway) {
      return of([]);
    }

    const pageSize = 200;

    return this.gateway.getTickets(1, pageSize).pipe(
      switchMap(firstPage => {
        const total = firstPage.total;
        const collectedTickets = [...firstPage.tickets];

        if (total <= pageSize) {
          return of(collectedTickets);
        }

        const totalPages = Math.ceil(total / pageSize);
        const remainingPageObservables: Observable<PaginatedTickets>[] = [];

        for (let page = 2; page <= totalPages; page++) {
          remainingPageObservables.push(this.gateway!.getTickets(page, pageSize));
        }

        return forkJoin(remainingPageObservables).pipe(
          map(pages => {
            for (const p of pages) {
              collectedTickets.push(...p.tickets);
            }
            return collectedTickets;
          })
        );
      })
    );
  }

  /**
   * Derives SLA calculation results for all tickets in state with performance caching
   * for resolved tickets.
   */
  private calculateAllSla(
    tickets: Readonly<Record<string, Ticket>>
  ): Record<string, SlaCalculationResult> {
    const results: Record<string, SlaCalculationResult> = {};
    for (const [id, ticket] of Object.entries(tickets)) {
      if (ticket.status === 'resolved') {
        const cached = this._slaCache.get(id);
        if (cached && cached.version === ticket.version) {
          results[id] = cached.result;
          continue;
        }
      }

      const sla = this.calculateSingleTicketSla(ticket);
      if (sla) {
        results[id] = sla;
        if (ticket.status === 'resolved') {
          this._slaCache.set(id, { version: ticket.version, result: sla });
        }
      }
    }
    return results;
  }

  /**
   * Calculates SLA for a single ticket using SlaCalculator.
   */
  private calculateSingleTicketSla(ticket: Ticket): SlaCalculationResult | null {
    const policy = this._policies[ticket.priority];
    const calendar = this._calendars[ticket.region];

    if (!policy || !calendar) {
      return null;
    }

    try {
      return calculateSla(ticket, policy, calendar, this._clock());
    } catch {
      // Inconsistent temporal ticket data handled safely without breaking state emission
      return null;
    }
  }

  /**
   * Emits error message to application state.
   */
  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this._state$.value;
    this._state$.next({
      ...current,
      error: message
    });
  }
}
