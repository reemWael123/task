import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HeaderComponent } from './header.component';
import { DeskFacade } from '../../application/desk.facade';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';

describe('HeaderComponent', () => {
  let component: HeaderComponent;
  let fixture: ComponentFixture<HeaderComponent>;
  let mockGateway: MockGateway;

  beforeEach(async () => {
    mockGateway = new MockGateway({ deterministic: true, totalTickets: 10 });

    await TestBed.configureTestingModule({
      imports: [HeaderComponent],
      providers: [
        { provide: TICKET_GATEWAY, useValue: mockGateway },
        DeskFacade
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(HeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should render brand and stream sync status', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('SLA Command Center');
    expect(el.querySelector('.status-label')?.textContent).toContain('SYNCED');
  });

  it('should toggle HTTP 500 error simulation flag', () => {
    expect(component.isHttp500Forced).toBeFalse();
    component.toggleHttp500();
    expect(component.isHttp500Forced).toBeTrue();
    component.toggleHttp500();
    expect(component.isHttp500Forced).toBeFalse();
  });

  it('should toggle HTTP 409 conflict simulation flag', () => {
    expect(component.isHttp409Forced).toBeFalse();
    component.toggleHttp409();
    expect(component.isHttp409Forced).toBeTrue();
  });

  it('should emit toggleSimulator event', () => {
    let emitted = false;
    component.toggleSimulator.subscribe(() => (emitted = true));
    const btn = fixture.nativeElement.querySelector('.btn-simulator-toggle') as HTMLButtonElement;
    btn.click();
    expect(emitted).toBeTrue();
  });
});
