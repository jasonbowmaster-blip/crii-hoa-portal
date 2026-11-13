begin;
-- unverified email: not linked
insert into auth.users (id, email, email_confirmed_at)
select 'a0000000-0000-4000-8000-0000000000d1', email, null from public.owners where id = '10000000-0000-4000-8000-000000000044';
select tests.ok((select user_id is null from public.owners where id = '10000000-0000-4000-8000-000000000044'), 'unverified email is not linked');
-- verifying it links (case-insensitive)
update auth.users set email = upper(email), email_confirmed_at = now() where id = 'a0000000-0000-4000-8000-0000000000d1';
select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-000000000044'), 'a0000000-0000-4000-8000-0000000000d1'::uuid, 'verifying the email links the owner');
-- a different verified user with the same roster email cannot take over a linked row
insert into auth.users (id, email, email_confirmed_at)
select 'a0000000-0000-4000-8000-0000000000d2', email, now() from public.owners where id = '10000000-0000-4000-8000-000000000044';
select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-000000000044'), 'a0000000-0000-4000-8000-0000000000d1'::uuid, 'already linked row is not stolen');
-- owner with no email on file (lot 17) is never linked by a blank email
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000d3', null, now());
select tests.ok((select user_id is null from public.owners where id = '10000000-0000-4000-8000-000000000017'), 'no-email owner not linked');
-- rpc path
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000d4', 'x@example.net', null);
select tests.as_user('a0000000-0000-4000-8000-0000000000d4');
select tests.eq(public.link_owner_on_sign_in(), 0, 'rpc links nothing for an unmatched account');
select tests.fails($$select public.link_owner_for('a0000000-0000-4000-8000-0000000000d4','x','2027-01-01','2027-01-01')$$, 'permission denied', 'link_owner_for is not callable by users');
rollback;
