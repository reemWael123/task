import { BusinessCalendar, CalendarConfig } from '../models/calendar.model';

interface ParsedShift {
  readonly startMinutes: number;
  readonly endMinutes: number;
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

export class TimezoneBusinessCalendar implements BusinessCalendar {
  public readonly timezone: string;
  private readonly workingDaysSet: Set<number>;
  private readonly holidaysSet: Set<string>;
  private readonly parsedShifts: readonly ParsedShift[];
  private readonly dateTimeFormatter: Intl.DateTimeFormat;

  constructor(public readonly config: CalendarConfig) {
    this.timezone = config.timezone;
    this.workingDaysSet = new Set(config.workingDays);
    this.holidaysSet = new Set(config.holidays ?? []);

    this.parsedShifts = config.shifts.map(shift => {
      const [sh, sm] = shift.start.split(':').map(val => parseInt(val, 10));
      const [eh, em] = shift.end.split(':').map(val => parseInt(val, 10));
      const startMinutes = (sh ?? 0) * 60 + (sm ?? 0);
      const endMinutes = (eh ?? 0) * 60 + (em ?? 0);

      if (startMinutes >= endMinutes) {
        throw new Error(
          `Invalid shift window: start '${shift.start}' must be strictly before end '${shift.end}'`
        );
      }
      return { startMinutes, endMinutes };
    });

    this.dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
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
      return new Date(start.getTime());
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

          if (overlapEnd > overlapStart) {
            totalWorkingMs += overlapEnd - overlapStart;
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
          hour = parseInt(p.value, 10) % 24;
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
          case 'hour': h = parseInt(p.value, 10) % 24; break;
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
