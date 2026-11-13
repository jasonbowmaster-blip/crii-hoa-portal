// Decides whether the fixed "We got your message" acknowledgment may go out.
// All rules must pass; any one failing means no automatic reply.

export interface AckHistoryItem { sender: string; sent_at: string } // ISO time
export type AckDecision = { send: true } | { send: false; reason: string };

export const ACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const VENDOR_DOMAINS = ['stripe.com', 'lob.com', 'resend.com', 'resend.dev', 'supabase.io', 'supabase.com', 'netlify.com', 'quickbooks.com', 'intuit.com', 'zoho.com'];
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)([+._-].*)?$/i;

export function extractAddress(sender: string): string {
  const m = sender.match(/<([^>]+)>/);
  return (m ? m[1] : sender).trim().toLowerCase();
}

export function shouldAutoAcknowledge(
  sender: string,
  headers: Record<string, string>,
  history: AckHistoryItem[],
  roster: string[],
  now: Date = new Date(),
): AckDecision {
  const address = extractAddress(sender);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { send: false, reason: 'bad_address' };

  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);

  const autoSubmitted = h['auto-submitted'];
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== 'no') return { send: false, reason: 'auto_submitted' };
  if (Object.keys(h).some((k) => k.startsWith('list-'))) return { send: false, reason: 'mailing_list' };
  if (/^(bulk|list|junk|auto_reply)$/i.test((h['precedence'] ?? '').trim())) return { send: false, reason: 'bulk_precedence' };
  if ('x-auto-response-suppress' in h || 'x-autoreply' in h || 'x-autorespond' in h) return { send: false, reason: 'auto_response_header' };

  const [local, domain] = address.split('@');
  if (AUTOMATED_LOCAL.test(local)) return { send: false, reason: 'automated_sender' };
  if (VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return { send: false, reason: 'vendor_sender' };

  if (!roster.map((r) => r.trim().toLowerCase()).includes(address)) return { send: false, reason: 'not_on_roster' };

  const cutoff = now.getTime() - ACK_WINDOW_MS;
  const recent = history.some((x) => extractAddress(x.sender) === address && new Date(x.sent_at).getTime() > cutoff);
  if (recent) return { send: false, reason: 'already_acknowledged_this_week' };

  return { send: true };
}
