import { Ticket, TicketStatus } from '../models/ticket.model';
import { SlaPolicy, SlaState } from '../models/sla.model';
import { BusinessCalendar } from '../models/calendar.model';

export interface SlaCalculationResult {
  readonly firstResponse: SlaState;
  readonly resolution: SlaState;
  readonly dueAt: {
    readonly firstResponse: Date;
    readonly resolution: Date;
  };
}

interface SlaTimeCalculator {
  getWorkingMinutesBetween(start: Date, end: Date): number;
  addBusinessMinutes(start: Date, minutes: number): Date;
}

interface TimelineSegment {
  readonly start: Date;
  readonly end: Date;
  readonly status: TicketStatus;
}

/**
 * EXPLICIT PROJECT ASSUMPTION (Decision 1):
 * The TDD specification does not formally define whether `vipMultiplier` multiplies
 * or divides SLA target durations. Per Decision 1, Option 1A is adopted:
 *   effectiveTargetMinutes = Math.round(baseMinutes * policy.vipMultiplier)
 * Values < 1.0 (e.g. 0.5) represent tighter/faster SLA windows for VIP customers.
 * This is an explicit project assumption subject to validation against mock policy values.
 */

/**
 * Calculates the SLA state and due dates for a given ticket.
 *
 * Current status vs statusHistory (Point 1):
 * - When statusHistory is empty, fallback to ticket.status for the interval from createdAt to now.
 * - When statusHistory contains entries, the latest status in statusHistory must match ticket.status.
 *   If there is a conflict, an error is thrown to reject inconsistent ticket data.
 *
 * Day-2 Rule (Decision 2 - Option 2B):
 * P1 VIP tickets have a 24/7 SLA that:
 * - Runs across all wall-clock minutes (bypassing business calendar working hours, weekends, and holidays).
 * - Does NOT pause during 'pending_customer'.
 * - DOES pause during 'on_hold'.
 *
 * Completed SLA dueAt:
 * When isCompleted === true, timeline segments are built only from createdAt to completedAt.
 * Remaining SLA budget is projected forward from completedAt, completely ignoring any
 * status changes or pauses that occur after completedAt.
 *
 * ResolvedAt Authoritative Milestone (Option 3.1):
 * When ticket.resolvedAt is set, it serves as the authoritative milestone completion marker
 * freezing the Resolution SLA at that historical timestamp, even if the ticket is subsequently
 * reopened or transitioned to another status.
 *
 * Projected dueAt while paused (Decision 3 - Option 3A):
 * When an uncompleted SLA is currently paused at `now`, dueAt is projected from `now`
 * assuming the ticket resumes immediately.
 *
 * Validation (Point 4):
 * Strict validation ensures invalid dates (createdAt, now, firstResponseAt, resolvedAt, statusHistory)
 * and illogical temporal sequences (now < createdAt, completion < createdAt) throw descriptive errors.
 */
