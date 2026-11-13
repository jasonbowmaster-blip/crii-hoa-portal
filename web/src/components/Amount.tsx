import { formatCents } from '../lib/ledger';

// Money in integer cents. Negative amounts show with a minus sign.
export default function Amount({ cents, className }: { cents: number; className?: string }) {
  return <span className={className}>{formatCents(cents)}</span>;
}
