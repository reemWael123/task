import { Component, EventEmitter, inject, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CustomerTier,
  Priority,
  Region,
  TicketStatus
} from '../../domain/models';
import {
  SlaSimulatorService,
  SlaSimulationResult
} from '../../domain/sla-simulator/sla-simulator.service';

@Component({
  selector: 'app-sla-simulator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="simulator-panel">
      <div class="simulator-header">
        <div class="header-left">
          <span class="icon">🧪</span>
          <h3>SLA Policy Simulator (Day 2 Sandbox)</h3>
          <span class="sandbox-tag">No Live State Mutation</span>
        </div>
        <button type="button" class="btn-close" (click)="close.emit()">✕</button>
      </div>

      <div class="simulator-body">
        <!-- Controls Column -->
        <div class="controls-column">
          <div class="control-row">
            <div class="form-group">
              <label>Priority</label>
              <select [(ngModel)]="priority" (ngModelChange)="runSimulation()">
                <option value="P1">P1 - Critical</option>
                <option value="P2">P2 - High</option>
                <option value="P3">P3 - Medium</option>
                <option value="P4">P4 - Low</option>
              </select>
            </div>

            <div class="form-group">
              <label>Customer Tier</label>
              <select [(ngModel)]="customerTier" (ngModelChange)="runSimulation()">
                <option value="standard">Standard Tier</option>
                <option value="vip">VIP Tier (Multiplier Applied)</option>
              </select>
            </div>

            <div class="form-group">
              <label>Region & Calendar</label>
              <select [(ngModel)]="region" (ngModelChange)="runSimulation()">
                <option value="SA">Saudi Arabia (SA) - Sun-Thu UTC+3</option>
                <option value="EG">Egypt (EG) - Sun-Thu Africa/Cairo</option>
                <option value="EU">Europe (EU) - Mon-Fri UTC</option>
                <option value="AE">UAE (AE) - Sun-Thu Asia/Dubai</option>
              </select>
            </div>

            <div class="form-group">
              <label>Ticket Status</label>
              <select [(ngModel)]="status" (ngModelChange)="runSimulation()">
                <option value="open">Open (Clock Running)</option>
                <option value="pending_customer">Pending Customer (Paused)</option>
                <option value="on_hold">On Hold (Paused)</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>
          </div>

          <!-- Time Controls -->
          <div class="time-controls">
            <label>Virtual Evaluation Clock: <strong>+{{ offsetMinutes }} mins</strong></label>
            <div class="button-presets">
              <button type="button" (click)="setOffset(0)">Now (+0m)</button>
              <button type="button" (click)="setOffset(15)">+15 mins</button>
              <button type="button" (click)="setOffset(60)">+1 hour</button>
              <button type="button" (click)="setOffset(240)">+4 hours</button>
              <button type="button" (click)="setOffset(1440)">+24 hours</button>
              <button type="button" (click)="setOffset(2880)">+48h (Weekend Bridge)</button>
            </div>
          </div>
        </div>

        <!-- Live Output Preview -->
        <div class="output-column" *ngIf="result as res">
          <div class="rule-badges">
            <span class="rule-badge vip-247" *ngIf="res.is24x7">⚡ 24/7 VIP Clock (Option 2B Active)</span>
            <span class="rule-badge paused-badge" *ngIf="res.isPaused">⏸️ SLA Paused</span>
            <span class="rule-badge tz-badge">🌐 Timezone: {{ res.calendarTimezone }}</span>
          </div>

          <div class="metrics-grid">
            <!-- First Response Card -->
            <div class="metric-card" [ngClass]="res.firstResponse.status">
              <div class="card-header">
                <h4>First Response SLA</h4>
                <span class="sla-badge" [ngClass]="res.firstResponse.status">{{ res.firstResponse.status | uppercase }}</span>
              </div>
              <div class="metric-stats">
                <div>Target: <strong>{{ res.firstResponse.targetMinutes }}m</strong></div>
                <div>Elapsed: <strong>{{ res.firstResponse.elapsedMinutes }}m</strong></div>
                <div>Remaining: <strong>{{ res.firstResponse.remainingMinutes }}m</strong></div>
              </div>
              <div class="progress-wrap">
                <div class="progress-bar" [style.width.%]="res.firstResponse.percentageElapsed" [ngClass]="res.firstResponse.status"></div>
              </div>
              <div class="due-date">Due: {{ res.firstResponse.dueAt }}</div>
            </div>

            <!-- Resolution Card -->
            <div class="metric-card" [ngClass]="res.resolution.status">
              <div class="card-header">
                <h4>Resolution SLA</h4>
                <span class="sla-badge" [ngClass]="res.resolution.status">{{ res.resolution.status | uppercase }}</span>
              </div>
              <div class="metric-stats">
                <div>Target: <strong>{{ res.resolution.targetMinutes }}m</strong></div>
                <div>Elapsed: <strong>{{ res.resolution.elapsedMinutes }}m</strong></div>
                <div>Remaining: <strong>{{ res.resolution.remainingMinutes }}m</strong></div>
              </div>
              <div class="progress-wrap">
                <div class="progress-bar" [style.width.%]="res.resolution.percentageElapsed" [ngClass]="res.resolution.status"></div>
              </div>
              <div class="due-date">Due: {{ res.resolution.dueAt }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .simulator-panel {
      background: #182234;
      border: 1px solid #3b82f6;
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
      margin: 1rem 1.5rem;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
    }

    .simulator-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #2563eb;
      padding-bottom: 0.5rem;
      margin-bottom: 0.75rem;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .header-left h3 {
      margin: 0;
      font-size: 0.95rem;
      color: #93c5fd;
    }

    .sandbox-tag {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
    }

    .btn-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 1.1rem;
      cursor: pointer;
    }

    .simulator-body {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 1.25rem;
    }

    @media (max-width: 900px) {
      .simulator-body {
        grid-template-columns: 1fr;
      }
    }

    .controls-column {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .control-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.6rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .form-group label {
      font-size: 0.7rem;
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
    }

    .form-group select {
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 0.35rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
    }

    .time-controls {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      background: #0f172a;
      padding: 0.6rem;
      border-radius: 0.375rem;
      border: 1px solid #1e293b;
    }

    .time-controls label {
      font-size: 0.75rem;
      color: #cbd5e1;
    }

    .time-controls strong {
      color: #38bdf8;
    }

    .button-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .button-presets button {
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      font-size: 0.7rem;
      padding: 0.2rem 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
    }

    .button-presets button:hover {
      background: #2563eb;
      color: #ffffff;
    }

    .output-column {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .rule-badges {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }

    .rule-badge {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
    }

    .vip-247 { background: #d97706; color: #ffffff; }
    .paused-badge { background: #64748b; color: #ffffff; }
    .tz-badge { background: #1e293b; color: #94a3b8; }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    .metric-card {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.375rem;
      padding: 0.6rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-header h4 {
      margin: 0;
      font-size: 0.8rem;
      color: #f1f5f9;
    }

    .sla-badge {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
    }

    .sla-badge.ok { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .sla-badge.at_risk { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .sla-badge.breached { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .sla-badge.paused { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

    .metric-stats {
      font-size: 0.7rem;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
    }

    .metric-stats strong {
      color: #f1f5f9;
    }

    .progress-wrap {
      height: 6px;
      background: #1e293b;
      border-radius: 9999px;
      overflow: hidden;
    }

    .progress-bar {
      height: 100%;
      border-radius: 9999px;
    }

    .progress-bar.ok { background: #22c55e; }
    .progress-bar.at_risk { background: #f59e0b; }
    .progress-bar.breached { background: #ef4444; }
    .progress-bar.paused { background: #64748b; }

    .due-date {
      font-size: 0.65rem;
      color: #64748b;
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `]
})
export class SlaSimulatorComponent implements OnInit {
  private readonly simulator = inject(SlaSimulatorService);

  @Output() public readonly close = new EventEmitter<void>();

  public priority: Priority = 'P1';
  public customerTier: CustomerTier = 'vip';
  public region: Region = 'SA';
  public status: TicketStatus = 'open';
  public offsetMinutes = 10;

  public result: SlaSimulationResult | null = null;

  public ngOnInit(): void {
    this.runSimulation();
  }

  public setOffset(mins: number): void {
    this.offsetMinutes = mins;
    this.runSimulation();
  }

  public runSimulation(): void {
    const baseCreated = new Date('2026-01-05T09:00:00.000Z');
    const evalDate = new Date(baseCreated.getTime() + this.offsetMinutes * 60 * 1000);

    const statusHistory = [
      { status: 'open' as TicketStatus, at: baseCreated.toISOString() }
    ];
    if (this.status !== 'open') {
      statusHistory.push({
        status: this.status,
        at: new Date(baseCreated.getTime() + 5 * 60 * 1000).toISOString()
      });
    }

    this.result = this.simulator.simulate({
      priority: this.priority,
      customerTier: this.customerTier,
      region: this.region,
      createdAt: baseCreated.toISOString(),
      evaluationTime: evalDate.toISOString(),
      statusHistory
    });
  }
}
