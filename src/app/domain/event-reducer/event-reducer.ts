import {
  DeskState,
  Agent,
  DeskEvent,
  Ticket,
  TicketStatusChanged,
  TicketAssigned,
  TicketCreated,
  AgentStatusChanged,
  StreamReset
} from '../models';

export const PARKED_EVENT_TTL_MS = 10_000;

export interface ParkedEventEntry {
  readonly event: DeskEvent;
  readonly parkedAt: number;
}

export interface ReducerDeskState extends DeskState {
  readonly parkedEvents: Readonly<Record<string, readonly ParkedEventEntry[]>>;
  readonly processedEventIds: Readonly<Record<string, true>>;
}

/**
 * Validates that currentNow is a valid Date instance.
 */
function resolveNow(now?: Date): Date {
  if (!now) {
    return new Date();
  }
  if (!(now instanceof Date) || isNaN(now.getTime())) {
    throw new Error(`Invalid evaluation timestamp 'now': '${now}'`);
  }
  return new Date(now.getTime());
}

/**
 * Creates the initial clean ReducerDeskState with agentLoad initialized to 0 for all provided agents.
 */
export function createInitialDeskState(
  agents?: Readonly<Record<string, Agent>>,
  now?: Date
): ReducerDeskState {
  const agentLoad: Record<string, number> = {};
  if (agents) {
    for (const agentId of Object.keys(agents)) {
      agentLoad[agentId] = 0;
    }
  }

  const validNow = resolveNow(now);

  return {
    tickets: {},
    agents: agents ? { ...agents } : {},
    agentLoad,
    lastSeq: 0,
    lastUpdatedAt: validNow,
    parkedEvents: {},
    processedEventIds: {}
  };
}

/**
 * Sweeps expired parked entries (older than 10,000 ms) from parkedEvents.
 * Expired entries have their eventId recorded in processedEventIds so they can never be re-parked or restart TTL.
 */
function sweepExpiredParkedEvents(
  parkedEvents: Readonly<Record<string, readonly ParkedEventEntry[]>>,
  processedEventIds: Record<string, true>,
  currentNowMs: number
): Record<string, readonly ParkedEventEntry[]> {
  const swept: Record<string, readonly ParkedEventEntry[]> = {};

  for (const [ticketId, entries] of Object.entries(parkedEvents)) {
    const activeEntries: ParkedEventEntry[] = [];
    for (const entry of entries) {
      if (currentNowMs - entry.parkedAt > PARKED_EVENT_TTL_MS) {
        // Expired! Record eventId in processedEventIds to finalize it
        processedEventIds[entry.event.eventId] = true;
      } else {
        activeEntries.push(entry);
      }
    }
    if (activeEntries.length > 0) {
      swept[ticketId] = activeEntries;
    }
  }

  return swept;
}

/**
 * Applies a TicketCreated event to the desk state.
 * Validates registered initial assignee, updates load, and replays unexpired parked events (seq > event.seq).
 */
