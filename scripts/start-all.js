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

let isShuttingDown = false;
let botProcess = null;
let botRestartTimer = null;
let restartAttempts = 0;
let lastRestartTime = Date.now();
const MAX_FAST_RESTARTS = 5;

// ── 1. Spawn Telegram Bot Process ───────────────────────────
function startBotProcess() {
  if (isShuttingDown) return;
  console.log('🤖 Launching Telegram Bot…');

  const now = Date.now();
  if (now - lastRestartTime < 10000) {
    restartAttempts++;
  } else {
    restartAttempts = 1;
  }
  lastRestartTime = now;

  if (restartAttempts > MAX_FAST_RESTARTS) {
    console.error('❌ Telegram Bot is restarting too quickly. Throttling restart by 30 seconds…');
    botRestartTimer = setTimeout(() => {
      restartAttempts = 0;
      startBotProcess();
    }, 30000);
    return;
  }

  botProcess = spawn('node', ['src/index.js'], {
    cwd: BOT_DIR,
    stdio: 'inherit',
    env: { ...process.env },
  });

  botProcess.on('error', (err) => {
    console.error('❌ Telegram Bot process error:', err.message);
  });

  botProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.warn(`⚠️ Telegram Bot exited with ${reason}. Auto-restarting in 5 seconds…`);
    botRestartTimer = setTimeout(startBotProcess, 5000);
  });
}

startBotProcess();

// ── 2. Spawn Next.js Web Application ────────────────────────
import fs from 'fs';
const standalonePath = join(ROOT_DIR, '.next', 'standalone', 'server.js');
const hasStandalone = fs.existsSync(standalonePath);

const nextCmd = hasStandalone ? 'node' : 'npx';
const nextArgs = hasStandalone ? ['.next/standalone/server.js'] : ['next', 'start'];

console.log(`🌐 Launching Next.js Web UI (${nextCmd} ${nextArgs.join(' ')})…`);
const nextProcess = spawn(nextCmd, nextArgs, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

nextProcess.on('error', (err) => {
  console.error('❌ Next.js Web UI process error:', err.message);
});

nextProcess.on('exit', (code) => {
  if (isShuttingDown) return;
  console.warn(`⚠️ Next.js Web UI exited with code ${code}`);
  process.exit(code || 1);
});

// ── Graceful Shutdown ───────────────────────────────────────
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (botRestartTimer) clearTimeout(botRestartTimer);
  console.log('\n🛑 Shutting down All-In-One processes…');
  if (botProcess) botProcess.kill('SIGTERM');
  if (nextProcess) nextProcess.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

