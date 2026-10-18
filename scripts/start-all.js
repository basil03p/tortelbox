// ============================================================
// Telegram Bot Service Runner — Pure Telegram Bot (No Web UI)
// ============================================================
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = join(__dirname, '..');
const BOT_DIR   = join(ROOT_DIR, 'tgbot');

console.log('🚀 Starting TorBox Telegram Bot Service…');

let isShuttingDown = false;
let botProcess = null;
let botRestartTimer = null;
let restartAttempts = 0;
let lastRestartTime = Date.now();
const MAX_FAST_RESTARTS = 5;

// ── Spawn Telegram Bot Process with Supervisor ──────────────
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

// ── Graceful Shutdown ───────────────────────────────────────
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (botRestartTimer) clearTimeout(botRestartTimer);
  console.log('\n🛑 Shutting down Telegram Bot process…');
  if (botProcess && !botProcess.killed) {
    const killTimeout = setTimeout(() => {
      try { botProcess.kill('SIGKILL'); } catch (_) {}
      process.exit(0);
    }, 4000);

    botProcess.once('exit', () => {
      clearTimeout(killTimeout);
      process.exit(0);
    });

    botProcess.kill('SIGTERM');
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