function reduceTicketCreated(
  state: ReducerDeskState,
  event: TicketCreated,
  sweptParkedEvents: Record<string, readonly ParkedEventEntry[]>,
  processedEventIds: Record<string, true>,
  currentNowMs: number
): {
  newTickets: Record<string, Ticket>;
  newAgentLoad: Record<string, number>;
  updatedParkedEvents: Record<string, readonly ParkedEventEntry[]>;
} {
  const incomingTicket = event.ticket;

  // Validate initial assignee if provided
  if (incomingTicket.assigneeId && incomingTicket.assigneeId.length > 0) {
    if (!state.agents[incomingTicket.assigneeId]) {
      throw new Error(
        `Cannot create ticket '${incomingTicket.id}' with unknown initial assignee '${incomingTicket.assigneeId}'. Agent must exist in state.agents.`
      );
    }
  }

  const newTickets: Record<string, Ticket> = { ...state.tickets };
  const newAgentLoad: Record<string, number> = { ...state.agentLoad };
  const updatedParkedEvents: Record<string, readonly ParkedEventEntry[]> = { ...sweptParkedEvents };

  // Calculate initial load contribution
  if (incomingTicket.assigneeId && incomingTicket.status !== 'resolved') {
    newAgentLoad[incomingTicket.assigneeId] = (newAgentLoad[incomingTicket.assigneeId] ?? 0) + 1;
  }

  let currentTicket: Ticket = {
    ...incomingTicket,
    statusHistory: incomingTicket.statusHistory ? [...incomingTicket.statusHistory] : []
  };

  processedEventIds[event.eventId] = true;

  // Replay parked events for this ticket if any exist
  const parked = updatedParkedEvents[incomingTicket.id];
  if (parked && parked.length > 0) {
    // Sort parked entries by seq ascending
    const sorted = [...parked].sort((a, b) => a.event.seq - b.event.seq);

    for (const entry of sorted) {
      // 1. Check TTL: strictly greater than 10,000 ms is expired
      if (currentNowMs - entry.parkedAt > PARKED_EVENT_TTL_MS) {
        processedEventIds[entry.event.eventId] = true;
        continue;
      }

      // 2. Option 1A: Discard parked events with seq < TicketCreated.seq as superseded
      if (entry.event.seq < event.seq) {
        processedEventIds[entry.event.eventId] = true;
        continue;
      }

      // 3. Replay valid post-creation parked events
      if (entry.event.type === 'TicketStatusChanged') {
        currentTicket = replayStatusChange(currentTicket, entry.event, newAgentLoad);
      } else if (entry.event.type === 'TicketAssigned') {
        currentTicket = replayAssignment(currentTicket, entry.event, newAgentLoad, state.agents);
      }

      processedEventIds[entry.event.eventId] = true;
    }

    delete updatedParkedEvents[incomingTicket.id];
  }

  newTickets[incomingTicket.id] = currentTicket;

  return {
    newTickets,
    newAgentLoad,
    updatedParkedEvents
  };
}

/**
 * Replays a status change onto an existing ticket during parked event replay.
 */
function replayStatusChange(
  ticket: Ticket,
  event: TicketStatusChanged,
  agentLoad: Record<string, number>
): Ticket {
  const oldStatus = ticket.status;
  const newStatus = event.status;

  if (oldStatus !== newStatus && ticket.assigneeId) {
    if (oldStatus !== 'resolved' && newStatus === 'resolved') {
      const currentLoad = agentLoad[ticket.assigneeId] ?? 0;
      if (currentLoad <= 0) {
        throw new Error(
          `Invariant violation: Cannot decrement agentLoad below 0 for agent '${ticket.assigneeId}'.`
        );
      }
      agentLoad[ticket.assigneeId] = currentLoad - 1;
    } else if (oldStatus === 'resolved' && newStatus !== 'resolved') {
      agentLoad[ticket.assigneeId] = (agentLoad[ticket.assigneeId] ?? 0) + 1;
    }
  }

  const updatedStatusHistory = [
    ...ticket.statusHistory,
    { status: newStatus, at: event.at }
  ];

  const resolvedAt =
    newStatus === 'resolved' && !ticket.resolvedAt ? event.at : ticket.resolvedAt;

  return {
    ...ticket,
    status: newStatus,
    statusHistory: updatedStatusHistory,
    ...(resolvedAt ? { resolvedAt } : {})
  };
}

/**
 * Replays an assignment onto an existing ticket during parked event replay.
 */
function replayAssignment(
  ticket: Ticket,
  event: TicketAssigned,
  agentLoad: Record<string, number>,
  agents: Readonly<Record<string, Agent>>
): Ticket {
  if (!agents[event.agentId]) {
    throw new Error(
      `Cannot assign ticket '${event.ticketId}' to unknown agent '${event.agentId}'. Agent must exist in state.agents.`
    );
  }

  if (event.version <= ticket.version) {
    return ticket; // Stale or equal version
  }

  const oldAssignee = ticket.assigneeId;
  const newAssignee = event.agentId;

  if (ticket.status !== 'resolved' && oldAssignee !== newAssignee) {
    if (oldAssignee) {
      const currentLoad = agentLoad[oldAssignee] ?? 0;
      if (currentLoad <= 0) {
        throw new Error(
          `Invariant violation: Cannot decrement agentLoad below 0 for agent '${oldAssignee}'.`
        );
      }
      agentLoad[oldAssignee] = currentLoad - 1;
    }
    agentLoad[newAssignee] = (agentLoad[newAssignee] ?? 0) + 1;
  }

  return {
    ...ticket,
    assigneeId: newAssignee,
    version: event.version
  };
}

