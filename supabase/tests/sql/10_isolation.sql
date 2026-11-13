-- Owners see only their own lot, record and audience-appropriate content.
begin;
-- Two owners sign in (verified emails match the roster; the link trigger attaches them).
insert into auth.users (id, email, email_confirmed_at)
select 'a0000000-0000-4000-8000-000000000042'::uuid, 'PAT.Example@Example.com', now()   -- case-insensitive match
union all
select 'a0000000-0000-4000-8000-000000000043'::uuid, email, now()
  from public.owners where id = '10000000-0000-4000-8000-000000000043';

select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-000000000042'),
                'a0000000-0000-4000-8000-000000000042'::uuid, 'Pat is linked to the owner row by verified email');

select tests.as_user('a0000000-0000-4000-8000-000000000042');

select tests.eq(tests.count('select 1 from public.lots'), 1::bigint, 'owner sees exactly one lot');
select tests.eq(tests.count($$select 1 from public.lots where lot_number = 42$$), 1::bigint, 'owner sees own lot 42');
select tests.eq(tests.count($$select 1 from public.invoices where lot_id <> '00000000-0000-4000-8000-000000000042'$$), 0::bigint, 'no other lot invoices');
select tests.eq(tests.count('select 1 from public.invoices'), 1::bigint, 'own invoice visible');
select tests.eq(tests.count($$select 1 from public.ledger_entries where lot_id <> '00000000-0000-4000-8000-000000000042'$$), 0::bigint, 'no other lot ledger rows');
select tests.ok(tests.count('select 1 from public.ledger_entries') >= 1, 'own ledger rows visible');
select tests.eq(tests.count($$select 1 from public.messages where owner_id <> '10000000-0000-4000-8000-000000000042'$$), 0::bigint, 'no other owner messages');
select tests.eq(tests.count('select 1 from public.messages'), 1::bigint, 'own message visible');
select tests.eq(tests.count('select 1 from public.owners'), 1::bigint, 'only own owner record');
select tests.eq(tests.count($$select 1 from public.owners where id = '10000000-0000-4000-8000-000000000043'$$), 0::bigint, 'neighbour owner record hidden');
select tests.eq(tests.count('select 1 from public.lot_balances'), 1::bigint, 'lot_balances is RLS-filtered for owners');
-- board-only tables
select tests.eq(tests.count('select 1 from public.checks'), 0::bigint, 'owner cannot read checks');
select tests.eq(tests.count('select 1 from public.board_tasks'), 0::bigint, 'owner cannot read board tasks');
select tests.eq(tests.count('select 1 from public.board_members'), 0::bigint, 'owner cannot read board members');
select tests.eq(tests.count('select 1 from public.reply_templates'), 0::bigint, 'owner cannot read templates');
select tests.eq(tests.count('select 1 from public.audit_log'), 0::bigint, 'owner cannot read audit log');
select tests.eq(tests.count('select 1 from public.mail_log'), 0::bigint, 'owner cannot read mail log');
select tests.fails('select 1 from public.claim_codes', 'permission denied', 'owner cannot touch claim_codes');
select tests.fails('select 1 from public.claim_attempts', 'permission denied', 'owner cannot touch claim_attempts');

-- documents by audience
select tests.eq(tests.count($$select 1 from public.documents where audience = 'board'$$), 0::bigint, 'owner cannot read board-only documents');
select tests.eq(tests.count($$select 1 from public.documents where is_draft$$), 0::bigint, 'owner cannot read draft documents');
select tests.ok(tests.count($$select 1 from public.documents where audience = 'owners'$$) > 0, 'owner reads owner documents');
select tests.eq(tests.count($$select 1 from public.announcements where audience = 'board'$$), 0::bigint, 'owner cannot read board announcements');
select tests.eq(tests.count($$select 1 from public.events where not is_public$$), 1::bigint, 'owner reads owner-only event');

