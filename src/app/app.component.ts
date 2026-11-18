import { Component, inject, OnInit, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { DeskFacade } from './application/desk.facade';
import { Ticket } from './domain/models';
import {
  AgentsPanelComponent,
  EscalationQueueComponent,
  HeaderComponent,
  SlaSimulatorComponent,
  TicketBoardComponent,
  TicketDetailComponent
} from './ui';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    HeaderComponent,
    EscalationQueueComponent,
    TicketBoardComponent,
    TicketDetailComponent,
    AgentsPanelComponent,
    SlaSimulatorComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  private readonly platformId = inject(PLATFORM_ID);
  public readonly facade = inject(DeskFacade);

  public selectedTicket: Ticket | null = null;
  public showSimulator = false;

  public ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      // Initial data hydration: fetch tickets and agents via paginated resynchronize
      this.facade.resynchronize().subscribe();
    }
  }

  public onSelectTicket(ticket: Ticket): void {
    this.selectedTicket = ticket;
  }

  public onCloseDetail(): void {
    this.selectedTicket = null;
  }

  public onToggleSimulator(): void {
    this.showSimulator = !this.showSimulator;
  }
}
