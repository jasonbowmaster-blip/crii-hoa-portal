// Builds the email the HOA Gmail inbox receives for a portal message.

export interface InboxMessage {
  topic: string;
  subject?: string;
  body: string;
  owner_name?: string | null;
}

export const TOPIC_LABELS: Record<string, string> = {
  question: 'Question', maintenance: 'Maintenance', arb: 'ARB', billing: 'Billing',
  records: 'Records', complaint: 'Complaint', other: 'Other',
};

export const MAX_BODY_CHARS = 5000;
export const MAX_SUBJECT_CHARS = 120;

// Headers must be one line: CR/LF (and other control characters) become spaces.
export function stripHeaderInjection(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstWords(body: string, count: number, maxChars: number): string {
  const words = stripHeaderInjection(body).split(' ').filter(Boolean);
  let text = words.slice(0, count).join(' ');
  const cut = words.length > count || text.length > maxChars;
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd();
  return cut ? `${text}…` : text;
}

export function buildInboxEmail(message: InboxMessage, lot: { lot_number: number } | null): { subject: string; text: string } {
  const lotTag = lot ? `[Lot ${lot.lot_number}]` : '[Lot ?]';
  const topicTag = `[${stripHeaderInjection(TOPIC_LABELS[message.topic] ?? 'Other')}]`;
  let subject = `${lotTag}${topicTag} ${firstWords(message.body, 8, 60)}`.trim();
  if (subject.length > MAX_SUBJECT_CHARS) subject = `${subject.slice(0, MAX_SUBJECT_CHARS - 1).trimEnd()}…`;
  const body = message.body.length > MAX_BODY_CHARS ? `${message.body.slice(0, MAX_BODY_CHARS)}\n[Message shortened]` : message.body;
  const text = [
    `From: ${stripHeaderInjection(message.owner_name ?? 'An owner')}${lot ? ` (Lot ${lot.lot_number})` : ''}`,
    `Topic: ${TOPIC_LABELS[message.topic] ?? 'Other'}`,
    '',
    body.replace(/\r\n?/g, '\n'),
    '',
    '-- Sent from the owner portal. Reply from the HOA inbox; the board approves anything about money or rules.',
  ].join('\n');
  return { subject, text };
}
