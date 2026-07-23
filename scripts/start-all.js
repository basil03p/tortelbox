// ============================================================
// Single Service Runner — Starts Next.js Web UI + Telegram Bot
// ============================================================
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = join(__dirname, '..');
const BOT_DIR   = join(ROOT_DIR, 'tgbot');

console.log('🚀 Starting TorBox All-In-One Single Service…');

// ── 1. Spawn Telegram Bot Process ───────────────────────────
console.log('🤖 Launching Telegram Bot…');
const botProcess = spawn('node', ['src/index.js'], {
  cwd: BOT_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

botProcess.on('error', (err) => {
  console.error('❌ Telegram Bot process error:', err.message);
});

botProcess.on('exit', (code) => {
  console.warn(`⚠️ Telegram Bot exited with code ${code}`);
});

// ── 2. Spawn Next.js Web Application ────────────────────────
console.log('🌐 Launching Next.js Web UI…');
const nextProcess = spawn('npx', ['next', 'start'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

nextProcess.on('error', (err) => {
  console.error('❌ Next.js Web UI process error:', err.message);
});

nextProcess.on('exit', (code) => {
  console.warn(`⚠️ Next.js Web UI exited with code ${code}`);
  process.exit(code || 1);
});

// ── Graceful Shutdown ───────────────────────────────────────
function shutdown() {
  console.log('\n🛑 Shutting down All-In-One processes…');
  botProcess.kill('SIGTERM');
  nextProcess.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