export function calculateSla(
  ticket: Ticket,
  policy: SlaPolicy,
  calendar: BusinessCalendar,
  now: Date
): {
  firstResponse: SlaState;
  resolution: SlaState;
  dueAt: {
    firstResponse: Date;
    resolution: Date;
  };
} {
  // Validation (Point 4)
  if (!now || !(now instanceof Date) || isNaN(now.getTime())) {
    throw new Error(`Invalid evaluation timestamp 'now': '${now}'`);
  }

  const createdDate = new Date(ticket.createdAt);
  if (isNaN(createdDate.getTime())) {
    throw new Error(`Invalid ticket createdAt timestamp: '${ticket.createdAt}'`);
  }

  if (now.getTime() < createdDate.getTime()) {
    throw new Error(
      `Evaluation timestamp 'now' (${now.toISOString()}) cannot be earlier than ticket createdAt (${createdDate.toISOString()})`
    );
  }

  if (ticket.firstResponseAt !== undefined) {
    const frDate = new Date(ticket.firstResponseAt);
    if (isNaN(frDate.getTime())) {
      throw new Error(
        `Invalid ticket firstResponseAt timestamp: '${ticket.firstResponseAt}'`
      );
    }
    if (frDate.getTime() < createdDate.getTime()) {
      throw new Error(
        `firstResponseAt (${frDate.toISOString()}) cannot be earlier than createdAt (${createdDate.toISOString()})`
      );
    }
  }

  if (ticket.resolvedAt !== undefined) {
    const resDate = new Date(ticket.resolvedAt);
    if (isNaN(resDate.getTime())) {
      throw new Error(`Invalid ticket resolvedAt timestamp: '${ticket.resolvedAt}'`);
    }
    if (resDate.getTime() < createdDate.getTime()) {
      throw new Error(
        `resolvedAt (${resDate.toISOString()}) cannot be earlier than createdAt (${createdDate.toISOString()})`
      );
    }
  }

  if (ticket.statusHistory && ticket.statusHistory.length > 0) {
    for (const entry of ticket.statusHistory) {
      const d = new Date(entry.at);
      if (isNaN(d.getTime())) {
        throw new Error(`Invalid timestamp in statusHistory: '${entry.at}'`);
      }
    }

    // Validation (Point 1): Current status vs statusHistory conflict check
    const sortedHistory = [...ticket.statusHistory]
      .map((entry, index) => ({
        status: entry.status,
        date: new Date(entry.at),
        originalIndex: index
      }))
      .sort((a, b) => {
        const diff = a.date.getTime() - b.date.getTime();
        return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
      });

    const latestEntry = sortedHistory[sortedHistory.length - 1];
    if (latestEntry.status !== ticket.status) {
      throw new Error(
        `Inconsistent ticket data: ticket.status '${ticket.status}' conflicts with the latest status in statusHistory '${latestEntry.status}' (at ${latestEntry.date.toISOString()}).`
      );
    }
  }

  const isP1Vip = ticket.priority === 'P1' && ticket.customerTier === 'vip';

  // Decision 2: 24/7 time calculator for P1 VIP vs BusinessCalendar for all other tickets
  const timeCalc: SlaTimeCalculator = isP1Vip
    ? {
        getWorkingMinutesBetween(start: Date, end: Date): number {
          if (start.getTime() >= end.getTime()) {
            return 0;
          }
          return Math.round((end.getTime() - start.getTime()) / 60000);
        },
        addBusinessMinutes(start: Date, minutes: number): Date {
          if (minutes <= 0) {
            return new Date(start.getTime());
          }
          return new Date(start.getTime() + Math.round(minutes * 60000));
        }
      }
    : calendar;

  // Decision 1: Resolve target minutes using Option 1A
  const isVip = ticket.customerTier === 'vip';
  const targetFRMins = isVip
    ? Math.round(policy.firstResponseMins * policy.vipMultiplier)
    : policy.firstResponseMins;
  const targetResMins = isVip
    ? Math.round(policy.resolutionMins * policy.vipMultiplier)
    : policy.resolutionMins;

  // Evaluate First Response SLA
  const frCompletedAt = ticket.firstResponseAt ? new Date(ticket.firstResponseAt) : undefined;
  const isFRCompleted = frCompletedAt !== undefined;
  const frCutoff = isFRCompleted ? frCompletedAt : now;

  const frResult = evaluateSingleMetricSla({
    ticket,
    createdDate,
    cutoff: frCutoff,
    targetMins: targetFRMins,
    timeCalc,
    isP1Vip,
    isCompleted: isFRCompleted,
    now
  });

  // Evaluate Resolution SLA
  // Point 3 (Explicit Documented Behavior):
  // When ticket.resolvedAt is set while ticket.status !== 'resolved', the current domain logic
  // treats ticket.resolvedAt as the authoritative milestone completion timestamp, freezing
  // the resolution SLA at that historical instant. This accommodates tickets that were resolved
  // and subsequently reopened or transitioned to a secondary state, preserving the initial
  // resolution SLA evaluation.
  const resCompletedAt = ticket.resolvedAt
    ? new Date(ticket.resolvedAt)
    : ticket.status === 'resolved'
      ? resolveLastResolvedTransition(ticket, now)
      : undefined;
  const isResCompleted = resCompletedAt !== undefined;
  const resCutoff = isResCompleted ? resCompletedAt : now;

  const resResult = evaluateSingleMetricSla({
    ticket,
    createdDate,
    cutoff: resCutoff,
    targetMins: targetResMins,
    timeCalc,
    isP1Vip,
    isCompleted: isResCompleted,
    now
  });

  return {
    firstResponse: frResult.state,
    resolution: resResult.state,
    dueAt: {
      firstResponse: frResult.dueAt,
      resolution: resResult.dueAt
    }
  };
}

interface MetricEvaluationContext {
  ticket: Ticket;
  createdDate: Date;
  cutoff: Date;
  targetMins: number;
  timeCalc: SlaTimeCalculator;
  isP1Vip: boolean;
  isCompleted: boolean;
  now: Date;
}

