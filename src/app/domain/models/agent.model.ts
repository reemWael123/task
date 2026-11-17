export type AgentStatus = 'online' | 'busy' | 'offline';

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly status: 'online' | 'busy' | 'offline';
  readonly maxLoad: number;
  readonly shift: {
    readonly start: string;
    readonly end: string;
    readonly tz: string;
  };
}
