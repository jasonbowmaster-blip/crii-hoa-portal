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
