import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TicketBoardComponent } from './ticket-board.component';
import { DeskFacade } from '../../application/desk.facade';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';
import { Ticket } from '../../domain/models';

describe('TicketBoardComponent', () => {
  let component: TicketBoardComponent;
  let fixture: ComponentFixture<TicketBoardComponent>;
  let facade: DeskFacade;

  beforeEach(async () => {
    const mockGateway = new MockGateway({ deterministic: true, totalTickets: 25, pageSize: 25 });

    await TestBed.configureTestingModule({
      imports: [TicketBoardComponent],
      providers: [
        { provide: TICKET_GATEWAY, useValue: mockGateway },
        DeskFacade
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TicketBoardComponent);
    component = fixture.componentInstance;
    facade = TestBed.inject(DeskFacade);

    // Initial resync to load tickets into facade
    facade.resynchronize().subscribe();
    fixture.detectChanges();
  });

  it('should initialize and display tickets within virtual window', () => {
    expect(component).toBeTruthy();
    expect(component.filteredTickets.length).toBe(25);
    expect(component.visibleTickets.length).toBeGreaterThan(0);
  });

  it('should filter tickets by priority', () => {
    component.priorityFilter = 'P1';
    component.onFilterChanged();
    expect(component.filteredTickets.every(t => t.priority === 'P1')).toBeTrue();
  });

  it('should filter tickets by region', () => {
    component.regionFilter = 'SA';
    component.onFilterChanged();
    expect(component.filteredTickets.every(t => t.region === 'SA')).toBeTrue();
  });

  it('should filter tickets by search query', () => {
    component.searchQuery = 'ticket-1';
    component.onFilterChanged();
    expect(component.filteredTickets.some(t => t.id === 'ticket-1')).toBeTrue();
  });

  it('should emit selectTicket on row click', () => {
    let selected: Ticket | undefined;
    component.selectTicket.subscribe((t: Ticket) => (selected = t));

    if (component.visibleTickets.length > 0) {
      const first = component.visibleTickets[0];
      component.onRowClick(first);
      expect(selected?.id).toBe(first.id);
      expect(component.selectedTicketId).toBe(first.id);
    }
  });

  it('should identify P2 tickets older than 2 hours', () => {
    const oldP2Ticket: Ticket = {
      id: 'ticket-old-p2',
      version: 1,
      priority: 'P2',
      status: 'open',
      customerTier: 'standard',
      region: 'EU',
      skills: [],
      createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      statusHistory: []
    };
    expect(component.isP2OlderThanTwoHours(oldP2Ticket)).toBeTrue();

    const newP2Ticket: Ticket = {
      ...oldP2Ticket,
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
    };
    expect(component.isP2OlderThanTwoHours(newP2Ticket)).toBeFalse();
  });
});
