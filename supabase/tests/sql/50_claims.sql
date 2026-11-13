begin;
insert into auth.users (id, email, email_confirmed_at) values
  ('a0000000-0000-4000-8000-0000000000e1', 'new.owner@example.net', now()),
  ('a0000000-0000-4000-8000-0000000000e2', 'unverified@example.net', null);

-- success: single use, makes a request + task, attaches nothing
select tests.as_user('a0000000-0000-4000-8000-0000000000e1');
select tests.eq((select (public.redeem_claim_code('sample-code-0042')->>'ok')::boolean), true, 'valid code (any case/dashes) accepted');
reset role;
select tests.eq((select count(*) from public.claim_requests where lot_id = '00000000-0000-4000-8000-000000000042' and status='pending' and user_id = 'a0000000-0000-4000-8000-0000000000e1'), 1::bigint, 'creates a pending claim request');
select tests.eq((select count(*) from public.board_tasks where kind = 'claim_attach' and status='open'), 1::bigint, 'creates a claim_attach task');
select tests.eq((select count(*) from public.lot_owners where owner_id in (select id from public.owners where user_id = 'a0000000-0000-4000-8000-0000000000e1')), 0::bigint, 'does not attach directly');
select tests.ok((select used_at is not null from public.claim_codes limit 1), 'code marked used');

-- reuse refused (even by another user)
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000e3', 'other@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000e3');
select tests.eq((select (public.redeem_claim_code('SAMPLE-CODE-0042')->>'ok')::boolean), false, 'used code cannot be redeemed again');

-- expiry
reset role;
insert into public.claim_codes (lot_id, code_hash, expires_at) values
  ('00000000-0000-4000-8000-000000000043', encode(sha256(convert_to('EXPIREDCODE12','UTF8')),'hex'), now() - interval '1 day');
select tests.as_user('a0000000-0000-4000-8000-0000000000e3');
select tests.eq((select (public.redeem_claim_code('EXPIRED-CODE12')->>'ok')::boolean), false, 'expired code refused');

-- unverified email refused
reset role;
insert into public.claim_codes (lot_id, code_hash, expires_at) values
  ('00000000-0000-4000-8000-000000000044', encode(sha256(convert_to('FRESHCODE1234','UTF8')),'hex'), now() + interval '30 days');
select tests.as_user('a0000000-0000-4000-8000-0000000000e2');
select tests.eq((select (public.redeem_claim_code('FRESHCODE1234')->>'ok')::boolean), false, 'unverified email cannot redeem');

-- rate limit: 5 tries an hour per user; the 6th is refused even with a correct code
reset role;
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000e4', 'guesser@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000e4');
select public.redeem_claim_code('WRONG' || g) from generate_series(1, 5) g;
select tests.like_msg((public.redeem_claim_code('FRESH-CODE-1234')->>'message'), 'Too many', 'sixth try refused with the right code') ;
reset role;
select tests.eq((select count(*) from public.claim_attempts where user_id = 'a0000000-0000-4000-8000-0000000000e4'), 5::bigint, 'only five tries recorded');
select tests.ok((select used_at is null from public.claim_codes where lot_id = '00000000-0000-4000-8000-000000000044'), 'rate-limited code stays unused');
-- limit is per hour: old attempts age out
update public.claim_attempts set attempted_at = now() - interval '2 hours' where user_id = 'a0000000-0000-4000-8000-0000000000e4';
select tests.as_user('a0000000-0000-4000-8000-0000000000e4');
select tests.eq((select (public.redeem_claim_code('FRESH-CODE-1234')->>'ok')::boolean), true, 'works again after the hour');

-- board approves the first claim: creates an owner linked to the lot
select tests.as_user('b0000000-0000-4000-8000-000000000001');
create temp table rc on commit drop as
  select * from public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e1'), true);
select tests.eq((select status from rc), 'approved', 'board approves claim');
reset role;
select tests.ok(exists (select 1 from public.lot_owners lo join public.owners o on o.id = lo.owner_id
                         where o.user_id = 'a0000000-0000-4000-8000-0000000000e1' and lo.lot_id = '00000000-0000-4000-8000-000000000042'), 'approval attaches the user to the lot');
select tests.as_user('a0000000-0000-4000-8000-0000000000e1');
select tests.eq(tests.count('select 1 from public.invoices'), 1::bigint, 'approved claimant can now read the lot invoice');
select tests.fails($$select public.resolve_claim_request(gen_random_uuid(), true)$$, 'board only', 'claimant cannot approve claims');
rollback;
