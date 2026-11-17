import { CalendarConfig, ShiftWindow } from '../models/calendar.model';
import { TimezoneBusinessCalendar } from './timezone-business-calendar';

/**
 * Egypt (EG): Sunday–Thursday working days.
 * Weekend: Friday and Saturday.
 * Timezone: Africa/Cairo (UTC+2 in winter, UTC+3 in summer).
 * Working hours (shifts) must be explicitly configured.
 */
export function createEgyptCalendar(
  shifts: readonly ShiftWindow[],
  holidays?: readonly string[]
): TimezoneBusinessCalendar {
  const config: CalendarConfig = {
    timezone: 'Africa/Cairo',
    workingDays: [0, 1, 2, 3, 4], // Sun, Mon, Tue, Wed, Thu
    shifts,
    holidays
  };
  return new TimezoneBusinessCalendar(config);
}

/**
 * Saudi Arabia (SA): Sunday–Thursday working days.
 * Weekend: Friday and Saturday.
 * Timezone: Asia/Riyadh (UTC+3, no DST).
 * Working hours (shifts) must be explicitly configured.
 */
export function createSaudiCalendar(
  shifts: readonly ShiftWindow[],
  holidays?: readonly string[]
): TimezoneBusinessCalendar {
  const config: CalendarConfig = {
    timezone: 'Asia/Riyadh',
    workingDays: [0, 1, 2, 3, 4], // Sun, Mon, Tue, Wed, Thu
    shifts,
    holidays
  };
  return new TimezoneBusinessCalendar(config);
}

/**
 * Europe (EU): Monday–Friday working days.
 * Weekend: Saturday and Sunday.
 * Timezone: Europe/London (or customizable, e.g. Europe/Paris, Europe/Berlin).
 * Working hours (shifts) must be explicitly configured.
 */
export function createEuropeCalendar(
  shifts: readonly ShiftWindow[],
  holidays?: readonly string[],
  timezone = 'Europe/London'
): TimezoneBusinessCalendar {
  const config: CalendarConfig = {
    timezone,
    workingDays: [1, 2, 3, 4, 5], // Mon, Tue, Wed, Thu, Fri
    shifts,
    holidays
  };
  return new TimezoneBusinessCalendar(config);
}

/**
 * United Arab Emirates (AE):
 * Working days and working hours (shifts) are explicitly configurable without assuming Mon–Fri or default shifts.
 * Timezone: Asia/Dubai (UTC+4, no DST).
 */
export function createUaeCalendar(
  workingDays: readonly number[],
  shifts: readonly ShiftWindow[],
  holidays?: readonly string[]
): TimezoneBusinessCalendar {
  const config: CalendarConfig = {
    timezone: 'Asia/Dubai',
    workingDays,
    shifts,
    holidays
  };
  return new TimezoneBusinessCalendar(config);
}