/**
 * Applies a TicketStatusChanged event to the desk state.
 * If the ticket is unknown, parks the event.
 */
function reduceTicketStatusChanged(
  state: ReducerDeskState,
  event: TicketStatusChanged,
  sweptParkedEvents: Record<string, readonly ParkedEventEntry[]>,
  processedEventIds: Record<string, true>,
  currentNowMs: number
): {
  newTickets: Record<string, Ticket>;
  newAgentLoad: Record<string, number>;
  updatedParkedEvents: Record<string, readonly ParkedEventEntry[]>;
} {
  const existingTicket = state.tickets[event.ticketId];

  // Unknown ticket: park the event
  if (!existingTicket) {
    const updatedParkedEvents = { ...sweptParkedEvents };
    const currentEntries = updatedParkedEvents[event.ticketId] ?? [];

    // Deduplication check: do not park the same eventId twice
    if (!currentEntries.some(e => e.event.eventId === event.eventId)) {
      updatedParkedEvents[event.ticketId] = [
        ...currentEntries,
        { event, parkedAt: currentNowMs }
      ];
    }

    return {
      newTickets: { ...state.tickets },
      newAgentLoad: { ...state.agentLoad },
      updatedParkedEvents
    };
  }

  // Known ticket: apply status transition
  const newAgentLoad = { ...state.agentLoad };
  const updatedTicket = replayStatusChange(existingTicket, event, newAgentLoad);
  processedEventIds[event.eventId] = true;

  return {
    newTickets: { ...state.tickets, [event.ticketId]: updatedTicket },
    newAgentLoad,
    updatedParkedEvents: sweptParkedEvents
  };
}

/**
 * Applies a TicketAssigned event to the desk state.
 * Validates version and agent registration. If ticket is unknown, parks the event.
 */
function reduceTicketAssigned(
  state: ReducerDeskState,
  event: TicketAssigned,
  sweptParkedEvents: Record<string, readonly ParkedEventEntry[]>,
  processedEventIds: Record<string, true>,
  currentNowMs: number
): {
  newTickets: Record<string, Ticket>;
  newAgentLoad: Record<string, number>;
  updatedParkedEvents: Record<string, readonly ParkedEventEntry[]>;
} {
  // Validate version format
  if (typeof event.version !== 'number' || !Number.isInteger(event.version) || event.version <= 0) {
    throw new Error(
      `Invalid version '${event.version}' in TicketAssigned event. Version must be a positive integer.`
    );
  }

  // Validate agent registration
  if (!state.agents[event.agentId]) {
    throw new Error(
      `Cannot assign ticket '${event.ticketId}' to unknown agent '${event.agentId}'. Agent must exist in state.agents.`
    );
  }

  const existingTicket = state.tickets[event.ticketId];

  // Unknown ticket: park the event
  if (!existingTicket) {
    const updatedParkedEvents = { ...sweptParkedEvents };
    const currentEntries = updatedParkedEvents[event.ticketId] ?? [];

    // Deduplication check
    if (!currentEntries.some(e => e.event.eventId === event.eventId)) {
      updatedParkedEvents[event.ticketId] = [
        ...currentEntries,
        { event, parkedAt: currentNowMs }
      ];
    }

    return {
      newTickets: { ...state.tickets },
      newAgentLoad: { ...state.agentLoad },
      updatedParkedEvents
    };
  }

  // Stale or duplicate version: ignore mutation
  if (event.version <= existingTicket.version) {
    processedEventIds[event.eventId] = true;
    return {
      newTickets: { ...state.tickets },
      newAgentLoad: { ...state.agentLoad },
      updatedParkedEvents: sweptParkedEvents
    };
  }

  const newAgentLoad = { ...state.agentLoad };
  const updatedTicket = replayAssignment(existingTicket, event, newAgentLoad, state.agents);
  processedEventIds[event.eventId] = true;

  return {
    newTickets: { ...state.tickets, [event.ticketId]: updatedTicket },
    newAgentLoad,
    updatedParkedEvents: sweptParkedEvents
  };
}

/**
 * Applies an AgentStatusChanged event to the desk state.
 */
