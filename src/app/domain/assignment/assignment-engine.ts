import { Agent } from '../models/agent.model';
import { DeskState } from '../models/desk-state.model';
import { Ticket } from '../models/ticket.model';

export interface AssignmentCandidate {
  readonly agent: Agent;
  readonly currentLoad: number;
  readonly remainingCapacity: number;
}

export interface AssignmentResult {
  readonly ticketId: string;
  readonly agentId: string;
  readonly assignedAt: Date;
}

const SHIFT_START_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHIFT_END_REGEX = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * Validates that an evaluation timestamp is a valid Date instance.
 */
function validateNow(now: Date): void {
  if (!now || !(now instanceof Date) || isNaN(now.getTime())) {
    throw new Error(`Invalid evaluation timestamp 'now': '${now}'`);
  }
}

/**
 * Validates that currentLoad is a non-negative finite integer.
 */
export function validateCurrentLoad(load: number, agentId?: string): void {
  if (
    typeof load !== 'number' ||
    isNaN(load) ||
    !Number.isFinite(load) ||
    !Number.isInteger(load) ||
    load < 0
  ) {
    const context = agentId ? ` for agent '${agentId}'` : '';
    throw new Error(
      `Invalid currentLoad${context}: '${load}'. Must be a non-negative finite integer.`
    );
  }
}

/**
 * Validates shift configuration and parses start and end minutes.
 */
function parseAndValidateShift(
  shift: Agent['shift'],
  agentId?: string
): { startMinutes: number; endMinutes: number } {
  if (!shift) {
    throw new Error(`Missing shift configuration for agent '${agentId ?? 'unknown'}'`);
  }

  // Validate IANA timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: shift.tz });
  } catch {
    throw new Error(
      `Invalid IANA timezone identifier '${shift.tz}' for agent '${agentId ?? 'unknown'}'`
    );
  }

  // Validate start time format (HH:mm)
  if (!shift.start || !SHIFT_START_REGEX.test(shift.start)) {
    throw new Error(
      `Invalid shift start time '${shift.start}' for agent '${agentId ?? 'unknown'}'. Expected HH:mm format (00:00–23:59).`
    );
  }

  // Validate end time format (HH:mm or 24:00)
  if (!shift.end || !SHIFT_END_REGEX.test(shift.end)) {
    throw new Error(
      `Invalid shift end time '${shift.end}' for agent '${agentId ?? 'unknown'}'. Expected HH:mm format (00:00–24:00).`
    );
  }

  const [sh, sm] = shift.start.split(':').map(v => parseInt(v, 10));
  const [eh, em] = shift.end.split(':').map(v => parseInt(v, 10));

  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  // Reject shifts where start === end
  if (startMinutes === endMinutes) {
    throw new Error(
      `Invalid shift window for agent '${agentId ?? 'unknown'}': start time '${shift.start}' cannot be identical to end time '${shift.end}'.`
    );
  }

  return { startMinutes, endMinutes };
}

/**
 * Verifies whether timestamp `now` falls within the agent's shift in their designated timezone.
 * Start boundary is inclusive; end boundary is exclusive.
 * Supports standard day shifts and overnight shifts (e.g. 22:00 to 06:00).
 */
export function isAgentOnShift(shift: Agent['shift'], now: Date, agentId?: string): boolean {
  validateNow(now);
  const { startMinutes, endMinutes } = parseAndValidateShift(shift, agentId);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: shift.tz,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric'
  });

  const parts = dtf.formatToParts(now);
  let localHour = 0;
  let localMinute = 0;

  for (const part of parts) {
    if (part.type === 'hour') {
      localHour = parseInt(part.value, 10);
    } else if (part.type === 'minute') {
      localMinute = parseInt(part.value, 10);
    }
  }

  const currentMinutes = localHour * 60 + localMinute;

  if (startMinutes < endMinutes) {
    // Standard day shift: start <= current < end
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight shift: current >= start OR current < end
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Checks whether an agent possesses all required skills for a ticket.
 * Skill matching is explicitly exact and case-sensitive (e.g. 'Billing' !== 'billing').
 */
export function isSkillEligible(agent: Agent, ticket: Ticket): boolean {
  if (!ticket.skills || ticket.skills.length === 0) {
    return true;
  }

  const agentSkillSet = new Set(agent.skills ?? []);
  return ticket.skills.every(skill => agentSkillSet.has(skill));
}

/**
 * Checks capacity eligibility:
 * - Normal tickets require currentLoad < maxLoad.
 * - VIP or P1 tickets may exceed maxLoad by at most +1 (currentLoad < maxLoad + 1).
 * - Never allows load > maxLoad + 1.
 * - P1 and VIP are not mutually exclusive.
 */
export function isCapacityEligible(
  agent: Agent,
  ticket: Ticket,
  currentLoad: number
): boolean {
  validateCurrentLoad(currentLoad, agent.id);

  const hasCapacityOverride = ticket.priority === 'P1' || ticket.customerTier === 'vip';

  if (hasCapacityOverride) {
    return currentLoad < agent.maxLoad + 1;
  }

  return currentLoad < agent.maxLoad;
}

/**
 * Checks whether a candidate agent satisfies all hard eligibility criteria:
 * 1. Status is strictly 'online'.
 * 2. On shift in their timezone at timestamp `now`.
 * 3. Matches all required skills (exact, case-sensitive).
 * 4. Has available capacity (respecting normal vs P1/VIP limits).
 */
export function isAgentEligible(
  agent: Agent,
  ticket: Ticket,
  currentLoad: number,
  now: Date
): boolean {
  validateNow(now);
  validateCurrentLoad(currentLoad, agent.id);

  // Status check: only 'online' agents are eligible
  if (agent.status !== 'online') {
    return false;
  }

  // Shift and timezone check
  if (!isAgentOnShift(agent.shift, now, agent.id)) {
    return false;
  }

  // Skill match check
  if (!isSkillEligible(agent, ticket)) {
    return false;
  }

  // Capacity check
  if (!isCapacityEligible(agent, ticket, currentLoad)) {
    return false;
  }

  return true;
}

/**
 * Resolves an agent's current load from state.agentLoad when available,
 * otherwise derives the load by counting non-resolved tickets assigned to the agent.
 */
export function resolveAgentLoad(agentId: string, state: DeskState): number {
  if (!agentId) {
    return 0;
  }

  // 1. Authoritative: state.agentLoad property
  if (state.agentLoad && Object.prototype.hasOwnProperty.call(state.agentLoad, agentId)) {
    const load = state.agentLoad[agentId];
    validateCurrentLoad(load, agentId);
    return load;
  }

  // 2. Fallback: count non-resolved tickets assigned to this agent in state.tickets
  if (!state.tickets) {
    return 0;
  }

  let count = 0;
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.assigneeId === agentId && ticket.status !== 'resolved') {
      count++;
    }
  }

  validateCurrentLoad(count, agentId);
  return count;
}

