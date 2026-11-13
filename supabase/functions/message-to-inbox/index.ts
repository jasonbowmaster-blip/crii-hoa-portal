// Turns a portal message into an email for the HOA Gmail inbox.
// The sender sits behind the EmailSender interface. The only implementation here
// logs and sends nothing; a real one comes later.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildInboxEmail } from '../_shared/inbox-email.ts';

export interface EmailSender {
  send(email: { to: string; subject: string; text: string }): Promise<void>;
}

const stubSender: EmailSender = {
  send(email) {
    console.log(`[stub sender] would send "${email.subject}" to ${email.to} (${email.text.length} chars)`);
    return Promise.resolve();
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => null);
  const messageId = String(body?.message_id ?? '');
  if (!messageId) return Response.json({ error: 'message_id is required' }, { status: 400 });

  // Invoked by a database webhook or trigger with the service key as a bearer token.
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (req.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Forbidden', { status: 403 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, key);
  const { data: message } = await db.from('messages').select('id, lot_id, owner_id, topic, body').eq('id', messageId).single();
  if (!message) return Response.json({ error: 'Not found' }, { status: 404 });
  const [{ data: lot }, { data: owner }] = await Promise.all([
    message.lot_id ? db.from('lots').select('lot_number').eq('id', message.lot_id).single() : Promise.resolve({ data: null }),
    message.owner_id ? db.from('owners').select('full_name').eq('id', message.owner_id).single() : Promise.resolve({ data: null }),
  ]);

  const email = buildInboxEmail({ topic: message.topic, body: message.body, owner_name: owner?.full_name }, lot);
  await stubSender.send({ to: Deno.env.get('HOA_INBOX_ADDRESS') ?? 'board@[our domain]', ...email });
  return Response.json({ sent: true, subject: email.subject });
});
