// Fails (exit 1) if browser-bound code or a built bundle contains a secret.
// Scans web/src, dist/ and dist-demo/ (or the folders given as arguments).
// Run: node scripts/check-no-secrets.mjs [folder ...]
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.pdf', '.zip', '.mp4']);

// Secret-looking values: always a finding, even in comments.
const VALUE_RULES = [
  { rule: 'stripe live key', re: /sk_live_[A-Za-z0-9]*/ },
  { rule: 'stripe test key', re: /sk_test_[A-Za-z0-9]*/ },
  { rule: 'stripe restricted live key', re: /rk_live_[A-Za-z0-9]*/ },
  { rule: 'stripe restricted test key', re: /rk_test_[A-Za-z0-9]*/ },
  { rule: 'stripe webhook secret', re: /whsec_[A-Za-z0-9]*/ },
  { rule: 'supabase secret key', re: /sb_secret_[A-Za-z0-9_-]*/ },
];
// Names of server secrets: a finding when used in code (comments are allowed to mention them).
const NAME_RE = /\b(SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|LOB_API_KEY)\b/;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function isServiceRoleJwt(payloadB64) {
  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')).role === 'service_role';
  } catch { return false; }
}

// Remove // and /* */ comments (not the // in URLs) so the name rule ignores comments.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\w"'`])\/\/.*$/gm, '$1');
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (!SKIP_EXT.has(extname(p).toLowerCase())) yield p;
  }
}

export function scanText(text) {
  const findings = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  for (const { rule, re } of VALUE_RULES) {
    const m = re.exec(text);
    if (m) findings.push({ rule, line: lineOf(m.index) });
  }
  for (const m of text.matchAll(JWT_RE)) {
    if (isServiceRoleJwt(m[1])) findings.push({ rule: 'service_role JWT', line: lineOf(m.index) });
  }
  const code = stripComments(text);
  const n = NAME_RE.exec(code);
  if (n) findings.push({ rule: `server secret name ${n[1]} in code`, line: code.slice(0, n.index).split('\n').length });
  return findings;
}

export function scanFolders(folders) {
  const out = [];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const file of walk(folder)) {
      for (const f of scanText(readFileSync(file, 'utf8'))) out.push({ file, ...f });
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(here, '..');
  const args = process.argv.slice(2);
  const folders = args.length ? args : ['web/src', 'dist', 'dist-demo'].map((f) => join(root, f));
  const findings = scanFolders(folders);
  if (findings.length) {
    console.error('Secrets found in browser-bound files:');
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.rule}`);
    process.exit(1);
  }
  const checked = folders.filter((f) => existsSync(f)).length;
  console.log(`No secrets found (${checked} folder${checked === 1 ? '' : 's'} scanned).`);
}
