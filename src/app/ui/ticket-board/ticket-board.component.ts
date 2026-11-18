import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  OnInit,
  Output,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeskFacade } from '../../application/desk.facade';
import { Agent, Priority, Region, SlaState, Ticket, TicketStatus } from '../../domain/models';

@Component({
  selector: 'app-ticket-board',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="ticket-board-container">
      <!-- Filter Toolbar -->
      <div class="filter-toolbar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search tickets by ID, skill, or assignee..."
            [(ngModel)]="searchQuery"
            (ngModelChange)="onFilterChanged()"
          />
          <button
            *ngIf="searchQuery"
            type="button"
            class="btn-clear"
            (click)="searchQuery = ''; onFilterChanged()"
          >✕</button>
        </div>

        <div class="filter-group">
          <!-- Priority Filter -->
          <div class="filter-item">
            <label>Priority:</label>
            <select [(ngModel)]="priorityFilter" (ngModelChange)="onFilterChanged()">
              <option value="ALL">All Priorities</option>
              <option value="P1">P1 - Critical</option>
              <option value="P2">P2 - High</option>
              <option value="P3">P3 - Medium</option>
              <option value="P4">P4 - Low</option>
            </select>
          </div>

          <!-- Status Filter -->
          <div class="filter-item">
            <label>Status:</label>
            <select [(ngModel)]="statusFilter" (ngModelChange)="onFilterChanged()">
              <option value="ALL">All Statuses</option>
              <option value="open">Open</option>
              <option value="pending_customer">Pending Customer</option>
              <option value="on_hold">On Hold</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>

          <!-- Region Filter -->
          <div class="filter-item">
            <label>Region:</label>
            <select [(ngModel)]="regionFilter" (ngModelChange)="onFilterChanged()">
              <option value="ALL">All Regions</option>
              <option value="EG">Egypt (EG)</option>
              <option value="AE">UAE (AE)</option>
              <option value="SA">Saudi Arabia (SA)</option>
              <option value="EU">Europe (EU)</option>
            </select>
          </div>

          <!-- SLA Filter -->
          <div class="filter-item">
            <label>SLA State:</label>
            <select [(ngModel)]="slaFilter" (ngModelChange)="onFilterChanged()">
              <option value="ALL">All SLA States</option>
              <option value="ok">OK</option>
              <option value="at_risk">At Risk</option>
              <option value="breached">Breached</option>
              <option value="paused">Paused</option>
            </select>
          </div>

          <!-- Tier Filter -->
          <div class="filter-item">
            <label>Customer Tier:</label>
            <select [(ngModel)]="tierFilter" (ngModelChange)="onFilterChanged()">
              <option value="ALL">All Tiers</option>
              <option value="standard">Standard</option>
              <option value="vip">VIP</option>
            </select>
          </div>
        </div>

        <div class="results-meta">
          Showing <strong>{{ filteredTickets.length }}</strong> of {{ facade.tickets.length }} tickets
        </div>
      </div>

      <!-- Error banner if facade error active -->
      <div class="error-banner" *ngIf="facade.error as err">
        <span>⚠️ {{ err }}</span>
        <button type="button" class="btn-clear-error" (click)="facade.clearError()">Dismiss</button>
      </div>

      <!-- Virtualized Ticket Table -->
      <div
        class="table-scroll-viewport"
        #viewport
        (scroll)="onViewportScroll()"
      >
        <div class="virtual-spacer" [style.height.px]="totalVirtualHeight">
          <div class="virtual-content" [style.transform]="'translateY(' + offsetY + 'px)'">
            <table class="tickets-table">
              <thead>
                <tr>
                  <th style="width: 140px;">Ticket ID</th>
                  <th style="width: 70px;">Pri</th>
                  <th style="width: 110px;">Region</th>
                  <th style="width: 130px;">Status</th>
                  <th style="width: 160px;">Assignee</th>
                  <th style="width: 130px;">First Response</th>
                  <th style="width: 130px;">Resolution</th>
                  <th style="width: 110px;">Alerts</th>
                  <th style="width: 220px;">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  *ngFor="let ticket of visibleTickets; trackBy: trackById"
                  [class.selected]="selectedTicketId === ticket.id"
                  [class.mutating]="facade.isTicketMutating(ticket.id)"
                  (click)="onRowClick(ticket)"
                >
                  <!-- ID & Tier -->
                  <td>
                    <div class="id-cell">
                      <span class="id-text">{{ ticket.id }}</span>
                      <span class="vip-tag" *ngIf="ticket.customerTier === 'vip'">VIP</span>
                    </div>
                  </td>

                  <!-- Priority -->
                  <td>
                    <span class="pri-badge" [ngClass]="ticket.priority">{{ ticket.priority }}</span>
                  </td>

                  <!-- Region & Skills -->
                  <td>
                    <div class="region-cell">
                      <span class="reg-tag">{{ ticket.region }}</span>
                      <span class="skills-mini" [title]="ticket.skills.join(', ')">
                        {{ ticket.skills[0] || '-' }}
                        <span *ngIf="ticket.skills.length > 1">+{{ ticket.skills.length - 1 }}</span>
                      </span>
                    </div>
                  </td>

                  <!-- Status -->
                  <td>
                    <span class="status-pill" [ngClass]="ticket.status">{{ formatStatus(ticket.status) }}</span>
                  </td>

                  <!-- Assignee -->
                  <td>
                    <div class="assignee-cell">
                      <span *ngIf="ticket.assigneeId" class="agent-name">
                        👤 {{ getAgentName(ticket.assigneeId) }}
                      </span>
                      <span *ngIf="!ticket.assigneeId" class="unassigned-pill">
                        Unassigned
                      </span>
                    </div>
                  </td>

                  <!-- First Response SLA -->
                  <td>
                    <ng-container *ngIf="facade.state.slaStatus[ticket.id] as sla">
                      <span class="sla-pill" [ngClass]="sla.firstResponse">
                        {{ sla.firstResponse | uppercase }}
                      </span>
                    </ng-container>
                  </td>

                  <!-- Resolution SLA -->
                  <td>
                    <ng-container *ngIf="facade.state.slaStatus[ticket.id] as sla">
                      <span class="sla-pill" [ngClass]="sla.resolution">
                        {{ sla.resolution | uppercase }}
                      </span>
                    </ng-container>
                  </td>

                  <!-- Alerts -->
                  <td>
                    <div class="alerts-cell">
                      <span
                        class="alert-badge breach-badge"
                        *ngIf="facade.state.slaStatus[ticket.id]?.firstResponse === 'breached' || facade.state.slaStatus[ticket.id]?.resolution === 'breached'"
                      >
                        BREACH
                      </span>
                      <span
                        class="alert-badge p2-badge"
                        *ngIf="isP2OlderThanTwoHours(ticket)"
                        title="P2 open > 2 hours"
                      >
                        P2 > 2h
                      </span>
                    </div>
                  </td>

                  <!-- Actions -->
                  <td>
                    <div class="actions-cell" (click)="$event.stopPropagation()">
                      <!-- Auto Assign -->
                      <button
                        type="button"
                        class="btn-action btn-auto"
                        [disabled]="facade.isTicketMutating(ticket.id) || ticket.status === 'resolved'"
                        (click)="autoAssign(ticket.id)"
                        title="Auto-match best agent"
                      >
                        ⚡
                      </button>

                      <!-- Manual Assign Select -->
                      <select
                        class="select-agent"
                        [disabled]="facade.isTicketMutating(ticket.id) || ticket.status === 'resolved'"
                        [ngModel]="ticket.assigneeId || ''"
                        (ngModelChange)="onManualAssign(ticket.id, $event)"
                      >
                        <option value="" disabled>Assign to...</option>
                        <option
                          *ngFor="let ag of facade.agents"
                          [value]="ag.id"
                          [disabled]="ag.status === 'offline' || (facade.agentLoad[ag.id] || 0) >= ag.maxLoad"
                        >
                          {{ ag.name }} ({{ facade.agentLoad[ag.id] || 0 }}/{{ ag.maxLoad }})
                        </option>
                      </select>

                      <!-- Undo Button -->
                      <button
                        type="button"
                        class="btn-action btn-undo"
                        *ngIf="facade.canUndoReassignment(ticket.id)"
                        (click)="undoReassignment(ticket.id)"
                        title="Undo recent reassignment"
                      >
                        ↩ Undo
                      </button>
                    </div>
                  </td>
                </tr>

                <tr *ngIf="visibleTickets.length === 0">
                  <td colspan="9" class="empty-state">
                    No tickets found matching current filters.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .ticket-board-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 0.5rem;
      overflow: hidden;
      margin: 1rem 1.5rem;
    }

    .filter-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
    }

    .search-box {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 220px;
    }

    .search-icon {
      position: absolute;
      left: 0.6rem;
      font-size: 0.85rem;
      color: #94a3b8;
    }

    .search-box input {
      width: 100%;
      padding: 0.4rem 2rem 0.4rem 2rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.375rem;
      color: #f1f5f9;
      font-size: 0.8rem;
    }

    .search-box input:focus {
      outline: none;
      border-color: #38bdf8;
    }

    .btn-clear {
      position: absolute;
      right: 0.5rem;
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
    }

    .filter-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .filter-item {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.75rem;
      color: #94a3b8;
    }

    .filter-item select {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.375rem;
      color: #f1f5f9;
      font-size: 0.75rem;
      padding: 0.35rem 0.5rem;
      cursor: pointer;
    }

    .results-meta {
      font-size: 0.75rem;
      color: #94a3b8;
      margin-left: auto;
    }

    .results-meta strong {
      color: #38bdf8;
    }

    .error-banner {
      background: #7f1d1d;
      color: #fee2e2;
      padding: 0.5rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8rem;
      font-weight: 500;
    }

    .btn-clear-error {
      background: transparent;
      border: 1px solid #f87171;
      color: #ffffff;
      border-radius: 4px;
      padding: 0.1rem 0.4rem;
      font-size: 0.7rem;
      cursor: pointer;
    }

    .table-scroll-viewport {
      flex: 1;
      overflow-y: auto;
      position: relative;
      height: 550px;
    }

    .virtual-spacer {
      position: relative;
      width: 100%;
    }

    .virtual-content {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
    }

    .tickets-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 0.78rem;
    }

    .tickets-table th {
      position: sticky;
      top: 0;
      background: #1e293b;
      color: #94a3b8;
      font-weight: 600;
      text-align: left;
      padding: 0.6rem 0.75rem;
      border-bottom: 2px solid #334155;
      z-index: 2;
    }

    .tickets-table td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #1e293b;
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      height: 48px;
      box-sizing: border-box;
    }

    .tickets-table tr {
      background: #0f172a;
      cursor: pointer;
      transition: background 0.1s;
    }

    .tickets-table tr:hover {
      background: #1e293b;
    }

    .tickets-table tr.selected {
      background: #1e293b;
      border-left: 3px solid #38bdf8;
    }

    .tickets-table tr.mutating {
      opacity: 0.7;
    }

    .id-cell {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .id-text {
      font-family: monospace;
      font-weight: 600;
      color: #f1f5f9;
    }

    .vip-tag {
      background: #d97706;
      color: #ffffff;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
    }

    .pri-badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      display: inline-block;
    }

    .pri-badge.P1 { background: #dc2626; color: #ffffff; }
    .pri-badge.P2 { background: #ea580c; color: #ffffff; }
    .pri-badge.P3 { background: #2563eb; color: #ffffff; }
    .pri-badge.P4 { background: #475569; color: #ffffff; }

    .region-cell {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .reg-tag {
      background: #334155;
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      font-weight: 600;
      font-size: 0.7rem;
    }

    .skills-mini {
      color: #94a3b8;
      font-size: 0.7rem;
    }

    .status-pill {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.15rem 0.4rem;
      border-radius: 9999px;
      display: inline-block;
    }

    .status-pill.open { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .status-pill.pending_customer { background: rgba(234, 179, 8, 0.2); color: #facc15; }
    .status-pill.on_hold { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
    .status-pill.resolved { background: rgba(34, 197, 94, 0.2); color: #4ade80; }

    .assignee-cell {
      display: flex;
      align-items: center;
    }

    .agent-name {
      color: #e2e8f0;
      font-weight: 500;
    }

    .unassigned-pill {
      color: #f87171;
      font-style: italic;
      font-size: 0.72rem;
    }

    .sla-pill {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      display: inline-block;
    }

    .sla-pill.ok { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .sla-pill.at_risk { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .sla-pill.breached { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .sla-pill.paused { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }

    .alerts-cell {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
    }

    .alert-badge {
      font-size: 0.6rem;
      font-weight: 800;
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
    }

    .breach-badge {
      background: #b91c1c;
      color: #ffffff;
    }

    .p2-badge {
      background: #be185d;
      color: #ffffff;
    }

    .actions-cell {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .btn-action {
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      border-radius: 0.25rem;
      padding: 0.2rem 0.4rem;
      font-size: 0.72rem;
      cursor: pointer;
    }

    .btn-action:hover:not(:disabled) {
      background: #334155;
    }

    .btn-action:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-auto {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }

    .btn-undo {
      background: #475569;
      color: #fbbf24;
      font-weight: 600;
    }

    .select-agent {
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-size: 0.7rem;
      padding: 0.2rem 0.3rem;
      border-radius: 0.25rem;
      max-width: 110px;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: #64748b;
      font-size: 0.85rem;
    }
  `]
})
export class TicketBoardComponent implements OnInit {
  public readonly facade = inject(DeskFacade);

  @Output() public readonly selectTicket = new EventEmitter<Ticket>();
  @ViewChild('viewport') private readonly viewportRef?: ElementRef<HTMLDivElement>;

  public searchQuery = '';
  public priorityFilter = 'ALL';
  public statusFilter = 'ALL';
  public regionFilter = 'ALL';
  public slaFilter = 'ALL';
  public tierFilter = 'ALL';

  public selectedTicketId: string | null = null;

  // Virtual Windowing configuration
  public readonly rowHeight = 48;
  public readonly bufferCount = 8;
  public totalVirtualHeight = 0;
  public offsetY = 0;
  public filteredTickets: Ticket[] = [];
  public visibleTickets: Ticket[] = [];

  public ngOnInit(): void {
    this.facade.tickets$.subscribe(() => {
      this.onFilterChanged();
    });
  }

  public onFilterChanged(): void {
    const query = this.searchQuery.trim().toLowerCase();
    const all = this.facade.tickets;

    this.filteredTickets = all.filter(ticket => {
      // Query filter
      if (query) {
        const idMatches = ticket.id.toLowerCase().includes(query);
        const skillMatches = ticket.skills.some(s => s.toLowerCase().includes(query));
        const agentNameMatches = ticket.assigneeId
          ? (this.facade.state.agents[ticket.assigneeId]?.name.toLowerCase().includes(query) ?? false)
          : false;
        if (!idMatches && !skillMatches && !agentNameMatches) {
          return false;
        }
      }

      // Priority filter
      if (this.priorityFilter !== 'ALL' && ticket.priority !== this.priorityFilter) {
        return false;
      }

      // Status filter
      if (this.statusFilter !== 'ALL' && ticket.status !== this.statusFilter) {
        return false;
      }

      // Region filter
      if (this.regionFilter !== 'ALL' && ticket.region !== this.regionFilter) {
        return false;
      }

      // Customer Tier filter
      if (this.tierFilter !== 'ALL' && ticket.customerTier !== this.tierFilter) {
        return false;
      }

      // SLA Filter
      if (this.slaFilter !== 'ALL') {
        const sla = this.facade.state.slaStatus[ticket.id];
        if (!sla || (sla.firstResponse !== this.slaFilter && sla.resolution !== this.slaFilter)) {
          return false;
        }
      }

      return true;
    });

    this.totalVirtualHeight = this.filteredTickets.length * this.rowHeight;
    this.updateVisibleSlice();
  }

  public onViewportScroll(): void {
    this.updateVisibleSlice();
  }

  private updateVisibleSlice(): void {
    const el = this.viewportRef?.nativeElement;
    const scrollTop = el?.scrollTop ?? 0;
    const viewportHeight = el?.clientHeight ?? 550;

    const startIndex = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferCount);
    const visibleCount = Math.ceil(viewportHeight / this.rowHeight) + this.bufferCount * 2;
    const endIndex = Math.min(this.filteredTickets.length, startIndex + visibleCount);

    this.offsetY = startIndex * this.rowHeight;
    this.visibleTickets = this.filteredTickets.slice(startIndex, endIndex);
  }

  public getAgentName(agentId?: string): string {
    if (!agentId) return '';
    return this.facade.state.agents[agentId]?.name || agentId;
  }

  public trackById(_index: number, ticket: Ticket): string {
    return ticket.id;
  }

  public formatStatus(status: TicketStatus): string {
    return status.replace('_', ' ');
  }

  public onRowClick(ticket: Ticket): void {
    this.selectedTicketId = ticket.id;
    this.selectTicket.emit(ticket);
  }

  public autoAssign(ticketId: string): void {
    this.facade.autoAssignTicket(ticketId).subscribe();
  }

  public onManualAssign(ticketId: string, agentId: string): void {
    if (agentId) {
      this.facade.assignTicket(ticketId, agentId).subscribe();
    }
  }

  public undoReassignment(ticketId: string): void {
    this.facade.undoReassignment(ticketId).subscribe();
  }

  public isP2OlderThanTwoHours(ticket: Ticket): boolean {
    if (ticket.priority !== 'P2' || ticket.status === 'resolved') {
      return false;
    }
    const createdMs = new Date(ticket.createdAt).getTime();
    return Date.now() - createdMs > 2 * 3600 * 1000;
  }
}
