// Small date helpers. Dates from the API are ISO strings; times show in the HOA's time zone.
import { appNow, HOA_TIME_ZONE as timeZone } from '../lib/clock';
const parts = (iso: string) => new Date(iso.length === 10 ? `${iso}T17:00:00Z` : iso);

export const shortDate = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
export const longDate = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });
export const monthTitle = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone });
export const monthAbbr = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short', timeZone }).toUpperCase();
export const dayNum = (iso: string) => parts(iso).toLocaleDateString('en-US', { day: 'numeric', timeZone });
export const weekdayTime = (iso: string) => {
  const d = parts(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone })}`;
};
export const daysAgo = (iso: string, now = appNow()) =>
  Math.floor((now.getTime() - parts(iso).getTime()) / 86_400_000);
export const greeting = (now = appNow()) => {
  const h = Number(now.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone }));
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
// "Saturday, May 15, 2027": the whole date in words, for screen readers and anywhere the short form is too terse.
export const fullDate = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone });
const isMidnight = (iso: string) =>
  parts(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).replace('24', '00') === '00:00';
// Deadlines and midnight-stamped dates are all-day: "Sat · all day", never "Sat 12:00 AM".
export const eventWhen = (iso: string, kind?: string) => {
  if (kind !== 'dues_date' && !isMidnight(iso)) return weekdayTime(iso);
  return `${parts(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone })} · all day`;
};
