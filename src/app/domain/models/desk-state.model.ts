import { Ticket } from './ticket.model';
import { Agent } from './agent.model';

export interface DeskState {
  readonly tickets: Readonly<Record<string, Ticket>>;
  readonly agents: Readonly<Record<string, Agent>>;
  readonly agentLoad: Readonly<Record<string, number>>;
  readonly lastSeq: number;
  readonly lastUpdatedAt: Date;
}
