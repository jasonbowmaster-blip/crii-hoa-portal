begin;
insert into auth.users (id, email, email_confirmed_at)
values ('a0000000-0000-4000-8000-000000000042', 'pat.example@example.com', now());
select tests.as_user('a0000000-0000-4000-8000-000000000042');

-- send_message sets lot and owner from auth.uid(); no way to name another lot
create temp table m on commit drop as select * from public.send_message('question', 'Hello board, a question.');
reset role;
select tests.eq((select lot_id from m), '00000000-0000-4000-8000-000000000042'::uuid, 'message lot comes from the session');
select tests.eq((select owner_id from m), '10000000-0000-4000-8000-000000000042'::uuid, 'message owner comes from the session');
select tests.ok((select due_at is null and status = 'new' and channel = 'portal' from m), 'plain question has no due date');

select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.fails($$select public.send_message('question','x', '00000000-0000-4000-8000-000000000043')$$, 'not a current owner', 'send_message refuses a lot the caller does not own');
select tests.fails($$insert into public.messages (lot_id, owner_id, topic, subject, body) values ('00000000-0000-4000-8000-000000000043','10000000-0000-4000-8000-000000000043','billing','forged','x')$$, 'permission denied|row-level', 'forged lot_id insert refused');
select tests.fails($$select public.send_message('bogus','x')$$, 'unknown topic', 'bad topic refused');
select tests.fails($$select public.send_message('question','   ')$$, '1 to 5000', 'empty body refused');

-- records request: 10 business days
create temp table r on commit drop as select * from public.send_message('records', 'Please send the budget.');
reset role;
select tests.ok((select due_at = public.add_business_days(created_at, 10) from r), 'records due_at is 10 business days out');
select tests.ok((select extract(isodow from due_at at time zone 'UTC') < 6 from r), 'due date is a weekday');
select tests.eq((select add_business_days from (select public.add_business_days(timestamptz '2027-03-05 10:00+00', 10) add_business_days) x),
                timestamptz '2027-03-19 10:00+00', 'friday + 10 business days = two fridays later');
select tests.eq((select count(*) from public.board_tasks where kind='records_request' and ref_id = (select id from r)), 1::bigint, 'records request opens a board task');

-- someone who owns nothing cannot send
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000ff','stranger@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000ff');
select tests.fails($$select public.send_message('question','hi')$$, 'no owner record', 'non-owner cannot send messages');

-- notice prefs
select tests.as_user('a0000000-0000-4000-8000-000000000042');
create temp table p1 on commit drop as select * from public.update_notice_prefs(false, true);
select tests.ok((select not email_notice_consent and email_notice_consent_at is null and board_notice_request from p1), 'consent off clears the timestamp');
create temp table p2 on commit drop as select * from public.update_notice_prefs(true, true);
select tests.ok((select email_notice_consent and email_notice_consent_at is not null from p2), 'consent on stamps the time');
rollback;