function reduceAgentStatusChanged(
  state: ReducerDeskState,
  event: AgentStatusChanged,
  sweptParkedEvents: Record<string, readonly ParkedEventEntry[]>,
  processedEventIds: Record<string, true>
): {
  newAgents: Record<string, Agent>;
  updatedParkedEvents: Record<string, readonly ParkedEventEntry[]>;
} {
  const newAgents = { ...state.agents };
  if (newAgents[event.agentId]) {
    newAgents[event.agentId] = {
      ...newAgents[event.agentId],
      status: event.status
    };
  }
  processedEventIds[event.eventId] = true;

  return {
    newAgents,
    updatedParkedEvents: sweptParkedEvents
  };
}

/**
 * Pure domain reducer applying a single DeskEvent immutably.
 *
 * NOTE on `lastSeq`:
 * In this reducer, `lastSeq` represents the high-water mark of sequence numbers observed
 * and handled (Math.max(state.lastSeq, event.seq)). It guarantees monotonicity, but does NOT
 * imply that all preceding sequence numbers were contiguously delivered without gaps.
 * Contiguous sequence gap buffering is the responsibility of EventPipeline.
 */
export function applyEvent(
  state: ReducerDeskState,
  event: DeskEvent,
  now?: Date
): ReducerDeskState {
  if (!state) {
    throw new Error('DeskState is required');
  }
  if (!event || !event.type || typeof event.eventId !== 'string' || typeof event.seq !== 'number') {
    throw new Error(`Invalid DeskEvent: ${JSON.stringify(event)}`);
  }

  // Idempotency: exact duplicate eventId returns unchanged state instance
  if (state.processedEventIds[event.eventId]) {
    return state;
  }

  const evaluationDate = resolveNow(now);
  const currentNowMs = evaluationDate.getTime();

  // Handle StreamReset: wipe stream-derived state
  if (event.type === 'StreamReset') {
    const resetAgentLoad: Record<string, number> = {};
    for (const agentId of Object.keys(state.agents)) {
      resetAgentLoad[agentId] = 0;
    }

    return {
      tickets: {},
      agents: { ...state.agents },
      agentLoad: resetAgentLoad,
      lastSeq: Math.max(state.lastSeq, event.seq),
      lastUpdatedAt: evaluationDate,
      parkedEvents: {},
      processedEventIds: { [event.eventId]: true }
    };
  }

  // Sweep expired parked events (older than 10,000 ms) and record their eventId in processedEventIds
  const processedEventIds: Record<string, true> = { ...state.processedEventIds };
  const sweptParkedEvents = sweepExpiredParkedEvents(
    state.parkedEvents,
    processedEventIds,
    currentNowMs
  );

  let newTickets = state.tickets;
  let newAgents = state.agents;
  let newAgentLoad = state.agentLoad;
  let updatedParkedEvents = sweptParkedEvents;

  switch (event.type) {
    case 'TicketCreated': {
      const result = reduceTicketCreated(
        state,
        event,
        sweptParkedEvents,
        processedEventIds,
        currentNowMs
      );
      newTickets = result.newTickets;
      newAgentLoad = result.newAgentLoad;
      updatedParkedEvents = result.updatedParkedEvents;
      break;
    }

    case 'TicketStatusChanged': {
      const result = reduceTicketStatusChanged(
        state,
        event,
        sweptParkedEvents,
        processedEventIds,
        currentNowMs
      );
      newTickets = result.newTickets;
      newAgentLoad = result.newAgentLoad;
      updatedParkedEvents = result.updatedParkedEvents;
      break;
    }

    case 'TicketAssigned': {
      const result = reduceTicketAssigned(
        state,
        event,
        sweptParkedEvents,
        processedEventIds,
        currentNowMs
      );
      newTickets = result.newTickets;
      newAgentLoad = result.newAgentLoad;
      updatedParkedEvents = result.updatedParkedEvents;
      break;
    }

    case 'AgentStatusChanged': {
      const result = reduceAgentStatusChanged(
        state,
        event,
        sweptParkedEvents,
        processedEventIds
      );
      newAgents = result.newAgents;
      updatedParkedEvents = result.updatedParkedEvents;
      break;
    }

    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unhandled event type: ${(exhaustiveCheck as DeskEvent).type}`);
    }
  }

  return {
    tickets: newTickets,
    agents: newAgents,
    agentLoad: newAgentLoad,
    lastSeq: Math.max(state.lastSeq, event.seq),
    lastUpdatedAt: evaluationDate,
    parkedEvents: updatedParkedEvents,
    processedEventIds
  };
}
