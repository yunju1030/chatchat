// Read-only scan; reports paths and categories, never credential values.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const excluded = new Set(['node_modules', '.npm-cache', '.git', '.vercel', '.aws', '.codex', '.agents', '.vscode', '.idea']);
let localKey = '';
try {
  const env = await readFile(join(root, '.env'), 'utf8');
  const match = env.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m);
  localKey = match?.[1]?.replace(/^['"]|['"]$/g, '') || '';
} catch { /* Missing local environment file is allowed. */ }
let scanned = 0;
const findings = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (excluded.has(entry.name)) continue;
    if (entry.name === '.env' || entry.name.startsWith('.env.') && entry.name !== '.env.example' || /\.(pem|key|log|tmp)$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await scan(path); continue; }
    const content = await readFile(path, 'utf8');
    scanned++;
    const categories = [];
    if (localKey.length >= 16 && content.includes(localKey)) categories.push('local OpenAI key matches');
    if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/.test(content)) categories.push('possible OpenAI key');
    if (/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(content)) categories.push('possible GitHub token');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) categories.push('private key');
    if (categories.length) findings.push({ path: relative(root, path), categories });
  }
}
await scan(root);
console.log(JSON.stringify({ scannedFiles: scanned, localOpenAIKeyConfigured: localKey.length >= 16, findings }, null, 2));
if (findings.length) process.exitCode = 1;
