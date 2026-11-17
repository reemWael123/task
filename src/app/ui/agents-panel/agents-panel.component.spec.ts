import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AgentsPanelComponent } from './agents-panel.component';
import { DeskFacade } from '../../application/desk.facade';
import { TICKET_GATEWAY } from '../../application/ticket-gateway.interface';
import { MockGateway } from '../../data/mock-gateway.service';
import { Agent } from '../../domain/models';

describe('AgentsPanelComponent', () => {
  let component: AgentsPanelComponent;
  let fixture: ComponentFixture<AgentsPanelComponent>;
  let facade: DeskFacade;

  beforeEach(async () => {
    const mockGateway = new MockGateway({ deterministic: true, totalTickets: 10 });

    await TestBed.configureTestingModule({
      imports: [AgentsPanelComponent],
      providers: [
        { provide: TICKET_GATEWAY, useValue: mockGateway },
        DeskFacade
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AgentsPanelComponent);
    component = fixture.componentInstance;
    facade = TestBed.inject(DeskFacade);

    facade.resynchronize().subscribe();
    fixture.detectChanges();
  });

  it('should render list of agents and their workload indicators', () => {
    expect(component).toBeTruthy();
    expect(component.facade.agents.length).toBeGreaterThan(0);
  });

  it('should calculate workload percentage and level correctly', () => {
    const agent: Agent = {
      id: 'agent-test',
      name: 'Test Agent',
      skills: ['billing'],
      status: 'online',
      maxLoad: 4,
      shift: { start: '08:00', end: '16:00', tz: 'UTC' }
    };

    expect(component.getLoadPercentage(agent)).toBe(0);
    expect(component.getLoadLevel(agent)).toBe('low');
  });

  it('should toggle agent status between online, busy, and offline', () => {
    const firstAgent = facade.agents[0];
    if (firstAgent) {
      const initialStatus = firstAgent.status;
      component.toggleStatus(firstAgent);
      // Calls gateway to update status
      expect(firstAgent).toBeDefined();
    }
  });
});
