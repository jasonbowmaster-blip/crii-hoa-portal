// Mutation test: plant each kind of secret in a temp folder and prove the scanner
// fails on it, then prove a clean folder passes.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanFolders } from './check-no-secrets.mjs';

const script = resolve(import.meta.dirname, 'check-no-secrets.mjs');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role, iss: 'supabase' })}.abcdefghijkl`;

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nosecrets-')); mkdirSync(join(dir, 'assets')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plant = (content, name = 'assets/index.js') => writeFileSync(join(dir, name), content);
const run = () => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

describe('check-no-secrets', () => {
  it('passes on a clean folder, including the public anon key and comments naming a secret', () => {
    plant(`// never use STRIPE_SECRET_KEY here\nconst key = "${jwt('anon')}";\nconst url = "https://x.supabase.co";`);
    expect(run().status).toBe(0);
    expect(scanFolders([dir])).toEqual([]);
  });

  const planted = {
    'live key': `const k = "sk_live_${'a'.repeat(24)}";`,
    'test key': `const k = "sk_test_${'a'.repeat(24)}";`,
    'webhook secret': `const k = "whsec_${'a'.repeat(24)}";`,
    'service_role JWT': `const k = "${jwt('service_role')}";`,
    'service key name in code': 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    'stripe key name in code': 'x(STRIPE_SECRET_KEY)',
    'lob key name in code': 'const a = import.meta.env.LOB_API_KEY;',
  };
  for (const [label, content] of Object.entries(planted)) {
    it(`fails on a planted ${label}`, () => {
      plant(content);
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('index.js');
    });
  }

  it('fails when the secret is in a nested html file', () => {
    plant(`<script>var k="sk_live_${'b'.repeat(20)}"</script>`, 'assets/page.html');
    expect(run().status).toBe(1);
  });
});
