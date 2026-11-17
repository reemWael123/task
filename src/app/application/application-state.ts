import { Agent, Ticket } from '../domain/models';
import { PipelineSyncStatus } from '../domain/event-pipeline';
import { SlaCalculationResult } from '../domain/sla';

/**
 * Performance metrics for SLA batch recomputations.
 */
export interface SlaBenchmarkMetrics {
  readonly executionTimeMs: number;
  readonly ticketCount: number;
  readonly timestamp: number;
}

/**
 * Centralized application state exposing data required by the UI.
 * EventPipeline remains the authoritative source for tickets, agents, agentLoad, and lastSeq.
 */
export interface ApplicationState {
  readonly tickets: Readonly<Record<string, Ticket>>;
  readonly ticketList: readonly Ticket[];
  readonly agents: Readonly<Record<string, Agent>>;
  readonly agentList: readonly Agent[];
  readonly agentLoad: Readonly<Record<string, number>>;
  readonly slaStatus: Readonly<Record<string, SlaCalculationResult>>;
  readonly slaBenchmark: SlaBenchmarkMetrics | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly syncStatus: PipelineSyncStatus;
  readonly lastSeq: number;
  readonly lastUpdatedAt: Date | null;
}

/**
 * Creates the initial application state.
 */
export function createInitialApplicationState(
  initialAgents?: Readonly<Record<string, Agent>>
): ApplicationState {
  const agents = initialAgents ? { ...initialAgents } : {};
  const agentList = Object.values(agents);
  const agentLoad: Record<string, number> = {};
  for (const agent of agentList) {
    agentLoad[agent.id] = 0;
  }

  return {
    tickets: {},
    ticketList: [],
    agents,
    agentList,
    agentLoad,
    slaStatus: {},
    slaBenchmark: null,
    isLoading: false,
    error: null,
    syncStatus: 'synced',
    lastSeq: 0,
    lastUpdatedAt: null
  };
}
