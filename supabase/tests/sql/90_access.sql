-- Access hardening: default privileges, board task writes, consent history, audit of owner writes,
-- roster-link notification, shared household sign-in, claim-code limits, draft documents, storage policies.
begin;

-- ---- default privileges: objects created later are closed to anon/authenticated ----
create table public.zz_future (x int);
create function public.zz_future_fn() returns int language sql as 'select 1';
select tests.ok(not has_table_privilege('anon', 'public.zz_future', 'select'), 'new table is closed to anon');
select tests.ok(not has_table_privilege('authenticated', 'public.zz_future', 'select'), 'new table is closed to authenticated');
select tests.ok(not has_function_privilege('anon', 'public.zz_future_fn()', 'execute'), 'new function is not executable by anon');
select tests.ok(not has_function_privilege('authenticated', 'public.zz_future_fn()', 'execute'), 'new function is not executable by authenticated');
select tests.ok(has_table_privilege('service_role', 'public.zz_future', 'select'), 'service role still reaches new tables');
-- everything that exists: anon only has the three public-content tables and the policy helpers
select tests.eq((select count(*) from information_schema.role_table_grants
                  where grantee = 'anon' and table_schema = 'public' and table_name not in ('documents','announcements','events','zz_future')),
                0::bigint, 'anon holds no grant on any other table');
select tests.eq((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname <> 'zz_future_fn' and has_function_privilege('anon', p.oid, 'execute')),
                array['is_board','is_board_admin','is_owner','my_lot_ids','my_owner_ids']::text[], 'anon can execute only the policy helpers');
select tests.ok(not has_function_privilege('authenticated', 'public.add_business_days(timestamptz, integer)', 'execute'), 'add_business_days is not callable by users');

-- ---- shared household email: one sign-in links to two owner records and two lots ----
update public.owners set email = 'shared.household@example.net' where id in ('10000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000045');
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000f2', 'Shared.Household@example.net', now());
select tests.eq((select count(*) from public.owners where user_id = 'a0000000-0000-4000-8000-0000000000f2'), 2::bigint, 'one sign-in links both owner records');
select tests.eq((select count(*) from public.board_tasks where kind = 'roster_change' and ref_id in ('10000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000045')),
                2::bigint, 'linking by roster email opens a board task per owner record');
select tests.like_msg((select summary from public.board_tasks where kind = 'roster_change' and ref_id = '10000000-0000-4000-8000-000000000044'), 'Lot 44', 'the task names the lot');
update auth.users set last_sign_in_at = now() where id = 'a0000000-0000-4000-8000-0000000000f2';
select tests.eq((select count(*) from public.board_tasks where kind = 'roster_change' and ref_id in ('10000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000045')),
                2::bigint, 'a repeat sign-in opens no new task');
select tests.as_user('a0000000-0000-4000-8000-0000000000f2');
select tests.eq(tests.count('select 1 from public.lots'), 2::bigint, 'the shared sign-in sees both lots');
select tests.eq(tests.count('select 1 from public.owners'), 2::bigint, 'the shared sign-in sees both owner records');
select tests.eq((select lot_id from public.send_message('question', 'Hello from a shared household')), '00000000-0000-4000-8000-000000000044'::uuid, 'send_message picks one lot without erroring');
reset role;

