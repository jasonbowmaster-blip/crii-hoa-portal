import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessDaysUntil, deadlineText } from './ledger';
import { currentYear, setAppNow, todayISO } from './clock';
import { peekNext, rememberNext, safeNext, takeNext } from './afterSignIn';
import { appReturnUrl, hasAuthCallback, stripAuthParams } from './authUrl';
import { openWhenReady } from './openWindow';
import { eventWhen, fullDate } from '../components/dates';

afterEach(() => { setAppNow(null); localStorage.clear(); vi.restoreAllMocks(); });

describe('deadlines', () => {
  it('counts days left, due today and days late', () => {
    expect(businessDaysUntil('2027-01-13T15:00:00Z', '2027-01-26T15:00:00Z')).toBe(9);
    expect(businessDaysUntil('2027-01-13T15:00:00Z', '2027-01-13T15:00:00Z')).toBe(0);
    // due Fri Jan 22, now Wed Jan 27: Mon 25, Tue 26, Wed 27 are three business days late
    expect(businessDaysUntil('2027-01-27T15:00:00Z', '2027-01-22T15:00:00Z')).toBe(-3);
    expect(deadlineText(-3)).toBe('3 business days late');
    expect(deadlineText(-1)).toBe('1 business day late');
    expect(deadlineText(1)).toBe('1 business day left');
    expect(deadlineText(0)).toBe('due today');
  });
});

describe('Eastern-time dates', () => {
  it('does not roll to tomorrow after 7 pm Eastern', () => {
    expect(todayISO(new Date('2027-01-14T02:30:00Z'))).toBe('2027-01-13');   // 9:30 pm EST on the 13th
    setAppNow('2027-01-01T03:00:00Z');                                        // still Dec 31 in Virginia
    expect(currentYear()).toBe(2026);
  });
  it('shows a deadline as all day and a full date in words', () => {
    expect(eventWhen('2027-05-15T04:00:00Z', 'dues_date')).toBe('Sat · all day');
    expect(eventWhen('2027-01-20T00:00:00Z', 'board_meeting')).toMatch(/Tue 7:00 PM/);
    expect(fullDate('2027-05-15T04:00:00Z')).toBe('Saturday, May 15, 2027');
  });
});

describe('remembered destination', () => {
  it('keeps only in-app paths and hands them out once', () => {
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('/sign-in')).toBeNull();
    rememberNext('/claim');
    expect(peekNext()).toBe('/claim');
    expect(takeNext()).toBe('/claim');
    expect(takeNext()).toBeNull();
  });
  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => rememberNext('/claim')).not.toThrow();
    expect(takeNext()).toBeNull();
  });
});

describe('sign-in callback address', () => {
  it('returns to the app address with no hash, and strips only the callback parameters', () => {
    expect(appReturnUrl({ origin: 'https://portal.example', pathname: '/app/' })).toBe('https://portal.example/app/');
    const href = 'https://portal.example/app/?code=abc123&keep=1#/claim';
    expect(hasAuthCallback(href)).toBe(true);
    expect(stripAuthParams(href)).toBe('https://portal.example/app/?keep=1#/claim');
    expect(hasAuthCallback(stripAuthParams(href))).toBe(false);
  });
});

describe('openWhenReady', () => {
  const fakeWin = () => ({ closed: false, opener: {}, document: { title: '' }, location: { href: '' }, close: vi.fn() });

  it('opens the tab before the link is fetched, then points it at the file', async () => {
    const win = fakeWin();
    const open = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    let resolve!: (u: string) => void;
    const pending = openWhenReady(() => new Promise<string>((r) => { resolve = r; }));
    expect(open).toHaveBeenCalledTimes(1);          // synchronously, while the tap still counts
    expect(win.location.href).toBe('');
    resolve('https://files.example/doc.pdf');
    await pending;
    expect(win.location.href).toBe('https://files.example/doc.pdf');
  });

  it('closes the empty tab and rethrows when the link cannot be fetched', async () => {
    const win = fakeWin();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    await expect(openWhenReady(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(win.close).toHaveBeenCalled();
  });

  it('falls back to the current tab when the browser refuses a new one', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await openWhenReady(async () => 'https://files.example/doc.pdf');
    expect(assign).toHaveBeenCalledWith('https://files.example/doc.pdf');
    vi.unstubAllGlobals();
  });
});
