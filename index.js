// WhatsApp <-> n8n bridge
// - Connects to WhatsApp using Baileys (multi-device, QR login, free)
// - Forwards text messages to your n8n Webhook (AI replies via OpenRouter)
// - NEW: handles "!music <url>" locally — downloads MP3 via yt-dlp and sends the audio file
//
// Setup:
//   1. npm install
//   2. cp .env.example .env  →  fill in N8N_WEBHOOK_URL
//   3. Make sure yt-dlp is installed: pip install yt-dlp  (or: pip3 install yt-dlp)
//   4. npm start
//   5. Scan the QR code with WhatsApp (Linked Devices > Link a Device)

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────
const N8N_WEBHOOK_URL  = process.env.N8N_WEBHOOK_URL;
const PREFIX           = process.env.BOT_PREFIX ?? '!';   // "!" → requires prefix; "" → reply to all
const MUSIC_CMD        = 'music';                          // triggers: !music <url>
const REPLY_TIMEOUT_MS = 20_000;
const MAX_AUDIO_MB     = 15;                               // WhatsApp limit for audio files

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL in .env — set it to your n8n Webhook node URL.');
  process.exit(1);
}

// ── Bot entry point ───────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_state');
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const code          = lastDisconnect?.error?.output?.statusCode;
      const shouldRestart = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Code:', code, '— Reconnecting:', shouldRestart);
      if (shouldRestart) startBot();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleMessage(sock, msg); }
      catch (err) { console.error('Error handling message:', err); }
    }
  });
}

// ── Message router ────────────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const from = msg.key.remoteJid;
  const text = extractText(msg);
  if (!text) return;

  // Enforce prefix if one is set
  if (PREFIX && !text.startsWith(PREFIX)) return;

  const body  = PREFIX ? text.slice(PREFIX.length).trim() : text.trim();
  if (!body) return;

  const [cmd, ...args] = body.split(/\s+/);

  // ── Music branch ──────────────────────────────────────────────────────────
  if (cmd.toLowerCase() === MUSIC_CMD) {
    const url = args[0];
    if (!url || !isValidUrl(url)) {
      await sock.sendMessage(from, { text: '❌ Please provide a valid URL.\nExample: !music https://youtube.com/watch?v=...' });
      return;
    }
    await handleMusic(sock, from, url, msg.pushName || 'friend');
    return;
  }

  // ── AI chat branch (routed through n8n / OpenRouter) ─────────────────────
  console.log(`[${from}] → ${body}`);
  await sock.sendPresenceUpdate('composing', from);

  const reply = await askN8n({ chatId: from, text: body, senderName: msg.pushName || 'Unknown' });
  await sock.sendMessage(from, { text: reply || "Sorry, I didn't get a reply." });
}

// ── Music downloader ──────────────────────────────────────────────────────────
async function handleMusic(sock, from, url, senderName) {
  await sock.sendMessage(from, { text: `🎵 Downloading your track, ${senderName}… hang tight!` });
  await sock.sendPresenceUpdate('composing', from);

  const tmpDir  = await mkdtemp(join(tmpdir(), 'wa-music-'));
  const outTmpl = join(tmpDir, '%(title).80s.%(ext)s');   // cap filename length

  try {
    // Download as best-quality MP3, max 10 min to avoid huge files
    await execFileAsync('yt-dlp', [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',          // ~128 kbps — small but decent
      '--match-filter', 'duration < 600', // skip anything over 10 min
      '--no-playlist',
      '-o', outTmpl,
      '--', url,                        // "--" prevents URL being parsed as a flag
    ]);

    // Find the downloaded file
    const { stdout } = await execFileAsync('sh', ['-c', `ls "${tmpDir}"/*.mp3 | head -1`]);
    const filePath   = stdout.trim();
    if (!filePath) throw new Error('yt-dlp ran but no MP3 found.');

    // Guard against huge files
    const buf      = await readFile(filePath);
    const sizeMB   = buf.byteLength / (1024 * 1024);
    if (sizeMB > MAX_AUDIO_MB) {
      await sock.sendMessage(from, { text: `⚠️ File is ${sizeMB.toFixed(1)} MB — too big to send on WhatsApp (limit ${MAX_AUDIO_MB} MB). Try a shorter track.` });
      return;
    }

    const filename = filePath.split('/').pop();
    await sock.sendMessage(from, {
      audio:    buf,
      mimetype: 'audio/mpeg',
      fileName: filename,
      ptt:      false,   // false = audio file (not voice note)
    });

    console.log(`[${from}] ✅ Sent: ${filename} (${sizeMB.toFixed(1)} MB)`);

  } catch (err) {
    console.error('Music download error:', err.message);

    let userMsg = '❌ Download failed. ';
    if (err.message.includes('match-filter'))      userMsg += 'Track is over 10 minutes — try a shorter one.';
    else if (err.message.includes('Unsupported'))  userMsg += "That URL isn't supported. Try a YouTube link.";
    else if (err.message.includes('yt-dlp'))       userMsg += 'yt-dlp may not be installed on the server. Ask your admin.';
    else                                            userMsg += 'Check the URL and try again.';

    await sock.sendMessage(from, { text: userMsg });
  } finally {
    // Clean up tmp files regardless of outcome
    try {
      const { stdout } = await execFileAsync('sh', ['-c', `ls "${tmpDir}" 2>/dev/null`]);
      for (const f of stdout.trim().split('\n').filter(Boolean)) {
        await unlink(join(tmpDir, f)).catch(() => {});
      }
    } catch (_) {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractText(msg) {
  const m = msg.message;
  return (
    m.conversation                  ||
    m.extendedTextMessage?.text     ||
    m.imageMessage?.caption         ||
    m.videoMessage?.caption         ||
    null
  );
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

async function askN8n({ chatId, text, senderName }) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
  try {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chatId, text, senderName }),
      signal:  controller.signal,
    });
    if (!res.ok) { console.error('n8n status', res.status); return 'Backend error — try again.'; }
    const data = await res.json();
    return data.reply || data.output || JSON.stringify(data);
  } catch (err) {
    if (err.name === 'AbortError') return 'That took too long — try again.';
    console.error('Failed to reach n8n:', err.message);
    return "Couldn't reach the AI backend right now.";
  } finally {
    clearTimeout(timeout);
  }
}

startBot();
