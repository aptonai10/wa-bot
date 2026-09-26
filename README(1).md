# WhatsApp AI Bot + Music Downloader
### Baileys + n8n + OpenRouter + yt-dlp — 100% free

```
WhatsApp ──Baileys (index.js)──┬──► n8n Webhook ──► OpenRouter ──► AI reply
                                └──► yt-dlp (local) ──────────────► MP3 audio
```

---

## Commands
| Command | What it does |
|---|---|
| `!ask <question>` | Sends question to n8n → OpenRouter AI → replies |
| `!music <url>` | Downloads YouTube (or any yt-dlp source) as MP3, sends the audio file |

Change `BOT_PREFIX` in `.env` to `""` to drop the `!` requirement.

---

## 1. Install yt-dlp (required for music)

**Linux / VPS / Termux:**
```bash
pip install yt-dlp
# or
pip3 install yt-dlp
# verify:
yt-dlp --version
```

**Windows:**
```
winget install yt-dlp
```

---

## 2. Set up n8n

- Import `n8n-workflow.json` → Workflows → Import from File
- Add an **OpenRouter** credential:
  - Type: **Header Auth**
  - Name: `Authorization`
  - Value: `Bearer sk-or-v1-YOUR_KEY`  ← get a free key at https://openrouter.ai/keys
- Open the **OpenRouter Chat** node → attach that credential
- Click **Active** to turn the workflow on
- Copy the **Production URL** from the Webhook node

---

## 3. Set up the Baileys bridge

```bash
npm install
cp .env.example .env
# open .env and set N8N_WEBHOOK_URL to the Production URL from step 2
npm start
```

Scan the QR code that prints in the terminal:
**WhatsApp → Settings → Linked Devices → Link a Device**

---

## 4. Test it

```
!music https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

You should get a "Downloading…" message, then an MP3 audio file sent back.

```
!ask what's the capital of Zambia
```

You should get an AI reply.

---

## Limits & notes

| Thing | Limit / note |
|---|---|
| Max track length | 10 minutes (enforced by `--match-filter`) |
| Max file size | 15 MB (WhatsApp audio limit) |
| Audio quality | ~128 kbps MP3 (good balance of size vs quality) |
| OpenRouter free models | Rate-limited; swap model in the n8n HTTP node if you hit limits |
| `auth_state/` folder | Stores your WA session — **never commit or share this** |

**Free hosting options to keep the Node process running:**
- Your own PC / VPS
- Termux on Android (works on your S10+)
- Render or Railway free tier (may sleep after inactivity — fine for testing)

---

## Troubleshooting

**`yt-dlp: command not found`**
→ Run `pip install yt-dlp` on the machine running `index.js`

**"Track is over 10 minutes"**
→ Edit `--match-filter duration < 600` in `index.js` to raise the limit (600 = seconds)

**"File too big"**
→ Lower audio quality: change `--audio-quality 5` to `9` (9 = smallest)

**WhatsApp disconnects**
→ The bot auto-reconnects. If it asks for QR again, just re-scan.

**n8n not replying**
→ Check that the workflow is **Active** (not just saved) and you're using the **Production URL**, not the Test URL.
