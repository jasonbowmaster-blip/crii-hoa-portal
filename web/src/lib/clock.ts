// One clock for the app. The demo freezes it so sample deadlines stay meaningful.
let fixed: string | null = null;
export function setAppNow(iso: string | null) { fixed = iso; }
export function appNow(): Date { return fixed ? new Date(fixed) : new Date(); }
// The association is in Virginia: show every time in Eastern time, whatever the viewer's device says.
export const HOA_TIME_ZONE = 'America/New_York';