-- ---- consent history and owner-write audit (owner 42 links by roster email) ----
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000f1', 'pat.example@example.com', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000f1');
select public.update_notice_prefs(true, true);     -- board notice request turns on
select public.update_notice_prefs(false, true);    -- consent withdrawn
select tests.ok((select email_notice_consent_at is null from public.owners where user_id = 'a0000000-0000-4000-8000-0000000000f1'), 'withdrawing consent clears the current date');
select tests.eq(tests.count('select 1 from public.notice_consents'), 2::bigint, 'each change is kept in the consent history');
select tests.eq((select count(*) from public.notice_consents where not email_notice_consent), 1::bigint, 'the withdrawal is in the history');
select public.update_notice_prefs(false, true);    -- no change
select tests.eq(tests.count('select 1 from public.notice_consents'), 2::bigint, 'an unchanged save adds no history row');
select tests.fails($$update public.notice_consents set email_notice_consent = true$$, 'permission denied', 'owner cannot edit consent history');
select tests.fails($$insert into public.notice_consents (owner_id, email_notice_consent, board_notice_request) values (gen_random_uuid(), true, true)$$, 'permission denied', 'owner cannot write consent history directly');
reset role;
select tests.fails($$delete from public.notice_consents$$, 'append-only', 'even a privileged role cannot delete consent history');
select tests.fails($$update public.notice_consents set email_notice_consent = true$$, 'append-only', 'even a privileged role cannot rewrite consent history');
select tests.ok(exists (select 1 from public.audit_log where table_name = 'owners' and action = 'UPDATE' and actor_id = 'a0000000-0000-4000-8000-0000000000f1'), 'owner self-service write is audited with the owner as actor');
select tests.as_user('a0000000-0000-4000-8000-000000000043');   -- an unrelated signed-in user
select tests.eq(tests.count('select 1 from public.notice_consents'), 0::bigint, 'other owners cannot read this history');
reset role;

-- ---- board tasks cannot be written directly ----
select tests.as_user('b0000000-0000-4000-8000-000000000004');   -- secretary
select tests.fails($$update public.board_tasks set status = 'done' where kind = 'check_confirm'$$, 'permission denied', 'board cannot close a check task by hand');
select tests.fails($$update public.board_tasks set status = 'done' where kind = 'claim_attach'$$, 'permission denied', 'board cannot close a claim task by hand');
select tests.fails($$insert into public.board_tasks (kind, title) values ('roster_change', 'x')$$, 'permission denied', 'board cannot insert tasks by hand');
select tests.eq((select count(*) from public.board_tasks where kind = 'check_confirm' and status = 'open'), 1::bigint, 'the check task is still open');
reset role;

