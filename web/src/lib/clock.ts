// One clock for the app. The demo freezes it so sample deadlines stay meaningful.
let fixed: string | null = null;
export function setAppNow(iso: string | null) { fixed = iso; }
export function appNow(): Date { return fixed ? new Date(fixed) : new Date(); }
// The association is in Virginia: show every time in Eastern time, whatever the viewer's device says.
export const HOA_TIME_ZONE = 'America/New_York';
// Today's date (YYYY-MM-DD) and year as the HOA sees them (Eastern time), not UTC. After 7 or 8 pm Eastern the UTC date is
// already tomorrow, so slicing toISOString() would pre-fill the wrong day.
export function todayISO(now: Date = appNow()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HOA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export const currentYear = (now: Date = appNow()): number => Number(todayISO(now).slice(0, 4));
