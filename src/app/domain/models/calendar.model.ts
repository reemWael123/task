export interface BusinessCalendar {
  readonly timezone: string;
  isWorkingTime(date: Date): boolean;
  addBusinessMinutes(start: Date, minutes: number): Date;
  getWorkingMinutesBetween(start: Date, end: Date): number;
}

export interface ShiftWindow {
  readonly start: string; // e.g. "09:00" (HH:mm format)
  readonly end: string;   // e.g. "17:00" (HH:mm format)
}

export interface CalendarConfig {
  readonly timezone: string;
  /** Working day indices: 0 = Sunday, 1 = Monday, ..., 6 = Saturday */
  readonly workingDays: readonly number[];
  readonly shifts: readonly ShiftWindow[];
  /** Optional holidays in 'YYYY-MM-DD' format */
  readonly holidays?: readonly string[];
}