function evaluateSingleMetricSla(ctx: MetricEvaluationContext): {
  state: SlaState;
  dueAt: Date;
} {
  const { ticket, createdDate, cutoff, targetMins, timeCalc, isP1Vip, isCompleted, now } = ctx;

  const segments = buildTimelineSegments(ticket, createdDate, cutoff);

  // Sum active elapsed business minutes
  let elapsedMins = 0;
  for (const seg of segments) {
    if (!isStatusPaused(seg.status, isP1Vip)) {
      elapsedMins += timeCalc.getWorkingMinutesBetween(seg.start, seg.end);
    }
  }

  // Determine current active/paused status at evaluation cutoff
  const currentStatusAtCutoff = getCurrentStatusAtCutoff(segments, ticket.status);
  const isCurrentlyPaused = isStatusPaused(currentStatusAtCutoff, isP1Vip);

  // Determine SLA State
  let state: SlaState;
  if (targetMins === 0) {
    if (elapsedMins > 0) {
      state = 'breached';
    } else {
      state = isCompleted ? 'ok' : isCurrentlyPaused ? 'paused' : 'ok';
    }
  } else {
    const ratio = elapsedMins / targetMins;
    if (ratio > 1.0) {
      // Once breached, it stays breached even if paused later
      state = 'breached';
    } else if (isCompleted) {
      // Completed within target cannot be paused
      state = ratio >= 0.7 ? 'at_risk' : 'ok';
    } else if (isCurrentlyPaused) {
      state = 'paused';
    } else if (ratio >= 0.7) {
      state = 'at_risk';
    } else {
      state = 'ok';
    }
  }

  // Calculate dueAt along the full timeline
  const dueAt = calculateMetricDueAt({
    ticket,
    createdDate,
    targetMins,
    timeCalc,
    isP1Vip,
    isCompleted,
    completedAt: isCompleted ? cutoff : undefined,
    now
  });

  return { state, dueAt };
}

interface DueAtCalculationContext {
  ticket: Ticket;
  createdDate: Date;
  targetMins: number;
  timeCalc: SlaTimeCalculator;
  isP1Vip: boolean;
  isCompleted: boolean;
  completedAt?: Date;
  now: Date;
}

function calculateMetricDueAt(ctx: DueAtCalculationContext): Date {
  const { ticket, createdDate, targetMins, timeCalc, isP1Vip, isCompleted, completedAt, now } = ctx;

  if (targetMins <= 0) {
    return new Date(createdDate.getTime());
  }

  // When isCompleted === true:
  // 1. Build timeline segments only from createdAt to completedAt.
  // 2. Calculate active business minutes within those segments (or detect breach).
  // 3. Calculate remaining SLA budget.
  // 4. Project remaining budget forward from completedAt using the business calendar.
  // 5. Ignore all status changes and pauses after completedAt.
  if (isCompleted && completedAt) {
    const segments = buildTimelineSegments(ticket, createdDate, completedAt);
    let remaining = targetMins;

    for (const seg of segments) {
      if (!isStatusPaused(seg.status, isP1Vip)) {
        const segWorkingMins = timeCalc.getWorkingMinutesBetween(seg.start, seg.end);
        if (remaining <= segWorkingMins) {
          // Breached before or at completedAt: historical instant of breach
          return timeCalc.addBusinessMinutes(seg.start, remaining);
        }
        remaining -= segWorkingMins;
      }
    }

    return timeCalc.addBusinessMinutes(completedAt, remaining);
  }

  // When isCompleted === false:
  // Traverse timeline up to now, then project remaining budget from now (Option 3A).
  const fullSegments = buildTimelineSegments(ticket, createdDate, now);
  let remaining = targetMins;

  for (const seg of fullSegments) {
    if (!isStatusPaused(seg.status, isP1Vip)) {
      const segWorkingMins = timeCalc.getWorkingMinutesBetween(seg.start, seg.end);
      if (remaining <= segWorkingMins) {
        return timeCalc.addBusinessMinutes(seg.start, remaining);
      }
      remaining -= segWorkingMins;
    }
  }

  return timeCalc.addBusinessMinutes(now, remaining);
}

/**
 * Checks whether a ticket status is considered paused.
 * Under Decision 2 (Option 2B), P1 VIP tickets do NOT pause during 'pending_customer',
 * but DO pause during 'on_hold'.
 */
