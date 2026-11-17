import { SlaSimulatorService, simulateSla } from './sla-simulator.service';

describe('SlaSimulatorService', () => {
  let service: SlaSimulatorService;

  beforeEach(() => {
    service = new SlaSimulatorService();
  });

  it('should simulate a standard P2 ticket during business hours', () => {
    // Created Monday 2026-01-05 at 09:00 UTC (Europe calendar 08:00-16:00)
    // P2 target: 30m firstResponse, 240m resolution
    const result = service.simulate({
      priority: 'P2',
      customerTier: 'standard',
      region: 'EU',
      createdAt: '2026-01-05T09:00:00.000Z',
      evaluationTime: '2026-01-05T09:10:00.000Z'
    });

    expect(result.firstResponse.status).toBe('ok');
    expect(result.firstResponse.targetMinutes).toBe(30);
    expect(result.firstResponse.dueAt).toBe('2026-01-05T09:30:00.000Z');
    expect(result.resolution.status).toBe('ok');
    expect(result.resolution.targetMinutes).toBe(240);
    expect(result.isPaused).toBeFalse();
    expect(result.is24x7).toBeFalse();
  });

  it('should mark firstResponse as breached when evaluationTime exceeds due date', () => {
    const result = service.simulate({
      priority: 'P1',
      customerTier: 'standard',
      region: 'EU',
      createdAt: '2026-01-05T09:00:00.000Z',
      evaluationTime: '2026-01-05T09:20:00.000Z' // 20m elapsed > 15m target
    });

    expect(result.firstResponse.status).toBe('breached');
  });

  it('should mark firstResponse as at_risk when approaching breach threshold', () => {
    // P1 target = 15m. At 13 minutes elapsed (13/15 = 86.7% > 80% threshold)
    const result = service.simulate({
      priority: 'P1',
      customerTier: 'standard',
      region: 'EU',
      createdAt: '2026-01-05T09:00:00.000Z',
      evaluationTime: '2026-01-05T09:13:00.000Z'
    });

    expect(result.firstResponse.status).toBe('at_risk');
  });

  it('should simulate P1 VIP 24/7 rule across weekends without pause', () => {
    // Saturday 2026-01-10 at 12:00 UTC. VIP multiplier 0.5 -> FR 15*0.5 = 7.5 -> 8m
    const result = service.simulate({
      priority: 'P1',
      customerTier: 'vip',
      region: 'EU',
      createdAt: '2026-01-10T12:00:00.000Z',
      evaluationTime: '2026-01-10T12:04:00.000Z'
    });

    expect(result.is24x7).toBeTrue();
    expect(result.firstResponse.status).toBe('ok');
    expect(result.firstResponse.dueAt).toBe('2026-01-10T12:08:00.000Z');
  });

  it('should detect paused SLA when status is pending_customer for standard tier', () => {
    const result = service.simulate({
      priority: 'P3',
      customerTier: 'standard',
      region: 'SA',
      createdAt: '2026-01-05T09:00:00.000Z',
      evaluationTime: '2026-01-05T10:00:00.000Z',
      statusHistory: [
        { status: 'open', at: '2026-01-05T09:00:00.000Z' },
        { status: 'pending_customer', at: '2026-01-05T09:15:00.000Z' }
      ]
    });

    expect(result.isPaused).toBeTrue();
    expect(result.firstResponse.status).toBe('paused');
  });

  it('should accept policy overrides and custom shifts', () => {
    const result = service.simulate({
      priority: 'P4',
      customerTier: 'standard',
      region: 'AE',
      createdAt: '2026-01-05T10:00:00.000Z',
      evaluationTime: '2026-01-05T10:30:00.000Z',
      policyOverrides: {
        firstResponseMins: 45
      },
      customShifts: [{ start: '10:00', end: '18:00' }]
    });

    expect(result.firstResponse.targetMinutes).toBe(45);
    expect(result.firstResponse.dueAt).toBe('2026-01-05T10:45:00.000Z');
  });
});
