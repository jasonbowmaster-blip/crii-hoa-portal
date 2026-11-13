-- 0006_grok: own-claim refusal, code release on reject, send_message rate limit, void reversal.

-- ===========================================================================
-- 1 + 2. Claims
-- ===========================================================================
begin;
insert into auth.users (id, email, email_confirmed_at) values
  ('a0000000-0000-4000-8000-0000000000c5', 'claimant.five@example.net', now());
insert into public.claim_codes (lot_id, code_hash, expires_at) values
  ('00000000-0000-4000-8000-000000000042', encode(sha256(convert_to('GROKCODE1', 'UTF8')), 'hex'), now() + interval '30 days'),
  ('00000000-0000-4000-8000-000000000043', encode(sha256(convert_to('GROKCODE2', 'UTF8')), 'hex'), now() + interval '30 days');

-- board member b4 redeems a code with their own sign-in
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select (public.redeem_claim_code('GROKCODE1')->>'ok')::boolean), true, 'a board member redeems a code');
select tests.fails($$select public.resolve_claim_request((select id from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004'), true)$$,
                   'your own sign-in', 'a board member cannot approve their own claim');
select tests.fails($$select public.resolve_claim_request((select id from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004'), false)$$,
                   'your own sign-in', 'a board member cannot reject their own claim either');
select tests.fails($$select public.resolve_task((select id from public.board_tasks where kind = 'claim_attach' and status = 'open'), 'approve')$$,
                   'your own sign-in', 'resolve_task refuses the claim_attach task for their own claim');
select tests.eq((select status from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004'), 'pending', 'the claim is still pending');
select tests.eq((select count(*) from public.board_tasks where kind = 'claim_attach' and status = 'open'), 1::bigint, 'and its task is still open');

-- another board member rejects: the code is released, the owner tries again
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select tests.eq((select status from public.resolve_claim_request((select id from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004'), false)), 'rejected', 'another board member can reject it');
reset role;
select tests.ok((select used_at is null from public.claim_codes where code_hash = encode(sha256(convert_to('GROKCODE1', 'UTF8')), 'hex')), 'rejecting releases the claim code');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select (public.redeem_claim_code('GROKCODE1')->>'ok')::boolean), true, 'the same code can be redeemed again after a rejection');
reset role;
select tests.eq((select count(*) from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004'), 2::bigint, 'a new request exists beside the rejected one');

-- the limits still count: third try ok, then the per-code cap (3 an hour) stops the fourth although the code is free
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select public.resolve_claim_request((select id from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004' and status = 'pending'), false);
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select (public.redeem_claim_code('GROKCODE1')->>'ok')::boolean), true, 'third redemption of the same code');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select public.resolve_claim_request((select id from public.claim_requests where user_id = 'b0000000-0000-4000-8000-000000000004' and status = 'pending'), false);
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.like_msg(public.redeem_claim_code('GROKCODE1')->>'message', 'Too many', 'the per-code limit still applies to a released code');
reset role;
select tests.eq((select count(*) from public.claim_attempts where user_id = 'b0000000-0000-4000-8000-000000000004'), 3::bigint, 'every earlier try stays counted (the refused fourth is not recorded)');

-- approval keeps the code used
select tests.as_user('a0000000-0000-4000-8000-0000000000c5');
select tests.eq((select (public.redeem_claim_code('GROKCODE2')->>'ok')::boolean), true, 'an owner redeems a code');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select tests.eq((select status from public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000c5'), true)), 'approved', 'another board member approves');
reset role;
select tests.ok((select used_at is not null from public.claim_codes where code_hash = encode(sha256(convert_to('GROKCODE2', 'UTF8')), 'hex')), 'approving keeps the code used');
rollback;

-- ===========================================================================
-- 3. send_message rate limit: 10 an hour, 30 a day, per sign-in
-- ===========================================================================
begin;
insert into auth.users (id, email, email_confirmed_at)
values ('a0000000-0000-4000-8000-000000000042', 'pat.example@example.com', now());
-- the seed's sample messages are dated in the future; move them out of the way so only this test's messages count
update public.messages set created_at = now() - interval '30 days';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select public.send_message('question', 'm' || g) from generate_series(1, 10) g;
select tests.fails($$select public.send_message('question', 'eleventh')$$, 'sent a lot of messages today. Please call or email the board', 'the 11th message in an hour is refused, with the friendly text');
reset role;
select tests.eq((select count(*) from public.messages where body = 'eleventh'), 0::bigint, 'and nothing was saved');
-- another owner is not affected by Pat's count
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-000000000043', 'someone.else@example.net', now());
update public.owners set user_id = 'a0000000-0000-4000-8000-000000000043' where id = '10000000-0000-4000-8000-000000000043';
select tests.as_user('a0000000-0000-4000-8000-000000000043');
select tests.eq((select body from public.send_message('question', 'neighbour is fine')), 'neighbour is fine', 'another owner can still send');
-- after the hour passes Pat can send again, until the day total reaches 30
reset role;
update public.messages set created_at = now() - interval '2 hours' where owner_id = '10000000-0000-4000-8000-000000000042' and body like 'm%';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select public.send_message('question', 'again 1');
select public.send_message('question', 'again 2');
reset role;
-- pad Pat's day to 30 (10 aged + 2 new = 12; add 18 more aged messages)
insert into public.messages (lot_id, owner_id, topic, subject, body, channel, created_at)
select '00000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000042', 'question', 'pad', 'pad', 'portal', now() - interval '3 hours'
from generate_series(1, 18);
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.fails($$select public.send_message('question', 'thirty-first')$$, 'sent a lot of messages today', 'the daily limit of 30 holds even when the hour is quiet');
reset role;
update public.messages set created_at = now() - interval '2 days' where body = 'pad';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq((select body from public.send_message('question', 'next day')), 'next day', 'old messages age out of the daily count');
rollback;

-- ===========================================================================
-- 5. invoice.voided reverses the unpaid charge
-- ===========================================================================
begin;
update public.invoices set stripe_invoice_id = 'in_42' where number = '2027-042';
update public.invoices set stripe_invoice_id = 'in_5' where number = '2027-005';
create function pg_temp.bal(p_lot int) returns text language sql as $$
  select balance_cents || '/' || processing_cents || '/' || state from public.lot_balances
   where lot_id = ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0'))::uuid $$;
create function pg_temp.void_ev(p_id text, p_sid text) returns jsonb language sql as $$
  select public.apply_stripe_event(p_id, jsonb_build_object('event_type','invoice.voided','stripe_invoice_id',p_sid,
    'invoice_status','void','reverse_invoice_charge',true,'ledger','[]'::jsonb)) $$;
grant execute on all functions in schema pg_temp to public;
set local role service_role;

select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'lot 42 owes its bill');
select pg_temp.void_ev('evt_void_42', 'in_42');
select tests.eq(pg_temp.bal(42), '0/0/paid', 'a voided bill no longer shows as owed');
select tests.eq((select count(*) from public.ledger_entries where external_ref = 'void:evt_void_42' and kind = 'credit' and amount_cents = -17500), 1::bigint, 'one credit row keyed by the void event');
select tests.eq((select status from public.invoices where number = '2027-042'), 'void', 'the invoice is void');
select pg_temp.void_ev('evt_void_42', 'in_42');
select pg_temp.void_ev('evt_void_42b', 'in_42');
select tests.eq((select count(*) from public.ledger_entries where external_ref like 'void:%' and lot_id = '00000000-0000-4000-8000-000000000042'), 1::bigint, 'replays add no second credit');

-- an already-paid invoice is not reversed (its payment row is removed first so the paid STATUS, not a zero net, is what holds)
reset role;
delete from public.ledger_entries where external_ref = 'pi_sample_005';
set local role service_role;
select tests.eq((select status from public.invoices where number = '2027-005'), 'paid', 'lot 5 invoice is paid');
select tests.eq(pg_temp.bal(5), '17500/0/unpaid', 'with an unpaid-looking charge behind it');
select pg_temp.void_ev('evt_void_5', 'in_5');
select tests.eq((select count(*) from public.ledger_entries where external_ref = 'void:evt_void_5'), 0::bigint, 'a paid invoice gets no reversal credit');
select tests.eq(pg_temp.bal(5), '17500/0/unpaid', 'and its balance is unchanged');
rollback;
