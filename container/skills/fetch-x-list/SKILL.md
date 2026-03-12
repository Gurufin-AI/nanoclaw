---
name: fetch-x-list
description: Scrape the latest tweets from an X (Twitter) List using the browser, summarize them, and send the report via Telegram. No X API key required. Uses cookie-based auth (X_AUTH_TOKEN) to bypass login walls.
allowed-tools: Bash(agent-browser:*), mcp__nanoclaw__send_message
---

# Fetch X List Content

Scrape the latest tweets from a public X List, summarize them, and send a structured report to the user via Telegram.

**Target list:** https://x.com/i/lists/1007168688854745088 (AI curators)

## Workflow

### Step 1 — Inject auth cookie (if available)

Check whether `X_AUTH_TOKEN` is set in the environment:

```bash
echo "${X_AUTH_TOKEN:-NOT_SET}"
```

If the value is **not** `NOT_SET`, inject the cookie before navigating:

```bash
# Open X root domain so the cookie is set on the correct origin
agent-browser open https://x.com
agent-browser wait --load networkidle
agent-browser wait 1000

# Inject the auth_token cookie (valid for x.com and subdomains)
agent-browser cookies set auth_token "$X_AUTH_TOKEN" --domain .x.com --path / --secure
agent-browser wait 500
```

If `X_AUTH_TOKEN` is `NOT_SET`, skip cookie injection and proceed — X may still allow public access.

### Step 2 — Open the list

```bash
agent-browser open https://x.com/i/lists/1007168688854745088
agent-browser wait --load networkidle
agent-browser wait 3000
```

### Step 3 — Check for login wall

Take a snapshot and inspect what loaded:

```bash
agent-browser snapshot -c
```

- If you see a **login/sign-in prompt** or the page redirects to `x.com/login`, X is blocking access. Skip to the **Blocked** section below.
- If you see a tweet feed, continue to Step 4.

### Step 4 — Scroll and collect tweets

Scroll down to load the past ~24 hours of tweets. Collect tweet text, author, timestamp, and any URLs.

```bash
# Scroll progressively to load more tweets
agent-browser scroll down 2000
agent-browser wait 2000
agent-browser scroll down 2000
agent-browser wait 2000
agent-browser scroll down 2000
agent-browser wait 2000
```

After scrolling, extract tweet content:

```bash
agent-browser snapshot -s "article"
```

For each visible tweet `article`:
- `agent-browser get text @eN` — tweet text
- `agent-browser get attr @eN href` — any links inside the tweet

Stop collecting when tweets are older than 24 hours from now.

### Step 5 — Analyze and categorize

For each collected tweet, classify it:

| Category | Signal words / patterns |
|----------|------------------------|
| 📄 **Paper** | arxiv.org, huggingface.co/papers, "paper", "research", "published" |
| 🎥 **Demo** | youtube.com, youtu.be, "demo", "try it", "live", colab link |
| 🔬 **Deep-dive** | "thread", long-form post, substack.com, "breakdown", "explained" |
| 📰 **News** | anything else noteworthy |

### Step 6 — Build and send the report

Send the report using `mcp__nanoclaw__send_message` with this format:

```
🐦 X List Digest — [DATE] (last 24h)
📋 [N] tweets from [M] authors

━━━━━━━━━━━━━━━━━━━━━━━━━━━

📄 PAPERS & RESEARCH
• [Author] — [short summary] → [URL if present]

🎥 DEMOS & TOOLS
• [Author] — [short summary] → [URL if present]

🔬 DEEP-DIVES & THREADS
• [Author] — [short summary] → [URL if present]

📰 OTHER NOTABLE POSTS
• [Author] — [short summary]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 [1-2 sentence overall takeaway about today's AI discourse]
```

Keep each bullet to one line. Omit sections with zero entries.

### Step 7 — Close the browser

```bash
agent-browser close
```

---

## If X blocks access (login wall)

Send this message to the user:

```
⚠️ X List Fetch — Login Required

X is requiring login to view this list. Public access is blocked.

To fix this, add your X auth_token cookie to .env:
  X_AUTH_TOKEN=your_token_here

See the "How to extract your auth_token" section in the fetch-x-list skill for step-by-step instructions.
```

Then close the browser: `agent-browser close`

---

## How to extract your auth_token

Your `auth_token` is a long-lived session cookie that X stores in your browser after login. It never expires unless you log out.

**Steps (Chrome / Edge / Brave):**

1. Open [https://x.com](https://x.com) and make sure you are logged in.
2. Press **F12** (or right-click → Inspect) to open DevTools.
3. Go to the **Application** tab → **Storage** → **Cookies** → `https://x.com`.
4. Find the cookie named **`auth_token`** in the list.
5. Copy the **Value** column — it looks like a long hex string (e.g. `abc123def456...`).

**Steps (Firefox):**

1. Open [https://x.com](https://x.com) and log in.
2. Press **F12** → **Storage** tab → **Cookies** → `https://x.com`.
3. Find **`auth_token`** and copy its value.

**Add it to your `.env` file:**

```
X_AUTH_TOKEN=abc123def456...
```

Then restart NanoClaw (`systemctl --user restart nanoclaw` on Linux, or `launchctl kickstart` on macOS) for the new env var to take effect.

> **Security note:** `auth_token` gives full access to your X account. Keep it in `.env` and never commit it to version control. The `.env` file is in `.gitignore` by default.

---

## Notes

- Do **not** use the X API or the `x-integration` skill — this is a Playwright-only scraper.
- If the page loads but tweets are sparse, try waiting longer before scrolling (X lazy-loads content).
- Timestamps on X are relative ("2h", "23h") — treat anything ≤ "23h" as within the last 24 hours.
- If you see a "Something went wrong" error page, reload once: `agent-browser reload` then wait 3000ms.
- The cookie injection sets `auth_token` on `.x.com` (with leading dot), which covers both `x.com` and `www.x.com`.
