import { calculateSla } from './sla-calculator';
import { Ticket, SlaPolicy } from '../models';
import { createEuropeCalendar, createEgyptCalendar, createSaudiCalendar } from '../calendar/regional-calendars';
import { ShiftWindow } from '../models/calendar.model';

describe('SlaCalculator', () => {
  const standardShifts: readonly ShiftWindow[] = [{ start: '09:00', end: '17:00' }];
  // Europe calendar: Mon-Fri 09:00-17:00 UTC (winter)
  const europeCalendar = createEuropeCalendar(standardShifts);
  // Egypt calendar: Sun-Thu 09:00-17:00 Africa/Cairo
  const egyptCalendar = createEgyptCalendar(standardShifts);

  const baseP1Policy: SlaPolicy = {
    priority: 'P1',
    firstResponseMins: 60, // 1 hour
    resolutionMins: 240, // 4 hours
    vipMultiplier: 0.5 // 50% time for VIP
  };

  const baseP2Policy: SlaPolicy = {
    priority: 'P2',
    firstResponseMins: 120, // 2 hours
    resolutionMins: 480, // 8 hours
    vipMultiplier: 0.5
  };

  function createBaseTicket(overrides: Partial<Ticket> = {}): Ticket {
    return {
      id: 'ticket-1',
      version: 1,
      priority: 'P1',
      status: 'open',
      customerTier: 'standard',
      region: 'EU',
      skills: ['billing'],
      createdAt: '2026-01-05T09:00:00Z', // Monday 09:00
      statusHistory: [],
      ...overrides
    };
  }

  describe('Decision 1: vipMultiplier Semantics (Option 1A)', () => {
    it('should use base policy minutes for standard customer tier', () => {
      // Monday 09:00, policy FR is 60m. At 09:30 (30m elapsed = 50%), state is 'ok'
      const ticket = createBaseTicket({
        customerTier: 'standard'
      });
      const now = new Date('2026-01-05T09:30:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('ok');
      // Due at 09:00 + 60m = 10:00
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    });

    it('should apply vipMultiplier to reduce target durations for VIP tier', () => {
      // P2 base FR is 120m * vipMultiplier (0.5) = 60m VIP target.
      // At 09:45 (45m elapsed / 60m = 75%), state is 'at_risk'
      const ticket = createBaseTicket({
        customerTier: 'vip',
        priority: 'P2' // P2 VIP to test standard business calendar with VIP multiplier
      });
      const now = new Date('2026-01-05T09:45:00Z');
      const result = calculateSla(ticket, baseP2Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('at_risk');
      // Due at 09:00 + 60m = 10:00
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
      // Resolution base is 480m * 0.5 = 240m (4 hours). Due at 13:00
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });
  });

  describe('Decision 2: Day-2 P1 VIP 24/7 Behavior (Option 2B)', () => {
    it('should calculate P1 VIP SLA 24/7 across weekends and outside business hours', () => {
      // Friday 2026-01-09 at 23:00 UTC (outside normal business hours)
      // Base FR = 60m, VIP = 30m target.
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-09T23:00:00Z'
      });

      // At Friday 23:20 (20m elapsed / 30m = 66.7% -> 'ok')
      const now1 = new Date('2026-01-09T23:20:00Z');
      const res1 = calculateSla(ticket, baseP1Policy, europeCalendar, now1);
      expect(res1.firstResponse).toBe('ok');
      // 24/7 wall-clock due date is exactly 23:30 Friday (not delayed to Monday!)
      expect(res1.dueAt.firstResponse.toISOString()).toBe('2026-01-09T23:30:00.000Z');

      // Saturday 2026-01-10 at 00:00 (60m elapsed > 30m target -> 'breached')
      const now2 = new Date('2026-01-10T00:00:00Z');
      const res2 = calculateSla(ticket, baseP1Policy, europeCalendar, now2);
      expect(res2.firstResponse).toBe('breached');
    });

    it('should NOT pause P1 VIP SLA during pending_customer (clock continues running)', () => {
      // Ticket created at 10:00 on Monday. P1 VIP target FR = 30m (due at 10:30).
      // At 10:10, moved to pending_customer.
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-05T10:00:00Z',
        status: 'pending_customer',
        statusHistory: [
          { status: 'open', at: '2026-01-05T10:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T10:10:00Z' }
        ]
      });

      // At 10:25 (25 mins elapsed out of 30m target = 83.3%)
      // Because P1 VIP does not pause on pending_customer, state must be 'at_risk', NOT 'paused'!
      const now = new Date('2026-01-05T10:25:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('at_risk');
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:30:00.000Z');
    });

    it('should pause P1 VIP SLA during on_hold', () => {
      // Ticket created at 10:00 on Monday. P1 VIP target FR = 30m.
      // At 10:10, moved to on_hold.
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-05T10:00:00Z',
        status: 'on_hold',
        statusHistory: [
          { status: 'open', at: '2026-01-05T10:00:00Z' },
          { status: 'on_hold', at: '2026-01-05T10:10:00Z' }
        ]
      });

      // At 10:25 (10 mins elapsed before pause, 20 mins remaining)
      // Because on_hold pauses P1 VIP, state must be 'paused'!
      const now = new Date('2026-01-05T10:25:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('paused');
      // Decision 3: projected from now (10:25) + 20 mins remaining = 10:45
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:45:00.000Z');
    });

    it('should pause P1 VIP SLA during on_hold, resume to open, exclude on_hold duration, and continue 24/7 wall-clock count', () => {
      // P1 VIP ticket created at 10:00 on Monday. Target FR = 30m.
      // 10:00-10:10: open (10m elapsed)
      // 10:10-10:40: on_hold (30m paused)
      // 10:40: resumed to open!
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-05T10:00:00Z',
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T10:00:00Z' },
          { status: 'on_hold', at: '2026-01-05T10:10:00Z' },
          { status: 'open', at: '2026-01-05T10:40:00Z' }
        ]
      });

      // At 10:50: 10m (from 10:00-10:10) + 10m (from 10:40-10:50) = 20m active elapsed out of 30m target (66.7%)
      const now1 = new Date('2026-01-05T10:50:00Z');
      const res1 = calculateSla(ticket, baseP1Policy, europeCalendar, now1);
      expect(res1.firstResponse).toBe('ok');
      // Due at 10:00 + 30m active + 30m on_hold = 11:00
      expect(res1.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:00:00.000Z');

      // At 11:00: 30m active elapsed = 100% -> 'at_risk'
      const now2 = new Date('2026-01-05T11:00:00Z');
      const res2 = calculateSla(ticket, baseP1Policy, europeCalendar, now2);
      expect(res2.firstResponse).toBe('at_risk');

      // At 11:05: 35m active elapsed > 30m -> 'breached'
      const now3 = new Date('2026-01-05T11:05:00Z');
      const res3 = calculateSla(ticket, baseP1Policy, europeCalendar, now3);
      expect(res3.firstResponse).toBe('breached');
    });

    it('should calculate P1 VIP pause and resume across a weekend seamlessly 24/7', () => {
      // P1 VIP created on Saturday 2026-01-10 at 22:00 UTC. Target FR = 30m.
      // 22:00 to 22:10: open (10m)
      // 22:10 to 23:10: on_hold (60m paused)
      // 23:10: resumed to open
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-10T22:00:00Z',
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-10T22:00:00Z' },
          { status: 'on_hold', at: '2026-01-10T22:10:00Z' },
          { status: 'open', at: '2026-01-10T23:10:00Z' }
        ]
      });

      // At Saturday 23:25 (10m + 15m = 25m elapsed / 30m = 83.3%)
      const now = new Date('2026-01-10T23:25:00Z');
      const res = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(res.firstResponse).toBe('at_risk');
      // Due at Saturday 22:00 + 30m active + 60m pause = 23:30 Saturday
      expect(res.dueAt.firstResponse.toISOString()).toBe('2026-01-10T23:30:00.000Z');
    });

    it('should calculate P1 VIP historical deadline correctly with multiple pause/resume cycles across weekends', () => {
      // P1 VIP created Friday 2026-01-09 at 22:00 UTC. Target FR = 30m (24/7).
      // 22:00 to 22:10: open (10m active, 20m remaining)
      // 22:10 to 22:40: on_hold (30m paused, 20m remaining)
      // 22:40 to 22:50: pending_customer (Does NOT pause P1 VIP! 10m active, 10m remaining)
      // 22:50 to 23:20: on_hold (30m paused, 10m remaining)
      // 23:20 onwards: open (remaining 10m active completed at 23:30)
      // Deadline: 22:00 + 30m active + 30m on_hold + 30m on_hold = 23:30 UTC
      const ticket = createBaseTicket({
        priority: 'P1',
        customerTier: 'vip',
        createdAt: '2026-01-09T22:00:00Z',
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-09T22:00:00Z' },
          { status: 'on_hold', at: '2026-01-09T22:10:00Z' },
          { status: 'pending_customer', at: '2026-01-09T22:40:00Z' },
          { status: 'on_hold', at: '2026-01-09T22:50:00Z' },
          { status: 'open', at: '2026-01-09T23:20:00Z' }
        ]
      });

      const now = new Date('2026-01-09T23:45:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('breached');
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-09T23:30:00.000Z');
    });
  });

  describe('Decision 3: Projected dueAt While Currently Paused (Option 3A)', () => {
    it('should project dueAt from injected now using remaining minutes when paused', () => {
      // Created at 09:00 on Monday. Target FR = 60m.
      // 09:00-09:20 open (20m used, 40m remaining).
      // At 09:20, moved to pending_customer.
      // Current now is 12:00.
      const ticket = createBaseTicket({
        status: 'pending_customer',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:20:00Z' }
        ]
      });

      const now = new Date('2026-01-05T12:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('paused');
      // Projected from now (12:00) + 40 business minutes = 12:40
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T12:40:00.000Z');
    });
  });

  describe('Thresholds & SLA States (< 70%, 70%-100%, > 100%)', () => {
    // Standard P1: FR = 60m (70% = 42m, 100% = 60m)
    it('should return ok when elapsed ratio < 70%', () => {
      const ticket = createBaseTicket();
      // 41 minutes elapsed (41/60 = 68.3%)
      const now = new Date('2026-01-05T09:41:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('ok');
    });

    it('should return at_risk at exactly 70% threshold', () => {
      const ticket = createBaseTicket();
      // Exactly 42 minutes elapsed (42/60 = 70.0%)
      const now = new Date('2026-01-05T09:42:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('at_risk');
    });

    it('should return at_risk at exactly 100% threshold', () => {
      const ticket = createBaseTicket();
      // Exactly 60 minutes elapsed (60/60 = 100.0%)
      const now = new Date('2026-01-05T10:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('at_risk');
    });

    it('should return breached when elapsed > 100%', () => {
      const ticket = createBaseTicket();
      // 61 minutes elapsed (61/60 = 101.7%)
      const now = new Date('2026-01-05T10:01:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);
      expect(result.firstResponse).toBe('breached');
    });
  });

  describe('Completed Tickets Handling (firstResponseAt and resolvedAt)', () => {
    it('should freeze firstResponse SLA at firstResponseAt while resolution SLA continues running', () => {
      // Created at 09:00.
      // firstResponseAt = 09:30 (30m used / 60m = 50% -> 'ok').
      // Now is 11:30 (2.5 hours later).
      const ticket = createBaseTicket({
        firstResponseAt: '2026-01-05T09:30:00Z'
      });
      const now = new Date('2026-01-05T11:30:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // First response must remain frozen as 'ok'
      expect(result.firstResponse).toBe('ok');
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');

      // Resolution SLA (target 240m = 4h): at 11:30, 150m elapsed / 240m = 62.5% -> 'ok'
      expect(result.resolution).toBe('ok');
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });

    it('should lock completed resolution at resolvedAt permanently even if now advances', () => {
      // Created at 09:00. Target resolution = 240m (due at 13:00).
      // Resolved at 12:00 (180m used / 240m = 75% -> 'at_risk').
      const ticket = createBaseTicket({
        status: 'resolved',
        resolvedAt: '2026-01-05T12:00:00Z'
      });
      // Now is 3 days later
      const now = new Date('2026-01-08T12:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // Must remain at_risk and NOT become breached!
      expect(result.resolution).toBe('at_risk');
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });

    it('should mark completed ticket as breached if completed after deadline', () => {
      // Target resolution = 240m (due at 13:00).
      // Resolved at 14:00 (300m used / 240m = 125%).
      const ticket = createBaseTicket({
        status: 'resolved',
        resolvedAt: '2026-01-05T14:00:00Z'
      });
      const now = new Date('2026-01-08T12:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.resolution).toBe('breached');
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });

    it('should keep dueAt at 10:00 when created at 09:00 with target 60m and first response at 09:20, even if paused afterwards', () => {
      // User Example: created at 09:00, target 60 minutes, first response at 09:20 -> dueAt must remain 10:00
      // Case 1: evaluated at 09:20 (immediately at completion)
      const ticket1 = createBaseTicket({
        createdAt: '2026-01-05T09:00:00Z',
        firstResponseAt: '2026-01-05T09:20:00Z',
        status: 'open',
        statusHistory: [{ status: 'open', at: '2026-01-05T09:00:00Z' }]
      });
      const res1 = calculateSla(ticket1, baseP1Policy, europeCalendar, new Date('2026-01-05T09:20:00Z'));
      expect(res1.firstResponse).toBe('ok');
      expect(res1.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');

      // Case 2: evaluated at 10:00
      const res2 = calculateSla(ticket1, baseP1Policy, europeCalendar, new Date('2026-01-05T10:00:00Z'));
      expect(res2.firstResponse).toBe('ok');
      expect(res2.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');

      // Case 3: ticket was moved to pending_customer at 09:20 after response, evaluated at 12:00
      // The post-response pause must NOT push firstResponse dueAt forward to 12:40!
      const ticket3 = createBaseTicket({
        createdAt: '2026-01-05T09:00:00Z',
        firstResponseAt: '2026-01-05T09:20:00Z',
        status: 'pending_customer',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:20:00Z' }
        ]
      });
      const res3 = calculateSla(ticket3, baseP1Policy, europeCalendar, new Date('2026-01-05T12:00:00Z'));
      expect(res3.firstResponse).toBe('ok');
      expect(res3.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    });

    it('should calculate historical resolution deadline correctly with multiple pause/resume intervals', () => {
      // Created at 09:00. Target resolution = 240m (4h active).
      // 09:00-10:00: open (60m active)
      // 10:00-11:00: pending_customer (60m paused)
      // 11:00-12:00: open (60m active)
      // 12:00-13:00: on_hold (60m paused)
      // 13:00 onwards: open (remaining 120m active runs 13:00-15:00)
      // Deadline: 09:00 + 240m active + 60m + 60m pauses = 15:00:00Z
      const history = [
        { status: 'open' as const, at: '2026-01-05T09:00:00Z' },
        { status: 'pending_customer' as const, at: '2026-01-05T10:00:00Z' },
        { status: 'open' as const, at: '2026-01-05T11:00:00Z' },
        { status: 'on_hold' as const, at: '2026-01-05T12:00:00Z' },
        { status: 'open' as const, at: '2026-01-05T13:00:00Z' }
      ];

      // Resolved on-time at 13:30 (active elapsed: 60m + 60m + 30m = 150m / 240m = 62.5% -> 'ok')
      const ticket = createBaseTicket({
        status: 'resolved',
        statusHistory: [
          ...history,
          { status: 'resolved', at: '2026-01-05T13:30:00Z' }
        ],
        resolvedAt: '2026-01-05T13:30:00Z'
      });
      const now = new Date('2026-01-05T17:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.resolution).toBe('ok');
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T15:00:00.000Z');
    });

    it('should freeze resolution SLA at resolvedAt when resolvedAt exists even if ticket.status is open (Point 3 documented behavior)', () => {
      // Created at 09:00. Target resolution = 240m (due at 13:00).
      // Resolved at 11:00 (120m used / 240m = 50% -> 'ok').
      // Later reopened to 'open' at 11:30.
      const ticket = createBaseTicket({
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'resolved', at: '2026-01-05T11:00:00Z' },
          { status: 'open', at: '2026-01-05T11:30:00Z' }
        ],
        resolvedAt: '2026-01-05T11:00:00Z'
      });
      const now = new Date('2026-01-05T15:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // Under the documented milestone completion behavior, resolution SLA milestone remains frozen at resolvedAt
      expect(result.resolution).toBe('ok');
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-05T13:00:00.000Z');
    });

    it('should ignore pauses occurring after completedAt (regression test: pause 09:40-09:50 does not shift dueAt from 10:00)', () => {
      // Created at 09:00.
      // First Response target: 60 minutes.
      // First response completed at 09:20.
      // Ticket enters pending_customer from 09:40 to 09:50.
      // Evaluated at 12:00.
      // Expected historical dueAt: 10:00, not 10:10.
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T09:00:00Z',
        firstResponseAt: '2026-01-05T09:20:00Z',
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:40:00Z' },
          { status: 'open', at: '2026-01-05T09:50:00Z' }
        ]
      });

      const now = new Date('2026-01-05T12:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('ok');
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    });

    it('should calculate historical dueAt correctly across multiple pause intervals without post-completion pauses shifting the deadline', () => {
      // Created Monday 09:00. Target FR = 60m.
      // 09:00-09:20: open (20m active)
      // 09:20-09:50: pending_customer (paused for 30m)
      // 09:50-10:10: open (20m active)
      // 10:10-10:40: on_hold (paused for 30m)
      // 10:40-11:10: open (30m active)
      const history = [
        { status: 'open' as const, at: '2026-01-05T09:00:00Z' },
        { status: 'pending_customer' as const, at: '2026-01-05T09:20:00Z' },
        { status: 'open' as const, at: '2026-01-05T09:50:00Z' },
        { status: 'on_hold' as const, at: '2026-01-05T10:10:00Z' },
        { status: 'open' as const, at: '2026-01-05T10:40:00Z' }
      ];

      // Completion Case A: Agent responded early at 10:05 (during second open interval)
      // Pre-completion active: 20m + 15m = 35m. Remaining budget = 25m.
      // Pause at 10:10-10:40 is AFTER 10:05 and is ignored -> dueAt is 10:05 + 25m = 10:30:00Z
      const ticketA = createBaseTicket({
        status: 'open',
        statusHistory: history,
        firstResponseAt: '2026-01-05T10:05:00Z'
      });

      // Completion Case B: Agent responded at 10:45 (after both pauses 09:20-09:50 and 10:10-10:40)
      // Pre-completion active: 20m + 20m + 5m = 45m. Remaining budget = 15m.
      // dueAt is 10:45 + 15m = 11:00:00Z
      const ticketB = createBaseTicket({
        status: 'open',
        statusHistory: history,
        firstResponseAt: '2026-01-05T10:45:00Z'
      });

      // Completion Case C: Agent responded near deadline at 10:55
      // Pre-completion active: 20m + 20m + 15m = 55m. Remaining budget = 5m.
      // dueAt is 10:55 + 5m = 11:00:00Z
      const ticketC = createBaseTicket({
        status: 'open',
        statusHistory: history,
        firstResponseAt: '2026-01-05T10:55:00Z'
      });

      const now = new Date('2026-01-05T12:00:00Z');
      const resA = calculateSla(ticketA, baseP1Policy, europeCalendar, now);
      const resB = calculateSla(ticketB, baseP1Policy, europeCalendar, now);
      const resC = calculateSla(ticketC, baseP1Policy, europeCalendar, now);

      expect(resA.firstResponse).toBe('ok');
      expect(resB.firstResponse).toBe('at_risk');
      expect(resC.firstResponse).toBe('at_risk');

      expect(resA.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:30:00.000Z');
      expect(resB.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:00:00.000Z');
      expect(resC.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:00:00.000Z');
    });
  });

  describe('Clarification 1 & 2: statusHistory Fallback and Deterministic Resolution', () => {
    it('should fallback to ticket.status when statusHistory is empty', () => {
      // Ticket created at 09:00 in 'pending_customer' with empty statusHistory
      const ticket = createBaseTicket({
        status: 'pending_customer',
        statusHistory: []
      });
      const now = new Date('2026-01-05T10:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // Entire interval was pending_customer, so 0 business mins elapsed, state is 'paused'
      expect(result.firstResponse).toBe('paused');
      // 60 mins remaining projected from now (10:00) = 11:00
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:00:00.000Z');
    });

    it('should resolve entries at the exact same timestamp by choosing the latest entry', () => {
      // At 10:00, two entries exist: first pending_customer, then open
      const ticket = createBaseTicket({
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T10:00:00Z' },
          { status: 'open', at: '2026-01-05T10:00:00Z' }
        ]
      });

      // At 10:30: from 09:00-10:00 (60m open), and 10:00-10:30 (30m open) -> 90m total open
      const now = new Date('2026-01-05T10:30:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // FR target is 60m. 90m elapsed -> breached
      expect(result.firstResponse).toBe('breached');
    });

    it('should correctly handle repeated consecutive same-status transitions', () => {
      const ticket = createBaseTicket({
        status: 'pending_customer',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:30:00Z' },
          { status: 'pending_customer', at: '2026-01-05T10:00:00Z' }
        ]
      });

      // Now at 11:00. Open from 09:00-09:30 (30m). Pending from 09:30-11:00 (paused).
      const now = new Date('2026-01-05T11:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('paused');
      // 30m remaining projected from 11:00 = 11:30
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:30:00.000Z');
    });

    it('should throw an error when ticket.status conflicts with latest statusHistory entry', () => {
      // ticket.status is 'open', but latest statusHistory entry is 'pending_customer'
      const conflictingTicket = createBaseTicket({
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:30:00Z' }
        ]
      });

      const now = new Date('2026-01-05T10:00:00Z');
      expect(() => {
        calculateSla(conflictingTicket, baseP1Policy, europeCalendar, now);
      }).toThrowError(
        /Inconsistent ticket data: ticket\.status 'open' conflicts with the latest status in statusHistory 'pending_customer'/
      );
    });
  });

  describe('Pausing and Resumption Across Multiple Intervals', () => {
    it('should exclude paused time across multiple alternating pauses', () => {
      // 09:00-09:20: open (20m)
      // 09:20-09:50: pending_customer (paused)
      // 09:50-10:10: open (20m)
      // 10:10-10:40: on_hold (paused)
      // 10:40-10:50: open (10m)
      // Total elapsed active = 20 + 20 + 10 = 50m.
      const ticket = createBaseTicket({
        status: 'open',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T09:20:00Z' },
          { status: 'open', at: '2026-01-05T09:50:00Z' },
          { status: 'on_hold', at: '2026-01-05T10:10:00Z' },
          { status: 'open', at: '2026-01-05T10:40:00Z' }
        ]
      });

      const now = new Date('2026-01-05T10:50:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // FR target is 60m. 50m elapsed / 60m = 83.3% -> 'at_risk'
      expect(result.firstResponse).toBe('at_risk');
      // Remaining is 10m -> due at 10:50 + 10m = 11:00
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T11:00:00.000Z');
    });

    it('should maintain breached state even if ticket is later paused', () => {
      // 09:00 to 10:10 in open status (70m elapsed > 60m target -> breached at 10:00)
      // At 10:10, moved to pending_customer
      const ticket = createBaseTicket({
        status: 'pending_customer',
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: '2026-01-05T10:10:00Z' }
        ]
      });

      const now = new Date('2026-01-05T11:00:00Z');
      const result = calculateSla(ticket, baseP1Policy, europeCalendar, now);

      // Must remain breached, NOT paused!
      expect(result.firstResponse).toBe('breached');
      // Historical dueAt when 60m was reached was 10:00
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    });
  });

  describe('Clarification 6: Zero Target Minutes', () => {
    const zeroPolicy: SlaPolicy = {
      priority: 'P1',
      firstResponseMins: 0,
      resolutionMins: 0,
      vipMultiplier: 1.0
    };

    it('should return ok when elapsed is 0 and target is 0', () => {
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T09:00:00Z'
      });
      const now = new Date('2026-01-05T09:00:00Z');
      const result = calculateSla(ticket, zeroPolicy, europeCalendar, now);

      expect(result.firstResponse).toBe('ok');
      expect(result.resolution).toBe('ok');
    });

    it('should return breached immediately when elapsed > 0 and target is 0', () => {
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T09:00:00Z'
      });
      const now = new Date('2026-01-05T09:01:00Z');
      const result = calculateSla(ticket, zeroPolicy, europeCalendar, now);

      expect(result.firstResponse).toBe('breached');
      expect(result.resolution).toBe('breached');
    });
  });

  describe('Timezones, Offsets, and Regional Business Calendar Integration', () => {
    it('should exclude weekend days in Egypt calendar (Friday and Saturday)', () => {
      // Egypt workweek is Sunday-Thursday. Friday (Jan 9) and Saturday (Jan 10) are weekends.
      // Created on Thursday 2026-01-08 at 16:00 Cairo (14:00 UTC).
      // Standard shifts 09:00-17:00 Cairo.
      // 1 hour left on Thursday (16:00-17:00 Cairo).
      // Policy resolution = 120m (2 hours).
      const ticket: Ticket = {
        id: 'ticket-eg',
        version: 1,
        priority: 'P2',
        status: 'open',
        customerTier: 'standard',
        region: 'EG',
        skills: [],
        createdAt: '2026-01-08T14:00:00Z', // 16:00 Cairo
        statusHistory: []
      };

      // Now is Friday 10:00 Cairo (weekend in Egypt).
      // Only 60 mins elapsed on Thursday; Friday is not working time.
      const nowFriday = new Date('2026-01-09T08:00:00Z'); // Friday 10:00 Cairo
      const result = calculateSla(ticket, baseP2Policy, egyptCalendar, nowFriday);

      // Resolution target is 480m. 60m elapsed = 12.5% -> ok
      expect(result.resolution).toBe('ok');
      // Due date should jump past Friday and Saturday to Sunday Jan 11 at 16:00 Cairo (7 hours remaining into Sunday = 16:00 Cairo = 14:00 UTC)
      // 480m - 60m = 420m (7 hours). Sunday starts 09:00 Cairo + 7h = 16:00 Cairo = 14:00 UTC
      expect(result.dueAt.resolution.toISOString()).toBe('2026-01-11T14:00:00.000Z');
    });

    it('should parse ISO strings with timezone offsets correctly and produce identical results', () => {
      // 2026-01-05T11:00:00+02:00 is exactly 2026-01-05T09:00:00Z
      const ticketWithOffset = createBaseTicket({
        createdAt: '2026-01-05T11:00:00+02:00'
      });
      const now = new Date('2026-01-05T09:30:00Z');
      const result = calculateSla(ticketWithOffset, baseP1Policy, europeCalendar, now);

      expect(result.firstResponse).toBe('ok');
      expect(result.dueAt.firstResponse.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    });

    it('should be strictly deterministic with injected now and not depend on system time', () => {
      const ticket = createBaseTicket();
      const now1 = new Date('2026-01-05T09:20:00Z');
      const now2 = new Date('2026-01-05T09:50:00Z');

      const res1 = calculateSla(ticket, baseP1Policy, europeCalendar, now1);
      const res2 = calculateSla(ticket, baseP1Policy, europeCalendar, now2);

      expect(res1.firstResponse).toBe('ok');
      expect(res2.firstResponse).toBe('at_risk');
    });
  });

  describe('Point 4: Validation of Timestamps and Temporal Consistency', () => {
    it('should throw when createdAt is an invalid date string', () => {
      const ticket = createBaseTicket({
        createdAt: 'invalid-date'
      });
      const now = new Date('2026-01-05T10:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/Invalid ticket createdAt timestamp: 'invalid-date'/);
    });

    it('should throw when now is earlier than createdAt', () => {
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T10:00:00Z'
      });
      const nowEarlier = new Date('2026-01-05T09:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, nowEarlier);
      }).toThrowError(/Evaluation timestamp 'now' .* cannot be earlier than ticket createdAt/);
    });

    it('should throw when now is an invalid Date object', () => {
      const ticket = createBaseTicket();
      const invalidNow = new Date('invalid');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, invalidNow);
      }).toThrowError(/Invalid evaluation timestamp 'now'/);
    });

    it('should throw when firstResponseAt is an invalid date string', () => {
      const ticket = createBaseTicket({
        firstResponseAt: 'not-a-date'
      });
      const now = new Date('2026-01-05T10:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/Invalid ticket firstResponseAt timestamp: 'not-a-date'/);
    });

    it('should throw when firstResponseAt is earlier than createdAt', () => {
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T10:00:00Z',
        firstResponseAt: '2026-01-05T09:30:00Z'
      });
      const now = new Date('2026-01-05T11:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/firstResponseAt .* cannot be earlier than createdAt/);
    });

    it('should throw when resolvedAt is an invalid date string', () => {
      const ticket = createBaseTicket({
        status: 'resolved',
        resolvedAt: 'garbage-date'
      });
      const now = new Date('2026-01-05T10:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/Invalid ticket resolvedAt timestamp: 'garbage-date'/);
    });

    it('should throw when resolvedAt is earlier than createdAt', () => {
      const ticket = createBaseTicket({
        createdAt: '2026-01-05T10:00:00Z',
        status: 'resolved',
        resolvedAt: '2026-01-05T08:00:00Z'
      });
      const now = new Date('2026-01-05T11:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/resolvedAt .* cannot be earlier than createdAt/);
    });

    it('should throw when a statusHistory entry has an invalid timestamp', () => {
      const ticket = createBaseTicket({
        statusHistory: [
          { status: 'open', at: '2026-01-05T09:00:00Z' },
          { status: 'pending_customer', at: 'invalid-time' }
        ]
      });
      const now = new Date('2026-01-05T10:00:00Z');
      expect(() => {
        calculateSla(ticket, baseP1Policy, europeCalendar, now);
      }).toThrowError(/Invalid timestamp in statusHistory: 'invalid-time'/);
    });
  });

  describe('Saudi Arabia Calendar SLA Calculation', () => {
    const saudiCalendar = createSaudiCalendar(standardShifts);

    it('should bridge Friday and Saturday weekend in Asia/Riyadh (UTC+3) and resume on Sunday', () => {
      // Thursday 2026-01-08 at 15:00 Riyadh (12:00 UTC).
      // Standard shift is 09:00-17:00 (06:00-14:00 UTC).
      // Thursday has 2 business hours remaining (15:00-17:00 Riyadh).
      // Resolution target for standard P1 is 4 hours (240 minutes).
      const ticket = createBaseTicket({
        region: 'SA',
        priority: 'P1',
        customerTier: 'standard',
        createdAt: '2026-01-08T12:00:00Z'
      });

      // Friday 2026-01-09 at 12:00 UTC is weekend in Saudi Arabia
      const fridayNow = new Date('2026-01-09T12:00:00Z');
      const fridayResult = calculateSla(ticket, baseP1Policy, saudiCalendar, fridayNow);

      // Remaining 2 business hours are scheduled on Sunday 2026-01-11 from 09:00 to 11:00 Riyadh (06:00 to 08:00 UTC).
      expect(fridayResult.dueAt.resolution.toISOString()).toBe('2026-01-11T08:00:00.000Z');

      // During weekend, elapsed business time has not advanced past 2 hours (120m / 240m = 50%), so status is 'ok'
      expect(fridayResult.resolution).toBe('ok');
    });
  });
});