-- ---- claim codes: per code and global limits, wording ----
insert into auth.users (id, email, email_confirmed_at)
select ('a0000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'guess' || g || '@example.net', now() from generate_series(1, 6) g;
insert into public.claim_codes (lot_id, code_hash, expires_at) values
  ('00000000-0000-4000-8000-000000000050', encode(sha256(convert_to('REALCODE5050','UTF8')),'hex'), now() + interval '30 days');
select tests.as_user('a0000000-0000-4000-8000-000000000101');
select public.redeem_claim_code('SHAREDGUESS1');
select tests.as_user('a0000000-0000-4000-8000-000000000102');
select public.redeem_claim_code('SHAREDGUESS1');
select tests.as_user('a0000000-0000-4000-8000-000000000103');
select public.redeem_claim_code('SHAREDGUESS1');
select tests.as_user('a0000000-0000-4000-8000-000000000104');
select tests.like_msg(public.redeem_claim_code('SHAREDGUESS1')->>'message', 'right now', 'a fourth account guessing the same code is refused');
select tests.like_msg(public.redeem_claim_code('SHARED-GUESS-1')->>'message', 'right now', 'dashes and case do not dodge the per-code limit');
select tests.eq((public.redeem_claim_code('OTHERGUESS2')->>'ok')::boolean, false, 'a different guess is still answered normally');
reset role;
-- global cap: a flood of tries from many accounts stops everyone for the hour
insert into public.claim_attempts (user_id, code_hash) select gen_random_uuid(), md5(g::text) from generate_series(1, 100) g;
select tests.as_user('a0000000-0000-4000-8000-000000000105');
select tests.like_msg(public.redeem_claim_code('REALCODE5050')->>'message', 'right now', 'global hourly cap stops even a correct code');
reset role;
select tests.ok((select used_at is null from public.claim_codes where lot_id = '00000000-0000-4000-8000-000000000050'), 'capped code stays unused');
delete from public.claim_attempts;
select tests.as_user('a0000000-0000-4000-8000-000000000105');
select tests.eq((public.redeem_claim_code('REALCODE5050')->>'ok')::boolean, true, 'code works once the cap clears');
reset role;
select tests.like_msg((select summary from public.board_tasks where kind = 'claim_attach' and lot_id = '00000000-0000-4000-8000-000000000050'), 'county land records', 'claim task asks the board to verify against county land records');
select tests.ok((select summary not like '%matches the owner on file%' from public.board_tasks where kind = 'claim_attach' and lot_id = '00000000-0000-4000-8000-000000000050'), 'claim task no longer says to match the owner on file');

-- ---- draft documents: owners see them, only audience = board hides ----
insert into auth.users (id, email, email_confirmed_at) select 'a0000000-0000-4000-8000-0000000000f3', email, now() from public.owners where id = '10000000-0000-4000-8000-000000000043';
select tests.as_user('a0000000-0000-4000-8000-0000000000f3');
select tests.eq(tests.count($$select 1 from public.documents where is_draft and audience = 'owners'$$), 1::bigint, 'owner sees the draft minutes');
select tests.eq(tests.count($$select 1 from public.documents where audience = 'board'$$), 0::bigint, 'owner still does not see board-only documents');
reset role;
insert into public.documents (folder, title, storage_path, audience, is_draft) values ('minutes', 'Draft board-only notes', 'sample/minutes/board-draft.pdf', 'board', true);
select tests.as_user('a0000000-0000-4000-8000-0000000000f3');
select tests.eq(tests.count($$select 1 from public.documents where title = 'Draft board-only notes'$$), 0::bigint, 'a board-only draft stays hidden');
reset role;

-- ---- storage policies on the private documents bucket ----
insert into storage.objects (bucket_id, name)
select 'documents', storage_path from public.documents;
insert into storage.objects (bucket_id, name) values ('documents', 'sample/orphan.pdf'), ('backups', 'sample/governing/declaration.pdf');
select tests.as_user('a0000000-0000-4000-8000-0000000000f3');   -- owner of lot 43
select tests.eq(tests.count($$select 1 from storage.objects where bucket_id = 'documents'$$),
                (select count(*) from public.documents where audience <> 'board'), 'owner can read exactly the files of documents they can see');
select tests.eq(tests.count($$select 1 from storage.objects where name like 'sample/packets/%'$$), 0::bigint, 'owner cannot read board packets');
select tests.eq(tests.count($$select 1 from storage.objects where name = 'sample/orphan.pdf'$$), 0::bigint, 'owner cannot read a file with no document row');
select tests.eq(tests.count($$select 1 from storage.objects where bucket_id = 'backups'$$), 0::bigint, 'owner cannot read the backups bucket');
select tests.fails($$insert into storage.objects (bucket_id, name) values ('documents', 'sample/owner-upload.pdf')$$, 'row-level security', 'owner cannot upload');
select tests.cannot_write($$delete from storage.objects where bucket_id = 'documents'$$, 'owner cannot delete files');
select tests.as_anon();
select tests.eq(tests.count($$select 1 from storage.objects where bucket_id = 'documents'$$),
                (select count(*) from public.documents where audience = 'public'), 'anon reads only public document files');
reset role;
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq(tests.count($$select 1 from storage.objects where bucket_id = 'documents'$$),
                (select count(*) from storage.objects where bucket_id = 'documents'), 'board reads every file in the documents bucket');
select tests.eq(tests.count($$select 1 from storage.objects where bucket_id = 'backups'$$), 0::bigint, 'board cannot read the backups bucket');
insert into storage.objects (bucket_id, name) values ('documents', 'sample/board-upload.pdf');
select tests.ok(true, 'board can upload');
select tests.fails($$insert into storage.objects (bucket_id, name) values ('backups', 'x.json')$$, 'row-level security', 'board cannot write the backups bucket');
reset role;
rollback;
