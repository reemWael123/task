import {
  applyEvent,
  createInitialDeskState,
  ReducerDeskState,
  PARKED_EVENT_TTL_MS
} from './event-reducer';
import {
  Agent,
  Ticket,
  TicketCreated,
  TicketStatusChanged,
  TicketAssigned,
  AgentStatusChanged,
  StreamReset
} from '../models';

describe('EventReducer (Step 1.4)', () => {
  // Helpers
  function createAgent(id: string, name: string): Agent {
    return {
      id,
      name,
      skills: ['billing'],
      status: 'online',
      maxLoad: 5,
      shift: { start: '09:00', end: '17:00', tz: 'UTC' }
    };
  }

  function createTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
    return {
      id,
      version: 1,
      priority: 'P2',
      status: 'open',
      customerTier: 'standard',
      region: 'EU',
      skills: ['billing'],
      createdAt: '2026-01-05T09:00:00Z',
      statusHistory: [],
      ...overrides
    };
  }

  function deepFreeze<T>(obj: T): T {
    if (obj && typeof obj === 'object') {
      Object.freeze(obj);
      for (const key of Object.keys(obj)) {
        deepFreeze((obj as Record<string, unknown>)[key]);
      }
    }
    return obj;
  }

  const agent1 = createAgent('agent-1', 'Agent One');
  const agent2 = createAgent('agent-2', 'Agent Two');
  const baseAgents = { 'agent-1': agent1, 'agent-2': agent2 };

  describe('1. createInitialDeskState', () => {
    it('should initialize agentLoad to 0 for every provided agent', () => {
      const state = createInitialDeskState(baseAgents, new Date('2026-01-05T09:00:00Z'));
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.agentLoad['agent-2']).toBe(0);
      expect(state.lastSeq).toBe(0);
      expect(state.tickets).toEqual({});
      expect(state.parkedEvents).toEqual({});
      expect(state.processedEventIds).toEqual({});
    });

    it('should handle undefined agents gracefully', () => {
      const state = createInitialDeskState(undefined, new Date('2026-01-05T09:00:00Z'));
      expect(state.agents).toEqual({});
      expect(state.agentLoad).toEqual({});
    });
  });

  describe('2. Standard In-Order Lifecycle', () => {
    let state: ReducerDeskState;
    const now = new Date('2026-01-05T09:00:00Z');

    beforeEach(() => {
      state = createInitialDeskState(baseAgents, now);
    });

    it('should apply TicketCreated for an unassigned ticket without altering load', () => {
      const event: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: undefined })
      };

      const next = applyEvent(state, event, now);
      expect(next.tickets['T1']).toBeDefined();
      expect(next.tickets['T1'].id).toBe('T1');
      expect(next.agentLoad['agent-1']).toBe(0);
      expect(next.lastSeq).toBe(1);
      expect(next.processedEventIds['evt-1']).toBeTrue();
    });

    it('should apply TicketCreated with initial assignee and increment load', () => {
      const event: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1' })
      };

      const next = applyEvent(state, event, now);
      expect(next.tickets['T1'].assigneeId).toBe('agent-1');
      expect(next.agentLoad['agent-1']).toBe(1);
      expect(next.agentLoad['agent-2']).toBe(0);
    });

    it('should apply TicketCreated with pre-resolved status without incrementing load', () => {
      const event: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', status: 'resolved' })
      };

      const next = applyEvent(state, event, now);
      expect(next.tickets['T1'].status).toBe('resolved');
      expect(next.agentLoad['agent-1']).toBe(0);
    });

    it('should apply TicketStatusChanged transitions and update statusHistory and load', () => {
      // 1. Create ticket assigned to agent-1
      const created: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', status: 'open' })
      };
      let s = applyEvent(state, created, now);
      expect(s.agentLoad['agent-1']).toBe(1);

      // 2. Transition open -> pending_customer (non-resolved -> non-resolved: no load change)
      const toPending: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:15:00Z'
      };
      s = applyEvent(s, toPending, new Date('2026-01-05T09:15:00Z'));
      expect(s.tickets['T1'].status).toBe('pending_customer');
      expect(s.tickets['T1'].statusHistory.length).toBe(1);
      expect(s.tickets['T1'].statusHistory[0]).toEqual({ status: 'pending_customer', at: '2026-01-05T09:15:00Z' });
      expect(s.agentLoad['agent-1']).toBe(1);

      // 3. Transition pending_customer -> on_hold
      const toOnHold: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-3',
        seq: 3,
        ticketId: 'T1',
        status: 'on_hold',
        at: '2026-01-05T09:30:00Z'
      };
      s = applyEvent(s, toOnHold, new Date('2026-01-05T09:30:00Z'));
      expect(s.tickets['T1'].status).toBe('on_hold');
      expect(s.agentLoad['agent-1']).toBe(1);

      // 4. Transition on_hold -> resolved (decrements load, sets resolvedAt)
      const toResolved: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-4',
        seq: 4,
        ticketId: 'T1',
        status: 'resolved',
        at: '2026-01-05T10:00:00Z'
      };
      s = applyEvent(s, toResolved, new Date('2026-01-05T10:00:00Z'));
      expect(s.tickets['T1'].status).toBe('resolved');
      expect(s.tickets['T1'].resolvedAt).toBe('2026-01-05T10:00:00Z');
      expect(s.agentLoad['agent-1']).toBe(0);

      // 5. Reopen resolved -> open (increments load)
      const toReopened: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-5',
        seq: 5,
        ticketId: 'T1',
        status: 'open',
        at: '2026-01-05T10:30:00Z'
      };
      s = applyEvent(s, toReopened, new Date('2026-01-05T10:30:00Z'));
      expect(s.tickets['T1'].status).toBe('open');
      expect(s.agentLoad['agent-1']).toBe(1);
    });

    it('should apply TicketAssigned and update assignee, version, and loads', () => {
      // 1. Create ticket assigned to agent-1
      const created: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', version: 1, status: 'open' })
      };
      let s = applyEvent(state, created, now);
      expect(s.agentLoad['agent-1']).toBe(1);
      expect(s.agentLoad['agent-2']).toBe(0);

      // 2. Reassign to agent-2 with version 2
      const assigned: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        agentId: 'agent-2',
        version: 2
      };
      s = applyEvent(s, assigned, now);
      expect(s.tickets['T1'].assigneeId).toBe('agent-2');
      expect(s.tickets['T1'].version).toBe(2);
      expect(s.agentLoad['agent-1']).toBe(0);
      expect(s.agentLoad['agent-2']).toBe(1);
    });

    it('should update agent.status on AgentStatusChanged without altering load', () => {
      const event: AgentStatusChanged = {
        type: 'AgentStatusChanged',
        eventId: 'evt-1',
        seq: 1,
        agentId: 'agent-1',
        status: 'busy'
      };
      const next = applyEvent(state, event, now);
      expect(next.agents['agent-1'].status).toBe('busy');
      expect(next.agentLoad['agent-1']).toBe(0);
      expect(next.lastSeq).toBe(1);
    });
  });

  describe('3. Idempotency & Deduplication', () => {
    it('should return exact same state reference when identical eventId is re-processed', () => {
      const state = createInitialDeskState(baseAgents, new Date());
      const event: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1' })
      };

      const first = applyEvent(state, event);
      expect(first.agentLoad['agent-1']).toBe(1);

      // Duplicate delivery
      const second = applyEvent(first, event);
      expect(second).toBe(first); // Identity equality
      expect(second.agentLoad['agent-1']).toBe(1); // Load not incremented twice
    });

    it('should not park duplicate eventId multiple times', () => {
      const state = createInitialDeskState(baseAgents, new Date());
      const unknownStatus: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-park-1',
        seq: 2,
        ticketId: 'T-UNKNOWN',
        status: 'pending_customer',
        at: '2026-01-05T09:15:00Z'
      };

      const first = applyEvent(state, unknownStatus);
      expect(first.parkedEvents['T-UNKNOWN'].length).toBe(1);

      // Same event delivered again while parked
      const second = applyEvent(first, unknownStatus);
      expect(second.parkedEvents['T-UNKNOWN'].length).toBe(1); // Not duplicated
    });
  });

  describe('4. Registered Agent Validation', () => {
    it('should reject TicketCreated with unknown initial assignee and leave state untouched', () => {
      const state = createInitialDeskState(baseAgents, new Date());
      const event: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'non-existent-agent' })
      };

      expect(() => applyEvent(state, event)).toThrowError(
        /Cannot create ticket 'T1' with unknown initial assignee 'non-existent-agent'\. Agent must exist in state\.agents\./
      );

      // Verify state was untouched
      expect(state.tickets['T1']).toBeUndefined();
      expect(state.lastSeq).toBe(0);
    });

    it('should reject TicketAssigned with unknown agentId and leave ticket and loads untouched', () => {
      let state = createInitialDeskState(baseAgents, new Date());
      const created: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', version: 1 })
      };
      state = applyEvent(state, created);
      expect(state.agentLoad['agent-1']).toBe(1);

      const invalidAssign: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        agentId: 'ghost-agent',
        version: 2
      };

      expect(() => applyEvent(state, invalidAssign)).toThrowError(
        /Cannot assign ticket 'T1' to unknown agent 'ghost-agent'\. Agent must exist in state\.agents\./
      );

      // Unmodified
      expect(state.tickets['T1'].assigneeId).toBe('agent-1');
      expect(state.tickets['T1'].version).toBe(1);
      expect(state.agentLoad['agent-1']).toBe(1);
      expect(state.agentLoad['ghost-agent']).toBeUndefined();
    });
  });

  describe('5. TicketAssigned Version Protection', () => {
    let state: ReducerDeskState;

    beforeEach(() => {
      state = createInitialDeskState(baseAgents, new Date());
      state = applyEvent(state, {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', version: 2 })
      });
    });

    it('should reject non-positive integer version with validation error', () => {
      expect(() =>
        applyEvent(state, {
          type: 'TicketAssigned',
          eventId: 'evt-v0',
          seq: 2,
          ticketId: 'T1',
          agentId: 'agent-2',
          version: 0
        })
      ).toThrowError(/Invalid version '0'/);

      expect(() =>
        applyEvent(state, {
          type: 'TicketAssigned',
          eventId: 'evt-vneg',
          seq: 2,
          ticketId: 'T1',
          agentId: 'agent-2',
          version: -2
        })
      ).toThrowError(/Invalid version '-2'/);

      expect(() =>
        applyEvent(state, {
          type: 'TicketAssigned',
          eventId: 'evt-vfloat',
          seq: 2,
          ticketId: 'T1',
          agentId: 'agent-2',
          version: 2.5
        })
      ).toThrowError(/Invalid version '2.5'/);
    });

    it('should ignore stale TicketAssigned where version < ticket.version', () => {
      // Current ticket version is 2, assigned to agent-1
      const staleAssign: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-stale',
        seq: 2,
        ticketId: 'T1',
        agentId: 'agent-2',
        version: 1 // Older than 2
      };

      const next = applyEvent(state, staleAssign);
      expect(next.tickets['T1'].assigneeId).toBe('agent-1'); // Not overwritten
      expect(next.tickets['T1'].version).toBe(2);
      expect(next.agentLoad['agent-1']).toBe(1);
      expect(next.agentLoad['agent-2']).toBe(0);
      expect(next.processedEventIds['evt-stale']).toBeTrue();
    });

    it('should ignore duplicate TicketAssigned where version === ticket.version', () => {
      const equalAssign: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-equal',
        seq: 2,
        ticketId: 'T1',
        agentId: 'agent-2',
        version: 2 // Equal to 2
      };

      const next = applyEvent(state, equalAssign);
      expect(next.tickets['T1'].assigneeId).toBe('agent-1'); // Not overwritten
      expect(next.tickets['T1'].version).toBe(2);
      expect(next.agentLoad['agent-1']).toBe(1);
      expect(next.agentLoad['agent-2']).toBe(0);
    });
  });

  describe('6. Strict Agent Load Invariant (No Silent Clamping)', () => {
    it('should throw an invariant violation error when load decrement is attempted at load 0', () => {
      // Ticket status says 'open', but agent-1 load is manually corrupted to 0
      const corruptedState: ReducerDeskState = {
        ...createInitialDeskState(baseAgents),
        tickets: {
          T1: createTicket('T1', { assigneeId: 'agent-1', status: 'open' })
        },
        agentLoad: { 'agent-1': 0 } // Corrupted
      };

      const resolveEvent: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-res',
        seq: 2,
        ticketId: 'T1',
        status: 'resolved',
        at: '2026-01-05T10:00:00Z'
      };

      expect(() => applyEvent(corruptedState, resolveEvent)).toThrowError(
        /Invariant violation: Cannot decrement agentLoad below 0 for agent 'agent-1'\./
      );
    });

    it('should not alter load when resolving an already resolved ticket', () => {
      let state = createInitialDeskState(baseAgents);
      state = applyEvent(state, {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', status: 'resolved' })
      });
      expect(state.agentLoad['agent-1']).toBe(0);

      // Another resolve event on resolved ticket
      state = applyEvent(state, {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        status: 'resolved',
        at: '2026-01-05T10:00:00Z'
      });
      expect(state.agentLoad['agent-1']).toBe(0);
    });

    it('should not alter load when reassigning a resolved ticket', () => {
      let state = createInitialDeskState(baseAgents);
      state = applyEvent(state, {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1', status: 'resolved', version: 1 })
      });
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.agentLoad['agent-2']).toBe(0);

      state = applyEvent(state, {
        type: 'TicketAssigned',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        agentId: 'agent-2',
        version: 2
      });

      expect(state.tickets['T1'].assigneeId).toBe('agent-2');
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.agentLoad['agent-2']).toBe(0);
    });
  });

  describe('7. Parked Events, Replay & 10s TTL Boundaries', () => {
    it('should park events for unknown tickets and replay when TicketCreated arrives', () => {
      const t0 = new Date('2026-01-05T09:00:00Z');
      let state = createInitialDeskState(baseAgents, t0);

      // Event 2 arrives: TicketStatusChanged for unknown T1
      const evt2: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:00:02Z'
      };
      state = applyEvent(state, evt2, new Date(t0.getTime() + 2_000));
      expect(state.tickets['T1']).toBeUndefined();
      expect(state.parkedEvents['T1'].length).toBe(1);
      expect(state.lastSeq).toBe(2);

      // Event 3 arrives: TicketAssigned for unknown T1
      const evt3: TicketAssigned = {
        type: 'TicketAssigned',
        eventId: 'evt-3',
        seq: 3,
        ticketId: 'T1',
        agentId: 'agent-1',
        version: 2
      };
      state = applyEvent(state, evt3, new Date(t0.getTime() + 3_000));
      expect(state.parkedEvents['T1'].length).toBe(2);
      expect(state.lastSeq).toBe(3);

      // Event 1 arrives: TicketCreated(seq: 1) within TTL (at t0 + 4s)
      const evt1: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: undefined, version: 1, status: 'open' })
      };
      state = applyEvent(state, evt1, new Date(t0.getTime() + 4_000));

      // Replay executed in seq order!
      expect(state.tickets['T1']).toBeDefined();
      expect(state.tickets['T1'].status).toBe('pending_customer'); // Updated by seq 2
      expect(state.tickets['T1'].assigneeId).toBe('agent-1'); // Updated by seq 3
      expect(state.tickets['T1'].version).toBe(2);
      expect(state.agentLoad['agent-1']).toBe(1); // Load accounted for
      expect(state.parkedEvents['T1']).toBeUndefined(); // Cleared
      expect(state.lastSeq).toBe(3); // Never regressed backwards
    });

    it('should replay an event at exactly 10,000 ms age (boundary)', () => {
      const parkTime = new Date('2026-01-05T09:00:00Z');
      let state = createInitialDeskState(baseAgents, parkTime);

      const evt2: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:00:00Z'
      };
      state = applyEvent(state, evt2, parkTime);

      // Exactly 10,000 ms later: still eligible!
      const exactBoundary = new Date(parkTime.getTime() + PARKED_EVENT_TTL_MS);
      const evt1: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { status: 'open' })
      };
      state = applyEvent(state, evt1, exactBoundary);

      expect(state.tickets['T1'].status).toBe('pending_customer'); // Successfully replayed
    });

    it('should discard an event at 10,001 ms age as expired and record eventId in processedEventIds', () => {
      const parkTime = new Date('2026-01-05T09:00:00Z');
      let state = createInitialDeskState(baseAgents, parkTime);

      const evt2: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-expired',
        seq: 2,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:00:00Z'
      };
      state = applyEvent(state, evt2, parkTime);

      // 10,001 ms later: expired!
      const expiredTime = new Date(parkTime.getTime() + PARKED_EVENT_TTL_MS + 1);
      const evt1: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { status: 'open' })
      };
      state = applyEvent(state, evt1, expiredTime);

      expect(state.tickets['T1'].status).toBe('open'); // Replay was discarded!
      expect(state.processedEventIds['evt-expired']).toBeTrue(); // Finalized

      // Attempting to re-deliver the expired event later must be rejected and not re-parked
      const reDelivered = applyEvent(state, evt2, new Date(parkTime.getTime() + 15_000));
      expect(reDelivered.parkedEvents['T1']).toBeUndefined(); // Cannot restart TTL
    });

    it('should discard parked events with seq < TicketCreated.seq per Option 1A', () => {
      const parkTime = new Date('2026-01-05T09:00:00Z');
      let state = createInitialDeskState(baseAgents, parkTime);

      // Pre-creation events parked at seq 2 and 3
      state = applyEvent(
        state,
        {
          type: 'TicketStatusChanged',
          eventId: 'evt-2',
          seq: 2,
          ticketId: 'T1',
          status: 'pending_customer',
          at: '2026-01-05T09:00:02Z'
        },
        parkTime
      );

      state = applyEvent(
        state,
        {
          type: 'TicketAssigned',
          eventId: 'evt-3',
          seq: 3,
          ticketId: 'T1',
          agentId: 'agent-1',
          version: 2
        },
        parkTime
      );

      // TicketCreated arrives with seq: 4 (newer than parked 2 and 3)
      const evt4: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-4',
        seq: 4,
        ticket: createTicket('T1', {
          status: 'open',
          assigneeId: undefined,
          version: 1,
          statusHistory: []
        })
      };
      state = applyEvent(state, evt4, new Date(parkTime.getTime() + 1_000));

      // Option 1A: seq 2 and 3 are discarded as superseded by seq 4
      expect(state.tickets['T1'].status).toBe('open');
      expect(state.tickets['T1'].assigneeId).toBeUndefined();
      expect(state.tickets['T1'].version).toBe(1);
      expect(state.tickets['T1'].statusHistory).toEqual([]);
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.parkedEvents['T1']).toBeUndefined();
      expect(state.processedEventIds['evt-2']).toBeTrue();
      expect(state.processedEventIds['evt-3']).toBeTrue();
    });
  });

  describe('8. Global lastSeq Monotonicity', () => {
    it('should never move lastSeq backwards when applying lower sequence events', () => {
      let state = createInitialDeskState(baseAgents);

      // Higher sequence parked first
      state = applyEvent(state, {
        type: 'TicketStatusChanged',
        eventId: 'evt-5',
        seq: 5,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:05:00Z'
      });
      expect(state.lastSeq).toBe(5);

      // Lower sequence TicketCreated arrives
      state = applyEvent(state, {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1')
      });

      expect(state.lastSeq).toBe(5); // Retains high-water mark, does not regress to 1
    });
  });

  describe('9. StreamReset', () => {
    it('should clear tickets, parked events, reset agent loads to 0, and re-initialize processedEventIds', () => {
      let state = createInitialDeskState(baseAgents);

      // Populate desk
      state = applyEvent(state, {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket: createTicket('T1', { assigneeId: 'agent-1' })
      });
      state = applyEvent(state, {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T-UNKNOWN',
        status: 'pending_customer',
        at: '2026-01-05T09:02:00Z'
      });

      expect(state.tickets['T1']).toBeDefined();
      expect(state.parkedEvents['T-UNKNOWN'].length).toBe(1);
      expect(state.agentLoad['agent-1']).toBe(1);

      // Reset
      const resetEvent: StreamReset = {
        type: 'StreamReset',
        eventId: 'evt-reset',
        seq: 100
      };
      state = applyEvent(state, resetEvent, new Date('2026-01-05T10:00:00Z'));

      expect(state.tickets).toEqual({});
      expect(state.parkedEvents).toEqual({});
      expect(state.agentLoad['agent-1']).toBe(0);
      expect(state.agentLoad['agent-2']).toBe(0);
      expect(state.agents['agent-1']).toBeDefined(); // Agents preserved
      expect(state.lastSeq).toBe(100);
      expect(state.processedEventIds).toEqual({ 'evt-reset': true }); // Re-initialized
    });
  });

  describe('10. Defensive Immutability', () => {
    it('should not mutate input state, ticket, or statusHistory in place', () => {
      let state = createInitialDeskState(baseAgents);
      const ticket = createTicket('T1', { assigneeId: 'agent-1', statusHistory: [] });

      deepFreeze(state);
      deepFreeze(ticket);

      const created: TicketCreated = {
        type: 'TicketCreated',
        eventId: 'evt-1',
        seq: 1,
        ticket
      };
      state = applyEvent(state, created);
      deepFreeze(state);

      const statusChanged: TicketStatusChanged = {
        type: 'TicketStatusChanged',
        eventId: 'evt-2',
        seq: 2,
        ticketId: 'T1',
        status: 'pending_customer',
        at: '2026-01-05T09:10:00Z'
      };
      deepFreeze(statusChanged);

      expect(() => applyEvent(state, statusChanged)).not.toThrow();
    });
  });
});
