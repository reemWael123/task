import { BusinessCalendar, CalendarConfig } from '../models/calendar.model';

interface ParsedShift {
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly startStr: string;
  readonly endStr: string;
}

interface LocalTimeComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
  readonly dateStr: string;
  readonly minuteOfDay: number;
}

function parseAndValidateShiftTime(
  timeStr: string,
  fieldName: string,
  isEnd = false
): number {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) {
    throw new Error(
      `Invalid ${fieldName} format: '${timeStr}'. Expected strict 'HH:mm' format.`
    );
  }
  const [hStr, mStr] = timeStr.split(':');
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);

  // 24:00 is allowed strictly as an end-only boundary
  if (isEnd && hours === 24) {
    if (minutes !== 0) {
      throw new Error(
        `Invalid ${fieldName} minute: '${minutes}' in '${timeStr}'. If hour is 24, minutes must be 00.`
      );
    }
    return 24 * 60; // 1440
  }

  if (hours < 0 || hours > 23) {
    throw new Error(
      `Invalid ${fieldName} hour: '${hours}' in '${timeStr}'. Hours must be between 00 and 23${isEnd ? ' (or 24:00 for end time)' : ''}.`
    );
  }
  if (minutes < 0 || minutes > 59) {
    throw new Error(
      `Invalid ${fieldName} minute: '${minutes}' in '${timeStr}'. Minutes must be between 00 and 59.`
    );
  }

  return hours * 60 + minutes;
}

/**
 * Calendar implementation supporting arbitrary regional timezones, configurable shifts,
 * and working days.
 *
 * Overnight shifts:
 * To represent an overnight shift spanning across midnight without losing any minutes,
 * use '24:00' as the end boundary of the evening shift (e.g. '22:00' to '24:00')
 * and '00:00' as the start of the morning shift (e.g. '00:00' to '06:00').
 */
export class TimezoneBusinessCalendar implements BusinessCalendar {
  public readonly timezone: string;
  private readonly workingDaysSet: Set<number>;
  private readonly holidaysSet: Set<string>;
  private readonly parsedShifts: readonly ParsedShift[];
  private readonly dateTimeFormatter: Intl.DateTimeFormat;

  constructor(public readonly config: CalendarConfig) {
    this.timezone = config.timezone;

    if (!Array.isArray(config.workingDays)) {
      throw new Error('Invalid calendar configuration: workingDays must be an array.');
    }
    for (const day of config.workingDays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(
          `Invalid working day index: ${day}. Working day indices must be integers between 0 (Sunday) and 6 (Saturday).`
        );
      }
    }
    this.workingDaysSet = new Set(config.workingDays);
    this.holidaysSet = new Set(config.holidays ?? []);

    if (!Array.isArray(config.shifts)) {
      throw new Error('Invalid calendar configuration: shifts must be an array.');
    }

    const rawParsedShifts: ParsedShift[] = config.shifts.map(shift => {
      const startMinutes = parseAndValidateShiftTime(shift.start, 'shift start', false);
      const endMinutes = parseAndValidateShiftTime(shift.end, 'shift end', true);

      if (startMinutes >= endMinutes) {
        throw new Error(
          `Invalid shift window: start '${shift.start}' must be strictly before end '${shift.end}'`
        );
      }
      return {
        startMinutes,
        endMinutes,
        startStr: shift.start,
        endStr: shift.end
      };
    });

