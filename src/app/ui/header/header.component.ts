import { Component, EventEmitter, inject, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DeskFacade } from '../../application/desk.facade';
import { MockGateway } from '../../data/mock-gateway.service';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule],
  template: `
    <header class="app-header">
      <div class="brand">
        <div class="logo-icon">⚡</div>
        <div class="brand-text">
          <h1>SLA Command Center</h1>
          <span class="subtitle">Support Desk Live Operations</span>
        </div>
      </div>

      <div class="header-center">
        <!-- Sync Status -->
        <div class="status-indicator" [ngClass]="facade.syncStatus">
          <span class="pulse-dot"></span>
          <span class="status-label">Stream: {{ facade.syncStatus | uppercase }}</span>
          <span class="seq-badge">Seq #{{ facade.lastSeq }}</span>
        </div>

        <!-- SLA Benchmark -->
        <div class="benchmark-pill" *ngIf="facade.slaBenchmark as bm" title="Batch SLA computation benchmark">
          <span class="icon">⏱️</span>
          <span class="metric">SLA Engine: <strong>{{ bm.executionTimeMs }} ms</strong></span>
          <span class="count">({{ bm.ticketCount }} tickets)</span>
        </div>
      </div>

      <div class="header-actions">
        <!-- Sim Controls -->
        <button
          type="button"
          class="btn-control btn-reset"
          (click)="triggerResync()"
          [disabled]="facade.syncStatus === 'resyncing'"
          title="Force StreamReset event to test resync"
        >
          🔄 Resync Stream
        </button>

        <!-- <button
          type="button"
          class="btn-control"
          [class.active]="isHttp500Forced"
          (click)="toggleHttp500()"
          title="Simulate HTTP 500 error on gateway"
        >
          ⚠️ Force 500
        </button>

        <button
          type="button"
          class="btn-control"
          [class.active]="isHttp409Forced"
          (click)="toggleHttp409()"
          title="Simulate HTTP 409 Conflict on gateway"
        >
          ⚡ Force 409
        </button> -->

        <button
          type="button"
          class="btn-simulator-toggle"
          (click)="toggleSimulator.emit()"
          title="Toggle SLA Policy Simulator"
        >
          🧪 Simulator
        </button>
      </div>
    </header>
  `,
  styles: [`
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.5rem;
      background: #111827;
      color: #f3f4f6;
      border-bottom: 1px solid #1f2937;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
      flex-wrap: wrap;
      gap: 1rem;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .logo-icon {
      font-size: 1.5rem;
      background: #2563eb;
      color: #ffffff;
      width: 2.25rem;
      height: 2.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 0.5rem;
    }

    .brand-text h1 {
      margin: 0;
      font-size: 1.15rem;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.02em;
    }

    .brand-text .subtitle {
      font-size: 0.75rem;
      color: #9ca3af;
    }

    .header-center {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #1f2937;
    }

    .status-indicator.synced {
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-indicator.synced .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .status-indicator.resyncing {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .status-indicator.resyncing .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
      animation: pulse 1s infinite;
    }

    .status-indicator.error {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .seq-badge {
      background: rgba(255, 255, 255, 0.1);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-family: monospace;
    }

    .benchmark-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.75rem;
      border-radius: 0.5rem;
      background: #1e293b;
      border: 1px solid #334155;
      font-size: 0.75rem;
      color: #cbd5e1;
    }

    .benchmark-pill strong {
      color: #38bdf8;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-control {
      padding: 0.35rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: #d1d5db;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-control:hover:not(:disabled) {
      background: #374151;
      color: #ffffff;
    }

    .btn-control.active {
      background: #dc2626;
      border-color: #ef4444;
      color: #ffffff;
    }

    .btn-reset:hover {
      border-color: #3b82f6;
      color: #60a5fa;
    }

    .btn-simulator-toggle {
      padding: 0.35rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: #ffffff;
      background: #4f46e5;
      border: 1px solid #6366f1;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: background 0.15s;
    }

    .btn-simulator-toggle:hover {
      background: #4338ca;
    }

    @keyframes pulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }
  `]
})
export class HeaderComponent {
  public readonly facade = inject(DeskFacade);
  private readonly gateway = inject(TICKET_GATEWAY, { optional: true });

  @Output() public readonly toggleSimulator = new EventEmitter<void>();

  public get isHttp500Forced(): boolean {
    return (this.gateway as MockGateway)?.forceHttp500 ?? false;
  }

  public get isHttp409Forced(): boolean {
    return (this.gateway as MockGateway)?.forceHttp409 ?? false;
  }

  public triggerResync(): void {
    if (this.gateway && 'triggerStreamReset' in this.gateway) {
      (this.gateway as MockGateway).triggerStreamReset(this.facade.lastSeq + 10);
    } else {
      this.facade.resynchronize().subscribe();
    }
  }

  public toggleHttp500(): void {
    if (this.gateway && 'forceHttp500' in this.gateway) {
      const mock = this.gateway as MockGateway;
      mock.forceHttp500 = !mock.forceHttp500;
    }
  }

  public toggleHttp409(): void {
    if (this.gateway && 'forceHttp409' in this.gateway) {
      const mock = this.gateway as MockGateway;
      mock.forceHttp409 = !mock.forceHttp409;
    }
  }
}
