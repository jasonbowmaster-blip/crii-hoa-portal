// Small structural types shared by the server functions. They mirror the
// fields of web/src/data/types.ts that the functions need, so the functions
// folder deploys on its own without importing from web/.

export interface LotRecord {
  id: string;
  lot_number: number;
  street_address: string;
  status: 'active' | 'on_hold' | 'in_collections';
}

export interface OwnerRecord {
  id: string;
  full_name: string;
  email: string | null;
  mailing_address: string;
  email_notice_consent: boolean;
}

// One owner of one lot (a lot can have several rows).
export interface LotOwnerRow {
  lot_id: string;
  owner: OwnerRecord;
}

export interface BalanceRow {
  lot_id: string;
  balance_cents: number;
  processing_cents?: number;   // bank payments still processing (NOT part of balance_cents)
}
