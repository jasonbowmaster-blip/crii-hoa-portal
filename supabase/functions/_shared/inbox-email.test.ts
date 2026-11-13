import { describe, expect, it } from 'vitest';
import { buildInboxEmail, MAX_BODY_CHARS, MAX_SUBJECT_CHARS, stripHeaderInjection } from './inbox-email.ts';

describe('buildInboxEmail', () => {
  it('formats the subject with lot, topic and first words', () => {
    const { subject } = buildInboxEmail({ topic: 'billing', body: 'Why is my balance higher than last year? Please explain.' }, { lot_number: 42 });
    expect(subject).toBe('[Lot 42][Billing] Why is my balance higher than last year?…');
  });
  it('removes CR/LF so a header cannot be injected', () => {
    const { subject } = buildInboxEmail({ topic: 'other', body: 'Hi\r\nBcc: evil@example.test\r\n\r\nbody' }, { lot_number: 1 });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(stripHeaderInjection('a\r\nb\nc')).toBe('a b c');
  });
  it('caps subject and body length', () => {
    const long = 'x'.repeat(10_000);
    const { subject, text } = buildInboxEmail({ topic: 'question', body: long }, null);
    expect(subject.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
    expect(text.length).toBeLessThan(MAX_BODY_CHARS + 500);
    expect(subject.startsWith('[Lot ?]')).toBe(true);
  });
  it('keeps the plain-text body', () => {
    const { text } = buildInboxEmail({ topic: 'maintenance', body: 'Tree down.\nNear lot 5.', owner_name: 'Sam Sample' }, { lot_number: 3 });
    expect(text).toContain('From: Sam Sample (Lot 3)');
    expect(text).toContain('Tree down.\nNear lot 5.');
  });
});