/**
 * Ranks candidate agents deterministically:
 * 1. Lowest currentLoad ascending.
 * 2. Highest remainingCapacity descending (agent.maxLoad - currentLoad).
 * 3. Deterministic tie-breaker: alphabetical agent.id ascending.
 */
function rankCandidates(candidates: AssignmentCandidate[]): AssignmentCandidate[] {
  return candidates.sort((a, b) => {
    // 1. Lowest currentLoad
    if (a.currentLoad !== b.currentLoad) {
      return a.currentLoad - b.currentLoad;
    }

    // 2. Highest remainingCapacity
    if (a.remainingCapacity !== b.remainingCapacity) {
      return b.remainingCapacity - a.remainingCapacity;
    }

    // 3. Alphabetical agent.id ascending
    return a.agent.id.localeCompare(b.agent.id);
  });
}

/**
 * Finds the best eligible agent for a ticket from a list of candidate agents.
 * Returns null if the ticket is already assigned, or if no eligible agent is found.
 */
export function findBestAgent(
  ticket: Ticket,
  agents: readonly Agent[],
  agentLoad: Readonly<Record<string, number>>,
  now: Date
): Agent | null {
  validateNow(now);

  // Do not reassign an already assigned ticket
  if (ticket.assigneeId && ticket.assigneeId.length > 0) {
    return null;
  }

  if (!agents || agents.length === 0) {
    return null;
  }

  const eligibleCandidates: AssignmentCandidate[] = [];

  for (const agent of agents) {
    const load =
      agentLoad && Object.prototype.hasOwnProperty.call(agentLoad, agent.id)
        ? agentLoad[agent.id]
        : 0;

    validateCurrentLoad(load, agent.id);

    if (isAgentEligible(agent, ticket, load, now)) {
      eligibleCandidates.push({
        agent,
        currentLoad: load,
        remainingCapacity: agent.maxLoad - load
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    return null;
  }

  const ranked = rankCandidates(eligibleCandidates);
  return ranked[0].agent;
}

/**
 * Assigns an unassigned ticket using the full DeskState context.
 * Returns an AssignmentResult with a defensively cloned assignedAt timestamp,
 * or null if the ticket is already assigned or no eligible agent is found.
 */
export function assignTicket(
  ticket: Ticket,
  state: DeskState,
  now: Date
): AssignmentResult | null {
  validateNow(now);

  // Do not reassign an already assigned ticket
  if (ticket.assigneeId && ticket.assigneeId.length > 0) {
    return null;
  }

  if (!state || !state.agents) {
    return null;
  }

  const agents = Object.values(state.agents);
  if (agents.length === 0) {
    return null;
  }

  const eligibleCandidates: AssignmentCandidate[] = [];

  for (const agent of agents) {
    const load = resolveAgentLoad(agent.id, state);
    if (isAgentEligible(agent, ticket, load, now)) {
      eligibleCandidates.push({
        agent,
        currentLoad: load,
        remainingCapacity: agent.maxLoad - load
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    return null;
  }

  const ranked = rankCandidates(eligibleCandidates);
  const bestAgent = ranked[0].agent;

  return {
    ticketId: ticket.id,
    agentId: bestAgent.id,
    assignedAt: new Date(now.getTime())
  };
}
