import {
  createEgyptCalendar,
  createEuropeCalendar,
  createSaudiCalendar,
  createUaeCalendar
} from './regional-calendars';
import { ShiftWindow } from '../models/calendar.model';

describe('Regional Calendars', () => {
  const shifts: readonly ShiftWindow[] = [{ start: '09:00', end: '17:00' }];

  describe('createEgyptCalendar', () => {
    it('should configure Sunday-Thursday working days in Africa/Cairo timezone with explicit shifts', () => {
      const calendar = createEgyptCalendar(shifts);
      expect(calendar.timezone).toBe('Africa/Cairo');

      // 2026-01-04 is Sunday (working day in Egypt)
      // In winter, Cairo is UTC+2, so 09:00 Cairo is 07:00 UTC
      const sundayWork = new Date('2026-01-04T08:00:00Z'); // 10:00 in Cairo
      expect(calendar.isWorkingTime(sundayWork)).toBeTrue();

      // 2026-01-09 is Friday (weekend in Egypt)
      const fridayWeekend = new Date('2026-01-09T08:00:00Z');
      expect(calendar.isWorkingTime(fridayWeekend)).toBeFalse();

      // 2026-01-10 is Saturday (weekend in Egypt)
      const saturdayWeekend = new Date('2026-01-10T08:00:00Z');
      expect(calendar.isWorkingTime(saturdayWeekend)).toBeFalse();
    });

    it('should respect custom shifts and holidays in Egypt', () => {
      const customShifts: ShiftWindow[] = [{ start: '10:00', end: '16:00' }];
      const holidays = ['2026-01-07']; // Coptic Christmas
      const calendar = createEgyptCalendar(customShifts, holidays);

      // Wednesday 2026-01-07 is holiday
      const copticChristmas = new Date('2026-01-07T09:00:00Z'); // 11:00 Cairo
      expect(calendar.isWorkingTime(copticChristmas)).toBeFalse();
    });
  });

  describe('createSaudiCalendar', () => {
    it('should configure Sunday-Thursday working days in Asia/Riyadh timezone with explicit shifts', () => {
      const calendar = createSaudiCalendar(shifts);
      expect(calendar.timezone).toBe('Asia/Riyadh');

      // Riyadh is UTC+3 (no DST)
      // 2026-01-04 is Sunday (working day) -> 10:00 Riyadh = 07:00 UTC
      const sundayWork = new Date('2026-01-04T07:00:00Z');
      expect(calendar.isWorkingTime(sundayWork)).toBeTrue();

      // 2026-01-09 is Friday (weekend)
      const fridayWeekend = new Date('2026-01-09T07:00:00Z');
      expect(calendar.isWorkingTime(fridayWeekend)).toBeFalse();

      // 2026-01-10 is Saturday (weekend)
      const saturdayWeekend = new Date('2026-01-10T07:00:00Z');
      expect(calendar.isWorkingTime(saturdayWeekend)).toBeFalse();
    });
  });

  describe('createEuropeCalendar', () => {
    it('should configure Monday-Friday working days in Europe/London timezone with explicit shifts', () => {
      const calendar = createEuropeCalendar(shifts);
      expect(calendar.timezone).toBe('Europe/London');

      // 2026-01-05 is Monday (working day) -> 10:00 London = 10:00 UTC (winter)
      const mondayWork = new Date('2026-01-05T10:00:00Z');
      expect(calendar.isWorkingTime(mondayWork)).toBeTrue();

      // 2026-01-03 is Saturday (weekend)
      const saturdayWeekend = new Date('2026-01-03T10:00:00Z');
      expect(calendar.isWorkingTime(saturdayWeekend)).toBeFalse();

      // 2026-01-04 is Sunday (weekend)
      const sundayWeekend = new Date('2026-01-04T10:00:00Z');
      expect(calendar.isWorkingTime(sundayWeekend)).toBeFalse();
    });

    it('should allow custom timezone in Europe', () => {
      const calendar = createEuropeCalendar(shifts, undefined, 'Europe/Berlin');
      expect(calendar.timezone).toBe('Europe/Berlin');
    });
  });

  describe('createUaeCalendar', () => {
    it('should require explicitly configured working days and shifts without assuming Mon-Fri or defaults', () => {
      // Modern UAE public sector workweek: Monday to Friday
      const uaePublicSectorDays = [1, 2, 3, 4, 5];
      const calendarPublic = createUaeCalendar(uaePublicSectorDays, shifts);
      expect(calendarPublic.timezone).toBe('Asia/Dubai');

      // Sunday 2026-01-04 is weekend for public sector
      // Dubai is UTC+4 -> 10:00 Dubai = 06:00 UTC
      const sundayTime = new Date('2026-01-04T06:00:00Z');
      expect(calendarPublic.isWorkingTime(sundayTime)).toBeFalse();

      // Monday 2026-01-05 is working day
      const mondayTime = new Date('2026-01-05T06:00:00Z');
      expect(calendarPublic.isWorkingTime(mondayTime)).toBeTrue();
    });

    it('should support traditional Sunday-Thursday UAE workweek when explicitly configured', () => {
      // Traditional UAE private sector workweek: Sunday to Thursday
      const uaeTraditionalDays = [0, 1, 2, 3, 4];
      const calendarTraditional = createUaeCalendar(uaeTraditionalDays, shifts);

      // Sunday 2026-01-04 is working day
      const sundayTime = new Date('2026-01-04T06:00:00Z');
      expect(calendarTraditional.isWorkingTime(sundayTime)).toBeTrue();

      // Friday 2026-01-09 is weekend
      const fridayTime = new Date('2026-01-09T06:00:00Z');
      expect(calendarTraditional.isWorkingTime(fridayTime)).toBeFalse();
    });

    it('should support custom shifts and holidays in UAE', () => {
      const uaeDays = [1, 2, 3, 4, 5];
      const customShifts: ShiftWindow[] = [
        { start: '08:00', end: '13:00' },
        { start: '14:00', end: '17:00' }
      ];
      const holidays = ['2026-12-02']; // UAE National Day
      const calendar = createUaeCalendar(uaeDays, customShifts, holidays);

      // National Day holiday
      const nationalDay = new Date('2026-12-02T06:00:00Z');
      expect(calendar.isWorkingTime(nationalDay)).toBeFalse();

      // During break 13:30 Dubai = 09:30 UTC
      const breakTime = new Date('2026-01-05T09:30:00Z');
      expect(calendar.isWorkingTime(breakTime)).toBeFalse();

      // During second shift 15:00 Dubai = 11:00 UTC
      const afternoonShiftTime = new Date('2026-01-05T11:00:00Z');
      expect(calendar.isWorkingTime(afternoonShiftTime)).toBeTrue();
    });
  });
});
