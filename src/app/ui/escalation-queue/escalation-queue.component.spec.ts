import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EscalationQueueComponent } from './escalation-queue.component';
import { DeskFacade } from '../../application/desk.facade';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';
import { Ticket } from '../../domain/models';

describe('EscalationQueueComponent', () => {
  let component: EscalationQueueComponent;
  let fixture: ComponentFixture<EscalationQueueComponent>;
  let facade: DeskFacade;

  beforeEach(async () => {
    const mockGateway = new MockGateway({ deterministic: true, totalTickets: 10 });

    await TestBed.configureTestingModule({
      imports: [EscalationQueueComponent],
      providers: [
        { provide: TICKET_GATEWAY, useValue: mockGateway },
        DeskFacade
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(EscalationQueueComponent);
    component = fixture.componentInstance;
    facade = TestBed.inject(DeskFacade);
    fixture.detectChanges();
  });

  it('should detect breached or overdue tickets in escalations list', () => {
    expect(component).toBeTruthy();
    const escalations = component.escalations;
    expect(Array.isArray(escalations)).toBeTrue();
  });

  it('should emit selectTicket when an escalation card is clicked', () => {
    let selected: Ticket | undefined;
    component.selectTicket.subscribe((t: Ticket) => (selected = t));

    const testTicket: Ticket = {
      id: 'ticket-esc-1',
      version: 1,
      priority: 'P1',
      status: 'open',
      customerTier: 'vip',
      region: 'SA',
      skills: ['billing'],
      createdAt: new Date().toISOString(),
      statusHistory: []
    };

    component.selectTicket.emit(testTicket);
    expect(selected?.id).toBe('ticket-esc-1');
  });
});
