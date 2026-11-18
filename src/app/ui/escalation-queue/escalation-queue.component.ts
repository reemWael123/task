import { Component, EventEmitter, inject, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DeskFacade } from '../../application/desk.facade';
import { Ticket } from '../../domain/models';

export interface EscalationItem {
  ticket: Ticket;
  reason: 'breached' | 'at_risk' | 'p2_overdue';
  badgeLabel: string;
}

@Component({
  selector: 'app-escalation-queue',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="escalation-panel" *ngIf="escalations.length > 0">
      <div class="panel-header">
        <div class="title-wrap">
          <span class="alert-icon">🔥</span>
          <h3>Urgent Escalation Queue</h3>
          <span class="count-badge">{{ escalations.length }}</span>
        </div>
        <span class="header-hint">Tickets requiring immediate operator action</span>
      </div>

      <div class="escalation-carousel">
        <div
          class="escalation-card"
          *ngFor="let item of escalations.slice(0, 8)"
          [ngClass]="item.reason"
          (click)="selectTicket.emit(item.ticket)"
        >
          <div class="card-top">
            <span class="badge" [ngClass]="item.reason">{{ item.badgeLabel }}</span>
            <span class="ticket-id">{{ item.ticket.id }}</span>
            <span class="vip-badge" *ngIf="item.ticket.customerTier === 'vip'">⭐ VIP</span>
          </div>

          <div class="card-mid">
            <span class="priority-chip" [ngClass]="item.ticket.priority">{{ item.ticket.priority }}</span>
            <span class="region-chip">{{ item.ticket.region }}</span>
            <span class="assignee-text">
              {{ item.ticket.assigneeId ? getAgentName(item.ticket.assigneeId) : '⚠️ Unassigned' }}
            </span>
          </div>

          <div class="card-bot">
            <button
              type="button"
              class="btn-quick-assign"
              (click)="$event.stopPropagation(); autoAssign(item.ticket.id)"
              [disabled]="facade.isTicketMutating(item.ticket.id)"
              title="Automatically match and assign best available agent"
            >
              {{ facade.isTicketMutating(item.ticket.id) ? '⏳ Assigning...' : '⚡ Auto-Assign' }}
            </button>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .escalation-panel {
      background: #1e1e2d;
      border: 1px solid #3730a3;
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      margin: 1rem 1.5rem 0;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .title-wrap {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .alert-icon {
      font-size: 1.1rem;
    }

    .title-wrap h3 {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 700;
      color: #f87171;
    }

    .count-badge {
      background: #dc2626;
      color: #ffffff;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.1rem 0.4rem;
      border-radius: 9999px;
    }

    .header-hint {
      font-size: 0.75rem;
      color: #94a3b8;
    }

    .escalation-carousel {
      display: flex;
      gap: 0.75rem;
      overflow-x: auto;
      padding-bottom: 0.25rem;
    }

    .escalation-card {
      min-width: 220px;
      max-width: 260px;
      background: #111827;
      border: 1px solid #374151;
      border-radius: 0.375rem;
      padding: 0.6rem;
      cursor: pointer;
      transition: transform 0.1s, border-color 0.15s;
    }

    .escalation-card:hover {
      transform: translateY(-2px);
      border-color: #6366f1;
    }

    .escalation-card.breached {
      border-left: 4px solid #ef4444;
    }

    .escalation-card.at_risk {
      border-left: 4px solid #f59e0b;
    }

    .escalation-card.p2_overdue {
      border-left: 4px solid #ec4899;
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.3rem;
      margin-bottom: 0.4rem;
    }

    .badge {
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
    }

    .badge.breached {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }

    .badge.at_risk {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    .badge.p2_overdue {
      background: rgba(236, 72, 153, 0.2);
      color: #f472b6;
    }

    .ticket-id {
      font-size: 0.75rem;
      font-weight: 600;
      color: #e2e8f0;
      font-family: monospace;
    }

    .vip-badge {
      font-size: 0.65rem;
      color: #fbbf24;
      font-weight: 700;
    }

    .card-mid {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.7rem;
      color: #94a3b8;
      margin-bottom: 0.5rem;
    }

    .priority-chip {
      font-weight: 700;
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
    }

    .priority-chip.P1 { background: #991b1b; color: #fee2e2; }
    .priority-chip.P2 { background: #9a3412; color: #ffedd5; }
    .priority-chip.P3 { background: #1e40af; color: #dbeafe; }
    .priority-chip.P4 { background: #374151; color: #f3f4f6; }

    .region-chip {
      background: #1e293b;
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
      font-weight: 600;
    }

    .assignee-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-bot {
      display: flex;
      justify-content: flex-end;
    }

    .btn-quick-assign {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.25rem 0.5rem;
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 0.25rem;
      cursor: pointer;
    }

    .btn-quick-assign:hover:not(:disabled) {
      background: #1d4ed8;
    }

    .btn-quick-assign:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `]
})
export class EscalationQueueComponent {
  public readonly facade = inject(DeskFacade);

  @Output() public readonly selectTicket = new EventEmitter<Ticket>();

  public getAgentName(agentId?: string): string {
    if (!agentId) return '';
    return this.facade.state.agents[agentId]?.name || agentId;
  }

  public get escalations(): EscalationItem[] {
    const list: EscalationItem[] = [];
    const nowMs = Date.now();
    const TWO_HOURS_MS = 2 * 3600 * 1000;

    for (const ticket of this.facade.tickets) {
      if (ticket.status === 'resolved') {
        continue;
      }

      const sla = this.facade.state.slaStatus[ticket.id];
      const isBreached = sla?.firstResponse === 'breached' || sla?.resolution === 'breached';
      const isAtRisk = sla?.firstResponse === 'at_risk' || sla?.resolution === 'at_risk';

      const createdMs = new Date(ticket.createdAt).getTime();
      const isP2Overdue = ticket.priority === 'P2' && (nowMs - createdMs > TWO_HOURS_MS);

      if (isBreached) {
        list.push({ ticket, reason: 'breached', badgeLabel: 'Breached' });
      } else if (isP2Overdue) {
        list.push({ ticket, reason: 'p2_overdue', badgeLabel: 'P2 > 2 Hours' });
      } else if (isAtRisk) {
        list.push({ ticket, reason: 'at_risk', badgeLabel: 'At Risk' });
      }
    }

    return list;
  }

  public autoAssign(ticketId: string): void {
    this.facade.autoAssignTicket(ticketId).subscribe();
  }
}
