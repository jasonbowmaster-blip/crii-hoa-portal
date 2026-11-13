import { describe, expect, it, vi } from 'vitest';

const createClient = vi.fn();
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => createClient(...a) }));

describe('Supabase client setup', () => {
  it('uses the PKCE flow with URL detection and waits for the callback exchange', async () => {
    const initialize = vi.fn().mockResolvedValue({ error: null });
    createClient.mockReturnValue({ auth: { initialize } });
    history.replaceState(null, '', '/?code=abc&x=1#/claim');
    const { createReadySupabaseApi } = await import('./adapter');
    await createReadySupabaseApi('https://x.example', 'anon');
    expect(createClient).toHaveBeenCalledWith('https://x.example', 'anon', { auth: { flowType: 'pkce', detectSessionInUrl: true } });
    expect(initialize).toHaveBeenCalled();
    expect(location.search).toBe('?x=1');          // callback code removed
    expect(location.hash).toBe('#/claim');         // route kept
  });

  it('sends people back to the app address without a hash', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({ error: null });
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    createClient.mockReturnValue({ auth: { signInWithOAuth, signInWithOtp, initialize: vi.fn() } });
    history.replaceState(null, '', '/app/#/sign-in');
    const { createSupabaseApi } = await import('./adapter');
    const api = createSupabaseApi('https://x.example', 'anon');
    await api.signInWithGoogle();
    await api.sendSignInLink('a@b.test');
    expect(signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(`${location.origin}/app/`);
    expect(signInWithOtp.mock.calls[0][0].options.emailRedirectTo).toBe(`${location.origin}/app/`);
  });
});
