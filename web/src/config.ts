// Public, non-secret settings. Real values come from VITE_* env vars at build time.
export const config = {
  dataMode: (import.meta.env.VITE_DATA_MODE ?? 'demo') as 'demo' | 'supabase',
  hoaName: import.meta.env.VITE_HOA_NAME ?? '[HOA name]',
  domain: import.meta.env.VITE_HOA_DOMAIN ?? '[our domain]',
  phone: import.meta.env.VITE_HOA_PHONE ?? '[HOA phone]',
  get boardEmail() { return `board@${this.domain}`; },
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
};