    // Sort shifts chronologically by startMinutes (and endMinutes for tie-break)
    const sortedShifts = [...rawParsedShifts].sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) {
        return a.startMinutes - b.startMinutes;
      }
      return a.endMinutes - b.endMinutes;
    });

    // Reject overlapping shifts
    for (let i = 0; i < sortedShifts.length - 1; i++) {
      const current = sortedShifts[i];
      const next = sortedShifts[i + 1];
      if (current.endMinutes > next.startMinutes) {
        throw new Error(
          `Overlapping shifts detected: '${current.startStr}-${current.endStr}' and '${next.startStr}-${next.endStr}'`
        );
      }
    }

    this.parsedShifts = sortedShifts;

    this.dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short'
    });
  }

  public isWorkingTime(date: Date): boolean {
    const comp = this.getLocalComponents(date);
    if (this.holidaysSet.has(comp.dateStr)) {
      return false;
    }
    if (!this.workingDaysSet.has(comp.weekday)) {
      return false;
    }
    return this.parsedShifts.some(
      shift => comp.minuteOfDay >= shift.startMinutes && comp.minuteOfDay < shift.endMinutes
    );
  }

  public addBusinessMinutes(start: Date, minutes: number): Date {
    if (minutes <= 0) {
      return new Date(start.getTime());
    }

    if (this.workingDaysSet.size === 0 || this.parsedShifts.length === 0) {
      throw new Error(
        'Cannot add business minutes: calendar has no working days or shifts configured'
      );
    }

    let remainingMs = Math.round(minutes * 60000);
    let current = new Date(start.getTime());

    let iterations = 0;
    const MAX_DAYS_ITERATIONS = 5000;

    while (remainingMs > 0 && iterations++ < MAX_DAYS_ITERATIONS) {
      const comp = this.getLocalComponents(current);
      const isWorkingDay =
        this.workingDaysSet.has(comp.weekday) && !this.holidaysSet.has(comp.dateStr);

      if (isWorkingDay) {
        for (const shift of this.parsedShifts) {
          if (remainingMs <= 0) {
            break;
          }

          const startHour = Math.floor(shift.startMinutes / 60);
          const startMin = shift.startMinutes % 60;
          const endHour = Math.floor(shift.endMinutes / 60);
          const endMin = shift.endMinutes % 60;

          const shiftStartUtc = this.zonedDateTimeToUtc(
            comp.year,
            comp.month,
            comp.day,
            startHour,
            startMin,
            0
          );
          const shiftEndUtc = this.zonedDateTimeToUtc(
            comp.year,
            comp.month,
            comp.day,
            endHour,
            endMin,
            0
          );

          // If current is before this shift start, jump to shift start
          if (current.getTime() < shiftStartUtc.getTime()) {
            current = new Date(shiftStartUtc.getTime());
          }

          // If current is within this shift
          if (
            current.getTime() >= shiftStartUtc.getTime() &&
            current.getTime() < shiftEndUtc.getTime()
          ) {
            const availableMs = shiftEndUtc.getTime() - current.getTime();
            if (remainingMs <= availableMs) {
              return new Date(current.getTime() + remainingMs);
            } else {
              remainingMs -= availableMs;
              current = new Date(shiftEndUtc.getTime());
            }
          }
        }
      }

      if (remainingMs > 0) {
        // Advance to start of next calendar day in local timezone
        const nextDayUtc = this.zonedDateTimeToUtc(
          comp.year,
          comp.month,
          comp.day + 1,
          0,
          0,
          0
        );
        current = new Date(nextDayUtc.getTime());
      }
    }

    if (remainingMs > 0) {
      throw new Error(
        `MAX_DAYS_ITERATIONS (${MAX_DAYS_ITERATIONS}) reached: unable to add business minutes within maximum search window`
      );
    }

    return current;
  }

  public getWorkingMinutesBetween(start: Date, end: Date): number {
    if (start.getTime() >= end.getTime()) {
      return 0;
    }

    if (this.workingDaysSet.size === 0 || this.parsedShifts.length === 0) {
      return 0;
    }

    const startLocal = this.getLocalComponents(start);
    const endLocal = this.getLocalComponents(end);

    let totalWorkingMs = 0;
    let lastCountedEndMs = -Infinity;
    let cursorUtc = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day);
    const endCursorUtc = Date.UTC(endLocal.year, endLocal.month - 1, endLocal.day);

    while (cursorUtc <= endCursorUtc) {
      const curDate = new Date(cursorUtc);
      const y = curDate.getUTCFullYear();
      const m = curDate.getUTCMonth() + 1;
      const d = curDate.getUTCDate();

      // Check midday for weekday & holiday in target timezone
      const middayUtc = this.zonedDateTimeToUtc(y, m, d, 12, 0, 0);
      const comp = this.getLocalComponents(middayUtc);

      if (this.workingDaysSet.has(comp.weekday) && !this.holidaysSet.has(comp.dateStr)) {
        for (const shift of this.parsedShifts) {
          const startHour = Math.floor(shift.startMinutes / 60);
          const startMin = shift.startMinutes % 60;
          const endHour = Math.floor(shift.endMinutes / 60);
          const endMin = shift.endMinutes % 60;

          const shiftStartUtc = this.zonedDateTimeToUtc(y, m, d, startHour, startMin, 0);
          const shiftEndUtc = this.zonedDateTimeToUtc(y, m, d, endHour, endMin, 0);

          const overlapStart = Math.max(start.getTime(), shiftStartUtc.getTime());
          const overlapEnd = Math.min(end.getTime(), shiftEndUtc.getTime());

          const effectiveStart = Math.max(overlapStart, lastCountedEndMs);

          if (overlapEnd > effectiveStart) {
            totalWorkingMs += overlapEnd - effectiveStart;
            lastCountedEndMs = overlapEnd;
          }
        }
      }

      cursorUtc += 24 * 3600 * 1000;
    }

    return Math.round(totalWorkingMs / 60000);
  }

  public getLocalComponents(date: Date): LocalTimeComponents {
    const parts = this.dateTimeFormatter.formatToParts(date);
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;
    let weekdayStr = '';

    for (const p of parts) {
      switch (p.type) {
        case 'year':
          year = parseInt(p.value, 10);
          break;
        case 'month':
          month = parseInt(p.value, 10);
          break;
        case 'day':
          day = parseInt(p.value, 10);
          break;
        case 'hour':
          hour = parseInt(p.value, 10);
          break;
        case 'minute':
          minute = parseInt(p.value, 10);
          break;
        case 'second':
          second = parseInt(p.value, 10);
          break;
        case 'weekday':
          weekdayStr = p.value;
          break;
      }
    }

    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6
    };

    const monthStr = month < 10 ? `0${month}` : `${month}`;
    const dayStr = day < 10 ? `0${day}` : `${day}`;

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday: weekdayMap[weekdayStr] ?? 0,
      dateStr: `${year}-${monthStr}-${dayStr}`,
      minuteOfDay: hour * 60 + minute
    };
  }

  public zonedDateTimeToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second = 0
  ): Date {
    const approx = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

    const getOffset = (d: Date): number => {
      const parts = this.dateTimeFormatter.formatToParts(d);
      let y = 0, m = 0, dt = 0, h = 0, min = 0, s = 0;
      for (const p of parts) {
        switch (p.type) {
          case 'year': y = parseInt(p.value, 10); break;
          case 'month': m = parseInt(p.value, 10); break;
          case 'day': dt = parseInt(p.value, 10); break;
          case 'hour': h = parseInt(p.value, 10); break;
          case 'minute': min = parseInt(p.value, 10); break;
          case 'second': s = parseInt(p.value, 10); break;
        }
      }
      const iso = `${y}-${m < 10 ? '0' + m : m}-${dt < 10 ? '0' + dt : dt}T${h < 10 ? '0' + h : h}:${min < 10 ? '0' + min : min}:${s < 10 ? '0' + s : s}Z`;
      return Date.parse(iso) - d.getTime();
    };

    const offset = getOffset(approx);
    let result = new Date(approx.getTime() - offset);
    const newOffset = getOffset(result);
    if (newOffset !== offset) {
      result = new Date(approx.getTime() - newOffset);
    }
    return result;
  }
}
