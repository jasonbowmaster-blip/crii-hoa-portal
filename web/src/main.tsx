import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { setApi } from './data/api';
import { config } from './config';
import './theme.css';

async function boot() {
  if (config.dataMode === 'supabase') {
    const { createSupabaseApi } = await import('./data/supabase/adapter');
    setApi(createSupabaseApi(config.supabaseUrl, config.supabaseAnonKey));
  } else {
    const { createDemoApi, DEMO_NOW } = await import('./data/demo/adapter');
    const { setAppNow } = await import('./lib/clock');
    setAppNow(DEMO_NOW);
    setApi(createDemoApi());
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
