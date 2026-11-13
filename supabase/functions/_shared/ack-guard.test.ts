import { describe, expect, it } from 'vitest';
import { shouldAutoAcknowledge } from './ack-guard.ts';

const roster = ['owner@example.test'];
const now = new Date('2027-03-10T12:00:00Z');
const ok = (sender = 'Owner <owner@example.test>', headers = {}, history: any[] = []) => shouldAutoAcknowledge(sender, headers, history, roster, now);

describe('shouldAutoAcknowledge', () => {
  it('acknowledges a roster sender', () => expect(ok()).toEqual({ send: true }));
  it('never replies to non-roster senders', () => expect(ok('stranger@example.test')).toMatchObject({ reason: 'not_on_roster' }));
  it('never replies to automated mail', () => {
    expect(ok(undefined, { 'Auto-Submitted': 'auto-replied' })).toMatchObject({ reason: 'auto_submitted' });
    expect(ok(undefined, { 'auto-submitted': 'no' })).toEqual({ send: true });
    expect(ok(undefined, { 'List-Unsubscribe': '<x>' })).toMatchObject({ reason: 'mailing_list' });
    expect(ok(undefined, { Precedence: 'bulk' })).toMatchObject({ reason: 'bulk_precedence' });
  });
  it('never replies to noreply or vendor senders even if on the roster', () => {
    const r = ['noreply@example.test', 'billing@stripe.com', 'x@mail.lob.com'];
    for (const s of r) expect(shouldAutoAcknowledge(s, {}, [], r, now).send).toBe(false);
  });
  it('limits to once per sender per 7 days', () => {
    const day = 86_400_000;
    expect(ok(undefined, {}, [{ sender: 'owner@example.test', sent_at: new Date(now.getTime() - 6 * day).toISOString() }])).toMatchObject({ reason: 'already_acknowledged_this_week' });
    expect(ok(undefined, {}, [{ sender: 'owner@example.test', sent_at: new Date(now.getTime() - 8 * day).toISOString() }])).toEqual({ send: true });
    expect(ok(undefined, {}, [{ sender: 'other@example.test', sent_at: now.toISOString() }])).toEqual({ send: true });
  });
  it('is case-insensitive on the address', () => expect(ok('OWNER@Example.test').send).toBe(true));
});
