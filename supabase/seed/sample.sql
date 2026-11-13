-- Obviously fake sample data. No real people, emails or addresses.
-- Deterministic ids: lot n = 00000000-0000-4000-8000-<n,12 digits>; owner n = 10000000-...; invoice n = 20000000-...
-- board member k = b0000000-0000-4000-8000-<k,12 digits>.
-- Ledger rule by lot number n: n%5=0 paid (cleared ACH); else n%7=1 processing ACH; else n%17=3 returned ACH; else unpaid.
-- n%11=0 carries 25000 cents of arrears; n%13=0 carries a 5000 cent credit.

begin;

insert into public.lots (id, lot_number, street_address, status)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, n,
       (34 + 2 * n) || ' ' || case when n <= 60 then 'Sample Lane' when n <= 90 then 'Example Court'
                                    when n <= 120 then 'Placeholder Drive' else 'Demo Circle' end,
       case when n = 99 then 'on_hold' else 'active' end
from generate_series(1, 150) n;

-- Owners: one per lot. Lots 17, 53, 71, 88, 112, 139 have no email on file.
with names as (
  select array['Pat','Sam','Alex','Jordan','Taylor','Casey','Riley','Morgan','Jamie','Robin'] as f,
         array['Example','Sample','Placeholder','Testerson','Demoson','Fakeman','Mockley','Trialby','Dummer','Specimen'] as l
)
insert into public.owners (id, full_name, first_name, email, phone, mailing_address, email_notice_consent,
                           email_notice_consent_at, board_notice_request)
select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       fn || ' ' || ln, fn,
       case when n in (17,53,71,88,112,139) then null
            else lower(fn) || '.' || lower(ln) || n || case when n % 2 = 0 then '@example.com' else '@example.org' end end,
       case when n % 3 = 0 then '555-01' || lpad(n::text, 2, '0') end,
       (34 + 2 * n) || ' ' || case when n <= 60 then 'Sample Lane' when n <= 90 then 'Example Court'
                                    when n <= 120 then 'Placeholder Drive' else 'Demo Circle' end || ', Sampleton, VA 20000',
       n % 2 = 0 and n not in (17,53,71,88,112,139),
       case when n % 2 = 0 and n not in (17,53,71,88,112,139) then timestamptz '2026-10-01 12:00+00' end,
       n % 10 = 0
from (
  select n,
         case when n = 42 then 'Pat' else (select f[(n % 10) + 1] from names) end as fn,
         case when n = 42 then 'Example' else (select l[((n / 10) % 10) + 1] from names) end as ln
  from generate_series(1, 150) n
) x;

-- Pat Example, lot 42, 118 Sample Lane. Email is example.com, no auth user yet (links on first verified sign-in).
update public.owners set email = 'pat.example@example.com', email_notice_consent = true,
       email_notice_consent_at = timestamptz '2026-10-01 12:00+00'
 where id = '10000000-0000-4000-8000-000000000042';

insert into public.lot_owners (lot_id, owner_id, starts_on)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, date '2020-01-01'
from generate_series(1, 150) n;

-- Nine board members, each also an owner. Auth users are created here only for the seed;
-- the sign-in link trigger attaches them to their owner rows.
create temp table board_seed (k int, lot int, role text, is_admin boolean) on commit drop;
insert into board_seed values
  (1, 3,'president',true), (2,12,'vice_president',false), (3,25,'treasurer',true), (4,33,'secretary',false),
  (5,57,'director',false), (6,64,'director',false), (7,80,'director',false), (8,101,'arb_chair',false),
  (9,120,'director',false);

insert into auth.users (id, email, email_confirmed_at)
select ('b0000000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid, o.email, now()
from board_seed b join public.owners o on o.id = ('10000000-0000-4000-8000-' || lpad(b.lot::text, 12, '0'))::uuid;

insert into public.board_members (user_id, owner_id, role, is_admin, term_ends_on, active)
select ('b0000000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(lot::text, 12, '0'))::uuid, role, is_admin, date '2027-12-31', true
from board_seed;

-- 2027 invoices
insert into public.invoices (id, lot_id, number, description, amount_cents, issued_on, due_on, status, paid_on)
select ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '2027-' || lpad(n::text, 3, '0'), '2027 annual assessment', 17500, date '2027-01-29', date '2027-05-15',
       case when n % 5 = 0 then 'paid' when n % 7 = 1 then 'processing' else 'open' end,
       case when n % 5 = 0 then date '2027-02-10' end
from generate_series(1, 150) n;

-- Ledger: charge for everyone, then carried amounts and payments per the rule in the header
insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, invoice_id, external_ref)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, date '2027-01-29', 'charge', '2027 annual assessment',
       'Invoice 2027-' || lpad(n::text, 3, '0') || ', due May 15', 17500, 'cleared', null,
       ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'inv:2027-' || lpad(n::text, 3, '0')
from generate_series(1, 150) n;

insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, external_ref)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, date '2027-01-01', 'opening_balance',
       case when n % 11 = 0 then 'Balance carried from 2026' else 'Credit carried from 2026' end,
       'Checked by the treasurer', case when n % 11 = 0 then 25000 else -5000 end, 'cleared', 'open:2027-' || lpad(n::text, 3, '0')
from generate_series(1, 150) n where n % 11 = 0 or n % 13 = 0;

insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, invoice_id, external_ref)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       case when n % 5 = 0 then date '2027-02-10' else date '2027-03-02' end,
       'payment', 'Payment by bank',
       case when n % 5 = 0 then 'Ending 6789' when n % 7 = 1 then 'Bank payment clearing' else 'Bank payment returned' end,
       -17500,
       case when n % 5 = 0 then 'cleared' when n % 7 = 1 then 'processing' else 'returned' end,
       'ach', ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'pi_sample_' || lpad(n::text, 3, '0')
