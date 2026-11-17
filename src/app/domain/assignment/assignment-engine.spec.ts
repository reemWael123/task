import {
  findBestAgent,
  assignTicket,
  isAgentEligible,
  isAgentOnShift,
  isCapacityEligible,
  isSkillEligible,
  resolveAgentLoad,
  validateCurrentLoad
} from './assignment-engine';
import { Agent, Ticket, DeskState } from '../models';

describe('AssignmentEngine (Step 1.3)', () => {
  // Helper factories
  function createAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'agent-1',
      name: 'Agent One',
      skills: ['billing', 'technical'],
      status: 'online',
      maxLoad: 5,
      shift: {
        start: '09:00',
        end: '17:00',
        tz: 'UTC'
      },
      ...overrides
    };
  }

  function createTicket(overrides: Partial<Ticket> = {}): Ticket {
    return {
      id: 'ticket-1',
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

  function createDeskState(overrides: Partial<DeskState> = {}): DeskState {
    return {
      tickets: {},
      agents: {},
      agentLoad: {},
      lastSeq: 0,
      lastUpdatedAt: new Date('2026-01-05T10:00:00Z'),
      ...overrides
    };
  }

  describe('1. Current Load Validation (validateCurrentLoad)', () => {
    it('should accept valid non-negative finite integers', () => {
      expect(() => validateCurrentLoad(0)).not.toThrow();
      expect(() => validateCurrentLoad(1)).not.toThrow();
      expect(() => validateCurrentLoad(42)).not.toThrow();
    });

    it('should reject negative numbers with a descriptive error', () => {
      expect(() => validateCurrentLoad(-1, 'agent-1')).toThrowError(
        /Invalid currentLoad for agent 'agent-1': '-1'\. Must be a non-negative finite integer\./
      );
    });

    it('should reject NaN', () => {
      expect(() => validateCurrentLoad(NaN, 'agent-1')).toThrowError(
        /Invalid currentLoad for agent 'agent-1': 'NaN'\. Must be a non-negative finite integer\./
      );
    });

    it('should reject Infinity and -Infinity', () => {
      expect(() => validateCurrentLoad(Infinity)).toThrowError(
        /Invalid currentLoad: 'Infinity'\. Must be a non-negative finite integer\./
      );
      expect(() => validateCurrentLoad(-Infinity)).toThrowError(
        /Invalid currentLoad: '-Infinity'\. Must be a non-negative finite integer\./
      );
    });

    it('should reject non-integer floating point numbers', () => {
      expect(() => validateCurrentLoad(2.5, 'agent-2')).toThrowError(
        /Invalid currentLoad for agent 'agent-2': '2.5'\. Must be a non-negative finite integer\./
      );
    });

    it('should reject non-number types', () => {
      expect(() => validateCurrentLoad('3' as unknown as number)).toThrowError(
        /Invalid currentLoad: '3'\. Must be a non-negative finite integer\./
      );
      expect(() => validateCurrentLoad(null as unknown as number)).toThrowError(
        /Invalid currentLoad: 'null'\. Must be a non-negative finite integer\./
      );
      expect(() => validateCurrentLoad(undefined as unknown as number)).toThrowError(
        /Invalid currentLoad: 'undefined'\. Must be a non-negative finite integer\./
      );
    });
  });

  describe('2. Shift and Timezone Validation & Determination (isAgentOnShift)', () => {
    it('should validate start boundary as inclusive and end boundary as exclusive for standard day shift', () => {
      const shift = { start: '09:00', end: '17:00', tz: 'UTC' };

      // 08:59:59 -> off shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T08:59:59Z'))).toBeFalse();

      // 09:00:00 -> on shift (inclusive start)
      expect(isAgentOnShift(shift, new Date('2026-01-05T09:00:00Z'))).toBeTrue();

      // 12:00:00 -> on shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T12:00:00Z'))).toBeTrue();

      // 16:59:59 -> on shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T16:59:59Z'))).toBeTrue();

      // 17:00:00 -> off shift (exclusive end)
      expect(isAgentOnShift(shift, new Date('2026-01-05T17:00:00Z'))).toBeFalse();
    });

    it('should support 24:00 as a valid end-only boundary', () => {
      const shift = { start: '16:00', end: '24:00', tz: 'UTC' };

      // 15:59 -> off shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T15:59:00Z'))).toBeFalse();

      // 16:00 -> on shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T16:00:00Z'))).toBeTrue();

      // 23:59 -> on shift
      expect(isAgentOnShift(shift, new Date('2026-01-05T23:59:00Z'))).toBeTrue();

      // 00:00 next day -> off shift (hour 0 < 16)
      expect(isAgentOnShift(shift, new Date('2026-01-06T00:00:00Z'))).toBeFalse();
    });

    it('should reject 24:00 as a start boundary', () => {
      const shift = { start: '24:00', end: '08:00', tz: 'UTC' };
      expect(() => isAgentOnShift(shift, new Date('2026-01-05T10:00:00Z'), 'agent-1')).toThrowError(
        /Invalid shift start time '24:00' for agent 'agent-1'\. Expected HH:mm format \(00:00–23:59\)\./
      );
    });

    it('should support overnight shifts spanning midnight (e.g. 22:00 to 06:00)', () => {
      const overnightShift = { start: '22:00', end: '06:00', tz: 'UTC' };

      // 21:59 -> off shift
      expect(isAgentOnShift(overnightShift, new Date('2026-01-05T21:59:00Z'))).toBeFalse();

      // 22:00 -> on shift (inclusive start)
      expect(isAgentOnShift(overnightShift, new Date('2026-01-05T22:00:00Z'))).toBeTrue();

      // 23:45 -> on shift
      expect(isAgentOnShift(overnightShift, new Date('2026-01-05T23:45:00Z'))).toBeTrue();

      // 00:00 -> on shift (past midnight)
      expect(isAgentOnShift(overnightShift, new Date('2026-01-06T00:00:00Z'))).toBeTrue();

      // 05:59 -> on shift
      expect(isAgentOnShift(overnightShift, new Date('2026-01-06T05:59:00Z'))).toBeTrue();

      // 06:00 -> off shift (exclusive end)
      expect(isAgentOnShift(overnightShift, new Date('2026-01-06T06:00:00Z'))).toBeFalse();

      // 12:00 -> off shift
      expect(isAgentOnShift(overnightShift, new Date('2026-01-06T12:00:00Z'))).toBeFalse();
    });

    it('should reject shifts where start === end with a descriptive validation error', () => {
      const zeroShift = { start: '09:00', end: '09:00', tz: 'UTC' };
      expect(() => isAgentOnShift(zeroShift, new Date('2026-01-05T09:00:00Z'), 'agent-1')).toThrowError(
        /Invalid shift window for agent 'agent-1': start time '09:00' cannot be identical to end time '09:00'\./
      );
    });

    it('should reject invalid shift time formats and out-of-range hours/minutes', () => {
      expect(() =>
        isAgentOnShift({ start: '9:00', end: '17:00', tz: 'UTC' }, new Date(), 'agent-1')
      ).toThrowError(/Invalid shift start time '9:00'/);

      expect(() =>
        isAgentOnShift({ start: '25:00', end: '17:00', tz: 'UTC' }, new Date(), 'agent-1')
      ).toThrowError(/Invalid shift start time '25:00'/);

      expect(() =>
        isAgentOnShift({ start: '09:60', end: '17:00', tz: 'UTC' }, new Date(), 'agent-1')
      ).toThrowError(/Invalid shift start time '09:60'/);

      expect(() =>
        isAgentOnShift({ start: '09:00', end: '24:01', tz: 'UTC' }, new Date(), 'agent-1')
      ).toThrowError(/Invalid shift end time '24:01'/);
    });

    it('should reject invalid IANA timezone identifiers', () => {
      expect(() =>
        isAgentOnShift({ start: '09:00', end: '17:00', tz: 'Invalid/Zone' }, new Date(), 'agent-1')
      ).toThrowError(/Invalid IANA timezone identifier 'Invalid\/Zone'/);
    });

    it('should reject missing shift configuration', () => {
      expect(() => isAgentOnShift(undefined as unknown as Agent['shift'], new Date(), 'agent-1')).toThrowError(
        /Missing shift configuration for agent 'agent-1'/
      );
    });

    it('should reject invalid now timestamp', () => {
      const shift = { start: '09:00', end: '17:00', tz: 'UTC' };
      expect(() => isAgentOnShift(shift, new Date('invalid'))).toThrowError(
        /Invalid evaluation timestamp 'now'/
      );
    });

    it('should correctly evaluate shifts across multiple regional timezones', () => {
      // 10:00 UTC on 2026-01-05
      const now = new Date('2026-01-05T10:00:00Z');

      // Dubai agent: UTC+4. 10:00 UTC = 14:00 Dubai. Shift 09:00–17:00 Dubai -> on shift
      const dubaiShift = { start: '09:00', end: '17:00', tz: 'Asia/Dubai' };
      expect(isAgentOnShift(dubaiShift, now)).toBeTrue();

      // London agent: UTC+0 in winter. 10:00 UTC = 10:00 London. Shift 09:00–17:00 London -> on shift
      const londonShift = { start: '09:00', end: '17:00', tz: 'Europe/London' };
      expect(isAgentOnShift(londonShift, now)).toBeTrue();

      // Tokyo agent: UTC+9. 10:00 UTC = 19:00 Tokyo. Shift 09:00–17:00 Tokyo -> off shift
      const tokyoShift = { start: '09:00', end: '17:00', tz: 'Asia/Tokyo' };
      expect(isAgentOnShift(tokyoShift, now)).toBeFalse();
    });
  });

  describe('3. Skill Matching (isSkillEligible)', () => {
    it('should match any agent if the ticket requires no skills', () => {
      const agent = createAgent({ skills: [] });
      const ticketEmptySkills = createTicket({ skills: [] });
      expect(isSkillEligible(agent, ticketEmptySkills)).toBeTrue();

      const ticketUndefinedSkills = { ...createTicket(), skills: undefined as unknown as string[] };
      expect(isSkillEligible(agent, ticketUndefinedSkills)).toBeTrue();
    });

    it('should match when agent possesses all required ticket skills', () => {
      const agent = createAgent({ skills: ['billing', 'technical', 'network'] });
      const ticket = createTicket({ skills: ['billing', 'technical'] });
      expect(isSkillEligible(agent, ticket)).toBeTrue();
    });

    it('should reject when agent lacks one or more required skills', () => {
      const agent = createAgent({ skills: ['billing'] });
      const ticket = createTicket({ skills: ['billing', 'technical'] });
      expect(isSkillEligible(agent, ticket)).toBeFalse();
    });

    it('should perform strictly exact, case-sensitive skill matching with no automatic trimming', () => {
      const agentLower = createAgent({ skills: ['billing'] });
      const ticketUpper = createTicket({ skills: ['Billing'] });
      const ticketPadded = createTicket({ skills: ['billing '] });

      // Case mismatch: 'Billing' does not match 'billing'
      expect(isSkillEligible(agentLower, ticketUpper)).toBeFalse();

      // Padding mismatch: 'billing ' does not match 'billing'
      expect(isSkillEligible(agentLower, ticketPadded)).toBeFalse();

      const agentUpper = createAgent({ skills: ['Billing'] });
      const ticketLower = createTicket({ skills: ['billing'] });
      expect(isSkillEligible(agentUpper, ticketLower)).toBeFalse();

      // Exact match
      expect(isSkillEligible(agentUpper, ticketUpper)).toBeTrue();
    });
  });

  describe('4. Capacity Rules & Boundary Eligibility (isCapacityEligible)', () => {
    const maxLoad = 5;
    const baseAgent = createAgent({ maxLoad });

    describe('Normal tickets (standard tier, P2/P3/P4)', () => {
      const normalTicket = createTicket({ priority: 'P2', customerTier: 'standard' });

      it('should allow assignment when currentLoad < maxLoad (boundary: maxLoad - 1)', () => {
        expect(isCapacityEligible(baseAgent, normalTicket, 4)).toBeTrue();
      });

      it('should reject assignment when currentLoad === maxLoad', () => {
        expect(isCapacityEligible(baseAgent, normalTicket, 5)).toBeFalse();
      });

      it('should reject assignment when currentLoad > maxLoad', () => {
        expect(isCapacityEligible(baseAgent, normalTicket, 6)).toBeFalse();
      });
    });

    describe('VIP tickets (customerTier: vip, non-P1)', () => {
      const vipTicket = createTicket({ priority: 'P2', customerTier: 'vip' });

      it('should allow assignment at currentLoad === maxLoad - 1', () => {
        expect(isCapacityEligible(baseAgent, vipTicket, 4)).toBeTrue();
      });

      it('should allow assignment at currentLoad === maxLoad (capacity override +1)', () => {
        expect(isCapacityEligible(baseAgent, vipTicket, 5)).toBeTrue();
      });

      it('should reject assignment when currentLoad === maxLoad + 1 (boundary)', () => {
        expect(isCapacityEligible(baseAgent, vipTicket, 6)).toBeFalse();
      });

      it('should reject assignment when currentLoad > maxLoad + 1', () => {
        expect(isCapacityEligible(baseAgent, vipTicket, 7)).toBeFalse();
      });
    });

    describe('P1 tickets (priority: P1, standard tier)', () => {
      const p1Ticket = createTicket({ priority: 'P1', customerTier: 'standard' });

      it('should allow assignment at currentLoad === maxLoad - 1', () => {
        expect(isCapacityEligible(baseAgent, p1Ticket, 4)).toBeTrue();
      });

      it('should allow assignment at currentLoad === maxLoad (capacity override +1)', () => {
        expect(isCapacityEligible(baseAgent, p1Ticket, 5)).toBeTrue();
      });

      it('should reject assignment when currentLoad === maxLoad + 1 (boundary)', () => {
        expect(isCapacityEligible(baseAgent, p1Ticket, 6)).toBeFalse();
      });

      it('should reject assignment when currentLoad > maxLoad + 1', () => {
        expect(isCapacityEligible(baseAgent, p1Ticket, 7)).toBeFalse();
      });
    });

    describe('P1 VIP tickets (priority: P1 AND customerTier: vip)', () => {
      const p1VipTicket = createTicket({ priority: 'P1', customerTier: 'vip' });

      it('should allow assignment at currentLoad === maxLoad', () => {
        expect(isCapacityEligible(baseAgent, p1VipTicket, 5)).toBeTrue();
      });

      it('should NOT allow stacking capacity overrides beyond maxLoad + 1', () => {
        // Must reject at maxLoad + 1, never allow > maxLoad + 1
        expect(isCapacityEligible(baseAgent, p1VipTicket, 6)).toBeFalse();
        expect(isCapacityEligible(baseAgent, p1VipTicket, 7)).toBeFalse();
      });
    });
  });

  describe('5. Agent Status Eligibility (isAgentEligible)', () => {
    const ticket = createTicket({ skills: ['billing'] });
    const now = new Date('2026-01-05T10:00:00Z');

    it('should accept online agents who meet all criteria', () => {
      const agent = createAgent({ status: 'online', skills: ['billing'] });
      expect(isAgentEligible(agent, ticket, 2, now)).toBeTrue();
    });

    it('should reject busy agents even if on shift and with available capacity', () => {
      const agent = createAgent({ status: 'busy', skills: ['billing'] });
      expect(isAgentEligible(agent, ticket, 0, now)).toBeFalse();
    });

    it('should reject offline agents', () => {
      const agent = createAgent({ status: 'offline', skills: ['billing'] });
      expect(isAgentEligible(agent, ticket, 0, now)).toBeFalse();
    });

    it('should reject online agents who are off shift', () => {
      const agent = createAgent({
        status: 'online',
        shift: { start: '18:00', end: '22:00', tz: 'UTC' }
      });
      expect(isAgentEligible(agent, ticket, 0, now)).toBeFalse();
    });

    it('should reject online agents who lack required skills', () => {
      const agent = createAgent({ status: 'online', skills: ['technical'] });
      expect(isAgentEligible(agent, ticket, 0, now)).toBeFalse();
    });

    it('should reject online agents who are at capacity', () => {
      const agent = createAgent({ status: 'online', maxLoad: 3 });
      expect(isAgentEligible(agent, ticket, 3, now)).toBeFalse();
    });
  });

  describe('6. Current Load Resolution (resolveAgentLoad)', () => {
    it('should use state.agentLoad[agentId] when the property exists', () => {
      const state = createDeskState({
        agentLoad: {
          'agent-1': 3,
          'agent-2': 0
        },
        tickets: {
          't-1': createTicket({ id: 't-1', assigneeId: 'agent-1', status: 'open' }),
          't-2': createTicket({ id: 't-2', assigneeId: 'agent-1', status: 'open' }),
          't-3': createTicket({ id: 't-3', assigneeId: 'agent-1', status: 'open' }),
          't-4': createTicket({ id: 't-4', assigneeId: 'agent-1', status: 'open' }) // 4 tickets in state
        }
      });

      // agentLoad takes precedence: returns 3, not 4
      expect(resolveAgentLoad('agent-1', state)).toBe(3);
      expect(resolveAgentLoad('agent-2', state)).toBe(0);
    });

    it('should derive load from state.tickets when agentLoad does not have the agent', () => {
      const state = createDeskState({
        agentLoad: {}, // agent-1 not present
        tickets: {
          't-1': createTicket({ id: 't-1', assigneeId: 'agent-1', status: 'open' }),
          't-2': createTicket({ id: 't-2', assigneeId: 'agent-1', status: 'pending_customer' }),
          't-3': createTicket({ id: 't-3', assigneeId: 'agent-1', status: 'on_hold' }),
          't-4': createTicket({ id: 't-4', assigneeId: 'agent-1', status: 'resolved' }), // resolved: excluded
          't-5': createTicket({ id: 't-5', assigneeId: 'agent-2', status: 'open' }), // other agent: excluded
          't-6': createTicket({ id: 't-6', assigneeId: undefined, status: 'open' }) // unassigned: excluded
        }
      });

      // open (1) + pending_customer (1) + on_hold (1) = 3
      expect(resolveAgentLoad('agent-1', state)).toBe(3);
      expect(resolveAgentLoad('agent-2', state)).toBe(1);
      expect(resolveAgentLoad('agent-3', state)).toBe(0);
    });

    it('should validate the resolved load and throw if it is invalid in agentLoad', () => {
      const state = createDeskState({
        agentLoad: {
          'agent-bad': -2
        }
      });
      expect(() => resolveAgentLoad('agent-bad', state)).toThrowError(/Invalid currentLoad for agent 'agent-bad'/);
    });

    it('should return 0 when agentId is empty or state has no tickets/load', () => {
      const emptyState = createDeskState({ tickets: undefined, agentLoad: undefined });
      expect(resolveAgentLoad('', emptyState)).toBe(0);
      expect(resolveAgentLoad('agent-1', emptyState)).toBe(0);
    });
  });

  describe('7. Candidate Ranking Hierarchy (findBestAgent)', () => {
    const now = new Date('2026-01-05T10:00:00Z');
    const ticket = createTicket({ skills: ['billing'] });

    it('Rule 1: should prioritize agent with the lowest currentLoad', () => {
      const agentA = createAgent({ id: 'agent-a', maxLoad: 5, skills: ['billing'] });
      const agentB = createAgent({ id: 'agent-b', maxLoad: 10, skills: ['billing'] });

      // Agent A: currentLoad 1 (remaining 4)
      // Agent B: currentLoad 2 (remaining 8)
      // Agent A must win because currentLoad 1 < 2, despite B having higher remaining capacity
      const agents = [agentB, agentA];
      const loads = { 'agent-a': 1, 'agent-b': 2 };

      const best = findBestAgent(ticket, agents, loads, now);
      expect(best).not.toBeNull();
      expect(best!.id).toBe('agent-a');
    });

    it('Rule 2: when currentLoad is tied, should prioritize agent with highest remainingCapacity', () => {
      const agentA = createAgent({ id: 'agent-a', maxLoad: 5, skills: ['billing'] });
      const agentB = createAgent({ id: 'agent-b', maxLoad: 8, skills: ['billing'] });

      // Both have currentLoad 2
      // Agent A: remaining 5 - 2 = 3
      // Agent B: remaining 8 - 2 = 6
      // Agent B must win because remaining capacity 6 > 3
      const agents = [agentA, agentB];
      const loads = { 'agent-a': 2, 'agent-b': 2 };

      const best = findBestAgent(ticket, agents, loads, now);
      expect(best).not.toBeNull();
      expect(best!.id).toBe('agent-b');
    });

    it('Rule 3: when currentLoad and remainingCapacity are tied, should break ties with alphabetical agent.id ascending', () => {
      const agentZ = createAgent({ id: 'agent-z', maxLoad: 5, skills: ['billing'] });
      const agentA = createAgent({ id: 'agent-a', maxLoad: 5, skills: ['billing'] });
      const agentM = createAgent({ id: 'agent-m', maxLoad: 5, skills: ['billing'] });

      // All have currentLoad 1, remaining 4
      const agents = [agentZ, agentM, agentA];
      const loads = { 'agent-z': 1, 'agent-m': 1, 'agent-a': 1 };

      const best = findBestAgent(ticket, agents, loads, now);
      expect(best).not.toBeNull();
      expect(best!.id).toBe('agent-a');
    });

    it('should return null when ticket is already assigned', () => {
      const assignedTicket = createTicket({ assigneeId: 'agent-existing' });
      const agent = createAgent({ id: 'agent-1' });

      const best = findBestAgent(assignedTicket, [agent], { 'agent-1': 0 }, now);
      expect(best).toBeNull();
    });

    it('should return null when agents array is empty', () => {
      const best = findBestAgent(ticket, [], {}, now);
      expect(best).toBeNull();
    });

    it('should return null when no candidate meets all eligibility criteria', () => {
      const busyAgent = createAgent({ id: 'agent-1', status: 'busy', skills: ['billing'] });
      const fullAgent = createAgent({ id: 'agent-2', maxLoad: 2, skills: ['billing'] });
      const offShiftAgent = createAgent({
        id: 'agent-3',
        shift: { start: '18:00', end: '22:00', tz: 'UTC' },
        skills: ['billing']
      });
      const wrongSkillAgent = createAgent({ id: 'agent-4', skills: ['technical'] });

      const agents = [busyAgent, fullAgent, offShiftAgent, wrongSkillAgent];
      const loads = { 'agent-1': 0, 'agent-2': 2, 'agent-3': 0, 'agent-4': 0 };

      const best = findBestAgent(ticket, agents, loads, now);
      expect(best).toBeNull();
    });
  });

  describe('8. Ticket Assignment Workflow & Immutability (assignTicket)', () => {
    const now = new Date('2026-01-05T10:00:00Z');

    it('should successfully assign an eligible ticket and return AssignmentResult with cloned assignedAt', () => {
      const agent1 = createAgent({ id: 'agent-1', maxLoad: 5, skills: ['billing'] });
      const agent2 = createAgent({ id: 'agent-2', maxLoad: 5, skills: ['billing'] });

      const ticket = createTicket({ id: 'ticket-99', skills: ['billing'] });

      const state = createDeskState({
        agents: {
          'agent-1': agent1,
          'agent-2': agent2
        },
        agentLoad: {
          'agent-1': 2,
          'agent-2': 1 // lower load -> should win
        }
      });

      const result = assignTicket(ticket, state, now);

      expect(result).not.toBeNull();
      expect(result!.ticketId).toBe('ticket-99');
      expect(result!.agentId).toBe('agent-2');
      expect(result!.assignedAt.getTime()).toBe(now.getTime());

      // Defensively cloned Date test: mutating input now must not mutate assignedAt
      now.setFullYear(2099);
      expect(result!.assignedAt.getFullYear()).toBe(2026);
    });

    it('should return null if the ticket is already assigned', () => {
      const ticket = createTicket({ assigneeId: 'agent-1' });
      const state = createDeskState({
        agents: { 'agent-2': createAgent({ id: 'agent-2' }) }
      });

      const result = assignTicket(ticket, state, now);
      expect(result).toBeNull();
    });

    it('should return null if state.agents is empty or undefined', () => {
      const ticket = createTicket();
      expect(assignTicket(ticket, createDeskState({ agents: {} }), now)).toBeNull();
      expect(assignTicket(ticket, undefined as unknown as DeskState, now)).toBeNull();
    });

    it('should preserve input immutability: neither ticket nor state are modified', () => {
      const ticket = createTicket({ id: 'ticket-immutable', skills: ['billing'] });
      const agent = createAgent({ id: 'agent-1', skills: ['billing'] });
      const state = createDeskState({
        agents: { 'agent-1': agent },
        agentLoad: { 'agent-1': 0 }
      });

      const ticketSnapshot = JSON.stringify(ticket);
      const stateSnapshot = JSON.stringify(state);

      assignTicket(ticket, state, now);

      expect(JSON.stringify(ticket)).toBe(ticketSnapshot);
      expect(JSON.stringify(state)).toBe(stateSnapshot);
    });

    it('should resolve load from tickets when agentLoad is missing during assignTicket', () => {
      const agentA = createAgent({ id: 'agent-a', maxLoad: 5, skills: ['billing'] });
      const agentB = createAgent({ id: 'agent-b', maxLoad: 5, skills: ['billing'] });

      const newTicket = createTicket({ id: 't-new', skills: ['billing'] });

      const state = createDeskState({
        agents: {
          'agent-a': agentA,
          'agent-b': agentB
        },
        agentLoad: {}, // derived from tickets
        tickets: {
          't-1': createTicket({ id: 't-1', assigneeId: 'agent-a', status: 'open' }),
          't-2': createTicket({ id: 't-2', assigneeId: 'agent-a', status: 'open' }),
          't-3': createTicket({ id: 't-3', assigneeId: 'agent-b', status: 'open' })
        }
      });

      // agent-a has 2 open tickets, agent-b has 1 open ticket
      // agent-b has lower load -> agent-b wins
      const result = assignTicket(newTicket, state, now);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('agent-b');
    });
  });
});
