import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { TICKET_GATEWAY } from './application/ticket-gateway.interface';
import { MockGateway } from './data/mock-gateway.service';
import { DeskFacade } from './application/desk.facade';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        {
          provide: TICKET_GATEWAY,
          useValue: new MockGateway({
            totalTickets: 20,
            pageSize: 10,
            deterministic: true
          })
        },
        DeskFacade
      ]
    }).compileComponents();
  });

  it('should create the app and trigger initial data hydration', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();

    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('SLA Command Center');
  });

  it('should toggle SLA Policy Simulator view', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.showSimulator).toBeFalse();

    app.onToggleSimulator();
    expect(app.showSimulator).toBeTrue();

    app.onToggleSimulator();
    expect(app.showSimulator).toBeFalse();
  });

  it('should select ticket and display ticket details drawer', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const mockTicket = app.facade.tickets[0];
    if (mockTicket) {
      app.onSelectTicket(mockTicket);
      expect(app.selectedTicket?.id).toBe(mockTicket.id);

      app.onCloseDetail();
      expect(app.selectedTicket).toBeNull();
    }
  });
});
