import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { setApi } from './data/api';
import { config } from './config';
import './theme.css';
// The demo backend is bundled statically (it is small and the preview must run from a single file);
// the real backend is loaded only when configured.
import { createDemoApi, DEMO_NOW } from './data/demo/adapter';
import { setAppNow } from './lib/clock';

async function boot() {
  if (config.dataMode === 'supabase') {
    const { createReadySupabaseApi } = await import('./data/supabase/adapter');
    setApi(await createReadySupabaseApi(config.supabaseUrl, config.supabaseAnonKey));
  } else {
    setAppNow(DEMO_NOW);
    setApi(createDemoApi());
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
