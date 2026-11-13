import { describe, expect, it } from 'vitest';
import { allowedOrigins, corsHeaders, preflight } from './cors.ts';

const PORTAL = 'https://portal.example.org';

describe('cors', () => {
  it('allows exactly the configured origin, never a wildcard', () => {
    expect(corsHeaders(PORTAL, PORTAL)['Access-Control-Allow-Origin']).toBe(PORTAL);
    expect(corsHeaders('https://evil.example.net', PORTAL)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders(`${PORTAL}.evil.net`, PORTAL)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(Object.values(corsHeaders(PORTAL, PORTAL))).not.toContain('*');
  });
  it('sends no allow-origin header when the setting is missing or is a wildcard', () => {
    expect(corsHeaders(PORTAL, undefined)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders(PORTAL, '')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('https://anything.example', '*')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders(null, PORTAL)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('*', '*')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(allowedOrigins('*')).toEqual([]);
  });
  it('supports several origins and ignores a trailing slash', () => {
    const setting = `${PORTAL}/, http://localhost:5173`;
    expect(allowedOrigins(setting)).toEqual([PORTAL, 'http://localhost:5173']);
    expect(corsHeaders('http://localhost:5173', setting)['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(corsHeaders(`${PORTAL}/`, setting)['Access-Control-Allow-Origin']).toBe(PORTAL);
  });
  it('always varies on Origin and names the headers the browser sends', () => {
    const h = corsHeaders('https://evil.example.net', PORTAL);
    expect(h.Vary).toBe('Origin');
    expect(h['Access-Control-Allow-Headers']).toMatch(/authorization/);
    expect(h['Access-Control-Allow-Headers']).toMatch(/content-type/);
    expect(h['Access-Control-Allow-Methods']).toMatch(/OPTIONS/);
  });
  it('answers a preflight with 204 and the same headers', () => {
    const p = preflight(PORTAL, PORTAL);
    expect(p.status).toBe(204);
    expect(p.headers['Access-Control-Allow-Origin']).toBe(PORTAL);
  });
});
