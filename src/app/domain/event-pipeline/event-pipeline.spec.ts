import {
  EventPipeline,
  DeskSnapshot,
  PipelineSyncStatus
} from './event-pipeline';
import {
  Agent,
  DeskEvent,
  StreamReset,
  Ticket,
  TicketAssigned,
  TicketCreated
} from '../models';
import {
  createInitialDeskState,
  ReducerDeskState
} from '../event-reducer';

describe('EventPipeline', () => {
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
    assigneeId?: string,
    eventId = `evt-${seq}`
  ): TicketCreated {
    return {
      type: 'TicketCreated',
      eventId,
      seq,
      ticket: createTicket(ticketId, assigneeId)
    };
  }

  function createTicketAssignedEvent(
    seq: number,
    ticketId: string,
    agentId: string,
    version = 2,
    eventId = `evt-${seq}`
  ): TicketAssigned {
    return {
      type: 'TicketAssigned',
      eventId,
      seq,
      ticketId,
      agentId,
      version
    };
  }

  function createStreamResetEvent(
    seq: number,
    eventId = `reset-${seq}`
  ): StreamReset {
    return {
      type: 'StreamReset',
      eventId,
      seq
    };
  }

  let pipeline: EventPipeline;

  beforeEach(() => {
    pipeline = new EventPipeline(standardAgents, { clock: mockClock });
  });

  describe('Scenario 1: Sequential Ingestion', () => {
    it('should process contiguous events 1, 2, 3 and emit each state transition with advancing lastSeq', () => {
      const emittedStates: number[] = [];
      pipeline.state$.subscribe(state => emittedStates.push(state.lastSeq));

      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', 'agent-1'), epoch);
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2', 'agent-2'), epoch);
      pipeline.handleEvent(createTicketAssignedEvent(3, 'ticket-1', 'agent-2', 2), epoch);

      expect(pipeline.state.lastSeq).toBe(3);
      expect(pipeline.bufferedCount).toBe(0);
      expect(emittedStates).toEqual([0, 1, 2, 3]);
      expect(pipeline.state.tickets['ticket-1'].assigneeId).toBe('agent-2');
      expect(pipeline.state.agentLoad['agent-1']).toBe(0);
      expect(pipeline.state.agentLoad['agent-2']).toBe(2);
    });
  });

  describe('Scenario 2: Gap Buffering & Contiguous Draining', () => {
    it('should buffer out-of-order events and drain them in strict sequence order once gap arrives', () => {
      const epoch = pipeline.getEpoch();

      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);
      expect(pipeline.state.lastSeq).toBe(1);

      // Ingest seq 3 and seq 4 (gap at 2)
      pipeline.handleEvent(createTicketCreatedEvent(3, 'ticket-3'), epoch);
      pipeline.handleEvent(createTicketCreatedEvent(4, 'ticket-4'), epoch);

      expect(pipeline.state.lastSeq).toBe(1);
      expect(pipeline.bufferedCount).toBe(2);
      expect(pipeline.getMissingSequences()).toEqual([2]);
      expect(pipeline.state.tickets['ticket-3']).toBeUndefined();

      // Ingest missing seq 2
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2'), epoch);

      // Now 2, 3, 4 should all be drained and applied
      expect(pipeline.state.lastSeq).toBe(4);
      expect(pipeline.bufferedCount).toBe(0);
      expect(pipeline.getMissingSequences()).toEqual([]);
      expect(pipeline.state.tickets['ticket-2']).toBeDefined();
      expect(pipeline.state.tickets['ticket-3']).toBeDefined();
      expect(pipeline.state.tickets['ticket-4']).toBeDefined();
    });
  });

  describe('Scenario 3: Buffer Overflow Protection', () => {
    it('should trigger gapOverflow and desynchronized status when maxBufferWindow is exceeded', () => {
      const smallWindowPipeline = new EventPipeline(standardAgents, {
        maxBufferWindow: 3,
        clock: mockClock
      });
      const epoch = smallWindowPipeline.getEpoch();

      let overflowSignal: any = null;
      let errorSignal: any = null;
      smallWindowPipeline.gapOverflow$.subscribe(sig => (overflowSignal = sig));
      smallWindowPipeline.error$.subscribe(err => (errorSignal = err));

      smallWindowPipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // Buffer 3 events: seq 3, 4, 5 (limit is 3)
      smallWindowPipeline.handleEvent(createTicketCreatedEvent(3, 'ticket-3'), epoch);
      smallWindowPipeline.handleEvent(createTicketCreatedEvent(4, 'ticket-4'), epoch);
      smallWindowPipeline.handleEvent(createTicketCreatedEvent(5, 'ticket-5'), epoch);

      expect(smallWindowPipeline.bufferedCount).toBe(3);
      expect(smallWindowPipeline.syncStatus).toBe('synced');
      expect(overflowSignal).toBeNull();

      // Ingest 6th event (would exceed window of 3)
      smallWindowPipeline.handleEvent(createTicketCreatedEvent(6, 'ticket-6'), epoch);

      expect(smallWindowPipeline.syncStatus).toBe('desynchronized');
      expect(smallWindowPipeline.bufferedCount).toBe(0); // Cleared
      expect(overflowSignal).toEqual({ missingSeq: 2, bufferedCount: 3 });
      expect(errorSignal?.message).toContain('exceeds maximum window of 3');
    });
  });

  describe('Scenario 4: Pre-Applied & Stale Duplicate Rejection', () => {
    it('should drop events with seq <= lastSeq or duplicate eventIds without mutating state', () => {
      const epoch = pipeline.getEpoch();

      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', undefined, 'evt-1'), epoch);
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2', undefined, 'evt-2'), epoch);

      const stateBefore = pipeline.state;

      // Duplicate event 2
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2-modified', undefined, 'evt-2'), epoch);
      // Older event 1
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1-modified', undefined, 'evt-1'), epoch);

      expect(pipeline.state).toBe(stateBefore);
      expect(pipeline.state.lastSeq).toBe(2);
    });
  });

  describe('Scenario 5: Duplicate ID with Different Sequence (Protocol Violation)', () => {
    it('should transition to desynchronized, emit error, and halt draining when duplicate eventId arrives with new seq', () => {
      const epoch = pipeline.getEpoch();
      let capturedError: any = null;
      pipeline.error$.subscribe(err => (capturedError = err));

      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', undefined, 'duplicate-id'), epoch);
      expect(pipeline.state.lastSeq).toBe(1);

      // Event 2 arrives with the same eventId 'duplicate-id'
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2', undefined, 'duplicate-id'), epoch);

      expect(pipeline.syncStatus).toBe('desynchronized');
      expect(pipeline.state.lastSeq).toBe(1); // Not advanced
      expect(capturedError?.message).toContain(
        "Protocol violation: eventId 'duplicate-id' was already processed, but arrived with new seq 2."
      );
    });
  });

  describe('Scenario 6: Case A - Identical Duplicate While Buffered', () => {
    it('should drop identical duplicates in the buffer and apply the event exactly once when gap is filled', () => {
      const stateWithSeq10: ReducerDeskState = {
        ...createInitialDeskState(standardAgents, fixedNow),
        lastSeq: 10
      };
      const pipelineWithSeq10 = new EventPipeline(stateWithSeq10, { clock: mockClock });
      const epoch = pipelineWithSeq10.getEpoch();

      // Ingest seq 12
      pipelineWithSeq10.handleEvent(createTicketCreatedEvent(12, 'ticket-12', undefined, 'evt-12'), epoch);
      expect(pipelineWithSeq10.bufferedCount).toBe(1);

      // Ingest exact duplicate seq 12
      pipelineWithSeq10.handleEvent(createTicketCreatedEvent(12, 'ticket-12', undefined, 'evt-12'), epoch);
      expect(pipelineWithSeq10.bufferedCount).toBe(1);

      // Ingest seq 11
      pipelineWithSeq10.handleEvent(createTicketCreatedEvent(11, 'ticket-11'), epoch);

      expect(pipelineWithSeq10.state.lastSeq).toBe(12);
      expect(pipelineWithSeq10.bufferedCount).toBe(0);
      expect(pipelineWithSeq10.state.tickets['ticket-11']).toBeDefined();
      expect(pipelineWithSeq10.state.tickets['ticket-12']).toBeDefined();
    });
  });

  describe('Scenario 7: Case B - Conflicting Buffered Sequence', () => {
    it('should flag sequence conflict protocol violation, not overwrite, and transition to desynchronized', () => {
      const stateWithSeq10: ReducerDeskState = {
        ...createInitialDeskState(standardAgents, fixedNow),
        lastSeq: 10
      };
      const pipelineWithSeq10 = new EventPipeline(stateWithSeq10, { clock: mockClock });
      const epoch = pipelineWithSeq10.getEpoch();
      let capturedError: any = null;
      pipelineWithSeq10.error$.subscribe(err => (capturedError = err));

      // Buffer seq 12 with evt-12-A
      pipelineWithSeq10.handleEvent(createTicketCreatedEvent(12, 'ticket-12-A', undefined, 'evt-12-A'), epoch);
      expect(pipelineWithSeq10.bufferedCount).toBe(1);

      // Incoming seq 12 with conflicting eventId 'evt-12-B'
      pipelineWithSeq10.handleEvent(createTicketCreatedEvent(12, 'ticket-12-B', undefined, 'evt-12-B'), epoch);

      expect(pipelineWithSeq10.syncStatus).toBe('desynchronized');
      expect(capturedError?.message).toContain(
        "Protocol violation: Sequence conflict at seq 12. Incoming eventId 'evt-12-B' conflicts with buffered 'evt-12-A'."
      );
      // Ensure existing event was NOT overwritten
      expect(pipelineWithSeq10.getBufferedEvents()[0].eventId).toBe('evt-12-A');
    });
  });

  describe('Scenario 8: StreamReset Sequence Guard', () => {
    it('should reject stale StreamReset events (seq <= lastSeq) without mutating state or buffer', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2'), epoch);
      pipeline.handleEvent(createTicketCreatedEvent(4, 'ticket-4'), epoch); // buffered

      expect(pipeline.state.lastSeq).toBe(2);
      expect(pipeline.bufferedCount).toBe(1);

      // Reset with seq 1 (stale)
      pipeline.handleEvent(createStreamResetEvent(1), epoch);
      expect(pipeline.state.lastSeq).toBe(2);
      expect(pipeline.bufferedCount).toBe(1);
      expect(pipeline.syncStatus).toBe('synced');

      // Reset with seq 2 (stale/equal)
      pipeline.handleEvent(createStreamResetEvent(2), epoch);
      expect(pipeline.state.lastSeq).toBe(2);
      expect(pipeline.bufferedCount).toBe(1);
      expect(pipeline.syncStatus).toBe('synced');
    });
  });

  describe('Scenario 9: Reset Gap Detection - Order 1 (Out-of-order gap)', () => {
    it('should set pendingResetSeq, identify both 16 and 17 as missing when 18 arrives, and preserve visible board', () => {
      const epoch1 = pipeline.getEpoch();
      for (let s = 1; s <= 10; s++) {
        pipeline.handleEvent(createTicketCreatedEvent(s, `ticket-${s}`), epoch1);
      }
      expect(pipeline.state.lastSeq).toBe(10);

      // StreamReset(15) accepted
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);

      expect(pipeline.pendingResetSeq).toBe(15);
      expect(pipeline.currentEpoch).toBe(2);
      expect(pipeline.syncStatus).toBe('resyncing');
      expect(pipeline.state.lastSeq).toBe(10); // Visible board preserved! Zero flicker!

      const epoch2 = pipeline.getEpoch();

      // Event with seq <= 15 on epoch 2 is dropped as obsolete pre-reset
      pipeline.handleEvent(createTicketCreatedEvent(14, 'ticket-14'), epoch2);
      expect(pipeline.bufferedCount).toBe(0);

      // Event 18 arrives first on epoch 2
      pipeline.handleEvent(createTicketCreatedEvent(18, 'ticket-18'), epoch2);

      expect(pipeline.bufferedCount).toBe(1);
      // Both 16 and 17 are missing relative to pendingResetSeq 15
      expect(pipeline.getMissingSequences()).toEqual([16, 17]);
      expect(pipeline.state.lastSeq).toBe(10); // Still visibly at 10
    });
  });

  describe('Scenario 10: Reset Gap Detection - Order 2 (Partial sequential then gap)', () => {
    it('should set pendingResetSeq, identify 0 missing on 16, and only 17 missing when 18 arrives', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);

      const epoch2 = pipeline.getEpoch();

      // Event 16 arrives first
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16'), epoch2);
      expect(pipeline.bufferedCount).toBe(1);
      expect(pipeline.getMissingSequences()).toEqual([]);

      // Event 18 arrives next
      pipeline.handleEvent(createTicketCreatedEvent(18, 'ticket-18'), epoch2);
      expect(pipeline.bufferedCount).toBe(2);
      expect(pipeline.getMissingSequences()).toEqual([17]);
    });
  });

  describe('Scenario 11: Connection Epoch Guard', () => {
    it('should reject events carrying old epoch after StreamReset bumped epoch', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);

      expect(pipeline.currentEpoch).toBe(2);

      // Late callback from connection 1 carrying epoch 1
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16'), 1);

      expect(pipeline.bufferedCount).toBe(0);
      expect(pipeline.getMissingSequences()).toEqual([]);
    });
  });

  describe('Scenario 12: Snapshot Hydration & Buffer Purge (Zero UI Flicker)', () => {
    it('should atomically hydrate snapshot, clear pendingResetSeq, purge covered buffer, and drain remaining events', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch1);
      expect(pipeline.state.lastSeq).toBe(1);

      pipeline.handleEvent(createStreamResetEvent(15), epoch1);
      const epoch2 = pipeline.getEpoch();

      // Post-reset events buffered
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16', 'agent-1'), epoch2);
      pipeline.handleEvent(createTicketCreatedEvent(18, 'ticket-18', 'agent-2'), epoch2);

      expect(pipeline.bufferedCount).toBe(2);

      const emittedStates: number[] = [];
      pipeline.state$.subscribe(s => emittedStates.push(s.lastSeq));

      // Server snapshot incorporates state up to sequence 16
      const snapshot: DeskSnapshot = {
        lastSeq: 16,
        tickets: {
          'ticket-16': createTicket('ticket-16', 'agent-1')
        },
        agents: standardAgents
      };

      pipeline.syncSnapshot(snapshot);

      expect(pipeline.syncStatus).toBe('synced');
      expect(pipeline.pendingResetSeq).toBeNull();
      expect(pipeline.state.lastSeq).toBe(16);
      expect(pipeline.state.tickets['ticket-16']).toBeDefined();

      // Buffered event 16 was purged (covered by snapshot).
      // Buffered event 18 remains buffered because 17 is missing.
      expect(pipeline.bufferedCount).toBe(1);
      expect(pipeline.getBufferedEvents()[0].seq).toBe(18);

      // Now event 17 arrives -> drains 17 and 18!
      pipeline.handleEvent(createTicketCreatedEvent(17, 'ticket-17', 'agent-1'), epoch2);

      expect(pipeline.state.lastSeq).toBe(18);
      expect(pipeline.bufferedCount).toBe(0);
      expect(pipeline.state.tickets['ticket-17']).toBeDefined();
      expect(pipeline.state.tickets['ticket-18']).toBeDefined();
    });
  });

  describe('Scenario 13: Snapshot Agent Validation (Mandatory & Empty vs Missing)', () => {
    it('should reject snapshot missing agents data and keep visible board', () => {
      let errorOccurred = false;
      pipeline.error$.subscribe(() => (errorOccurred = true));

      const invalidSnapshot = {
        lastSeq: 15,
        tickets: {}
      } as unknown as DeskSnapshot;

      pipeline.syncSnapshot(invalidSnapshot);

      expect(pipeline.syncStatus).toBe('error');
      expect(errorOccurred).toBe(true);
    });

    it('should reject snapshot if a ticket is assigned to an unknown agent', () => {
      let errorMessage = '';
      pipeline.error$.subscribe(err => (errorMessage = err.message));

      const invalidSnapshot: DeskSnapshot = {
        lastSeq: 15,
        tickets: {
          'ticket-1': createTicket('ticket-1', 'unknown-agent-99')
        },
        agents: standardAgents
      };

      pipeline.syncSnapshot(invalidSnapshot);

      expect(pipeline.syncStatus).toBe('error');
      expect(errorMessage).toContain("Ticket 'ticket-1' is assigned to unknown agent 'unknown-agent-99'");
    });

    it('should accept snapshot with empty agents collection when all tickets are unassigned', () => {
      const validEmptySnapshot: DeskSnapshot = {
        lastSeq: 15,
        tickets: {
          'ticket-1': createTicket('ticket-1') // unassigned
        },
        agents: {}
      };

      pipeline.syncSnapshot(validEmptySnapshot);

      expect(pipeline.syncStatus).toBe('synced');
      expect(pipeline.state.lastSeq).toBe(15);
      expect(pipeline.state.tickets['ticket-1']).toBeDefined();
      expect(pipeline.state.agentLoad).toEqual({});
    });

    it('should accurately recompute agentLoad for all non-resolved tickets', () => {
      const snapshot: DeskSnapshot = {
        lastSeq: 20,
        tickets: {
          'ticket-1': createTicket('ticket-1', 'agent-1', 'open'),
          'ticket-2': createTicket('ticket-2', 'agent-1', 'open'),
          'ticket-3': createTicket('ticket-3', 'agent-1', 'resolved'),
          'ticket-4': createTicket('ticket-4', 'agent-2', 'open')
        },
        agents: standardAgents
      };

      pipeline.syncSnapshot(snapshot);

      expect(pipeline.state.agentLoad['agent-1']).toBe(2); // resolved not counted
      expect(pipeline.state.agentLoad['agent-2']).toBe(1);
    });
  });

  describe('Scenario 14: Snapshot Fetch Failure & Board Retention', () => {
    it('should transition syncStatus to error, keep visible board on state$, and retain post-reset buffer', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch1);
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);

      const epoch2 = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16'), epoch2);

      let emittedError: any = null;
      pipeline.error$.subscribe(err => (emittedError = err));

      pipeline.notifySnapshotFailure(new Error('Network timeout during GET /tickets'));

      expect(pipeline.syncStatus).toBe('error');
      expect(emittedError?.message).toBe('Network timeout during GET /tickets');
      expect(pipeline.state.lastSeq).toBe(1); // Visible board preserved!
      expect(pipeline.bufferedCount).toBe(1); // Event 16 preserved!
    });
  });

  describe('Scenario 15: Snapshot Retry Success', () => {
    it('should hydrate state and drain preserved buffered events after snapshot retry succeeds', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);
      const epoch2 = pipeline.getEpoch();

      // Buffer live post-reset events
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16', 'agent-1'), epoch2);
      pipeline.handleEvent(createTicketCreatedEvent(17, 'ticket-17', 'agent-2'), epoch2);

      // Attempt 1 fails
      pipeline.notifySnapshotFailure(new Error('HTTP 500'));
      expect(pipeline.syncStatus).toBe('error');
      expect(pipeline.bufferedCount).toBe(2);

      // Attempt 2 succeeds
      const snapshot: DeskSnapshot = {
        lastSeq: 15,
        tickets: {},
        agents: standardAgents
      };

      pipeline.syncSnapshot(snapshot);

      expect(pipeline.syncStatus).toBe('synced');
      expect(pipeline.state.lastSeq).toBe(17); // 16 and 17 drained!
      expect(pipeline.bufferedCount).toBe(0);
      expect(pipeline.state.tickets['ticket-16']).toBeDefined();
      expect(pipeline.state.tickets['ticket-17']).toBeDefined();
    });
  });

  describe('Scenario 16: Repeated Snapshot Failures', () => {
    it('should maintain error status and preserve board and buffer across multiple failures without crash', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);
      const epoch2 = pipeline.getEpoch();

      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16'), epoch2);

      const errors: string[] = [];
      pipeline.error$.subscribe(err => errors.push(err.message));

      pipeline.notifySnapshotFailure(new Error('Failure 1'));
      pipeline.notifySnapshotFailure(new Error('Failure 2'));
      pipeline.notifySnapshotFailure(new Error('Failure 3'));

      expect(pipeline.syncStatus).toBe('error');
      expect(errors).toEqual(['Failure 1', 'Failure 2', 'Failure 3']);
      expect(pipeline.bufferedCount).toBe(1);
      expect(pipeline.state.lastSeq).toBe(0);
    });
  });

  describe('Stale Snapshot Sequence Guard', () => {
    it('should reject snapshot if snapshot.lastSeq is less than pendingResetSeq', () => {
      const epoch = pipeline.getEpoch();
      pipeline.handleEvent(createStreamResetEvent(15), epoch);

      let errMessage = '';
      pipeline.error$.subscribe(err => (errMessage = err.message));

      pipeline.syncSnapshot({
        lastSeq: 14, // less than 15!
        tickets: {},
        agents: standardAgents
      });

      expect(pipeline.syncStatus).toBe('error');
      expect(errMessage).toContain('Stale snapshot rejected: snapshot.lastSeq (14) is less than pendingResetSeq (15)');
    });
  });

  describe('Issue 1: Events Arriving After notifySnapshotFailure() While pendingResetSeq Is Active', () => {
    it('should continue buffering live events that arrive after notifySnapshotFailure() and drain them on retry', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch1);
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);
      const epoch2 = pipeline.getEpoch();

      // Snapshot attempt 1 fails
      pipeline.notifySnapshotFailure(new Error('Initial fetch failed'));
      expect(pipeline.syncStatus).toBe('error');
      expect(pipeline.pendingResetSeq).toBe(15);

      // Live events arrive AFTER notifySnapshotFailure() while pendingResetSeq is active
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16', 'agent-1'), epoch2);
      pipeline.handleEvent(createTicketCreatedEvent(17, 'ticket-17', 'agent-2'), epoch2);

      // Verifies that post-reset events were NOT dropped; they are safely buffered
      expect(pipeline.bufferedCount).toBe(2);

      // Snapshot retry succeeds
      const retrySnapshot: DeskSnapshot = {
        lastSeq: 15,
        tickets: {},
        agents: standardAgents
      };
      pipeline.syncSnapshot(retrySnapshot);

      expect(pipeline.syncStatus).toBe('synced');
      expect(pipeline.state.lastSeq).toBe(17); // 16 and 17 drained seamlessly
      expect(pipeline.bufferedCount).toBe(0);
      expect(pipeline.state.tickets['ticket-16']).toBeDefined();
      expect(pipeline.state.tickets['ticket-17']).toBeDefined();
    });
  });

  describe('Issue 2: Duplicate eventId Across Different Sequences in sequenceBuffer', () => {
    it('should detect duplicate eventId across different sequences in sequenceBuffer as a protocol violation', () => {
      const epoch = pipeline.getEpoch();
      let capturedError: any = null;
      pipeline.error$.subscribe(err => (capturedError = err));

      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // Buffer seq 3 with eventId 'shared-id'
      pipeline.handleEvent(createTicketCreatedEvent(3, 'ticket-3', undefined, 'shared-id'), epoch);
      expect(pipeline.bufferedCount).toBe(1);

      // Incoming seq 4 with the SAME eventId 'shared-id'
      pipeline.handleEvent(createTicketCreatedEvent(4, 'ticket-4', undefined, 'shared-id'), epoch);

      expect(pipeline.syncStatus).toBe('desynchronized');
      expect(capturedError?.message).toContain(
        "Protocol violation: Duplicate eventId 'shared-id' detected in sequence buffer at seq 3 and incoming seq 4."
      );
    });
  });

  describe('Issue 3: processedEventIds Retention Across StreamReset and syncSnapshot()', () => {
    it('should retain both pre-reset event IDs and StreamReset event ID in processedEventIds after syncSnapshot(), rejecting replays of either', () => {
      const epoch1 = pipeline.getEpoch();

      // 1. Process event before StreamReset
      pipeline.handleEvent(
        createTicketCreatedEvent(1, 'ticket-pre', undefined, 'pre-reset-event-1'),
        epoch1
      );
      expect(pipeline.state.processedEventIds['pre-reset-event-1']).toBe(true);

      // 2. Process StreamReset with a specific eventId
      pipeline.handleEvent(createStreamResetEvent(15, 'reset-event-15'), epoch1);

      // 3. Hydrate state via snapshot
      pipeline.syncSnapshot({
        lastSeq: 15,
        tickets: {},
        agents: standardAgents
      });

      // Assertions:
      // - Pre-reset event ID remains in processedEventIds
      expect(pipeline.state.processedEventIds['pre-reset-event-1']).toBe(true);
      // - StreamReset event ID is also retained
      expect(pipeline.state.processedEventIds['reset-event-15']).toBe(true);

      const epoch2 = pipeline.getEpoch();
      const stateBefore = pipeline.state;

      // 4. Replay of pre-reset event ID with seq <= lastSeq (15) is dropped as duplicate/stale
      pipeline.handleEvent(
        createTicketCreatedEvent(1, 'ticket-pre-replayed', undefined, 'pre-reset-event-1'),
        epoch2
      );
      expect(pipeline.state).toBe(stateBefore);

      // Replay of pre-reset event ID with seq > lastSeq (16) is caught as a protocol violation
      let capturedError: any = null;
      pipeline.error$.subscribe(err => (capturedError = err));
      pipeline.handleEvent(
        createTicketCreatedEvent(16, 'ticket-pre-replayed-new-seq', undefined, 'pre-reset-event-1'),
        epoch2
      );
      expect(pipeline.syncStatus).toBe('desynchronized');
      expect(capturedError?.message).toContain(
        "Protocol violation: eventId 'pre-reset-event-1' was already processed, but arrived with new seq 16."
      );

      // 5. Replay of StreamReset event ID is rejected
      const pipelineForResetTest = new EventPipeline(standardAgents, { clock: mockClock });
      const pEpoch = pipelineForResetTest.getEpoch();
      pipelineForResetTest.handleEvent(createStreamResetEvent(15, 'reset-event-15'), pEpoch);
      pipelineForResetTest.syncSnapshot({ lastSeq: 15, tickets: {}, agents: standardAgents });
      const pEpoch2 = pipelineForResetTest.getEpoch();
      const pStateBefore = pipelineForResetTest.state;

      pipelineForResetTest.handleEvent(createStreamResetEvent(20, 'reset-event-15'), pEpoch2);
      expect(pipelineForResetTest.state).toBe(pStateBefore);
      expect(pipelineForResetTest.currentEpoch).toBe(pEpoch2); // Epoch not bumped again
    });
  });

  describe('Issue 4: Maximum Sequence Gap Distance in Addition to Buffer Size', () => {
    it('should trigger gapOverflow when sequence gap distance exceeds maxBufferWindow even for a single event', () => {
      const pipelineWithWindow10 = new EventPipeline(standardAgents, {
        maxBufferWindow: 10,
        clock: mockClock
      });
      const epoch = pipelineWithWindow10.getEpoch();

      let overflowSignal: any = null;
      let errorSignal: any = null;
      pipelineWithWindow10.gapOverflow$.subscribe(sig => (overflowSignal = sig));
      pipelineWithWindow10.error$.subscribe(err => (errorSignal = err));

      pipelineWithWindow10.handleEvent(createTicketCreatedEvent(1, 'ticket-1'), epoch);

      // An event arrives with seq: 25 (gap distance is 25 - 1 = 24 > 10)
      pipelineWithWindow10.handleEvent(createTicketCreatedEvent(25, 'ticket-25'), epoch);

      expect(pipelineWithWindow10.syncStatus).toBe('desynchronized');
      expect(overflowSignal).toEqual({ missingSeq: 2, bufferedCount: 0 });
      expect(errorSignal?.message).toContain(
        'Sequence gap distance of 23 (seq 25 relative to expected seq 2) exceeds maximum window of 10.'
      );
    });
  });

  describe('Issue 5: Validation of Incoming seq as a Non-Negative Safe Integer', () => {
    it('should reject invalid sequence numbers (negative, non-integer, unsafe integer)', () => {
      const epoch = pipeline.getEpoch();

      expect(() => {
        pipeline.handleEvent({ type: 'TicketCreated', eventId: 'e-1', seq: -1 } as any, epoch);
      }).toThrowError(/Invalid DeskEvent received/);

      expect(() => {
        pipeline.handleEvent({ type: 'TicketCreated', eventId: 'e-2', seq: 2.5 } as any, epoch);
      }).toThrowError(/Invalid DeskEvent received/);

      expect(() => {
        pipeline.handleEvent({ type: 'TicketCreated', eventId: 'e-3', seq: NaN } as any, epoch);
      }).toThrowError(/Invalid DeskEvent received/);

      expect(() => {
        pipeline.handleEvent(
          { type: 'TicketCreated', eventId: 'e-4', seq: Number.MAX_SAFE_INTEGER + 10 } as any,
          epoch
        );
      }).toThrowError(/Invalid DeskEvent received/);
    });

    it('should reject snapshot with invalid lastSeq (negative, non-integer, unsafe integer)', () => {
      let errorMessage = '';
      pipeline.error$.subscribe(err => (errorMessage = err.message));

      pipeline.syncSnapshot({
        lastSeq: -5,
        tickets: {},
        agents: standardAgents
      });

      expect(pipeline.syncStatus).toBe('error');
      expect(errorMessage).toContain("lastSeq '-5' must be a non-negative safe integer");
    });
  });

  describe('Issue 6: Board Retention and Zero-Flicker Atomic Snapshot Publication', () => {
    it('should prove state$ retains visible board with zero empty emissions during StreamReset and failure, and emits atomically on syncSnapshot', () => {
      const epoch1 = pipeline.getEpoch();
      pipeline.handleEvent(createTicketCreatedEvent(1, 'ticket-1', 'agent-1'), epoch1);
      pipeline.handleEvent(createTicketCreatedEvent(2, 'ticket-2', 'agent-2'), epoch1);

      expect(pipeline.state.lastSeq).toBe(2);

      // Track all emissions on public state$
      const observedStateHistory: { ticketCount: number; lastSeq: number }[] = [];
      pipeline.state$.subscribe(s => {
        observedStateHistory.push({
          ticketCount: Object.keys(s.tickets).length,
          lastSeq: s.lastSeq
        });
      });

      // Initially subscribed receives current state
      expect(observedStateHistory.length).toBe(1);
      expect(observedStateHistory[0]).toEqual({ ticketCount: 2, lastSeq: 2 });

      // Step 1: StreamReset arrives
      pipeline.handleEvent(createStreamResetEvent(15), epoch1);

      // state$ must NOT emit empty tickets {}!
      expect(observedStateHistory.length).toBe(1);
      expect(pipeline.state.lastSeq).toBe(2);
      expect(pipeline.state.tickets['ticket-1']).toBeDefined();

      const epoch2 = pipeline.getEpoch();
      // Step 2: Live post-reset event arrives and buffers
      pipeline.handleEvent(createTicketCreatedEvent(16, 'ticket-16', 'agent-1'), epoch2);
      expect(observedStateHistory.length).toBe(1);

      // Step 3: Snapshot failure occurs
      pipeline.notifySnapshotFailure(new Error('Gateway timeout'));
      expect(observedStateHistory.length).toBe(1); // STILL NO EMISSION!
      expect(pipeline.state.tickets['ticket-1']).toBeDefined(); // BOARD STILL VISIBLE!

      // Step 4: Snapshot arrives with replacement tickets
      const snapshot: DeskSnapshot = {
        lastSeq: 15,
        tickets: {
          'ticket-fresh-A': createTicket('ticket-fresh-A', 'agent-1'),
          'ticket-fresh-B': createTicket('ticket-fresh-B', 'agent-2'),
          'ticket-fresh-C': createTicket('ticket-fresh-C', 'agent-1')
        },
        agents: standardAgents
      };

      pipeline.syncSnapshot(snapshot);

      // Atomic transition! Exactly one emission from snapshot + one emission from draining seq 16
      // None of the emissions ever had 0 tickets!
      expect(observedStateHistory.length).toBe(3); // [initial (2), snapshot (3), drained 16 (4)]
      expect(observedStateHistory[1]).toEqual({ ticketCount: 3, lastSeq: 15 });
      expect(observedStateHistory[2]).toEqual({ ticketCount: 4, lastSeq: 16 });

      // Invariant: zero intermediate empty-board emissions
      for (const emission of observedStateHistory) {
        expect(emission.ticketCount).toBeGreaterThan(0);
      }
    });
  });
});
