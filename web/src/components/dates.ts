// Small date helpers for owner screens. Dates from the API are ISO strings.
const parts = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);

export const shortDate = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const longDate = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const monthTitle = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
export const monthAbbr = (iso: string) =>
  parts(iso).toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
export const dayNum = (iso: string) => String(parts(iso).getDate());
export const weekdayTime = (iso: string) => {
  const d = parts(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};
export const daysAgo = (iso: string, now = new Date()) =>
  Math.floor((now.getTime() - parts(iso).getTime()) / 86_400_000);
export const greeting = (now = new Date()) => {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
