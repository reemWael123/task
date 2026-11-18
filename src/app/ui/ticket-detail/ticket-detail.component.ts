import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DeskFacade } from '../../application/desk.facade';
import { Agent, Ticket, TicketStatus } from '../../domain/models';
import { TICKET_GATEWAY, TicketGateway } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';

@Component({
  selector: 'app-ticket-detail',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="drawer-backdrop" (click)="close.emit()">
      <div class="drawer-content" (click)="$event.stopPropagation()">
        <!-- Header -->
        <div class="drawer-header">
          <div class="header-title">
            <span class="pri-badge" [ngClass]="currentTicket.priority">{{ currentTicket.priority }}</span>
            <h2>{{ currentTicket.id }}</h2>
            <span class="vip-tag" *ngIf="currentTicket.customerTier === 'vip'">VIP</span>
          </div>
          <button type="button" class="btn-close" (click)="close.emit()">✕</button>
        </div>

        <div class="drawer-body">
          <!-- Metadata Grid -->
          <div class="meta-section">
            <div class="meta-card">
              <span class="meta-label">Region</span>
              <span class="meta-val">{{ currentTicket.region }}</span>
            </div>
            <div class="meta-card">
              <span class="meta-label">Current Status</span>
              <span class="meta-val status-text" [ngClass]="currentTicket.status">{{ formatStatus(currentTicket.status) }}</span>
            </div>
            <div class="meta-card">
              <span class="meta-label">Version</span>
              <span class="meta-val">v{{ currentTicket.version }}</span>
            </div>
            <div class="meta-card">
              <span class="meta-label">Customer Tier</span>
              <span class="meta-val">{{ currentTicket.customerTier | uppercase }}</span>
            </div>
          </div>

          <!-- Assignee Details -->
          <div class="section-card">
            <div class="section-title">👤 Assigned Agent</div>
            <div class="assignee-info" *ngIf="currentTicket.assigneeId; else unassignedState">
              <div class="agent-avatar">👤</div>
              <div class="agent-details">
                <h4>{{ assignedAgent?.name || currentTicket.assigneeId }}</h4>
                <p>Status: <strong>{{ assignedAgent?.status || 'unknown' }}</strong> | Current Load: {{ facade.agentLoad[currentTicket.assigneeId] || 0 }}</p>
                <p class="shift-info" *ngIf="assignedAgent?.shift as shift">
                  Shift: {{ shift.start }} - {{ shift.end }} ({{ shift.tz }})
                </p>
              </div>
            </div>
            <ng-template #unassignedState>
              <div class="unassigned-box">
                <span>⚠️ This ticket is currently unassigned.</span>
                <button
                  type="button"
                  class="btn-assign-quick"
                  (click)="autoAssign()"
                  [disabled]="facade.isTicketMutating(currentTicket.id)"
                >
                  ⚡ Auto-Assign Best Agent
                </button>
              </div>
            </ng-template>
          </div>

          <!-- SLA Details -->
          <div class="section-card" *ngIf="facade.state.slaStatus[currentTicket.id] as sla">
            <div class="section-title">⏱️ SLA Target Breakdown</div>
            <div class="sla-grid">
              <div class="sla-metric-card" [ngClass]="sla.firstResponse">
                <span class="sla-metric-name">First Response</span>
                <span class="sla-status-badge" [ngClass]="sla.firstResponse">{{ sla.firstResponse | uppercase }}</span>
                <span class="sla-due-time">Due: {{ formatTime(sla.dueAt.firstResponse) }}</span>
              </div>
              <div class="sla-metric-card" [ngClass]="sla.resolution">
                <span class="sla-metric-name">Resolution</span>
                <span class="sla-status-badge" [ngClass]="sla.resolution">{{ sla.resolution | uppercase }}</span>
                <span class="sla-due-time">Due: {{ formatTime(sla.dueAt.resolution) }}</span>
              </div>
            </div>
          </div>

          <!-- Status Transitions -->
          <div class="section-card">
            <div class="section-title">🔄 Change Ticket Status</div>
            <div class="status-actions">
              <button
                type="button"
                class="btn-status"
                [disabled]="currentTicket.status === 'open'"
                (click)="changeStatus('open')"
              >
                Open
              </button>
              <button
                type="button"
                class="btn-status"
                [disabled]="currentTicket.status === 'pending_customer'"
                (click)="changeStatus('pending_customer')"
              >
                Pending Customer
              </button>
              <button
                type="button"
                class="btn-status"
                [disabled]="currentTicket.status === 'on_hold'"
                (click)="changeStatus('on_hold')"
              >
                On Hold
              </button>
              <button
                type="button"
                class="btn-status btn-resolve"
                [disabled]="currentTicket.status === 'resolved'"
                (click)="changeStatus('resolved')"
              >
                ✓ Resolve Ticket
              </button>
            </div>
          </div>

          <!-- Required Skills -->
          <div class="section-card">
            <div class="section-title">🏷️ Required Skills</div>
            <div class="skills-wrap">
              <span class="skill-chip" *ngFor="let s of currentTicket.skills">{{ s }}</span>
              <span class="no-skills" *ngIf="currentTicket.skills.length === 0">No special skills required</span>
            </div>
          </div>

          <!-- Status History Timeline -->
          <div class="section-card">
            <div class="section-title">📜 Status History Timeline</div>
            <div class="timeline">
              <div class="timeline-item" *ngFor="let item of currentTicket.statusHistory">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                  <span class="timeline-status">{{ formatStatus(item.status) }}</span>
                  <span class="timeline-time">{{ formatTime(item.at) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(2px);
      z-index: 100;
      display: flex;
      justify-content: flex-end;
    }

    .drawer-content {
      width: 460px;
      max-width: 90vw;
      height: 100%;
      background: #0f172a;
      border-left: 1px solid #334155;
      display: flex;
      flex-direction: column;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
    }

    .drawer-header {
      padding: 1rem 1.25rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .header-title h2 {
      margin: 0;
      font-size: 1.1rem;
      color: #ffffff;
      font-family: monospace;
    }

    .pri-badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
    }

    .pri-badge.P1 { background: #dc2626; color: #ffffff; }
    .pri-badge.P2 { background: #ea580c; color: #ffffff; }
    .pri-badge.P3 { background: #2563eb; color: #ffffff; }
    .pri-badge.P4 { background: #475569; color: #ffffff; }

    .vip-tag {
      background: #d97706;
      color: #ffffff;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
    }

    .btn-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 1.25rem;
      cursor: pointer;
    }

    .btn-close:hover {
      color: #ffffff;
    }

    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .meta-section {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    .meta-card {
      background: #1e293b;
      padding: 0.6rem 0.8rem;
      border-radius: 0.375rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .meta-label {
      font-size: 0.7rem;
      color: #94a3b8;
      text-transform: uppercase;
      font-weight: 600;
    }

    .meta-val {
      font-size: 0.85rem;
      font-weight: 600;
      color: #f1f5f9;
    }

    .status-text.open { color: #60a5fa; }
    .status-text.pending_customer { color: #facc15; }
    .status-text.on_hold { color: #c084fc; }
    .status-text.resolved { color: #4ade80; }

    .section-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      padding: 0.8rem 1rem;
    }

    .section-title {
      font-size: 0.75rem;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      margin-bottom: 0.6rem;
    }

    .assignee-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .agent-avatar {
      font-size: 1.5rem;
      background: #334155;
      width: 2.5rem;
      height: 2.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
    }

    .agent-details h4 {
      margin: 0;
      font-size: 0.9rem;
      color: #ffffff;
    }

    .agent-details p {
      margin: 0.1rem 0 0;
      font-size: 0.75rem;
      color: #94a3b8;
    }

    .unassigned-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      color: #f87171;
      font-size: 0.8rem;
    }

    .btn-assign-quick {
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 0.35rem 0.7rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
    }

    .sla-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    .sla-metric-card {
      background: #0f172a;
      border: 1px solid #334155;
      padding: 0.6rem;
      border-radius: 0.375rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .sla-metric-name {
      font-size: 0.7rem;
      color: #94a3b8;
    }

    .sla-status-badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      display: inline-block;
      width: fit-content;
    }

    .sla-status-badge.ok { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .sla-status-badge.at_risk { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .sla-status-badge.breached { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .sla-status-badge.paused { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

    .sla-due-time {
      font-size: 0.7rem;
      color: #64748b;
    }

    .status-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .btn-status {
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-size: 0.75rem;
      padding: 0.35rem 0.6rem;
      border-radius: 0.375rem;
      cursor: pointer;
    }

    .btn-status:hover:not(:disabled) {
      background: #334155;
    }

    .btn-status:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-resolve {
      background: rgba(34, 197, 94, 0.15);
      border-color: #22c55e;
      color: #4ade80;
    }

    .skills-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .skill-chip {
      background: #0f172a;
      border: 1px solid #334155;
      color: #38bdf8;
      font-size: 0.7rem;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
    }

    .timeline {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      padding-left: 0.5rem;
      border-left: 2px solid #334155;
    }

    .timeline-item {
      position: relative;
      padding-left: 1rem;
    }

    .timeline-dot {
      position: absolute;
      left: -0.85rem;
      top: 0.25rem;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #38bdf8;
    }

    .timeline-content {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
    }

    .timeline-status {
      font-weight: 600;
      color: #f1f5f9;
    }

    .timeline-time {
      color: #64748b;
    }
  `]
})
export class TicketDetailComponent {
  public readonly facade = inject(DeskFacade);
  private readonly gateway = inject(TICKET_GATEWAY, { optional: true });

  @Input({ required: true }) public ticket!: Ticket;
  @Output() public readonly close = new EventEmitter<void>();

  public get assignedAgent(): Agent | undefined {
    const id = this.currentTicket.assigneeId;
    return id ? this.facade.state.agents[id] : undefined;
  }

  public get currentTicket(): Ticket {
    // Keep synced with facade state
    return this.facade.state.tickets[this.ticket.id] ?? this.ticket;
  }

  public formatStatus(status: TicketStatus): string {
    return status.replace('_', ' ');
  }

  public formatTime(time: string | Date | undefined): string {
    if (!time) return '-';
    const d = typeof time === 'string' ? new Date(time) : time;
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  public autoAssign(): void {
    this.facade.autoAssignTicket(this.currentTicket.id).subscribe();
  }

  public changeStatus(newStatus: TicketStatus): void {
    if (this.gateway && 'updateTicketStatus' in this.gateway) {
      (this.gateway as MockGateway).updateTicketStatus(this.currentTicket.id, newStatus).subscribe();
    }
  }
}
