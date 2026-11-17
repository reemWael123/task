import { ComponentFixture, TestBed } from '@angular/core';
import { TicketDetailComponent } from './ticket-detail.component';
import { DeskFacade } from '../../application/desk.facade';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';
import { Ticket } from '../../domain/models';

describe('TicketDetailComponent', () => {
  let component: TicketDetailComponent;
  let fixture: ComponentFixture<TicketDetailComponent>;
  let mockGateway: MockGateway;

  const sampleTicket: Ticket = {
    id: 'ticket-detail-1',
    version: 1,
    priority: 'P1',
    status: 'open',
    customerTier: 'vip',
    region: 'SA',
    skills: ['billing'],
    createdAt: '2026-11-18T08:00:00.000Z',
    statusHistory: [{ status: 'open', at: '2026-11-18T08:00:00.000Z' }]
  };

  beforeEach(async () => {
    mockGateway = new MockGateway({ deterministic: true, totalTickets: 10 });

    await TestBed.configureTestingModule({
      imports: [TicketDetailComponent],
      providers: [
        { provide: TICKET_GATEWAY, useValue: mockGateway },
        DeskFacade
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TicketDetailComponent);
    component = fixture.componentInstance;
    component.ticket = sampleTicket;
    fixture.detectChanges();
  });

  it('should render ticket details and VIP tag', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('ticket-detail-1');
    expect(el.querySelector('.vip-tag')?.textContent).toContain('VIP');
  });

  it('should emit close event on close button click', () => {
    let closed = false;
    component.close.subscribe(() => (closed = true));

    const btn = fixture.nativeElement.querySelector('.btn-close') as HTMLButtonElement;
    btn.click();
    expect(closed).toBeTrue();
  });

  it('should format status strings correctly', () => {
    expect(component.formatStatus('pending_customer')).toBe('pending customer');
    expect(component.formatStatus('on_hold')).toBe('on hold');
  });
});
