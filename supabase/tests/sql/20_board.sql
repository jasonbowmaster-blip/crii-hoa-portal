-- Board access, former members, board writes and audit.
begin;
select tests.as_user('b0000000-0000-4000-8000-000000000002');  -- vice president (not admin)
select tests.ok(public.is_board(), 'is_board() true for active member');
select tests.eq(tests.count('select 1 from public.lots'), 150::bigint, 'board reads all lots');
select tests.eq(tests.count('select 1 from public.invoices'), 150::bigint, 'board reads all invoices');
select tests.ok(tests.count('select 1 from public.ledger_entries') > 150, 'board reads all ledger rows');
select tests.eq(tests.count('select 1 from public.owners'), 150::bigint, 'board reads all owners');
select tests.eq(tests.count('select 1 from public.board_members'), 9::bigint, 'board reads board members');
select tests.eq(tests.count($$select 1 from public.documents where audience = 'board'$$), 1::bigint, 'board reads board-only document');
select tests.eq(tests.count('select 1 from public.audit_log'), 0::bigint, 'non-admin board cannot read audit log');
select tests.eq(tests.count('select 1 from public.lot_balances'), 150::bigint, 'board reads all balances');
select tests.fails('select 1 from public.claim_codes', 'permission denied', 'board cannot read claim code hashes');

-- content write by any board member, audited
insert into public.announcements (title, body, audience) values ('Test notice', 'Body', 'owners');
select tests.cannot_write($$update public.lots set status = 'on_hold' where lot_number = 5$$, 'non-admin board cannot edit roster');
select tests.cannot_write($$update public.board_members set is_admin = true$$, 'non-admin cannot make admins');
select tests.fails($$insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents) values ('00000000-0000-4000-8000-000000000005','2027-01-01','credit','x',-1)$$, 'permission denied', 'board cannot write ledger directly');
reset role;
select tests.eq((select count(*) from public.audit_log where table_name = 'announcements' and action = 'INSERT'
                  and actor_id = 'b0000000-0000-4000-8000-000000000002'), 1::bigint, 'announcement insert audited with actor');

-- admin writes audited and readable by admins
select tests.as_user('b0000000-0000-4000-8000-000000000001');  -- president, admin
update public.lots set status = 'on_hold' where lot_number = 5;
select tests.eq(tests.count($$select 1 from public.audit_log where table_name = 'lots' and action = 'UPDATE'$$), 1::bigint, 'admin sees audited roster change');
select tests.eq((select old_data->>'status' from public.audit_log where table_name='lots' order by id desc limit 1), 'active', 'audit keeps old value');

-- former board member
reset role;
update public.board_members set active = false where user_id = 'b0000000-0000-4000-8000-000000000002';
select tests.as_user('b0000000-0000-4000-8000-000000000002');
select tests.ok(not public.is_board(), 'is_board() false once inactive');
select tests.eq(tests.count('select 1 from public.board_members'), 0::bigint, 'former board member cannot read board members');
select tests.eq(tests.count('select 1 from public.checks'), 0::bigint, 'former board member cannot read checks');
select tests.eq(tests.count($$select 1 from public.documents where audience = 'board'$$), 0::bigint, 'former board member cannot read board documents');
select tests.eq(tests.count('select 1 from public.lots where lot_number <> 12'), 0::bigint, 'former board member sees only their own lot');
select tests.fails($$select public.log_check('00000000-0000-4000-8000-000000000005','9',100,'2027-01-01')$$, 'board only', 'former board member cannot log checks');
select tests.fails($$insert into public.announcements (title, body, audience) values ('x','y','public')$$, 'permission denied|row-level', 'former board member cannot post');
rollback;
