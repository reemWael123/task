export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export type TicketStatus = 'open' | 'pending_customer' | 'on_hold' | 'resolved';

export type CustomerTier = 'standard' | 'vip';

export type Region = 'EG' | 'AE' | 'SA' | 'EU';

export interface Ticket {
  readonly id: string;
  readonly version: number;
  readonly priority: Priority;
  readonly status: TicketStatus;
  readonly customerTier: 'standard' | 'vip';
  readonly region: 'EG' | 'AE' | 'SA' | 'EU';
  readonly skills: readonly string[];
  readonly createdAt: string;
  readonly firstResponseAt?: string;
  readonly resolvedAt?: string;
  readonly assigneeId?: string;
  readonly statusHistory: readonly {
    readonly status: TicketStatus;
    readonly at: string;
  }[];
}
