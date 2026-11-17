import { Injectable } from '@angular/core';
import {
  CustomerTier,
  Priority,
  Region,
  ShiftWindow,
  SlaPolicy,
  SlaState,
  Ticket,
  TicketStatus
} from '../models';
import { calculateSla, SlaCalculationResult } from '../sla';
import {
  createEgyptCalendar,
  createEuropeCalendar,
  createSaudiCalendar,
  createUaeCalendar
} from '../calendar/regional-calendars';
import { BusinessCalendar } from '../models/calendar.model';

export interface SlaSimulationInput {
  priority: Priority;
  customerTier: CustomerTier;
  region: Region;
  createdAt: string;
  evaluationTime: string;
  statusHistory?: readonly { status: TicketStatus; at: string }[];
  policyOverrides?: Partial<SlaPolicy>;
  customShifts?: readonly ShiftWindow[];
  customWorkingDays?: readonly number[];
}

export interface MetricSimulationOutput {
  status: SlaState;
  targetMinutes: number;
  elapsedMinutes: number;
  dueAt: string;
  remainingMinutes: number;
  percentageElapsed: number;
}

export interface SlaSimulationResult {
  firstResponse: MetricSimulationOutput;
  resolution: MetricSimulationOutput;
  isPaused: boolean;
  is24x7: boolean;
  calendarTimezone: string;
}

const DEFAULT_SIMULATOR_POLICIES: Record<Priority, SlaPolicy> = {
  P1: { priority: 'P1', firstResponseMins: 15, resolutionMins: 120, vipMultiplier: 0.5 },
  P2: { priority: 'P2', firstResponseMins: 30, resolutionMins: 240, vipMultiplier: 0.75 },
  P3: { priority: 'P3', firstResponseMins: 60, resolutionMins: 480, vipMultiplier: 1.0 },
  P4: { priority: 'P4', firstResponseMins: 120, resolutionMins: 960, vipMultiplier: 1.0 }
};

const DEFAULT_SHIFTS: readonly ShiftWindow[] = [{ start: '08:00', end: '16:00' }];

export function resolveSimulationCalendar(
  region: Region,
  customShifts?: readonly ShiftWindow[],
  customWorkingDays?: readonly number[]
): BusinessCalendar {
  const shifts = customShifts && customShifts.length > 0 ? customShifts : DEFAULT_SHIFTS;
  switch (region) {
    case 'EG':
      return createEgyptCalendar(shifts);
    case 'SA':
      return createSaudiCalendar(shifts);
    case 'EU':
      return createEuropeCalendar(shifts);
    case 'AE':
      return createUaeCalendar(
        customWorkingDays && customWorkingDays.length > 0 ? customWorkingDays : [0, 1, 2, 3, 4],
        shifts
      );
  }
}

/**
 * Pure simulation function that runs hypothetical ticket scenarios through the
 * domain SLA engine without affecting application or pipeline state.
 */
export function simulateSla(input: SlaSimulationInput): SlaSimulationResult {
  const basePolicy = DEFAULT_SIMULATOR_POLICIES[input.priority];
  const policy: SlaPolicy = {
    ...basePolicy,
    ...input.policyOverrides
  };

  const calendar = resolveSimulationCalendar(
    input.region,
    input.customShifts,
    input.customWorkingDays
  );

  const evaluationDate = new Date(input.evaluationTime);
  const statusHistory = input.statusHistory && input.statusHistory.length > 0
    ? [...input.statusHistory]
    : [{ status: 'open' as TicketStatus, at: input.createdAt }];

  const currentStatus = statusHistory[statusHistory.length - 1].status;

  const ticket: Ticket = {
    id: 'sim-ticket',
    version: 1,
    priority: input.priority,
    status: currentStatus,
    customerTier: input.customerTier,
    region: input.region,
    skills: [],
    createdAt: input.createdAt,
    statusHistory,
    ...(currentStatus === 'resolved' ? { resolvedAt: statusHistory[statusHistory.length - 1].at } : {})
  };

  const rawResult = calculateSla(ticket, policy, calendar, evaluationDate);

  // VIP multiplier target calculation
  const isVip = input.customerTier === 'vip';
  const effectiveMultiplier = isVip ? policy.vipMultiplier : 1.0;
  const targetFrMins = Math.round(policy.firstResponseMins * effectiveMultiplier);
  const targetResMins = Math.round(policy.resolutionMins * effectiveMultiplier);

  const remainingFrMs = rawResult.dueAt.firstResponse.getTime() - evaluationDate.getTime();
  const remainingFrMins = Math.round(remainingFrMs / (60 * 1000));
  const elapsedFrMins = Math.max(0, targetFrMins - remainingFrMins);
  const pctFr = targetFrMins > 0 ? Math.min(100, Math.max(0, Math.round((elapsedFrMins / targetFrMins) * 100))) : 0;

  const remainingResMs = rawResult.dueAt.resolution.getTime() - evaluationDate.getTime();
  const remainingResMins = Math.round(remainingResMs / (60 * 1000));
  const elapsedResMins = Math.max(0, targetResMins - remainingResMins);
  const pctRes = targetResMins > 0 ? Math.min(100, Math.max(0, Math.round((elapsedResMins / targetResMins) * 100))) : 0;

  const is24x7 = input.priority === 'P1' && input.customerTier === 'vip';
  const isPaused = rawResult.firstResponse === 'paused' || rawResult.resolution === 'paused';

  return {
    firstResponse: {
      status: rawResult.firstResponse,
      targetMinutes: targetFrMins,
      elapsedMinutes: elapsedFrMins,
      dueAt: rawResult.dueAt.firstResponse.toISOString(),
      remainingMinutes: remainingFrMins,
      percentageElapsed: pctFr
    },
    resolution: {
      status: rawResult.resolution,
      targetMinutes: targetResMins,
      elapsedMinutes: elapsedResMins,
      dueAt: rawResult.dueAt.resolution.toISOString(),
      remainingMinutes: remainingResMins,
      percentageElapsed: pctRes
    },
    isPaused,
    is24x7,
    calendarTimezone: calendar.timezone
  };
}

@Injectable({
  providedIn: 'root'
})
export class SlaSimulatorService {
  public simulate(input: SlaSimulationInput): SlaSimulationResult {
    return simulateSla(input);
  }
}