-- writes
select tests.fails($$insert into public.invoices (lot_id, number, description, amount_cents, due_on) values ('00000000-0000-4000-8000-000000000042','X-1','x',1,'2027-01-01')$$, 'permission denied', 'owner cannot insert invoices');
select tests.fails($$insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents) values ('00000000-0000-4000-8000-000000000042','2027-01-01','credit','free money',-17500)$$, 'permission denied', 'owner cannot forge a ledger credit');
select tests.fails($$insert into public.board_tasks (kind, title) values ('roster_change','x')$$, 'permission denied|row-level', 'owner cannot insert board tasks');
select tests.fails($$insert into public.documents (folder,title,storage_path,audience) values ('forms','x','x','public')$$, 'permission denied|row-level', 'owner cannot insert documents');
select tests.fails($$insert into public.board_members (user_id, role, is_admin) values ('a0000000-0000-4000-8000-000000000042','president',true)$$, 'permission denied|row-level', 'owner cannot make themself board');
select tests.fails($$insert into public.messages (lot_id, owner_id, topic, subject, body) values ('00000000-0000-4000-8000-000000000043','10000000-0000-4000-8000-000000000043','question','x','x')$$, 'permission denied|row-level', 'owner cannot insert messages directly');
select tests.cannot_write($$update public.lots set status = 'on_hold' where lot_number = 43$$, 'owner cannot update another lot');
select tests.cannot_write($$update public.lots set status = 'on_hold' where lot_number = 42$$, 'owner cannot update even own lot');
select tests.cannot_write($$update public.invoices set status = 'paid'$$, 'owner cannot mark invoices paid');
select tests.cannot_write($$update public.ledger_entries set amount_cents = 0$$, 'owner cannot edit ledger');
select tests.cannot_write($$update public.owners set email = 'x@example.com', user_id = null where id = '10000000-0000-4000-8000-000000000043'$$, 'owner cannot edit another owner');
select tests.cannot_write($$update public.owners set user_id = 'a0000000-0000-4000-8000-000000000042' where id = '10000000-0000-4000-8000-000000000043'$$, 'owner cannot grab another owner row');
select tests.cannot_write($$update public.messages set status = 'closed'$$, 'owner cannot edit messages');
select tests.cannot_write($$delete from public.documents$$, 'owner cannot delete documents');

-- owner 43 sees their own thing only
select tests.as_user('a0000000-0000-4000-8000-000000000043');
select tests.eq(tests.count($$select 1 from public.owners where id = '10000000-0000-4000-8000-000000000042'$$), 0::bigint, 'owner 43 cannot read Pat');
select tests.eq(tests.count($$select 1 from public.messages where owner_id = '10000000-0000-4000-8000-000000000042'$$), 0::bigint, 'owner 43 cannot read Pat messages');

-- a signed-in user who owns nothing sees nothing
reset role;
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000ff','stranger@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000ff');
select tests.eq(tests.count('select 1 from public.lots'), 0::bigint, 'stranger sees no lots');
select tests.eq(tests.count($$select 1 from public.documents where audience = 'owners'$$), 0::bigint, 'stranger cannot read owner documents');
select tests.ok(tests.count($$select 1 from public.documents where audience = 'public'$$) > 0, 'stranger reads public documents');

-- anonymous
select tests.as_anon();
select tests.eq(tests.count($$select 1 from public.documents where audience <> 'public'$$), 0::bigint, 'anon sees only public documents');
select tests.ok(tests.count('select 1 from public.documents') > 0, 'anon sees public documents');
select tests.eq(tests.count($$select 1 from public.events where not is_public$$), 0::bigint, 'anon sees only public events');
select tests.fails('select 1 from public.invoices', 'permission denied', 'anon cannot read invoices');
select tests.fails('select 1 from public.owners', 'permission denied', 'anon cannot read owners');
select tests.fails($$select public.send_message('question','hi')$$, 'permission denied', 'anon cannot call send_message');

-- Owner whose lot_owners row has ended loses lot access
reset role;
update public.lot_owners set ends_on = current_date - 1 where owner_id = '10000000-0000-4000-8000-000000000042';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq(tests.count('select 1 from public.invoices'), 0::bigint, 'former owner (ends_on past) sees no invoices');
select tests.eq(tests.count('select 1 from public.lots'), 0::bigint, 'former owner sees no lot');
reset role;
update public.lot_owners set ends_on = current_date + 30 where owner_id = '10000000-0000-4000-8000-000000000042';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq(tests.count('select 1 from public.invoices'), 1::bigint, 'ends_on in the future keeps access');
rollback;
