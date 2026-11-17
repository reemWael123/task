import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DeskFacade } from '../../application/desk.facade';
import { Agent } from '../../domain/models';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';

@Component({
  selector: 'app-agents-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="agents-panel">
      <div class="panel-header">
        <div class="header-title">
          <span class="icon">👥</span>
          <h3>Active Agent Roster</h3>
        </div>
        <span class="agent-count">{{ facade.agents.length }} agents registered</span>
      </div>

      <div class="agents-grid">
        <div
          class="agent-card"
          *ngFor="let agent of facade.agents"
          [ngClass]="agent.status"
        >
          <div class="card-top">
            <div class="agent-meta">
              <span class="status-indicator" [ngClass]="agent.status"></span>
              <h4>{{ agent.name }}</h4>
            </div>
            <button
              type="button"
              class="btn-toggle-status"
              (click)="toggleStatus(agent)"
              title="Click to toggle status (Online -> Busy -> Offline)"
            >
              {{ agent.status | uppercase }}
            </button>
          </div>

          <!-- Shift & Timezone -->
          <div class="shift-info" *ngIf="agent.shift as s">
            <span class="shift-time">🕒 {{ s.start }} - {{ s.end }}</span>
            <span class="shift-tz">({{ s.tz }})</span>
          </div>

          <!-- Capacity Bar -->
          <div class="capacity-section">
            <div class="capacity-label">
              <span>Workload</span>
              <strong>{{ facade.agentLoad[agent.id] || 0 }} / {{ agent.maxLoad }}</strong>
            </div>
            <div class="progress-track">
              <div
                class="progress-fill"
                [style.width.%]="getLoadPercentage(agent)"
                [ngClass]="getLoadLevel(agent)"
              ></div>
            </div>
          </div>

          <!-- Skills Chips -->
          <div class="skills-list">
            <span class="skill-tag" *ngFor="let skill of agent.skills">{{ skill }}</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .agents-panel {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
      margin: 1rem 1.5rem;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .header-title h3 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 700;
      color: #f1f5f9;
    }

    .agent-count {
      font-size: 0.75rem;
      color: #94a3b8;
    }

    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 0.75rem;
    }

    .agent-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.375rem;
      padding: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: border-color 0.15s;
    }

    .agent-card.offline {
      opacity: 0.65;
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-indicator.online { background: #10b981; box-shadow: 0 0 6px #10b981; }
    .status-indicator.busy { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    .status-indicator.offline { background: #64748b; }

    .agent-meta h4 {
      margin: 0;
      font-size: 0.85rem;
      font-weight: 600;
      color: #ffffff;
    }

    .btn-toggle-status {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.15s;
    }

    .online .btn-toggle-status {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.4);
    }

    .busy .btn-toggle-status {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.4);
    }

    .offline .btn-toggle-status {
      background: rgba(100, 116, 139, 0.2);
      color: #94a3b8;
      border-color: rgba(100, 116, 139, 0.4);
    }

    .shift-info {
      font-size: 0.7rem;
      color: #94a3b8;
      display: flex;
      gap: 0.3rem;
    }

    .capacity-section {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .capacity-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.7rem;
      color: #cbd5e1;
    }

    .progress-track {
      height: 6px;
      background: #0f172a;
      border-radius: 9999px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 9999px;
      transition: width 0.2s;
    }

    .progress-fill.low { background: #10b981; }
    .progress-fill.medium { background: #3b82f6; }
    .progress-fill.high { background: #f59e0b; }
    .progress-fill.full { background: #ef4444; }

    .skills-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .skill-tag {
      background: #0f172a;
      border: 1px solid #334155;
      color: #94a3b8;
      font-size: 0.65rem;
      padding: 0.05rem 0.35rem;
      border-radius: 3px;
    }
  `]
})
export class AgentsPanelComponent {
  public readonly facade = inject(DeskFacade);
  private readonly gateway = inject(TICKET_GATEWAY, { optional: true });

  public getLoadPercentage(agent: Agent): number {
    const current = this.facade.agentLoad[agent.id] ?? 0;
    if (agent.maxLoad <= 0) return 0;
    return Math.min(100, Math.round((current / agent.maxLoad) * 100));
  }

  public getLoadLevel(agent: Agent): string {
    const pct = this.getLoadPercentage(agent);
    if (pct >= 100) return 'full';
    if (pct >= 75) return 'high';
    if (pct >= 40) return 'medium';
    return 'low';
  }

  public toggleStatus(agent: Agent): void {
    const nextStatus: Agent['status'] =
      agent.status === 'online' ? 'busy' : agent.status === 'busy' ? 'offline' : 'online';

    if (this.gateway && 'updateAgentStatus' in this.gateway) {
      (this.gateway as MockGateway).updateAgentStatus(agent.id, nextStatus).subscribe();
    }
  }
}
