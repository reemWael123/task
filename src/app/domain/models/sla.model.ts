import { Priority } from './ticket.model';

export type SlaState = 'ok' | 'at_risk' | 'breached' | 'paused';

export interface SlaPolicy {
  readonly priority: Priority;
  readonly firstResponseMins: number;
  readonly resolutionMins: number;
  readonly vipMultiplier: number;
}
