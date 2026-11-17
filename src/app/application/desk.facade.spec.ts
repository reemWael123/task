import { Observable, of, Subject, throwError } from 'rxjs';
import {
  Agent,
  DeskEvent,
  Ticket,
  TicketAssigned,
  TicketCreated
} from '../domain/models';
import {
  DeskSnapshot,
  EventPipeline
} from '../domain/event-pipeline';
import { DeskFacade, SlaConfig } from './desk.facade';
import { PaginatedTickets, TicketGateway } from './ticket-gateway.interface';

describe('DeskFacade', () => {
  const fixedNow = new Date('2026-11-18T10:00:00.000Z');
  const mockClock = () => fixedNow;

  const agentAlice: Agent = {
    id: 'agent-1',
    name: 'Alice',
    skills: ['billing'],
    status: 'online',
    maxLoad: 5,
    shift: { start: '08:00', end: '16:00', tz: 'UTC' }
  };

  const agentBob: Agent = {
    id: 'agent-2',
    name: 'Bob',
    skills: ['tech'],
    status: 'online',
    maxLoad: 5,
    shift: { start: '08:00', end: '16:00', tz: 'UTC' }
  };

  const standardAgents: Record<string, Agent> = {
    'agent-1': agentAlice,
    'agent-2': agentBob
  };

  function createTicket(
    id: string,
    assigneeId?: string,
    status: 'open' | 'resolved' = 'open'
  ): Ticket {
    return {
      id,
      version: 1,
      priority: 'P2',
      status,
      customerTier: 'standard',
      region: 'EU',
      skills: ['billing'],
      createdAt: '2026-11-18T09:00:00.000Z',
      ...(assigneeId ? { assigneeId } : {}),
      statusHistory: [{ status, at: '2026-11-18T09:00:00.000Z' }]
    };
  }

  function createTicketCreatedEvent(
    seq: number,
    ticketId: string,
    assigneeId?: string
  ): TicketCreated {
    return {
      type: 'TicketCreated',
      eventId: `evt-${seq}`,
      seq,
      ticket: createTicket(ticketId, assigneeId)
    };
  }

  class MockGateway implements TicketGateway {
    public ticketsPages: Record<number, PaginatedTickets> = {};
    public agents: Agent[] = [agentAlice, agentBob];
    public eventStream$ = new Subject<{ event: DeskEvent; epoch: number }>();
    public activeStreams: { epoch: number; subject: Subject<{ event: DeskEvent; epoch: number }> }[] = [];
    public streamError?: Error;
    public assignedCalls: { ticketId: string; agentId: string; version: number }[] = [];
    public shouldFailTickets = false;
    public shouldFailAgents = false;
    public failPage?: number;
    public assignTicketResponse?: (
      ticketId: string,
      agentId: string,
      version: number
    ) => Observable<Ticket>;

    getTickets(page = 1, pageSize = 200) {
      if (this.shouldFailTickets) {
        return throwError(() => new Error('HTTP 500: Tickets endpoint failed'));
      }
      if (this.failPage !== undefined && this.failPage === page) {
        return throwError(() => new Error(`HTTP 500: Tickets page ${page} failed`));
      }
      const pageData = this.ticketsPages[page] ?? {
        tickets: [],
        total: 0,
        page,
        pageSize
      };
      return of(pageData);
    }

    getAgents() {
      if (this.shouldFailAgents) {
        return throwError(() => new Error('HTTP 500: Agents endpoint failed'));
      }
      return of(this.agents);
    }

    getEventStream(epoch = 1) {
      if (this.streamError) {
        return throwError(() => this.streamError);
      }
      const streamSubject = new Subject<{ event: DeskEvent; epoch: number }>();
      const entry = { epoch, subject: streamSubject };
      this.activeStreams.push(entry);

      return new Observable<{ event: DeskEvent; epoch: number }>(subscriber => {
        const sub1 = streamSubject.subscribe(subscriber);
        const sub2 = this.eventStream$.subscribe(subscriber);
        return () => {
          sub1.unsubscribe();
          sub2.unsubscribe();
          const idx = this.activeStreams.indexOf(entry);
          if (idx !== -1) {
            this.activeStreams.splice(idx, 1);
          }
        };
      });
    }

    assignTicket(ticketId: string, agentId: string, version: number) {
      this.assignedCalls.push({ ticketId, agentId, version });
      if (this.assignTicketResponse) {
        return this.assignTicketResponse(ticketId, agentId, version);
      }
      return of({
        ...createTicket(ticketId, agentId),
        version: version + 1
      });
    }
  }

  let pipeline: EventPipeline;
  let gateway: MockGateway;
  let facade: DeskFacade;

  beforeEach(() => {
    pipeline = new EventPipeline(standardAgents, { clock: mockClock });
    gateway = new MockGateway();
    facade = new DeskFacade(pipeline, gateway, { clock: mockClock });
  });

  afterEach(() => {
    facade.destroy();
  });

  describe('1. Initial Application State', () => {
    it('should initialize with correct default state and populate registered agents', () => {
      const state = facade.state;

      expect(state.tickets).toEqual({});
      expect(state.ticketList).toEqual([]);
      expect(state.agents).toEqual(standardAgents);
      expect(state.agentList.length).toBe(2);
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.agentLoad['agent-2']).toBe(0);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.syncStatus).toBe('synced');
      expect(state.lastSeq).toBe(0);
    });

    it('should expose synchronous convenience getters matching state', () => {
      expect(facade.tickets).toEqual([]);
      expect(facade.agents.length).toBe(2);
      expect(facade.agentLoad['agent-1']).toBe(0);
      expect(facade.syncStatus).toBe('synced');
      expect(facade.isLoading).toBe(false);
      expect(facade.error).toBeNull();
      expect(facade.lastSeq).toBe(0);
    });
  });

  describe('2. Synchronizing Facade State with EventPipeline', () => {
    it('should reactively update tickets, agentLoad, and lastSeq when EventPipeline emits new state', () => {
      const emittedTicketCounts: number[] = [];
      facade.tickets$.subscribe(tickets => emittedTicketCounts.push(tickets.length));

      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', 'agent-1'), epoch);

      expect(facade.state.lastSeq).toBe(1);
      expect(facade.tickets.length).toBe(1);
      expect(facade.state.tickets['ticket-1']).toBeDefined();
      expect(facade.agentLoad['agent-1']).toBe(1);
      expect(emittedTicketCounts).toEqual([0, 1]);
    });

    it('should automatically calculate SLA status for tickets in state', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      const sla = facade.state.slaStatus['ticket-1'];
      expect(sla).toBeDefined();
      expect(sla.firstResponse).toBe('breached');
      expect(sla.resolution).toBe('ok');
      expect(sla.dueAt.firstResponse instanceof Date).toBe(true);
      expect(sla.dueAt.resolution instanceof Date).toBe(true);
    });
  });

  describe('3. Propagating Connection and Synchronization Status', () => {
    it('should propagate syncStatus transitions from EventPipeline to Facade observables', () => {
      const emittedStatuses: string[] = [];
      facade.syncStatus$.subscribe(status => emittedStatuses.push(status));

      const epoch = pipeline.getEpoch();
      // Valid StreamReset transitions pipeline to 'resyncing'
      pipeline.handleEvent({ type: 'StreamReset', eventId: 'r-15', seq: 15 }, epoch);

      expect(facade.syncStatus).toBe('resyncing');
      expect(facade.state.syncStatus).toBe('resyncing');
      expect(emittedStatuses).toEqual(['synced', 'resyncing']);
    });
  });

  describe('4. Loading and Error States', () => {
    it('should update isLoading flag and emit to isLoading$', () => {
      const emittedLoading: boolean[] = [];
      facade.isLoading$.subscribe(loading => emittedLoading.push(loading));

      facade.setLoading(true);
      expect(facade.isLoading).toBe(true);

      facade.setLoading(false);
      expect(facade.isLoading).toBe(false);

      expect(emittedLoading).toEqual([false, true, false]);
    });

    it('should capture EventPipeline errors and allow clearError', () => {
      const emittedErrors: (string | null)[] = [];
      facade.error$.subscribe(err => emittedErrors.push(err));

      const epoch = pipeline.getEpoch();
      // Apply event 1
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', undefined), epoch);

      // Re-send same eventId with seq 2 to trigger protocol violation
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2', undefined), epoch);

      // Trigger error manually via notifySnapshotFailure
      pipeline.notifySnapshotFailure(new Error('Snapshot timeout'));

      expect(facade.error).toContain('Snapshot timeout');

      facade.clearError();
      expect(facade.error).toBeNull();
    });
  });

  describe('5. Lifecycle and Cleanup', () => {
    it('should clean up subscriptions on destroy() so pipeline emissions no longer mutate Facade state', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);
      expect(facade.tickets.length).toBe(1);

      // Destroy facade
      facade.destroy();

      // Ingest event 2
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2'), epoch);

      // Facade state should NOT update because it unsubscribed
      expect(facade.tickets.length).toBe(1);
    });
  });

  describe('6. Delegation to Domain Services (No Logic Duplication)', () => {
    it('should delegate findBestAgentForTicket to AssignmentEngine respecting skills and load', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-unassigned'), epoch);

      const bestAgent = facade.findBestAgentForTicket('ticket-unassigned');
      expect(bestAgent).toBeDefined();
      expect(bestAgent?.id).toBe('agent-1'); // agent-1 has 'billing' skill
    });

    it('should return null when finding agent for an already assigned ticket', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-assigned', 'agent-1'), epoch);

      const bestAgent = facade.findBestAgentForTicket('ticket-assigned');
      expect(bestAgent).toBeNull();
    });

    it('should delegate autoAssignTicket to AssignmentEngine and call TicketGateway.assignTicket', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      let assignmentResult: any = null;
      facade.autoAssignTicket('ticket-1').subscribe(res => (assignmentResult = res));

      expect(assignmentResult).toBeDefined();
      expect(assignmentResult.agentId).toBe('agent-1');
      expect(gateway.assignedCalls.length).toBe(1);
      expect(gateway.assignedCalls[0]).toEqual({
        ticketId: 'ticket-1',
        agentId: 'agent-1',
        version: 1
      });
    });

    it('should delegate manual assignTicket to TicketGateway', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      let assignedTicket: any = null;
      facade.assignTicket('ticket-1', 'agent-2').subscribe(t => (assignedTicket = t));

      expect(assignedTicket).toBeDefined();
      expect(assignedTicket?.assigneeId).toBe('agent-2');
      expect(gateway.assignedCalls.length).toBe(1);
    });

    it('should provide getTicketSla on demand using SlaCalculator', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      const sla = facade.getTicketSla('ticket-1');
      expect(sla).toBeDefined();
      expect(sla?.firstResponse).toBe('breached');
    });
  });

  describe('7. Gateway Pagination & Snapshot Assembly', () => {
    it('should traverse multiple ticket pages from TicketGateway and apply complete DeskSnapshot to pipeline', () => {
      // Setup gateway with 2 pages (total: 300 tickets)
      const page1Tickets = [createTicket('ticket-p1-1'), createTicket('ticket-p1-2')];
      const page2Tickets = [createTicket('ticket-p2-1')];

      gateway.ticketsPages[1] = {
        tickets: page1Tickets,
        total: 300,
        page: 1,
        pageSize: 200
      };
      gateway.ticketsPages[2] = {
        tickets: page2Tickets,
        total: 300,
        page: 2,
        pageSize: 200
      };

      let completed = false;
      facade.resynchronize(15).subscribe(() => (completed = true));

      expect(completed).toBe(true);
      expect(facade.state.lastSeq).toBe(15);
      expect(facade.tickets.length).toBe(3);
      expect(facade.state.tickets['ticket-p1-1']).toBeDefined();
      expect(facade.state.tickets['ticket-p1-2']).toBeDefined();
      expect(facade.state.tickets['ticket-p2-1']).toBeDefined();
      expect(facade.isLoading).toBe(false);
    });

    it('should handle single-page tickets from TicketGateway seamlessly', () => {
      gateway.ticketsPages[1] = {
        tickets: [createTicket('single-1')],
        total: 1,
        page: 1,
        pageSize: 200
      };

      facade.resynchronize(10).subscribe();

      expect(facade.state.lastSeq).toBe(10);
      expect(facade.tickets.length).toBe(1);
      expect(facade.state.tickets['single-1']).toBeDefined();
    });
  });

  describe('8. Gateway Failure Handling', () => {
    it('should notify EventPipeline and set error when tickets query fails', () => {
      gateway.shouldFailTickets = true;

      let errorCaptured: any = null;
      facade.resynchronize(15).subscribe({
        error: err => (errorCaptured = err)
      });

      expect(errorCaptured).toBeDefined();
      expect(facade.error).toContain('HTTP 500: Tickets endpoint failed');
      expect(facade.syncStatus).toBe('error');
      expect(facade.isLoading).toBe(false);
    });

    it('should notify EventPipeline and set error when agents query fails', () => {
      gateway.shouldFailAgents = true;

      let errorCaptured: any = null;
      facade.resynchronize(15).subscribe({
        error: err => (errorCaptured = err)
      });

      expect(errorCaptured).toBeDefined();
      expect(facade.error).toContain('HTTP 500: Agents endpoint failed');
      expect(facade.syncStatus).toBe('error');
    });

    it('should handle pagination failure midway (Page 1 succeeds, Page 2 fails) without modifying visible board or calling syncSnapshot', () => {
      // 1. Establish visible initial board
      const initialEpoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-initial'), initialEpoch);
      expect(facade.tickets.length).toBe(1);
      expect(facade.tickets[0].id).toBe('ticket-initial');
      expect(facade.lastSeq).toBe(1);

      // 2. Setup gateway with 2 pages (total: 400 tickets)
      gateway.ticketsPages[1] = {
        tickets: [createTicket('ticket-p1-1'), createTicket('ticket-p1-2')],
        total: 400,
        page: 1,
        pageSize: 200
      };
      // Page 2 configured to fail
      gateway.failPage = 2;

      // 3. Spy on EventPipeline methods
      const syncSnapshotSpy = spyOn(pipeline, 'syncSnapshot').and.callThrough();
      const notifyFailureSpy = spyOn(pipeline, 'notifySnapshotFailure').and.callThrough();

      // 4. Trigger resynchronize
      let caughtError: any = null;
      facade.resynchronize(15).subscribe({
        error: err => (caughtError = err)
      });

      // 5. Assertions:
      // syncSnapshot must NEVER be called
      expect(syncSnapshotSpy).not.toHaveBeenCalled();
      // notifySnapshotFailure MUST be called
      expect(notifyFailureSpy).toHaveBeenCalled();
      // Visible board remains completely untouched
      expect(facade.tickets.length).toBe(1);
      expect(facade.tickets[0].id).toBe('ticket-initial');
      expect(facade.lastSeq).toBe(1);
      // Loading flag is reset to false
      expect(facade.isLoading).toBe(false);
      // Facade exposes the error
      expect(facade.error).toContain('HTTP 500: Tickets page 2 failed');
      expect(facade.syncStatus).toBe('error');
      expect(caughtError).toBeDefined();
    });
  });

  describe('9. Real-Time Event Stream Integration', () => {
    it('should forward incoming stream events from TicketGateway directly into EventPipeline', () => {
      const currentEpoch = pipeline.getEpoch();
      const event = createTicketCreatedEvent(1, 'stream-ticket-1');

      gateway.eventStream$.next({ event, epoch: currentEpoch });

      expect(facade.state.lastSeq).toBe(1);
      expect(facade.state.tickets['stream-ticket-1']).toBeDefined();
    });

    it('should reject events carrying an old epoch delivered through the Facade gateway subscription after StreamReset', () => {
      const initialEpoch = pipeline.getEpoch();
      expect(initialEpoch).toBe(1);

      // 1. Normal event arrives on epoch 1 via gateway subscription
      gateway.eventStream$.next({
        event: createTicketCreatedEvent(1, 'stream-ticket-1'),
        epoch: initialEpoch
      });
      expect(facade.lastSeq).toBe(1);
      expect(facade.state.tickets['stream-ticket-1']).toBeDefined();

      // 2. StreamReset delivered on epoch 1
      gateway.eventStream$.next({
        event: { type: 'StreamReset', eventId: 'rst-15', seq: 15 },
        epoch: initialEpoch
      });
      expect(facade.syncStatus).toBe('resyncing');
      expect(pipeline.getEpoch()).toBe(initialEpoch + 1); // Pipeline epoch incremented to 2

      // 3. Late event delivered from the old connection carrying old epoch 1
      gateway.eventStream$.next({
        event: createTicketCreatedEvent(16, 'stream-ticket-old'),
        epoch: initialEpoch
      });

      // Assert: Old epoch event is rejected!
      expect(facade.state.tickets['stream-ticket-old']).toBeUndefined();
      expect(pipeline.bufferedCount).toBe(0); // Not buffered

      // 4. Event delivered from new connection carrying new epoch 2
      gateway.eventStream$.next({
        event: createTicketCreatedEvent(16, 'stream-ticket-new'),
        epoch: initialEpoch + 1
      });

      // Assert: New epoch event is accepted and buffered (seq 16 > pendingResetSeq 15)
      expect(pipeline.bufferedCount).toBe(1);
    });

    it('should close old connection and establish new connection with updated epoch when pipeline enters resyncing', () => {
      // Facade constructor connected the initial stream (epoch 1)
      expect(gateway.activeStreams.length).toBe(1);
      const firstStream = gateway.activeStreams[0];
      expect(firstStream.epoch).toBe(1);

      // StreamReset is delivered through stream 1
      firstStream.subject.next({
        event: { type: 'StreamReset', eventId: 'rst-20', seq: 20 },
        epoch: 1
      });

      // Assert: pipeline has entered 'resyncing' and incremented epoch to 2
      expect(facade.syncStatus).toBe('resyncing');
      expect(pipeline.getEpoch()).toBe(2);

      // Assert: Facade automatically closed old connection and established new connection
      expect(gateway.activeStreams.length).toBe(1);
      const secondStream = gateway.activeStreams[0];
      expect(secondStream).not.toBe(firstStream);
      expect(secondStream.epoch).toBe(2);

      // Events on the new connection (epoch 2) are accepted and buffered
      secondStream.subject.next({
        event: createTicketCreatedEvent(21, 'post-reset-ticket'),
        epoch: 2
      });
      expect(pipeline.bufferedCount).toBe(1);
    });

    it('should handle stream reconnection error gracefully and expose error on facade', () => {
      gateway.streamError = new Error('WebSocket connection refused');
      facade.connectEventStream();

      expect(facade.error).toContain('WebSocket connection refused');
    });
  });

  describe('10. Optimistic Manual and Auto Assignment', () => {
    it('should apply optimistic assignment immediately to state and agentLoad before gateway returns', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      expect(facade.state.tickets['ticket-1'].assigneeId).toBeUndefined();
      expect(facade.state.agentLoad['agent-1']).toBe(0);

      const inFlightSubject = new Subject<Ticket>();
      gateway.assignTicketResponse = () => inFlightSubject.asObservable();

      let assignedResult: Ticket | null = null;
      facade.assignTicket('ticket-1', 'agent-1').subscribe(t => (assignedResult = t));

      // 1. Gateway has NOT returned yet
      expect(assignedResult).toBeNull();

      // 2. State immediately reflects optimistic assignment
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);
      expect(facade.state.agentLoad['agent-1']).toBe(1);
      expect(facade.state.agentLoad['agent-2']).toBe(0);
      expect(facade.isTicketMutating('ticket-1')).toBe(true);
    });

    it('should transition mutation to api-confirmed on API success before corresponding stream event arrives', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      const inFlightSubject = new Subject<Ticket>();
      gateway.assignTicketResponse = () => inFlightSubject.asObservable();

      facade.assignTicket('ticket-1', 'agent-1').subscribe();

      // Mutation is pending in-flight
      expect(facade.isTicketMutating('ticket-1')).toBe(true);
      expect(facade.getTicketMutation('ticket-1')?.status).toBe('pending');

      // API responds with updated ticket
      const serverTicket: Ticket = {
        ...createTicket('ticket-1', 'agent-1'),
        version: 2
      };
      inFlightSubject.next(serverTicket);
      inFlightSubject.complete();

      // Mutation is now API-confirmed (no longer pending)
      expect(facade.isTicketMutating('ticket-1')).toBe(false);
      expect(facade.getTicketMutation('ticket-1')?.status).toBe('api-confirmed');
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);
      expect(facade.state.agentLoad['agent-1']).toBe(1);

      // EventPipeline confirmed state is NOT directly mutated or overwritten
      expect(pipeline.state.tickets['ticket-1'].assigneeId).toBeUndefined();
      expect(pipeline.state.tickets['ticket-1'].version).toBe(1);
    });

    it('should reconcile api-confirmed mutation when authoritative TicketAssigned event arrives after API success', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // API succeeds immediately
      facade.assignTicket('ticket-1', 'agent-1').subscribe();
      expect(facade.getTicketMutation('ticket-1')?.status).toBe('api-confirmed');

      // Authoritative event arrives on event stream
      const assignedEvent: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-assign-1',
        seq: 2,
        ticketId: 'ticket-1',
        agentId: 'agent-1',
        version: 2
      };
      pipeline.handleEvent(assignedEvent, epoch);

      // Mutation overlay is retired because EventPipeline state has caught up to version 2
      expect(facade.getTicketMutation('ticket-1')).toBeNull();
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);

      // Agent load is NOT duplicated (still exactly 1)
      expect(facade.state.agentLoad['agent-1']).toBe(1);
    });

    it('should retain api-confirmed state without leaving mutation pending indefinitely when no stream event arrives', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // API succeeds
      facade.assignTicket('ticket-1', 'agent-1').subscribe();

      // No stream event ever arrives.
      // Mutation is NOT left pending indefinitely
      expect(facade.isTicketMutating('ticket-1')).toBe(false);
      expect(facade.getTicketMutation('ticket-1')?.status).toBe('api-confirmed');

      // State remains consistent with server-confirmed assignment
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);
      expect(facade.state.agentLoad['agent-1']).toBe(1);

      // EventPipeline domain state remains clean
      expect(pipeline.state.tickets['ticket-1'].assigneeId).toBeUndefined();
    });

    it('should ignore stale API response from an older assignment request when a newer assignment was dispatched', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      const request1Subject = new Subject<Ticket>();
      const request2Subject = new Subject<Ticket>();
      let callCount = 0;

      gateway.assignTicketResponse = () => {
        callCount++;
        return callCount === 1 ? request1Subject.asObservable() : request2Subject.asObservable();
      };

      // Request 1: assign to agent-1 (Alice)
      facade.assignTicket('ticket-1', 'agent-1').subscribe();
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');

      // Request 2: newer assignment to agent-2 (Bob)
      facade.assignTicket('ticket-1', 'agent-2').subscribe();
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.agentLoad['agent-2']).toBe(1);
      expect(facade.state.agentLoad['agent-1']).toBe(0);

      // Now Request 1's API response arrives late (returning Alice, version 2)
      request1Subject.next({
        ...createTicket('ticket-1', 'agent-1'),
        version: 2
      });
      request1Subject.complete();

      // Assertion: Stale response from Request 1 MUST NOT overwrite Request 2!
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.tickets['ticket-1'].version).toBe(3);
      expect(facade.state.agentLoad['agent-2']).toBe(1);
      expect(facade.state.agentLoad['agent-1']).toBe(0);
      expect(facade.getTicketMutation('ticket-1')?.targetAgentId).toBe('agent-2');
    });

    it('should reconcile optimistic assignment when authoritative TicketAssigned event arrives on stream', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // Ingest optimistic assignment
      facade.assignTicket('ticket-1', 'agent-1').subscribe();
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);

      // Now authoritative stream event arrives
      const assignedEvent: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-assign-1',
        seq: 2,
        ticketId: 'ticket-1',
        agentId: 'agent-1',
        version: 2
      };
      pipeline.handleEvent(assignedEvent, epoch);

      // State is authoritatively updated
      expect(facade.state.lastSeq).toBe(2);
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);
      expect(facade.state.agentLoad['agent-1']).toBe(1);
    });

    it('should rollback optimistic assignment and revert agentLoad on HTTP 409 Conflict', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      gateway.assignTicketResponse = () =>
        throwError(() => new Error('HTTP 409: Conflict - version mismatch'));

      let caughtError: any = null;
      facade.assignTicket('ticket-1', 'agent-1').subscribe({
        error: err => (caughtError = err)
      });

      expect(caughtError).toBeDefined();
      expect(facade.error).toContain('HTTP 409: Conflict');

      // State rolled back to original unassigned state
      expect(facade.state.tickets['ticket-1'].assigneeId).toBeUndefined();
      expect(facade.state.tickets['ticket-1'].version).toBe(1);
      expect(facade.state.agentLoad['agent-1']).toBe(0);
      expect(facade.state.agentLoad['agent-2']).toBe(0);
    });

    it('should rollback optimistic reassignment from previous agent to new agent on HTTP 500 Server Error', () => {
      const epoch = pipeline.getEpoch();
      // Ticket initially assigned to agent-1 (Alice)
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', 'agent-1'), epoch);
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.agentLoad['agent-1']).toBe(1);
      expect(facade.state.agentLoad['agent-2']).toBe(0);

      gateway.assignTicketResponse = () =>
        throwError(() => new Error('HTTP 500: Internal server error'));

      let caughtError: any = null;
      facade.assignTicket('ticket-1', 'agent-2').subscribe({
        error: err => (caughtError = err)
      });

      expect(caughtError).toBeDefined();
      expect(facade.error).toContain('HTTP 500: Internal server error');

      // State and agent loads restored to Alice
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(1);
      expect(facade.state.agentLoad['agent-1']).toBe(1);
      expect(facade.state.agentLoad['agent-2']).toBe(0);
    });

    it('should handle concurrent assignment requests where an older failing request does not rollback a newer assignment', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      const request1Subject = new Subject<Ticket>();
      const request2Subject = new Subject<Ticket>();
      let callCount = 0;

      gateway.assignTicketResponse = () => {
        callCount++;
        return callCount === 1 ? request1Subject.asObservable() : request2Subject.asObservable();
      };

      // Request 1: assign to agent-1
      facade.assignTicket('ticket-1', 'agent-1').subscribe({ error: () => {} });
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.agentLoad['agent-1']).toBe(1);

      // Request 2 (concurrent, newer): assign to agent-2
      facade.assignTicket('ticket-1', 'agent-2').subscribe({ error: () => {} });
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.agentLoad['agent-1']).toBe(0);
      expect(facade.state.agentLoad['agent-2']).toBe(1);

      // Now Request 1 fails with HTTP 409
      request1Subject.error(new Error('HTTP 409: Conflict on request 1'));

      // Assertion: State must NOT rollback to unassigned or agent-1!
      // Request 2's optimistic update to agent-2 must be preserved!
      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.tickets['ticket-1'].version).toBe(3);
      expect(facade.state.agentLoad['agent-1']).toBe(0);
      expect(facade.state.agentLoad['agent-2']).toBe(1);

      // Request 2 completes successfully
      request2Subject.next({
        ...createTicket('ticket-1', 'agent-2'),
        version: 3
      });
      request2Subject.complete();

      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.agentLoad['agent-2']).toBe(1);
    });

    it('should apply optimistic update and rollback on HTTP 500 for autoAssignTicket', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      gateway.assignTicketResponse = () =>
        throwError(() => new Error('HTTP 500: Auto-assign failed'));

      let caughtError: any = null;
      facade.autoAssignTicket('ticket-1').subscribe({
        error: err => (caughtError = err)
      });

      expect(caughtError).toBeDefined();
      expect(facade.error).toContain('HTTP 500: Auto-assign failed');

      // State rolled back to unassigned
      expect(facade.state.tickets['ticket-1'].assigneeId).toBeUndefined();
      expect(facade.state.tickets['ticket-1'].version).toBe(1);
      expect(facade.state.agentLoad['agent-1']).toBe(0);
      expect(facade.state.agentLoad['agent-2']).toBe(0);
    });
  });

  describe('Undo Reassignment & SLA Benchmarking', () => {
    it('should track undo history and revert assignment to previous assignee', () => {
      const epoch = pipeline.getEpoch();
      // Create ticket initially assigned to agent-1
      pipeline.handleEvent({
        type: 'TicketCreated',
        eventId: 'evt-c-1',
        seq: 1,
        ticket: createTicket('ticket-1', 'agent-1')
      }, epoch);

      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.canUndoReassignment('ticket-1')).toBeFalse();

      // Gateway returns updated ticket for reassignment to agent-2
      gateway.assignTicketResponse = (id, agId, ver) => of({
        ...createTicket(id, agId),
        version: ver + 1
      });

      facade.assignTicket('ticket-1', 'agent-2').subscribe();

      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(facade.state.tickets['ticket-1'].version).toBe(2);
      expect(facade.canUndoReassignment('ticket-1')).toBeTrue();

      // Undo reassignment: restores agent-1
      facade.undoReassignment('ticket-1').subscribe();

      expect(facade.state.tickets['ticket-1'].assigneeId).toBe('agent-1');
      expect(facade.state.tickets['ticket-1'].version).toBe(3);
      expect(facade.canUndoReassignment('ticket-1')).toBeFalse();
    });

    it('should reject undo if ticket has been concurrently modified', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent({
        type: 'TicketCreated',
        eventId: 'evt-c-1',
        seq: 1,
        ticket: createTicket('ticket-1', 'agent-1')
      }, epoch);

      gateway.assignTicketResponse = (id, agId, ver) => of({
        ...createTicket(id, agId),
        version: ver + 1
      });

      facade.assignTicket('ticket-1', 'agent-2').subscribe();
      expect(facade.canUndoReassignment('ticket-1')).toBeTrue();

      // Concurrent modification: server emits status change bumping version to 3
      pipeline.handleEvent({
        type: 'TicketStatusChanged',
        eventId: 'evt-s-1',
        seq: 2,
        ticketId: 'ticket-1',
        status: 'pending_customer',
        at: '2026-11-18T10:15:00.000Z'
      }, epoch);

      // Current ticket version is now 3 (or higher), while record expects version 2
      expect(facade.canUndoReassignment('ticket-1')).toBeFalse();

      let undoError: Error | null = null;
      facade.undoReassignment('ticket-1').subscribe({
        error: (err) => (undoError = err)
      });

      expect(undoError).toBeDefined();
      expect(undoError!.message).toContain('Ticket has been concurrently modified or has no undo history');
    });

    it('should emit SLA benchmark metrics upon recomputing state', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent({
        type: 'TicketCreated',
        eventId: 'evt-c-1',
        seq: 1,
        ticket: createTicket('ticket-1')
      }, epoch);

      expect(facade.slaBenchmark).toBeDefined();
      expect(facade.slaBenchmark!.ticketCount).toBe(1);
      expect(facade.slaBenchmark!.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