from generate_series(1, 150) n
where n % 5 = 0 or n % 7 = 1 or (n % 17 = 3);

-- Messages
insert into public.messages (id, lot_id, owner_id, topic, subject, body, status, created_at, answered_at, due_at, channel) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000042','10000000-0000-4000-8000-000000000042',
  'question','When is the next board meeting?','When is the next board meeting? I would like to attend.','answered',
  timestamptz '2027-02-03 14:05+00', timestamptz '2027-02-04 15:00+00', null, 'portal'),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000043','10000000-0000-4000-8000-000000000043',
  'billing','Is my bank payment still processing?','I paid by bank two days ago. Is it still processing?','new',
  timestamptz '2027-03-04 09:30+00', null, null, 'portal'),
 ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000010',
  'records','Request for budget and minutes','Please send me the 2027 budget and last year''s minutes.','new',
  timestamptz '2027-03-08 10:00+00', null, timestamptz '2027-03-22 10:00+00', 'portal'),
 ('30000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000077','10000000-0000-4000-8000-000000000077',
  'maintenance','Light out at the entrance','The light at the Sample Lane entrance is out.','acknowledged',
  timestamptz '2027-03-09 18:45+00', null, null, 'portal');

insert into public.board_tasks (kind, lot_id, title, summary, ref_id, due_at) values
 ('records_request','00000000-0000-4000-8000-000000000010','Records request','Request for budget and minutes',
  '30000000-0000-4000-8000-000000000003', timestamptz '2027-03-22 10:00+00'),
 ('template_reply','00000000-0000-4000-8000-000000000043','Answer with a template','Bank payment status question',
  '30000000-0000-4000-8000-000000000002', null);

-- One check waiting for a second person (logged by the treasurer, board member 3)
insert into public.checks (id, lot_id, check_number, amount_cents, received_on, logged_by, state) values
 ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021','1042',17500,date '2027-03-10',
  'b0000000-0000-4000-8000-000000000003','received');
insert into public.board_tasks (kind, lot_id, title, summary, ref_id) values
 ('check_confirm','00000000-0000-4000-8000-000000000021','Confirm check deposit',
  'Check 1042 was logged. A second board member confirms it is on the deposit.','40000000-0000-4000-8000-000000000001');

-- Documents: all six folders; one board-only; one draft
insert into public.documents (folder, title, storage_path, audience, posted_on, is_draft) values
 ('governing','Declaration of covenants (sample)','sample/governing/declaration.pdf','owners',date '2020-01-15',false),
 ('governing','Bylaws (sample)','sample/governing/bylaws.pdf','public',date '2020-01-15',false),
 ('rules_arb','ARB guidelines (sample)','sample/rules/arb-guidelines.pdf','owners',date '2024-06-01',false),
 ('minutes','Board minutes, January 2027 (sample)','sample/minutes/2027-01.pdf','owners',date '2027-02-20',false),
 ('minutes','Board minutes, February 2027 (draft)','sample/minutes/2027-02-draft.pdf','owners',date '2027-03-15',true),
 ('board_packets','Board packet, March 2027 (board only)','sample/packets/2027-03.pdf','board',date '2027-03-10',false),
 ('budgets','2027 budget (sample)','sample/budgets/2027-budget.pdf','owners',date '2026-12-15',false),
 ('forms','ARB request form (sample)','sample/forms/arb-request.pdf','public',date '2024-06-01',false);

insert into public.events (title, kind, starts_at, location, video_url, notes, is_public) values
 ('Board meeting','board_meeting',timestamptz '2027-01-19 19:00-05','Sample [Meeting place], 1 Example Way',null,'Open to all owners.',true),
 ('Annual meeting','annual_meeting',timestamptz '2027-04-20 19:00-04','Sample [Meeting place], 1 Example Way','https://example.com/video/annual','Election of directors.',true),
 ('Tree work on Sample Lane','tree_work',timestamptz '2027-03-25 08:00-04','Sample Lane',null,null,false),
 ('Assessments due','dues_date',timestamptz '2027-05-15 12:00-04',null,null,'2027 assessment is due.',true);

insert into public.announcements (title, body, posted_at, audience) values
 ('2027 bills are out','Bills went out by email and paper. The due date is May 15.',timestamptz '2027-01-29 12:00+00','owners'),
 ('Annual meeting notice','The annual meeting is April 20 at the clubhouse.',timestamptz '2027-03-20 12:00+00','public'),
 ('Board work session','The board meets privately to prepare the budget.',timestamptz '2027-03-01 12:00+00','board');

insert into public.reply_templates (name, body, version, approved_on) values
 ('Payment is processing','Thank you. A bank payment can take a few business days to clear. Your bill will show Paid when it does.',1,date '2026-11-01'),
 ('Where are the documents','Governing documents, minutes and forms are in the Documents section of the portal.',1,date '2026-11-01'),
 ('Meeting schedule','Board meetings are listed under Events in the portal. Owners are welcome to attend.',1,date '2026-11-01'),
 ('Message received','Thank you for writing. The board has your message and will reply within two business days.',1,date '2026-11-01');

insert into public.holidays (day, name) values (date '2027-05-31', 'Memorial Day'), (date '2027-07-05', 'Independence Day observed');

-- Claim code for lot 42, for demos: SAMPLE-CODE-0042 (stored only as a hash, valid 90 days from seeding)
insert into public.claim_codes (lot_id, code_hash, expires_at) values
 ('00000000-0000-4000-8000-000000000042',
  encode(sha256(convert_to('SAMPLECODE0042', 'UTF8')), 'hex'), now() + interval '90 days');

commit;
