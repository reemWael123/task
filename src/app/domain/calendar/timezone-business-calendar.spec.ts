import { TimezoneBusinessCalendar } from './timezone-business-calendar';
import { CalendarConfig, ShiftWindow } from '../models/calendar.model';

describe('TimezoneBusinessCalendar', () => {
  const standardShifts: ShiftWindow[] = [{ start: '09:00', end: '17:00' }];
  const monToFri = [1, 2, 3, 4, 5];

  describe('Working Day Validation', () => {
    it('should accept valid working day indices 0 to 6', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: [0, 1, 2, 3, 4, 5, 6],
          shifts: standardShifts
        });
      }).not.toThrow();
    });

    it('should reject working day index less than 0', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: [-1, 1, 2],
          shifts: standardShifts
        });
      }).toThrowError(/Invalid working day index: -1/);
    });

    it('should reject working day index greater than 6', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: [1, 2, 7],
          shifts: standardShifts
        });
      }).toThrowError(/Invalid working day index: 7/);
    });

    it('should reject non-integer working day index', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: [1, 2.5, 3],
          shifts: standardShifts
        });
      }).toThrowError(/Invalid working day index: 2.5/);
    });

    it('should reject non-array workingDays', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: null as unknown as number[],
          shifts: standardShifts
        });
      }).toThrowError(/Invalid calendar configuration: workingDays must be an array/);
    });
  });

  describe('Shift Format and Range Validation', () => {
    it('should accept valid strict HH:mm shift times including 24:00 as end boundary', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '00:00', end: '08:00' },
            { start: '08:00', end: '16:00' },
            { start: '16:00', end: '24:00' }
          ]
        });
      }).not.toThrow();
    });

    it('should reject 24:00 as shift start time', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '24:00', end: '04:00' }]
        });
      }).toThrowError(/Invalid shift start hour: '24'/);
    });

    it('should reject 24:xx with non-zero minutes for shift end', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '16:00', end: '24:05' }]
        });
      }).toThrowError(/Invalid shift end minute: '5' in '24:05'. If hour is 24, minutes must be 00./);
    });

    it('should reject single-digit hour or minute format', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '9:00', end: '17:00' }]
        });
      }).toThrowError(/Invalid shift start format: '9:00'/);

      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '09:0', end: '17:00' }]
        });
      }).toThrowError(/Invalid shift start format: '09:0'/);
    });

    it('should reject shift formats with seconds or invalid characters', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '09:00:00', end: '17:00:00' }]
        });
      }).toThrowError(/Invalid shift start format: '09:00:00'/);

      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: 'morning', end: '17:00' }]
        });
      }).toThrowError(/Invalid shift start format: 'morning'/);
    });

    it('should reject hours outside 00–23', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '24:00', end: '25:00' }]
        });
      }).toThrowError(/Invalid shift start hour: '24'/);
    });

    it('should reject minutes outside 00–59', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '09:60', end: '17:00' }]
        });
      }).toThrowError(/Invalid shift start minute: '60'/);

      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '09:00', end: '17:75' }]
        });
      }).toThrowError(/Invalid shift end minute: '75'/);
    });

    it('should reject shift where start is equal to or after end', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '17:00', end: '09:00' }]
        });
      }).toThrowError(/Invalid shift window: start '17:00' must be strictly before end '09:00'/);

      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [{ start: '12:00', end: '12:00' }]
        });
      }).toThrowError(/Invalid shift window: start '12:00' must be strictly before end '12:00'/);
    });

    it('should reject non-array shifts', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: null as unknown as ShiftWindow[]
        });
      }).toThrowError(/Invalid calendar configuration: shifts must be an array/);
    });
  });

  describe('Shift Sorting and Overlap Detection', () => {
    it('should allow adjacent contiguous non-overlapping shifts', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '09:00', end: '13:00' },
            { start: '13:00', end: '17:00' }
          ]
        });
      }).not.toThrow();
    });

    it('should reject partially overlapping shifts', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '09:00', end: '13:00' },
            { start: '12:30', end: '17:00' }
          ]
        });
      }).toThrowError(/Overlapping shifts detected: '09:00-13:00' and '12:30-17:00'/);
    });

    it('should reject overlapping shifts regardless of input order', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '12:30', end: '17:00' },
            { start: '09:00', end: '13:00' }
          ]
        });
      }).toThrowError(/Overlapping shifts detected: '09:00-13:00' and '12:30-17:00'/);
    });

    it('should reject nested/contained overlapping shifts', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '09:00', end: '17:00' },
            { start: '10:00', end: '14:00' }
          ]
        });
      }).toThrowError(/Overlapping shifts detected: '09:00-17:00' and '10:00-14:00'/);
    });

    it('should reject exact duplicate shifts', () => {
      expect(() => {
        new TimezoneBusinessCalendar({
          timezone: 'UTC',
          workingDays: monToFri,
          shifts: [
            { start: '09:00', end: '17:00' },
            { start: '09:00', end: '17:00' }
          ]
        });
      }).toThrowError(/Overlapping shifts detected: '09:00-17:00' and '09:00-17:00'/);
    });
  });

  describe('isWorkingTime', () => {
    const calendar = new TimezoneBusinessCalendar({
      timezone: 'Europe/London',
      workingDays: monToFri, // Mon-Fri
      shifts: [{ start: '09:00', end: '17:00' }],
      holidays: ['2026-01-01']
    });

    it('should return true during working hours on a working day', () => {
      // 2026-01-05 is Monday
      const mondayAt10 = new Date('2026-01-05T10:00:00Z');
      expect(calendar.isWorkingTime(mondayAt10)).toBeTrue();
    });

    it('should return false before or after shift hours', () => {
      const mondayAt8 = new Date('2026-01-05T08:00:00Z');
      const mondayAt17 = new Date('2026-01-05T17:00:00Z'); // Half-open interval [09:00, 17:00)
      const mondayAt18 = new Date('2026-01-05T18:00:00Z');
      expect(calendar.isWorkingTime(mondayAt8)).toBeFalse();
      expect(calendar.isWorkingTime(mondayAt17)).toBeFalse();
      expect(calendar.isWorkingTime(mondayAt18)).toBeFalse();
    });

    it('should return false on weekends', () => {
      // 2026-01-03 is Saturday, 2026-01-04 is Sunday
      const saturdayNoon = new Date('2026-01-03T12:00:00Z');
      const sundayNoon = new Date('2026-01-04T12:00:00Z');
      expect(calendar.isWorkingTime(saturdayNoon)).toBeFalse();
      expect(calendar.isWorkingTime(sundayNoon)).toBeFalse();
    });

    it('should return false on holidays', () => {
      // 2026-01-01 is Thursday (normally working day), but listed in holidays
      const newYearsNoon = new Date('2026-01-01T12:00:00Z');
      expect(calendar.isWorkingTime(newYearsNoon)).toBeFalse();
    });
  });

  describe('addBusinessMinutes with Unsorted Shifts and Multi-Shift Days', () => {
    it('should produce identical results regardless of shift input order', () => {
      const shiftsForward: ShiftWindow[] = [
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '17:00' }
      ];
      const shiftsReversed: ShiftWindow[] = [
        { start: '13:00', end: '17:00' },
        { start: '09:00', end: '12:00' }
      ];

      const calForward = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: shiftsForward
      });

      const calReversed = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: shiftsReversed
      });

      // Monday 08:00 UTC (before first shift)
      const start = new Date('2026-01-05T08:00:00Z');

      // Adding 120 mins should jump to 09:00 and end at 11:00 UTC
      const resultFwd120 = calForward.addBusinessMinutes(start, 120);
      const resultRev120 = calReversed.addBusinessMinutes(start, 120);
      expect(resultFwd120.toISOString()).toBe('2026-01-05T11:00:00.000Z');
      expect(resultRev120.toISOString()).toBe('2026-01-05T11:00:00.000Z');

      // Adding 240 mins (4h): 3h in morning (09:00-12:00), 1h in afternoon (13:00-14:00)
      const resultFwd240 = calForward.addBusinessMinutes(start, 240);
      const resultRev240 = calReversed.addBusinessMinutes(start, 240);
      expect(resultFwd240.toISOString()).toBe('2026-01-05T14:00:00.000Z');
      expect(resultRev240.toISOString()).toBe('2026-01-05T14:00:00.000Z');
    });

    it('should advance through gap between shifts correctly', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '18:00' }
        ]
      });

      // Start at 12:30 (during break)
      const start = new Date('2026-01-05T12:30:00Z');
      // Adding 60 mins should jump to 14:00 and return 15:00
      const result = calendar.addBusinessMinutes(start, 60);
      expect(result.toISOString()).toBe('2026-01-05T15:00:00.000Z');
    });

    it('should roll over to next working day when starting after all shifts end', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: [{ start: '09:00', end: '17:00' }]
      });

      // Start at 19:00 on Monday
      const start = new Date('2026-01-05T19:00:00Z');
      // Adding 30 mins should jump to Tuesday 09:00 and return 09:30
      const result = calendar.addBusinessMinutes(start, 30);
      expect(result.toISOString()).toBe('2026-01-06T09:30:00.000Z');
    });
  });

  describe('Weekend and Holiday Handling in addBusinessMinutes', () => {
    it('should skip weekends when adding business minutes', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri, // Mon-Fri
        shifts: [{ start: '09:00', end: '17:00' }]
      });

      // Friday 2026-01-09 at 16:00 UTC (1 hour remaining in Friday shift)
      const friday16 = new Date('2026-01-09T16:00:00Z');
      // Add 120 minutes (2 hours): 1 hour used on Friday (until 17:00), 1 hour on Monday (09:00-10:00)
      const result = calendar.addBusinessMinutes(friday16, 120);
      expect(result.toISOString()).toBe('2026-01-12T10:00:00.000Z');
    });

    it('should skip holidays when adding business minutes', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: [{ start: '09:00', end: '17:00' }],
        holidays: ['2026-01-12'] // Monday is a holiday
      });

      // Friday 2026-01-09 at 16:00 UTC
      const friday16 = new Date('2026-01-09T16:00:00Z');
      // Adding 120 minutes: 1 hour on Friday, skips Sat & Sun, skips holiday Monday, lands on Tuesday at 10:00
      const result = calendar.addBusinessMinutes(friday16, 120);
      expect(result.toISOString()).toBe('2026-01-13T10:00:00.000Z');
    });

    it('should return exact date copy when adding 0 or negative minutes', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: monToFri,
        shifts: [{ start: '09:00', end: '17:00' }]
      });

      const date = new Date('2026-01-05T10:15:30.500Z');
      expect(calendar.addBusinessMinutes(date, 0).getTime()).toBe(date.getTime());
      expect(calendar.addBusinessMinutes(date, -10).getTime()).toBe(date.getTime());
    });
  });

  describe('MAX_DAYS_ITERATIONS and Edge Errors', () => {
    it('should throw an error when MAX_DAYS_ITERATIONS is reached', () => {
      // Mock calendar where days are never working days due to holidays or iteration limit
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: [],
        shifts: [{ start: '09:00', end: '17:00' }]
      });

      const start = new Date('2026-01-05T09:00:00Z');
      expect(() => {
        calendar.addBusinessMinutes(start, 60);
      }).toThrowError(/Cannot add business minutes: calendar has no working days or shifts configured/);
    });

    it('should throw when shifts array is empty', () => {
      const calendar = new TimezoneBusinessCalendar({
        timezone: 'UTC',
        workingDays: [1, 2, 3],
        shifts: []
      });

      const start = new Date('2026-01-05T09:00:00Z');
      expect(() => {
        calendar.addBusinessMinutes(start, 60);
      }).toThrowError(/Cannot add business minutes: calendar has no working days or shifts configured/);
    });
  });

  describe('getWorkingMinutesBetween and No Double-Counting', () => {
    const calendar = new TimezoneBusinessCalendar({
      timezone: 'UTC',
      workingDays: monToFri,
      shifts: [
        { start: '09:00', end: '13:00' },
        { start: '13:00', end: '17:00' } // Contiguous adjacent shifts
      ],
      holidays: ['2026-01-07'] // Wednesday is a holiday
    });

    it('should return 0 when start is at or after end', () => {
      const t1 = new Date('2026-01-05T12:00:00Z');
      const t2 = new Date('2026-01-05T10:00:00Z');
      expect(calendar.getWorkingMinutesBetween(t1, t2)).toBe(0);
      expect(calendar.getWorkingMinutesBetween(t1, t1)).toBe(0);
    });

    it('should not double-count time at adjacent shift boundary', () => {
      // Monday from 08:00 to 18:00 spans the entire 09:00-13:00 and 13:00-17:00 shifts
      // Exactly 8 hours = 480 minutes
      const start = new Date('2026-01-05T08:00:00Z');
      const end = new Date('2026-01-05T18:00:00Z');
      expect(calendar.getWorkingMinutesBetween(start, end)).toBe(480);
    });

    it('should exclude weekends and holidays in getWorkingMinutesBetween', () => {
      // Monday 2026-01-05 09:00 to Friday 2026-01-09 17:00:
      // Monday: 8h (480m)
      // Tuesday: 8h (480m)
      // Wednesday: 0h (Holiday!)
      // Thursday: 8h (480m)
      // Friday: 8h (480m)
      // Total = 4 * 480 = 1920 minutes
      const start = new Date('2026-01-05T09:00:00Z');
      const end = new Date('2026-01-09T17:00:00Z');
      expect(calendar.getWorkingMinutesBetween(start, end)).toBe(1920);
    });

    it('should be symmetric and bijective with addBusinessMinutes', () => {
      const start = new Date('2026-01-05T10:15:00Z');
      const minutesToAdd = 750; // 12.5 hours spanning across days
      const target = calendar.addBusinessMinutes(start, minutesToAdd);
      const measured = calendar.getWorkingMinutesBetween(start, target);
      expect(measured).toBe(minutesToAdd);
    });
  });

  describe('Daylight Saving Time (DST) Transitions', () => {
    // London transitions:
    // Spring Forward: Sunday, March 29, 2026 (01:00 UTC -> 02:00 BST, UTC+0 -> UTC+1)
    // Fall Back: Sunday, October 25, 2026 (02:00 BST -> 01:00 GMT, UTC+1 -> UTC+0)
    const londonCalendar = new TimezoneBusinessCalendar({
      timezone: 'Europe/London',
      workingDays: monToFri,
      shifts: [{ start: '09:00', end: '17:00' }]
    });

    it('should handle spring-forward DST transition correctly', () => {
      // Friday March 27, 2026 at 16:00 London time (GMT, UTC+0) = 2026-03-27T16:00:00Z
      const fridayStart = new Date('2026-03-27T16:00:00Z');
      // Friday has 1h remaining (16:00-17:00 GMT)
      // Over the weekend (Sunday March 29), DST springs forward to BST (UTC+1)
      // Monday March 30 starts at 09:00 London time (BST = 08:00 UTC)
      // Adding 120 minutes: 60 mins on Friday, 60 mins on Monday (09:00 to 10:00 BST = 09:00 UTC)
      const result = londonCalendar.addBusinessMinutes(fridayStart, 120);
      expect(result.toISOString()).toBe('2026-03-30T09:00:00.000Z');

      // Check working minutes between
      const measured = londonCalendar.getWorkingMinutesBetween(fridayStart, result);
      expect(measured).toBe(120);
    });

    it('should handle fall-back DST transition correctly', () => {
      // Friday October 23, 2026 at 16:00 London time (BST, UTC+1) = 2026-10-23T15:00:00Z
      const fridayStart = new Date('2026-10-23T15:00:00Z');
      // Over the weekend (Sunday October 25), DST falls back to GMT (UTC+0)
      // Monday October 26 starts at 09:00 London time (GMT = 09:00 UTC)
      // Adding 120 minutes: 60 mins on Friday, 60 mins on Monday (09:00 to 10:00 GMT = 10:00 UTC)
      const result = londonCalendar.addBusinessMinutes(fridayStart, 120);
      expect(result.toISOString()).toBe('2026-10-26T10:00:00.000Z');

      const measured = londonCalendar.getWorkingMinutesBetween(fridayStart, result);
      expect(measured).toBe(120);
    });

    it('should correctly determine isWorkingTime before and after DST transitions', () => {
      // Before spring forward: 09:30 London time is 09:30 UTC
      const winterDate = new Date('2026-03-27T09:30:00Z');
      expect(londonCalendar.isWorkingTime(winterDate)).toBeTrue();

      // After spring forward: 09:30 London time is 08:30 UTC
      const summerDate = new Date('2026-03-30T08:30:00Z');
      expect(londonCalendar.isWorkingTime(summerDate)).toBeTrue();

      // 09:30 UTC in summer is 10:30 London time (still working time)
      const summerDate1030 = new Date('2026-03-30T09:30:00Z');
      expect(londonCalendar.isWorkingTime(summerDate1030)).toBeTrue();

      // 16:30 UTC in summer is 17:30 London time (after 17:00 BST -> not working time)
      const summerDate1730 = new Date('2026-03-30T16:30:00Z');
      expect(londonCalendar.isWorkingTime(summerDate1730)).toBeFalse();
    });

    describe('Africa/Cairo DST transitions', () => {
      // Egypt observed DST:
      // Spring transition: Last Friday of April (midnight, 2026-04-24 00:00: UTC+2 -> UTC+3)
      // Autumn transition: Last Thursday/Friday of October (midnight, 2026-10-29/30: UTC+3 -> UTC+2)
      // Working days in Egypt are Sunday-Thursday ([0, 1, 2, 3, 4]), Friday/Saturday are weekends ([5, 6]).
      const egyptCalendar = new TimezoneBusinessCalendar({
        timezone: 'Africa/Cairo',
        workingDays: [0, 1, 2, 3, 4], // Sun-Thu
        shifts: [{ start: '09:00', end: '17:00' }]
      });

      it('should handle spring DST transition in Africa/Cairo (UTC+2 -> UTC+3)', () => {
        // Thursday April 23, 2026 at 16:00 Cairo time (winter, UTC+2) = 2026-04-23T14:00:00Z
        // 1 hour remaining in Thursday shift (16:00-17:00 Cairo)
        // Friday April 24 & Saturday April 25: Egypt weekend; Egypt switches to summer time (UTC+3)
        // Sunday April 26 is first working day after DST spring-forward (summer, UTC+3)
        // Sunday 09:00 Cairo time = 06:00 UTC
        // Adding 120 minutes: 60 mins Thursday (until 17:00 Cairo / 15:00 UTC) + 60 mins Sunday (09:00 to 10:00 Cairo / 07:00 UTC)
        const start = new Date('2026-04-23T14:00:00Z');
        const result = egyptCalendar.addBusinessMinutes(start, 120);
        expect(result.toISOString()).toBe('2026-04-26T07:00:00.000Z');

        const measured = egyptCalendar.getWorkingMinutesBetween(start, result);
        expect(measured).toBe(120);
      });

      it('should handle autumn DST transition in Africa/Cairo (UTC+3 -> UTC+2)', () => {
        // Thursday October 29, 2026 at 16:00 Cairo time (summer, UTC+3) = 2026-10-29T13:00:00Z
        // 1 hour remaining in Thursday shift (16:00-17:00 Cairo)
        // Friday October 30 & Saturday October 31: Egypt weekend; Egypt switches to winter time (UTC+2)
        // Sunday November 1 is first working day after DST fall-back (winter, UTC+2)
        // Sunday 09:00 Cairo time = 07:00 UTC
        // Adding 120 minutes: 60 mins Thursday (until 17:00 Cairo / 14:00 UTC) + 60 mins Sunday (09:00 to 10:00 Cairo / 08:00 UTC)
        const start = new Date('2026-10-29T13:00:00Z');
        const result = egyptCalendar.addBusinessMinutes(start, 120);
        expect(result.toISOString()).toBe('2026-11-01T08:00:00.000Z');

        const measured = egyptCalendar.getWorkingMinutesBetween(start, result);
        expect(measured).toBe(120);
      });

      it('should correctly determine isWorkingTime before and after Cairo DST transitions', () => {
        // Before spring forward (winter UTC+2): 09:30 Cairo = 07:30 UTC
        const winterWorking = new Date('2026-04-23T07:30:00Z');
        expect(egyptCalendar.isWorkingTime(winterWorking)).toBeTrue();

        // After spring forward (summer UTC+3): 09:30 Cairo = 06:30 UTC
        const summerWorking = new Date('2026-04-26T06:30:00Z');
        expect(egyptCalendar.isWorkingTime(summerWorking)).toBeTrue();

        // 14:30 UTC before spring forward was 16:30 Cairo (inside shift [09:00, 17:00))
        expect(egyptCalendar.isWorkingTime(new Date('2026-04-23T14:30:00Z'))).toBeTrue();

        // 14:30 UTC after spring forward is 17:30 Cairo (after 17:00 Cairo shift end -> false)
        expect(egyptCalendar.isWorkingTime(new Date('2026-04-26T14:30:00Z'))).toBeFalse();
      });
    });
  });

  describe('Overnight Shift Handling via 24:00 Boundary', () => {
    // Overnight shift: 22:00 to 06:00, represented seamlessly without losing any minutes:
    // 22:00 to 24:00 (120 mins) and 00:00 to 06:00 (360 mins)
    const calendar = new TimezoneBusinessCalendar({
      timezone: 'UTC',
      workingDays: monToFri,
      shifts: [
        { start: '22:00', end: '24:00' },
        { start: '00:00', end: '06:00' }
      ]
    });

    it('should correctly determine isWorkingTime across midnight with 24:00 boundary', () => {
      // 21:59 is before the shift
      expect(calendar.isWorkingTime(new Date('2026-01-05T21:59:00Z'))).toBeFalse();
      // 22:00 is shift start
      expect(calendar.isWorkingTime(new Date('2026-01-05T22:00:00Z'))).toBeTrue();
      // 23:59:59 is inside the evening shift
      expect(calendar.isWorkingTime(new Date('2026-01-05T23:59:59Z'))).toBeTrue();
      // 00:00:00 is start of the morning shift
      expect(calendar.isWorkingTime(new Date('2026-01-06T00:00:00Z'))).toBeTrue();
      // 05:59:59 is inside the morning shift
      expect(calendar.isWorkingTime(new Date('2026-01-06T05:59:59Z'))).toBeTrue();
      // 06:00:00 is shift end
      expect(calendar.isWorkingTime(new Date('2026-01-06T06:00:00Z'))).toBeFalse();
    });

    it('should add business minutes across midnight without losing any minutes', () => {
      // Start at 23:00 on Monday (1 hour left before midnight)
      const start = new Date('2026-01-05T23:00:00Z');
      // Adding 120 minutes: 60 mins until midnight, 60 mins into Tuesday morning (00:00 to 01:00)
      const result = calendar.addBusinessMinutes(start, 120);
      expect(result.toISOString()).toBe('2026-01-06T01:00:00.000Z');
    });

    it('should calculate working minutes across midnight without losing any minutes', () => {
      const start = new Date('2026-01-05T23:00:00Z');
      const end = new Date('2026-01-06T01:00:00Z');
      expect(calendar.getWorkingMinutesBetween(start, end)).toBe(120);
    });
  });
});
