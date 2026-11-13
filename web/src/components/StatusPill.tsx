const LABELS: Record<string, string> = {
  paid: 'Paid', unpaid: 'Unpaid', processing: 'Processing', credit: 'Credit', returned: 'Returned',
  new: 'Received', acknowledged: 'Received', draft_waiting: 'With the board', escalated: 'With the board',
  answered: 'Answered', closed: 'Closed', draft: 'Draft',
};
const CLASS: Record<string, string> = {
  credit: 'paid', answered: 'paid', closed: 'paid', new: 'processing', acknowledged: 'processing',
  draft_waiting: 'processing', escalated: 'processing', draft: 'processing',
};

export default function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill--${CLASS[status] ?? status}`}>{LABELS[status] ?? status}</span>;
}
