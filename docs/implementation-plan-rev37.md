
# HOA portal implementation plan
 · 
## Summary
The HOA builds and owns a simple phone-first portal and a permanent front door (web address, email, phone number and post office box), and plugs specialist services in behind it for payments, books, mail and the assistant. Its software runs about $165 to $445 a year, 55 to 83% below TownSq Pro's ~$970, and about $1,000 to $1,300 all-in with mail, the PO box and payment fees. The main reason to build is stability, not price: it ends the cycle of five portals in five years: owners learn one address and one sign-in, and vendors can change behind it without owners noticing.
What owners get: sign in with Google or an emailed link, already set up for their lot; see what they owe and pay; find documents and meetings; message the board from one place.
What the board gets: one HOA inbox with board-approved reply templates, a fixed acknowledgment and topic labels (an AI drafting assistant is decided in May from real volume); admin screens to post, upload and mail; books that fill themselves from the bank.
Recommended services: Supabase and Netlify (portal), Stripe (bills and payments), QuickBooks Free or Zoho Books Standard (books with an automatic bank feed; the HOA's accountant decides), Lob (paper mail), Resend (sign-in email), no assistant purchase before May, the communal Google account the HOA already has (Gmail, Calendar, Drive), ideally upgraded to one Google Workspace seat, and Google Voice as voicemail to the inbox (phone).
Timeline: board approval Nov 19, budget letter Dec 15, 2027 bills out by Feb 26 from Stripe and paper whether or not the portal is ready, with a due date pushed back without penalty; the portal launches when it passes its pilot, February or March.
Effort: about 150 to 250 volunteer hours to set up the smaller launch scope, then 40 to 80 hours a year (estimates, raised after the review).
Guardrails: the portal never holds card or bank details or a ledger; nothing about money, enforcement, ARB decisions or legal matters goes out without a board member's approval; paper notices stay until each owner opts into email.
Companion documents: the scope and options analysis and the clickable phone mock-ups.
Decisions for the Nov 19 board meeting: approve the plan and services; name a second admin; set the 2027 due date with no penalty; adopt guidelines for electronic notice and the email opt-in form; approve the reply templates (no automatic AI replies at launch); get a fidelity bond quote; refer the open legal questions to the attorney (full list in the last sections).
## What the four-way review changed
Claude, Codex and Gemini reviewed revision 11 independently on Nov 13; Grok's run failed (details in the review log). They agreed on the plan's shape, an HOA-owned front door with replaceable services behind it, and found money, legal and cost gaps that are fixed below. No reviewer recommended switching to a hosted portal, so portal trials are not needed now.
Do these before the Nov 19 vote; they don't depend on it:
Request the full PayHOA export now: owner ledger and balances, payment history, documents, roster and email consents. PayHOA deletes data 30 days after closure.
File the DPOR/CICB change within 30 days of the manager's termination.
Ask John Marshall Bank for its Eagle Financial conversion date. A routing-number or feed change in February would hit bills and the books.
Ask the HOA's accountant which ledger they work in. That choice sets the books pick and the cost.
Get a fidelity bond quote (Va. Code §55.1-1827, at least $10,000).
Main changes in this revision:
Money controls: opening balances from PayHOA, a per-lot ledger view, a monthly Stripe payout runbook, ACH Processing and return states, and two-person check handling (flow 2).
Books: QuickBooks Free allows one user, no accountant and one bank feed. The board now picks between it and Zoho Books Standard after asking the accountant.
Virginia fixes: board-meeting notice is posted plus mailed only to owners who ask. Late fees only after 60 days, capped at 5%. Resale falls under the Resale Disclosure Act. Added the fidelity bond, the reserve study and pesticide signs.
Assistant: no purchase and no automatic AI replies at launch. Templates, a fixed acknowledgment and labels; decide on drafts-only AI in May.
Identity: one Workspace seat or two hardware keys, named admins where vendors allow, real "send as" for board@, Google Voice as voicemail only.
Scope and dates: bills no longer wait for the portal; the launch scope is smaller; effort and cost restated honestly.
## Requirements
The needs are basic and the budget is low; the hard requirement is stability for owners after years of vendor churn.
The association. 150 homes in Virginia under the Property Owners' Association Act (Va. Code 55.1, Chapter 18); 9-member volunteer board; dues under $200 a year, billed once; no amenities, so spending is mostly grass and trees; self-managed after firing the management company; bank account at John Marshall Bank; email on file for about 144 of 150 homes; owner engagement is low and expected to stay low.
 | 
# | 
Requirement | 
Where it is met
 | 
R1 | 
Schedule one annual meeting and track board meetings every other month | 
Calendar and notices flow
 | 
R2 | 
Send paper and email bills | 
Billing flow: Stripe invoices, Lob for paper
 | 
R3 | 
Receive payments by bank, card and check | 
Stripe hosted payment page; checks to the PO box
 | 
R4 | 
Keep the books for every account, including tree service and small expenses | 
QuickBooks Free with an automatic bank feed
 | 
R5 | 
A clear, simple, intuitive one-stop shop that works well on a phone | 
The portal, installable to the home screen
 | 
R6 | 
Direct communication between owners and the board | 
Message the board form, HOA email and phone, all into one inbox
 | 
R7 | 
A full-featured assistant, behind the scenes, as receptionist and front door | 
Lindy on the communal Gmail, rules in the assistant section
 | 
R8 | 
Owners sign in with Google, or another easy way, with nothing to activate | 
Pre-registered accounts, Google or emailed link
 | 
R9 | 
The HOA owns the portal, the data and the contact points | 
HOA-owned domain, code, accounts and exports
 | 
R10 | 
Vendors can change behind the front door without owners noticing | 
Specialists sit behind the portal; no vendor address ever printed
 | 
R11 | 
Running cost 75 to 80% below hosted portals | 
Lean tier, about $185 a year
 | 
R12 | 
Minimal overhead for the board | 
Pre-registration, automatic bank feed, assistant triage
 | 
R13 | 
Meet Virginia records, notice and voting rules | 
Compliance section
 | 
R14 | 
Easy handoff if the president leaves | 
Handoff section
Constraints. Never build accounting, collections or an assistant that decides money, enforcement or legal matters on its own. No public deploys or account creation before the board approves. Bills by Jan 29, Feb 26 at the latest, with the due date pushed back without penalty. Keep this work separate from Jason's other projects so it can be handed off.
## Architecture
Two layers: what the HOA owns, which owners see and which never changes, and the specialists behind it, which the board can replace at any time.
Every owner contact, whether the portal form, email, phone or paper, lands in the communal Gmail inbox, where the assistant and the board work. The portal is a progressive web app on Netlify with its data in Supabase; small server functions on Supabase talk to Stripe, Lob and the inbox. QuickBooks Free reads the bank on its own, and Stripe payouts arrive there as deposits. No vendor's address, number or link is ever printed on anything owners receive.
## Service selections
Each job has one pick for launch and named alternates we can switch to without owners noticing, because owners only ever see the HOA domain, email, phone and PO box. Prices are list prices checked in November 2026 and should be re-checked the week before any account is opened.
 | 
Job | 
Pick for launch | 
Why this one | 
Alternates | 
Yearly cost
 | 
Portal hosting (web app) | 
Netlify, free plan, in a new account owned by the HOA | 
Free for our traffic, automatic HTTPS on our domain, simple deploys from a code repository | 
Cloudflare Pages (simplest if the domain is at Cloudflare), Vercel | 
$0
 | 
Database, sign-in, files | 
Supabase: free plan, Pro during billing season (about Jan to Jun) | 
Postgres, Google and email-link sign-in, row-level security, file storage and server functions in one place; plain Postgres exports. The free plan pauses after a quiet week and has no automatic backups, so pay for Pro while bills are out | 
Supabase Pro all year ($300); Firebase | 
~$150
 | 
Bills and payments | 
Stripe Invoicing | 
Hosted invoice pages with ACH and card, automatic reminders, "paid outside Stripe" for checks, webhooks into the portal. ACH 0.8% capped at $5; cards 2.9% + 30¢; invoicing 0.4% per paid invoice. Stripe needs a named board member as account representative, with a successor | 
Stripe Checkout (saves the 0.4%, about $100 a year, but we would build reminders ourselves; revisit in May); QuickBooks Payments | 
Fees only, about $2.10 per ACH payment on a $175 bill
 | 
Books (ledger) | 
The HOA accountant's choice of QuickBooks Online Free or Zoho Books Standard | 
QuickBooks Free: 1 user, no accountant access, one bank connection, no integrations, so only the treasurer works in it. Zoho Books Standard: bank feeds and an accountant seat (its Free plan has no bank feed) | 
QuickBooks Simple Start (~$456); Wave Pro | 
$0 or ~$180
 | 
Paper mail | 
Lob, Developer plan (no monthly fee) | 
Letters by API with tracking. Certified mail is on this plan: $6.95, plus $2.91 for the electronic return receipt Virginia hearing notices need, on top of the ~$1.07 letter | 
PostGrid; the board prints and stamps if the integration slips | 
~$450 (four runs; see Cost)
 | 
Sign-in and system email | 
Resend, free plan | 
Sign-in links and receipts from our domain with SPF, DKIM and DMARC. Free plan caps at 100 emails a day, so notices to all homes go out over two days | 
Postmark, Amazon SES | 
$0
 | 
Shared mailbox and identity | 
One Google Workspace seat for the HOA (price to confirm), or the current consumer account with two hardware keys | 
A Workspace seat gives real admin recovery, named board logins and "send as" board@ on our domain. A consumer account cannot have two real admins | 
Consumer account with keys | 
~$0 to $100
 | 
Front-door assistant | 
None at launch: Gmail templates, filters, labels and a fixed acknowledgment | 
Volume is low and not yet measured, and a $360 tool would be the largest line in the budget. Decide on drafts-only AI in May | 
Lindy, Gemini in Workspace, a small function calling a model API (see the assistant section) | 
$0
 | 
Phone and text number | 
Google Voice on the HOA account, voicemail to the inbox only, with a monthly call so the number is not reclaimed | 
Free; voicemail lands in the inbox as text | 
Google Voice for Workspace, OpenPhone (~$180) | 
$0
 | 
Domain and email address | 
Cloudflare Registrar, with Cloudflare Email Routing for board@ | 
Permanent address printed on every bill and notice; owned by the HOA, auto-renews on an HOA card | 
Any registrar (Google Domains is now Squarespace) | 
~$15
 | 
Bank | 
John Marshall Bank (stay until the May review) | 
No switching during billing season. Confirm the Eagle Financial conversion date first | 
Alliance Association Bank (lockbox deposits mailed checks for us), Relay | 
$0 to bank fees
 | 
Online votes (later) | 
Not at launch | 
The statute allows electronic votes unless our declaration forbids them; we hold them until the documents are checked and a vendor is picked | 
ElectionBuddy, Vote HOA Now | 
$0 now; ~$150 to $300 per election later
 | 
Backups | 
Nightly database export to the HOA Drive, plus an encrypted monthly copy kept outside Google | 
We hold our own copy whatever the vendor does; a restore test is a launch gate | 
Supabase Pro backups | 
$0
What we will not use. No hand-built accounting, collections or payment handling: card and bank details never touch our code. No vendor portal or vendor email address is ever printed for owners.
## End-to-end flows
Each flow below names who starts it, what the owner sees, what happens behind the scenes, and where the record lives. The phone mock-ups show the owner side of flows 1 to 5.
### 1. Owner onboarding (pre-registered)
Before launch, the board loads the roster (lot, address, owner names, mailing address, email) into the portal database. Each email on file is attached to its lot.
The launch letter goes out by email to the about 144 homes with an email on file and on paper to all 150 homes. It gives the portal address, the HOA email and phone, and says the owner does not need to register.
The owner opens the portal and taps "Continue with Google" or enters their email for a one-time sign-in link. If the email matches the roster, they land in their own lot with nothing to set up.
Every lot gets a claim code printed on its paper letter, because many owners sign in with a Google account that differs from the email on file. Entering it with any email attaches that email to the lot after a board check. Codes are single-use, expire after 90 days and are rate-limited. Before loading, two board members check the roster against county land records, since emails from the old manager may be stale.
A second owner on the same lot (spouse, co-owner) is added by the board or invited by the first owner; the board approves.
Email notices start only after the owner ticks the email consent box (Virginia requires owners to elect email notice). Until then, notices stay on paper.
### 2. Annual bill and payment
The board adopts the budget and the dues amount. The treasurer approves the bill run in the board view.
The portal creates one Stripe invoice per lot, with the HOA name, lot and due date, and stores the invoice link.
Owners who chose email get an email from the HOA address with a Pay button. Everyone else gets a paper statement through Lob with the same amount, the portal address, a QR code to the payment page, and the PO box for checks.
The owner pays by bank (ACH) or card on the Stripe page, or mails a check. Stripe sends the receipt; the portal home shows Paid within minutes through a Stripe webhook.
Checks are entered by the treasurer as "paid outside Stripe" on the invoice, so the portal and Stripe agree.
Stripe pays out to the HOA operating account. The bank feed brings the deposit into QuickBooks, where the treasurer matches it to dues income. The Stripe fee is booked as a bank charge.
Reminders go out automatically from Stripe at set days before and after the due date. Late fees, payment plans and collections are board decisions; the assistant drafts the letters and the board approves each one.
Money controls for flow 2 (added after review):
Opening balances. Each lot's carried arrears, credits and prepayments come from the PayHOA export, are checked by the treasurer and a second board member, and appear as a line on that lot's 2027 invoice.
Per-lot ledger view. The portal shows a running balance per lot (charges, payments, credits) built from Stripe events and recorded checks. It is a read-out for owners, resale certificates and collections, not accounting.
Stripe payout runbook (monthly). Stripe pays out in batches, net of fees. The treasurer books each payout from Stripe's payout report: dues income at the gross amount, Stripe fees as an expense, both through a "Stripe clearing" account, so income ties to the invoices.
ACH states. The portal shows Processing until an ACH payment settles, then Paid. A returned or disputed payment flips the lot back to Unpaid and opens a board task.
Checks. One person empties the PO box and logs each check; a second marks the invoice paid once the deposit clears. A check states received, deposited or returned. Double payments are credited forward or refunded, as the board decides.
Safety. Bill creation and webhook handling are idempotent and signature-checked, so a retried event never double-counts. Reminders skip lots that are paid, disputed or on hold.
### 3. Messages and requests (intake)
An owner sends a message from the portal, emails board@, calls or texts the HOA number, or mails the PO box. All four land in the HOA Gmail; portal messages arrive tagged with lot and topic.
The assistant reads each one. If it matches an approved template (meeting time, how to pay, document link, trash day), it replies at once and logs it. If it is money, enforcement, ARB, legal, records or resale, it drafts a reply and puts it in the board queue. Anything unclear is escalated to a named board member.
The board approves, edits or rejects drafts from the board view or Gmail. The owner sees the status in Recent messages.
Every message, reply and decision is kept in the HOA Gmail and the portal log, so the record survives any change of assistant.
### 4. Documents
The secretary uploads a file to a folder (governing documents, rules, minutes, packets, budgets, forms) and marks it owners-only or board-only.
Owners see it in Documents and in New on the home screen. Board-only files never reach owners.
Draft minutes post within 60 days of a meeting, as Virginia requires, and are marked draft until approved.
Records requests come in as a message topic. The assistant starts a 10-business-day clock and drafts the response list for the board.
### 5. Calendar, meetings and notices
The secretary adds board and annual meetings, tree work and the dues date. Owners can add the HOA calendar to their phone.
Owner (member) meetings: notice goes out at least 14 days before the annual meeting and 7 days before other member meetings, by email to owners who elected email and by mail to the rest (§55.1-1815). Board meetings: the notice is posted on the portal's public page and the calendar, and sent only to owners who asked in writing for board notices, renewed yearly (§55.1-1816). Mail is scheduled with a few days' margin, and an email that bounces goes out by mail.
The agenda packet posts when the board receives it. Minutes follow as in flow 4.
### 6. Architectural review (ARB)
The owner picks "Home change (ARB)" in Message, describes the project and attaches photos or a sketch.
The request gets a number and a due date set by the governing documents. The owner gets an acknowledgment and a completeness checklist; approval wording is the ARB chair's alone.
The ARB chair approves, denies or asks for more in the board queue. The decision letter goes from the HOA address and is filed in the lot record.
### 7. Votes and resolutions
At launch, owner votes stay at meetings and on paper or by proxy.
No binding board votes by email until the attorney says otherwise. Reviewers read §55.1-1816 as barring informal gatherings used to avoid open meetings, so expect action without a meeting to be rare and unanimous. Use a short, noticed video meeting instead; recording a vote in later minutes does not cure it.
Electronic owner voting is a later phase, after the board adopts a resolution under Virginia's electronic voting rules and picks a vendor.
### 8. Owner changes and resale
A sale or a new email arrives as a message. The assistant drafts the roster change; the board confirms it.
The seller's portal access ends at closing and the buyer's lot account is created from the new contact details.
Resale certificates fall under the Virginia Resale Disclosure Act (Va. Code Title 55.1, Chapter 23.1), with their own deadline (reported as 14 days; the attorney confirms), fee caps and form. The request is logged on arrival, and the treasurer prepares the certificate from the per-lot ledger.
### 9. Paying vendors (tree service, mowing, insurance)
The vendor's invoice comes to board@ or the PO box and is logged.
The treasurer checks it against the contract; a second officer approves anything over a threshold the board sets.
Payment goes by check or bank bill-pay, and the bank feed brings it into the books.
A W-9 is collected before the first payment, and a 1099 is filed at year end where required.
### 10. Year-end, insurance and exceptions
Tax return (usually Form 1120-H) through the accountant; DPOR/CICB annual report.
Renew D&O insurance and the fidelity bond.
Reserve study at least every five years, reviewed each year with the budget (§55.1-1826).
Signs at least 48 hours before any pesticide or herbicide is applied on common areas (§55.1-1818), written into the grounds contract.
Collections: at a board-set age, an unpaid lot goes to the attorney for the lien steps (§55.1-1833). Lien and enforcement notices always go on paper.
Returned mail and bounced email each open a board task.
Director elections at the annual meeting use paper ballots and proxies until electronic voting is adopted.
## The assistant
The assistant is the invisible front door. Owners write to the HOA, not to a bot, and every reply comes from the HOA address. It never moves money, changes the books or decides anything for the board.
At launch (changed after review): no assistant purchase and no automatic AI replies. All three reviewers advised against autonomous replies at launch, and two against paying for a tool before volume is known. The board launches with:
Gmail filters that apply topic labels (portal messages already carry lot and topic in the subject).
The approved templates saved as Gmail templates, so any board member sends one in two taps.
One fixed acknowledgment ("We got your message; the board replies within 2 business days"), sent at most once per sender per week, never to automated senders.
A Monday digest built from the labels.
In May, with real message counts, the board decides on a drafts-only AI helper: Lindy (~$360 a year), Gemini in Gmail if the HOA has a Workspace seat, or a small portal function that calls a model API (cents a month). The rest of this section is the design that helper must follow.
Where it works. It is connected only to the communal HOA Google account: the Gmail inbox (which also receives portal messages, board@ forwarding and Google Voice voicemail and texts), the HOA calendar and a read-only folder of published documents. It has no access to Stripe, QuickBooks, the bank or the portal database.
The auto-reply line.
 | 
It may send on its own | 
It drafts for board approval | 
It escalates to a named board member
 | 
Meeting dates, times and links already on the calendar | 
Anything about a specific bill, balance, fee, payment plan or refund | 
Threats, safety issues, emergencies, anything about a lawsuit
 | 
How to pay, the PO box, the portal address | 
Enforcement, violations and hearing notices | 
Anything it is unsure how to classify
 | 
Links to published documents and rules | 
ARB requests and decisions | 
Messages from attorneys, lenders, the press or government
 | 
Trash, tree-work and other published notices | 
Records and resale requests (starts the 10-business-day clock) | 
A second message from the same owner on an unanswered item
 | 
"We got your message" acknowledgments with a reply date | 
Anything that would commit the HOA to spend or act | 
Messages naming a board member personally
Guards, whichever helper is chosen:
It sends on its own only the fixed acknowledgment and fixed-text answers with no variables; meeting times only by quoting the posted notice word for word.
It only ever replies to the sender, never to another address, and never sends attachments.
It never replies to senders who are not on the roster, to automated mail (Auto-Submitted, List or bulk headers), or to Stripe, Lob, Resend or noreply senders. That stops reply loops.
Email text is treated as content, never as instructions; it cannot change recipients, payments or permissions.
Bank and Stripe notices go to a folder it cannot read.
Every send is logged in the portal's messages table with the template and version, the input, the approver and the time.
The board's off switch works even if the portal is down.
Every reply carries the footer "Replies from the board's office may be prepared with help from software".
Logging. Every message gets a Gmail label for its topic and status (new, acknowledged, draft waiting, escalated, closed), and a row in the portal messages table with its Gmail thread id. The table is the record, so nothing is lost if labels are edited or the helper changes. A daily check flags anything waiting more than 2 business days; the Monday digest summarizes the week.
Trial plan (from May). Run drafts only on a fixed test set of ordinary and tricky messages (including an injection attempt and an out-of-office loop), then on live mail for at least two months, including a billing month. Widening what it may send needs zero unauthorized disclosures, correct escalation every time and a board vote.
Switching vendors. The templates, labels and rules live in a Google Doc owned by the HOA, not in the vendor. A new assistant is pointed at the same inbox and doc; owners see no change.
Approval needed. Today's board rule is that a person approves every send. Only the fixed acknowledgment changes that at launch, and it needs a board vote on Nov 19. Records requests start their 10-business-day clock when the message arrives, not when anything classifies it. The portal messages table, not Gmail labels, is the record, because labels can be edited.
## Board operations
The runbooks below are what the board actually does. Each task names a role, not a person, so it survives turnover.
Every year
 | 
When | 
Task | 
Role | 
Tools
 | 
By Dec 15 (or the date the board sets) | 
Adopt the budget and send it to owners before Jan 1 | 
Treasurer, secretary | 
Portal post, email, Lob
 | 
After adoption | 
Approve the bill run; statements and invoices go out | 
Treasurer | 
Board view, Stripe, Lob
 | 
Due date | 
Check unpaid list; reminders go out automatically | 
Treasurer | 
Stripe, board view
 | 
30 and 60 days after due | 
Decide late fees and letters; approve drafts | 
Board | 
Board queue
 | 
Spring | 
Plan the annual meeting; notice 14+ days ahead | 
Secretary | 
Calendar, Lob, email
 | 
May | 
Keep-or-buy review; bank review | 
Board | 
Review checklist
 | 
Year end | 
Close the books; give the accountant read access | 
Treasurer | 
QuickBooks
 | 
Each January | 
Renew domain, check DPOR/CICB registration, review templates and admins | 
President | 
Registrar, DPOR
Every month (about 1 to 2 hours)
Treasurer matches deposits and bills in QuickBooks (the bank feed does the entry).
Treasurer checks the nightly backup ran and the monthly Drive export is there.
President reads the weekly digests and clears anything waiting more than 7 days.
Two board members confirm the admin list and that no former member still has access.
Every board meeting (every other month)
7+ days before: secretary posts the notice and calendar entry; email and paper go out.
When received: agenda packet posts to Board packets.
After: draft minutes post within 60 days; approved minutes replace them.
When something happens
New owner or sale: confirm the roster change the assistant drafted.
ARB request: chair decides within the governing-document deadline.
Records request: respond within 10 business days.
Board member leaves: remove their access the same week; the second admin confirms.
## Data and integrations
The portal keeps only what it needs to show owners their account and run the board's work. Money records live in Stripe and QuickBooks; the portal stores links and status, never card or bank numbers.
Main tables
 | 
Table | 
Holds | 
Who can see it
 | 
lots | 
Lot number, street address, status | 
Owners: their own lot. Board: all
 | 
owners | 
Name, mailing address, email, phone, email-notice consent and date, claim code (hashed) | 
Owners: their own record. Board: all
 | 
lot_owners | 
Which owners belong to which lot, start and end dates | 
Board
 | 
board_members | 
Role, admin level, term dates | 
Board
 | 
invoices | 
Stripe invoice id and link, amount, due date, status, paid date, paid outside Stripe flag | 
Owners: their lot. Board: all
 | 
messages | 
Topic, lot, Gmail thread id, status, assigned board member | 
Owners: their own. Board: all
 | 
documents | 
Folder, title, file path, audience (owners or board), posted date | 
By audience
 | 
events | 
Title, date, place or link, type, notice sent dates | 
Owners and board
 | 
arb_requests | 
Lot, description, files, due date, decision, letter | 
Owners: their own. Board: all
 | 
mail_log | 
Lob letter id, type, lot, sent and delivered dates, certified tracking | 
Board
 | 
audit_log | 
Who changed what and when | 
Board admins
Row-level security in the database enforces the "who can see it" column, so a mistake in the app screens cannot show one owner another owner's data.
Integrations
 | 
Link | 
Direction | 
How | 
When
 | 
Stripe to portal | 
In | 
Webhook to a server function: invoice paid, failed, voided | 
Within minutes
 | 
Portal to Stripe | 
Out | 
Server function creates customers and invoices from the approved bill run | 
Bill run
 | 
Portal to Lob | 
Out | 
Server function sends statements and notices with return tracking | 
Bill run, notices
 | 
Lob to portal | 
In | 
Webhook for mailed, delivered, returned | 
Daily
 | 
Bank to QuickBooks | 
In | 
QuickBooks bank feed | 
Daily
 | 
Stripe to QuickBooks | 
None at launch | 
Payouts arrive as bank deposits through the feed; treasurer matches | 
Monthly
 | 
Portal to Gmail | 
Out | 
Portal messages are emailed into the HOA inbox with lot and topic in the subject | 
Instant
 | 
Gmail to portal | 
In | 
Status labels sync back to Recent messages | 
Every 15 minutes
 | 
Portal to Resend | 
Out | 
Sign-in links and receipts | 
Instant
 | 
Portal to Google Drive | 
Out | 
Nightly database export and monthly full export (database, documents, mail log) | 
Nightly, monthly
 | 
Calendar feed | 
Out | 
Public iCal link of owner events | 
Live
Exports. On the first of each month, a job writes plain CSV and JSON files of every table, plus the document files, to the HOA Google Drive. QuickBooks, Stripe and Lob each have their own exports. Together these are enough to move to any other portal or management company.
## Security, privacy and Virginia compliance
Accounts and access
All HOA accounts (Google, registrar, Netlify, Supabase, Stripe, QuickBooks, Lob, Resend, assistant) are opened under the communal HOA Google account, never a personal one.
Two-step verification on every account, using a security key or authenticator app. At least two board officers hold admin rights everywhere; recovery codes are kept in a sealed envelope with the secretary and in a shared password manager vault.
Board members get the least access their role needs. The board view is open only to accounts on the board_members table.
No secret keys in the code repository. Keys live in Netlify and Supabase environment settings and are rotated when an admin leaves.
Identity fixes (added after review). One consumer Google login cannot have two real admins: delegation does not reach Drive, Voice or vendors that use "Sign in with Google", and QuickBooks Free and Lob Developer each allow one user. So:
Preferred: one Google Workspace seat as the HOA identity, with super-admin recovery held by two officers. Board members use their own logins wherever a vendor supports several users (Stripe, Supabase, Netlify, GitHub, Zoho).
Otherwise: two hardware security keys on the consumer account, held by two officers. Its recovery email and phone must not be one person's own, and the password sits in a vault shared by exactly two people and is changed on every departure.
Keep an encrypted copy of the monthly export outside Google, and a printed account inventory: vendor, sign-in method, recovery path.
Netlify holds only the public Supabase key. The service key, Stripe secret and Lob key live only in Supabase function secrets. Stripe and Lob webhooks are signature-checked.
Row-level security keys board access on the sign-in user id, not email text. Tests cover another owner, a former board member and forged lot ids, for reads and writes.
Sign-in and claim-code endpoints are rate-limited, and owner exports are kept in a restricted folder.
GitHub organization with 2FA and secret scanning, sign-in alerts on the HOA account, and a written step for "an owner saw another owner's data".
Documents and ARB photos sit in private storage buckets with their own access rules, served only through short-lived signed links.
A build check fails if the service key or any secret appears in the web app's code or public settings. Backups run with a read-only database role.
Claim codes are at least 12 characters, limited to 5 tries an hour, and the board is notified whenever a new sign-in attaches to a lot.
Owner data
Owners see only their own lot, bills and messages. Owner contact details are never shown to other owners and never sold or shared outside HOA business.
Card and bank details stay with Stripe. The portal never sees them.
A short privacy notice on the portal explains what we keep and why.
Nightly backups are kept 30 days; monthly exports are kept 7 years with the financial records.
Virginia Property Owners' Association Act (Va. Code Title 55.1, Chapter 18)
 | 
Rule (sections opened Nov 13, 2026) | 
What the plan does
 | 
Budget to owners before the fiscal year; reserve study at least every 5 years, reviewed yearly (§55.1-1826) | 
Adopt and send by Dec 15. Ask whether a reserve study exists; if not, budget one
 | 
Member meetings: 14 days' notice for annual or regular meetings, 7 days for others; email only to owners who elected it; a bounced email goes by mail (§55.1-1815) | 
Email to consenting owners, Lob to the rest, sent with a few days' margin
 | 
Board meetings: notice posted where most owners will see it, and sent to owners who ask in writing, renewed yearly; agenda packets available when the board gets them (§55.1-1816) | 
Portal public page and calendar, plus a requester list. No mailing to every owner (saves ~$650 to $900 a year)
 | 
Draft minutes available within 60 days, or sooner if sent with an agenda package; executive-session minutes excluded (§55.1-1815) | 
Minutes folder; secretary runbook
 | 
Records within 10 business days of a written request for a self-managed association; actual-cost charges under a board-adopted schedule (§55.1-1815) | 
Clock starts on arrival. Board adopts the cost schedule and the list of withheld categories
 | 
Hearing notice at least 14 days ahead by registered or certified mail, return receipt requested, or hand delivery; charges only if the documents allow them, capped at $50 an offense or $10 a day for 90 days (§55.1-1819) | 
Lob certified mail with electronic return receipt; 14-day gap built into the flow
 | 
Late fees only on assessments unpaid 60 days after the due date, capped at the §58.1-3915 penalty, 5% (§55.1-1824) | 
Reminder at 30 days; a late fee (about $8.75 on $175) is considered only after 60, if the documents allow
 | 
Electronic notices, votes and consents are allowed unless the declaration forbids them; electronic meetings need board guidelines; owners who stay on paper get a reasonable alternative; lien and enforcement notices stay on paper (§55.1-1832) | 
Owner consent for email notice comes from §55.1-1815. E-voting waits for a check of our documents. If board meetings use video, adopt guidelines on Nov 19
 | 
Fidelity bond or dishonesty insurance for officers, directors and others handling funds: the lesser of $1M or reserves plus a quarter of annual assessments, at least $10,000; funds in a federally insured bank (§55.1-1827) | 
Quote and buy before volunteers handle checks
 | 
Signs at least 48 hours before pesticide use on common areas (§55.1-1818) | 
In the grounds contract and the calendar
 | 
Liens for unpaid assessments (§55.1-1833) | 
Collections step in flow 10, through the attorney
 | 
Resale certificates (Resale Disclosure Act, Chapter 23.1, §55.1-2307 on) | 
Flow 8; the attorney confirms the deadline and fee cap
 | 
DPOR/CICB registration and the filing after the manager's termination (§55.1-1835; page did not load for review) | 
Filing this week, then the annual report each year
 | 
Association complaint procedure on the CICB form, so owners can complain before going to the Ombudsman (§54.1-2354.4; 18VAC48-70) | 
Board adopts it; the form goes in Documents and its own message topic with a tracked deadline
 | 
Hearing decision sent within 7 days by hand delivery or registered or certified mail (§55.1-1819, reported by review; attorney confirms). Lien notice steps before a memorandum of lien (§55.1-1833) | 
Both in flow 10 and the attorney checklist
The attorney should confirm the late-fee cap, between-meeting board votes by email and the ARB deadline. Sections not yet checked word-for-word against the current code are listed under Open questions.
## Build and launch timeline
The dates assume the board approves the plan on Thu Nov 19 and bills go out in February with a later due date and no late fee, as was done last year. Nothing is opened, bought or deployed before that vote.
 | 
Phase | 
Dates | 
What gets done | 
Done when
 | 
0. Do now | 
Nov 13 to 19 | 
Request the PayHOA export; make the DPOR/CICB filing; get the bank's conversion date; ask the accountant which ledger they use; get a fidelity bond quote | 
Export in hand; filing receipt
 | 
1. Approve | 
Thu Nov 19 | 
Board approves the plan, services, spending cap, the two admins, the reply templates and the fixed acknowledgment, the budget date and the due date | 
Vote in the minutes
 | 
2. Front door | 
Nov 20 to Dec 4 | 
Buy the domain; set up board@ with real send-as, the Workspace seat or hardware keys, Google Voice voicemail and the PO box; open Stripe (named representative), the books, Lob, Resend, Supabase and Netlify under the HOA; check the roster against land records | 
Test email, call and letter all reach the HOA inbox
 | 
3. Budget letter | 
By Dec 15 | 
Adopted 2027 budget to all 150 homes, with the new contact points, the email-notice consent form, the board-notice request form and every lot's claim code (this replaces a separate launch letter) | 
Mailed before Jan 1
 | 
4. Money set-up | 
Dec 1 to Jan 15 | 
Load and cross-check opening balances; write the Stripe payout runbook; dry-run the bill run in Stripe test mode | 
Accountant agrees with a worked example, including an exception month
 | 
5. Bills out | 
Early February, Feb 26 at the latest | 
Bill run approved; Stripe invoices emailed; Lob statements with QR code and a lot-numbered stub for checks. The portal is not required | 
Every lot invoiced and mailed
 | 
6. Build the core | 
Dec 1 to Feb 12 | 
Sign-in, home, My bill with the lot ledger, Documents, Message, board view, nightly backup | 
Restore test passed; every board member has done each flow
 | 
7. Pilot and launch | 
Feb 15 to Mar 15 | 
9 board members and about 10 owners use it; fix what they find; launch email; Supabase Pro on through June | 
No open issue that blocks paying or signing in
 | 
8. Settle in | 
Mar to May | 
ARB module, Lob delivery webhooks, Gmail label sync, calendar feed, first monthly export | 
Due date passes with the books reconciled
 | 
9. Review | 
May 2027 | 
Keep-or-buy check; bank review; assistant decision; Stripe Checkout; e-voting | 
Board vote
The due date for 2027 dues is the board's call. Last year it moved to June or July; a date 90 days after bills go out (mid-May) is the default in this plan.
## Cost
Yearly running cost
 | 
Item | 
Lean (QuickBooks Free, consumer Google) | 
With paid books and a Workspace seat
 | 
Hosting | 
$0 | 
$0
 | 
Database (Supabase Pro about Jan to Jun) | 
~$150 | 
~$150
 | 
Books | 
$0 (QuickBooks Free) | 
~$180 (Zoho Books Standard)
 | 
Workspace seat | 
$0 | 
~$100 (price to confirm)
 | 
Domain | 
~$15 | 
~$15
 | 
Software subtotal | 
~$165 | 
~$445
 | 
Paper mail: budget letter, statements, annual meeting notice, a few certified hearing notices | 
~$450 | 
~$450
 | 
PO box | 
~$100 to $200 | 
same
 | 
Payment fees (about 60% paying online by ACH) | 
~$200 to $300 | 
same
 | 
Fidelity bond | 
Quote pending | 
same
 | 
Assistant | 
$0 until May (Lindy would add ~$360) | 
same
 | 
All-in | 
~$1,000 to $1,100 plus the bond | 
~$1,250 to $1,400 plus the bond
The earlier $185 figure counted one mail run where the plan sends four, left out Supabase Pro for billing season, and assumed a free ledger with an accountant seat that doesn't exist. Hosted portals also charge for mail and payment fees, and the bond is needed either way, so the comparison below is software only. The board decides whether owners pay card fees.
Compared with hosted portals (portal and back office only)
 | 
Option (software only) | 
Yearly | 
Lean build saves | 
Paid-books build saves
 | 
Build, lean | 
~$165 | 
 | 
 | 
Build, paid books and Workspace | 
~$445 | 
 | 
 | 
TownSq Pro | 
~$970 | 
~83% | 
~54%
 | 
ManageCasa Growth | 
~$1,920 | 
~91% | 
~77%
 | 
HOA Express Deluxe (2022 list price, includes domain and email) | 
~$562 | 
~71% | 
~21%
The lean build clears the 75 to 80% bar against TownSq and ManageCasa. With paid books and a Workspace seat it clears it only against ManageCasa, and neither version clears it against HOA Express's lower price (a 2022 figure, to re-check). So the books choice decides the savings, and the stronger case for building is stability: one front door the HOA owns, which no vendor change can move.
Setup cost. No software spend before launch beyond the domain and PO box. The real cost is time: about 150 to 250 hours to build and launch the smaller launch scope, then 40 to 80 hours a year for upkeep (reviewers estimated 140 to 220 and, for the full scope, 200 to 350) (see Handoff). A freelancer for the build would cost roughly $8,000 to $16,000 at $75 to $100 an hour, which would erase several years of savings, so Jason will build it with Claude Code (decided Nov 12).
## Testing, launch and success measures
Testing before owners see it
Automated checks on every change: sign-in, owner can see only their own lot, board view is closed to owners, Stripe webhook marks an invoice paid, Lob test letter is created.
A database test that tries to read another lot's data as an owner and must fail.
Stripe and Lob in test mode for the whole build; a full dry-run bill run with test invoices for all 150 lots before the real one.
Phone checks on iPhone and Android, large text, and a screen reader on the sign-in, home and pay screens.
Restore test: rebuild the database from the nightly backup into a spare project once before launch and once a year.
Launch checklist
Roster loaded and checked by two board members; claim codes printed for every lot; opening balances checked by two people; restore test passed.
Every board member has signed in and done each flow once.
Templates approved by the board; assistant trial result recorded.
Bill run approved in a board vote; invoices match the adopted dues.
Launch letter and email reviewed by the president and secretary.
Rollback plan: if the portal fails at launch, invoices still work from the Stripe email links and paper statements, and the HOA inbox and phone keep working.
Success measures for the May review
 | 
Measure | 
Target
 | 
Owners who signed in at least once | 
60% (90 of 150)
 | 
Dues paid by the due date | 
Same or better than last year
 | 
Payments made online | 
60% or more
 | 
Messages answered within 2 business days | 
90%
 | 
Records requests answered within 10 business days | 
100%
 | 
Board hours per month on admin | 
5 or fewer, after launch month
 | 
Running cost | 
At or under the lean-tier estimate
 | 
Unplanned outages longer than a day | 
None
If the portal misses most of these in May, the board can move to a hosted portal behind the same domain, email and phone, and owners keep the same front door.
## Handoff, portability and exit plan
Who does what after launch
 | 
Role | 
Yearly hours | 
Skills needed
 | 
Portal maintainer (technical volunteer or paid helper) | 
15 to 30 | 
Reads a short code base, follows the runbook, can ask Claude Code for changes
 | 
Treasurer | 
10 to 20 | 
QuickBooks basics, approving a bill run
 | 
Secretary | 
5 to 10 | 
Uploading documents, adding events, sending notices
 | 
President / assistant owner | 
5 | 
Reviewing the weekly digest and templates
What makes it handoff-ready
One code repository owned by the HOA GitHub organization, with a plain-English README, a setup script and the runbooks from this plan.
Common, widely used parts (Postgres, a standard web framework, Netlify, Stripe) that any freelancer knows.
Every account owned by the HOA Google account with two admins, so no one person's departure locks the board out.
A one-page "if the maintainer leaves" sheet: how to pause the portal, keep billing running from Stripe alone, and hire help.
Exit plan. If the board decides to buy instead, the steps are: export the roster and history (monthly export), import owners to the hosted portal, point the portal address at the hosted portal or redirect it, keep board@, the phone and the PO box. Stripe, QuickBooks and Lob records stay with the HOA. Owners see the same addresses throughout, which avoids another round of re-registration.
## Risks and mitigations
 | 
Risk | 
Likelihood | 
Effect | 
Mitigation
 | 
The builder runs out of time before February | 
Medium | 
Bills late | 
Bills do not depend on the portal: Stripe emails and Lob statements can go out alone; the portal launches when ready
 | 
Only one person understands the system | 
Medium | 
Stuck when they leave | 
Two admins everywhere, README and runbooks, common tools, exit plan
 | 
Owner data shown to the wrong owner | 
Low | 
Serious trust and legal harm | 
Database row-level security, automated tests that must fail across lots, review before launch
 | 
Supabase free plan pauses after a quiet week | 
Medium | 
Portal down until restarted | 
Pro during billing season (about Jan to Jun); keep-alive check the rest of the year
 | 
Assistant sends a wrong or unapproved reply | 
Low to medium | 
Confusion, possible dispute | 
Templates only, drafts for everything else, one-tap off switch, weekly digest, no AI replies at launch; drafts-only trial from May
 | 
A vendor raises prices or shuts down | 
Medium over 2 years | 
Rework | 
Every vendor sits behind the HOA front door; named alternates; monthly exports
 | 
Owners do not sign in | 
High | 
Board still answers by email and phone | 
Paper and email keep working; pre-registration means no setup; the assistant answers email the same way
 | 
Account takeover of the HOA Google account | 
Low | 
Everything exposed | 
Security keys, two admins, alerts on new sign-ins, recovery codes held offline
 | 
Bank merger changes feeds or fees | 
Medium | 
Manual entry for a while | 
Bank review in May; Alliance and Relay as ready alternates
 | 
Virginia rule misread | 
Low | 
Notice or record defect | 
Attorney review of the items in Open questions before launch
## Open questions and decisions
For Jason (facts we need)
The HOA's exact legal name, and the domain you want (for example, the community name followed by hoa.org).
The 2027 dues amount and the fiscal year (calendar year assumed).
The 2027 due date (mid-May assumed, 90 days after bills).
Whether owners pay card fees or the HOA absorbs them (ACH stays free to owners either way).
Who is the second admin on every account.
Copies of the declaration and bylaws, to set the ARB deadline, late-fee rules and notice rules.
The 2027 board meeting dates, times and place or video link.
Which records and data you have from the old manager, including the PayHOA export.
Whether the board is fine with a Google Voice number as the HOA phone.
The budget letter date: Dec 15 is used here (the scope doc said Dec 18).
Who builds the portal: decided Nov 12, Jason builds it with Claude Code.
Added after the review (for Jason)
Has the PayHOA export been requested? Does it include per-lot balances, payment history and documents, and what is the deletion date?
What date was the manager terminated, and has the DPOR/CICB change been filed?
Who is the HOA's accountant or tax preparer, and which ledger do they use?
Do we have a reserve study, a fidelity bond and D&O insurance, and when do they renew?
How many bank accounts are there (operating, reserve)?
Will the board pay about $100 a year for one Google Workspace seat, or keep the consumer account with two hardware keys?
Which board member will be Stripe's account representative, and who succeeds them?
Who empties the PO box and logs checks, and who records them? It must be two people.
What is the collections threshold, and which attorney handles liens?
For the board on Nov 19 (votes)
Approve the plan and the lean-tier services, with a spending cap.
Approve the two account admins and the rule that all accounts belong to the HOA Google account.
Approve the reply templates and the one fixed acknowledgment; no AI assistant purchase before the May review. Approve getting a fidelity bond, a records cost schedule, and electronic-meeting guidelines if the board will meet by video.
Set the budget adoption date and the dues due date.
For the attorney
Late-fee cap and process under our documents and Virginia law.
Whether the board may vote by email between meetings.
The ARB response deadline and what happens if it passes.
The wording of the email-notice consent form and electronic-voting resolution.
Confirm the DPOR/CICB termination filing under §55.1-1835 (the page did not load for review), the Resale Disclosure Act deadline and fee cap (Chapter 23.1), whether our declaration limits electronic notice or voting, and how the board may act without a meeting (likely unanimous written consent only).
## Review log and sources
Review log
 | 
Reviewer | 
Model | 
Status
 | 
Claude (author) | 
Claude Opus 5.5 | 
Drafted Nov 12, 2026 (revision 11)
 | 
Claude (independent) | 
Claude Opus 5.5, fresh session with web access | 
Done Nov 13. Opened Virginia Code sections and vendor pricing pages
 | 
Codex | 
GPT-6, read-only, on the HP | 
Done Nov 13. Packet hash verified
 | 
Gemini | 
gemini-4-argon on the API, read-only | 
Done Nov 13 in two runs, both cut off by the output limit. Questions 1 to 6 are covered; 7 and 8 are partly missing
 | 
Grok | 
grok-4.7 | 
Failed Nov 13: four calls timed out at 5 minutes, including the packet split in halves. Needs a harness fix before it can review a packet this size
All legs got the same packet (SHA-256 d6cb2476…f39e), and none saw another's findings. Where they disagreed, the claim was checked against the source:
Zoho Books Free: Gemini said it includes bank feeds. Zoho's pricing page lists feeds only from Standard.
Lob certified mail: Gemini said it needs a $260-a-month plan. Lob's pricing details list it on the free Developer plan at $6.95.
Fidelity bond: Gemini said the minimum is $50,000. §55.1-1827 sets $10,000.
QuickBooks Free: Gemini said it doesn't exist. Intuit's pricing page lists it, with 1 user and no accountant.
The assistant pick, Stripe product, hosting and Supabase tier were settled as described in this revision. The full comparison, the packet and every review are in the project files under reviews/2026-11-13-impl-plan and on ticket #2014.
Sources
Virginia Property Owners' Association Act, Va. Code Title 55.1, Chapter 18: law.lis.virginia.gov/vacode/title55.1/chapter18/
Stripe pricing and Stripe Invoicing pricing: stripe.com/pricing
QuickBooks Online plans, including the free tier: quickbooks.intuit.com/pricing
Lob pricing: lob.com/pricing
Supabase pricing: supabase.com/pricing
Netlify pricing: netlify.com/pricing
Resend pricing: resend.com/pricing
Lindy pricing: lindy.ai/pricing
TownSq and ManageCasa pricing pages and quotes gathered in the scope doc
Companion documents: Build our own HOA portal: scope and plan; phone mock-ups