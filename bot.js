// Multi-account AFK bot (mineflayer) - bananasmp.net boxpvp /warp afk
// Setup: Node.js 18+, then:  npm install mineflayer   and   node bot.js
//
// Flow per account:
//   join -> accept resource pack -> /login (or /register) -> /server boxpvp
//   -> /warp afk (stand still 3s) -> verify teleport -> anti-AFK movement

const mineflayer = require('mineflayer');

const HOST = 'play.servername.com';
const PORT = 25565;

const ACCOUNTS = [
  { username: 'UserName_1',      password: 'password' },
  { username: 'UserName_2',      password: 'password' },
  { username: 'UserName_3',      password: 'password' },
  { username: 'UserName_4',      password: 'password' },
  { username: 'UserName_5',      password: 'password' },
];

const START_GAP_MS = 15000;        // gap between account joins
const RECONNECT_DELAY_MS = 30000;  // base wait before reconnect
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // backoff cap
const AFTER_LOGIN_DELAY_MS = 3000; // wait after /login before /server
const AFTER_SERVER_DELAY_MS = 6000;// wait after /server boxpvp before /warp
const WARP_WAIT_MS = 6000;         // stand still this long after /warp afk (3s tp + margin)
const WARP_MAX_TRIES = 6;
const MIN_TP_DISTANCE = 8;         // blocks moved = teleport succeeded
const MOVE_EVERY_MS = 4 * 60 * 1000;
const BAL_COMMAND = '/bal';            // balance check command
const BAL_EVERY_MS = 30 * 60 * 1000;   // check every 30 min
const BAL_REPLY_WINDOW_MS = 5000;      // log chat replies for 5s after /bal

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared queue: no two bots connect within START_GAP_MS of each other,
// even when many get kicked at the same moment.
let nextConnectAt = 0;
function scheduleStart(acc, attempt, delay) {
  const at = Math.max(Date.now() + delay, nextConnectAt);
  nextConnectAt = at + START_GAP_MS;
  const wait = at - Date.now();
  setTimeout(() => startBot(acc, attempt), wait);
  return wait;
}

function startBot(acc, attempt = 0) {
  const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}] [${acc.username}]`, ...a);

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: acc.username,
    auth: 'offline',
    // version: '1.20.4', // uncomment + set if auto-detect fails
  });

  let authSent = false;
  let flowRunning = false;
  let inAfk = false;
  let moveTimer = null;
  let reachedAfk = false;
  let balTimer = null;
  let balListenUntil = 0;
  let banned = false;
  let closed = false;
  let needsRegister = false;

  // 1) Resource pack prompt -> accept
  bot.on('resourcePack', () => {
    log('resource pack prompt -> accepting');
    try { bot.acceptResourcePack(); } catch (e) { log('resourcePack err', e.message); }
  });

  // 2) Login only (accounts are already registered)
  bot.on('messagestr', (msg) => {
    const m = msg.toLowerCase();
    if (authSent) return;
    if (m.includes('/login')) {
      authSent = true;
      bot.chat(`/login ${acc.password}`);
      log('login sent');
      setTimeout(() => runFlow(), AFTER_LOGIN_DELAY_MS);
    } else if (m.includes('/register')) {
      needsRegister = true;
      log('WARNING: server is asking to register - this account is not registered yet (login-only mode)');
    }
  });

  // Fallback: some servers auto-login returning players (session) and never show /login
  bot.once('spawn', () => {
    setTimeout(() => {
      if (!authSent && !needsRegister && !flowRunning && !closed) {
        log('no login prompt seen (session auto-login?) -> starting flow anyway');
        runFlow();
      }
    }, 12000);
  });

  // 3) + 4) /server boxpvp then /warp afk with verification
  async function runFlow() {
    if (flowRunning) return;
    flowRunning = true;
    inAfk = false;
    stopMoving();
    try {
      bot.chat('/server boxpvp');
      log('/server boxpvp sent');
      await sleep(AFTER_SERVER_DELAY_MS);

      for (let i = 1; i <= WARP_MAX_TRIES; i++) {
        if (!bot.entity) { await sleep(3000); continue; }
        const before = bot.entity.position.clone();
        bot.clearControlStates(); // make sure we are NOT moving
        bot.chat('/warp afk');
        log(`/warp afk sent (try ${i}) - standing still`);
        await sleep(WARP_WAIT_MS);

        const moved = bot.entity ? bot.entity.position.distanceTo(before) : 0;
        if (moved >= MIN_TP_DISTANCE) {
          log(`teleport OK (moved ${moved.toFixed(1)} blocks). AFK mode ON`);
          inAfk = true;
          reachedAfk = true;
          startMoving();
          startBalCheck();
          break;
        }
        log('teleport not detected, retrying...');
        await sleep(5000);
      }
      if (!inAfk) {
        log('could not confirm AFK teleport after retries - retrying whole flow in 60s');
        setTimeout(() => { if (!closed && !inAfk) runFlow(); }, 60000);
      }
    } catch (e) {
      log('flow error:', e.message);
    } finally {
      flowRunning = false;
    }
  }

  // If we get bounced back (server switch / restart) after being AFK, redo the flow
  bot.on('spawn', () => {
    log('spawned');
    if (inAfk && !flowRunning) {
      log('respawned while AFK -> re-running flow');
      inAfk = false;
      setTimeout(() => runFlow(), 5000);
    }
  });

  // 5) Anti-AFK (only AFTER teleport is confirmed, so it never cancels /warp)
  function startMoving() {
    stopMoving();
    moveTimer = setInterval(() => {
      if (!bot.entity) return;
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
      bot.look(Math.random() * Math.PI * 2, 0, true);
    }, MOVE_EVERY_MS);
  }
  function stopMoving() {
    if (moveTimer) clearInterval(moveTimer);
    moveTimer = null;
    if (balTimer) clearInterval(balTimer);
    balTimer = null;
  }

  // Balance check: send /bal, then log the server's replies for a few seconds
  function startBalCheck() {
    if (balTimer) clearInterval(balTimer);
    const check = () => {
      if (!inAfk) return;
      balListenUntil = Date.now() + BAL_REPLY_WINDOW_MS;
      bot.chat(BAL_COMMAND);
      log(`${BAL_COMMAND} sent`);
    };
    setTimeout(check, 10000); // first check shortly after arriving
    balTimer = setInterval(check, BAL_EVERY_MS);
  }

  bot.on('messagestr', (msg) => {
    if (Date.now() < balListenUntil && msg.trim()) log('[BAL]', msg.trim());
  });

  bot.on('kicked', (r) => {
    const text = typeof r === 'string' ? r : JSON.stringify(r);
    log('kicked:', text);
    if (/\bban(ned)?\b/i.test(text)) banned = true;
  });
  bot.on('error', (e) => log('error:', e.message));
  bot.on('end', () => {
    closed = true;
    stopMoving();
    if (banned) {
      log('looks like this account is BANNED - not reconnecting.');
      return;
    }
    const nextAttempt = reachedAfk ? 0 : attempt + 1;
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (nextAttempt > 0 ? nextAttempt - 1 : 0), MAX_RECONNECT_DELAY_MS)
      + Math.floor(Math.random() * 15000); // jitter so all bots don't reconnect at the same second
    const wait = scheduleStart(acc, nextAttempt, delay);
    log(`disconnected, reconnecting in ${Math.round(wait / 1000)}s (attempt ${nextAttempt})...`);
  });
}

ACCOUNTS.forEach((acc) => scheduleStart(acc, 0, 0));
