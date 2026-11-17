import { Ticket, TicketStatus } from './ticket.model';
import { AgentStatus } from './agent.model';

export interface TicketCreated {
  readonly type: 'TicketCreated';
  readonly eventId: string;
  readonly seq: number;
  readonly ticket: Ticket;
}

export interface TicketStatusChanged {
  readonly type: 'TicketStatusChanged';
  readonly eventId: string;
  readonly seq: number;
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly at: string;
}

export interface TicketAssigned {
  readonly type: 'TicketAssigned';
  readonly eventId: string;
  readonly seq: number;
  readonly ticketId: string;
  readonly agentId: string;
  readonly version: number;
}

export interface AgentStatusChanged {
  readonly type: 'AgentStatusChanged';
  readonly eventId: string;
  readonly seq: number;
  readonly agentId: string;
  readonly status: AgentStatus;
}

export interface StreamReset {
  readonly type: 'StreamReset';
  readonly eventId: string;
  readonly seq: number;
}

export type DeskEvent =
  | TicketCreated
  | TicketStatusChanged
  | TicketAssigned
  | AgentStatusChanged
  | StreamReset;