function isStatusPaused(status: TicketStatus, isP1Vip: boolean): boolean {
  if (isP1Vip) {
    return status === 'on_hold';
  }
  return status === 'pending_customer' || status === 'on_hold';
}

/**
 * Builds chronological, non-overlapping segments from `createdDate` up to `cutoff`.
 */
function buildTimelineSegments(
  ticket: Ticket,
  createdDate: Date,
  cutoff: Date
): readonly TimelineSegment[] {
  if (createdDate.getTime() >= cutoff.getTime()) {
    return [];
  }

  // Clarification 1: When statusHistory is empty, use ticket.status as fallback
  if (!ticket.statusHistory || ticket.statusHistory.length === 0) {
    return [{ start: createdDate, end: cutoff, status: ticket.status }];
  }

  // Clarification 2: Parse, sort, and resolve statusHistory deterministically
  const parsed = ticket.statusHistory
    .map((entry, index) => ({
      status: entry.status,
      date: new Date(entry.at),
      originalIndex: index
    }))
    .filter(item => !isNaN(item.date.getTime()))
    .sort((a, b) => {
      const diff = a.date.getTime() - b.date.getTime();
      return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
    });

  if (parsed.length === 0) {
    return [{ start: createdDate, end: cutoff, status: ticket.status }];
  }

  // Deduplicate entries at the exact same timestamp (last entry in event order wins)
  const uniqueAtTime: { status: TicketStatus; date: Date }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const curr = parsed[i];
    const next = parsed[i + 1];
    if (next && next.date.getTime() === curr.date.getTime()) {
      continue; // Skip earlier entry at the same timestamp
    }
    uniqueAtTime.push({ status: curr.status, date: curr.date });
  }

  // Build segments
  const segments: TimelineSegment[] = [];
  let currentStart = createdDate;

  // Determine initial status at createdAt
  const firstTransition = uniqueAtTime[0];
  let currentStatus: TicketStatus;

  let transitionIndex = 0;
  if (firstTransition && firstTransition.date.getTime() <= createdDate.getTime()) {
    currentStatus = firstTransition.status;
    // Skip all transitions occurring at or before createdDate except the latest effective one
    while (
      transitionIndex < uniqueAtTime.length &&
      uniqueAtTime[transitionIndex].date.getTime() <= createdDate.getTime()
    ) {
      currentStatus = uniqueAtTime[transitionIndex].status;
      transitionIndex++;
    }
  } else {
    // If first transition is strictly after createdAt, the ticket started in 'open'
    currentStatus = 'open';
  }

  // Step through transitions occurring between createdDate and cutoff
  while (transitionIndex < uniqueAtTime.length) {
    const transition = uniqueAtTime[transitionIndex++];
    if (transition.date.getTime() >= cutoff.getTime()) {
      break;
    }

    if (transition.date.getTime() > currentStart.getTime()) {
      segments.push({
        start: currentStart,
        end: transition.date,
        status: currentStatus
      });
      currentStart = transition.date;
      currentStatus = transition.status;
    }
  }

  // Final segment up to cutoff
  if (currentStart.getTime() < cutoff.getTime()) {
    segments.push({
      start: currentStart,
      end: cutoff,
      status: currentStatus
    });
  }

  // Squash consecutive segments sharing the same status
  return squashConsecutiveSegments(segments);
}

function squashConsecutiveSegments(segments: readonly TimelineSegment[]): readonly TimelineSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const squashed: TimelineSegment[] = [];
  let current = segments[0];

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    if (next.status === current.status && next.start.getTime() === current.end.getTime()) {
      current = {
        start: current.start,
        end: next.end,
        status: current.status
      };
    } else {
      squashed.push(current);
      current = next;
    }
  }
  squashed.push(current);
  return squashed;
}

function getCurrentStatusAtCutoff(
  segments: readonly TimelineSegment[],
  fallbackStatus: TicketStatus
): TicketStatus {
  if (segments.length === 0) {
    return fallbackStatus;
  }
  return segments[segments.length - 1].status;
}

function resolveLastResolvedTransition(ticket: Ticket, fallback: Date): Date {
  if (!ticket.statusHistory || ticket.statusHistory.length === 0) {
    return fallback;
  }
  for (let i = ticket.statusHistory.length - 1; i >= 0; i--) {
    if (ticket.statusHistory[i].status === 'resolved') {
      const d = new Date(ticket.statusHistory[i].at);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }
  }
  return fallback;
}
