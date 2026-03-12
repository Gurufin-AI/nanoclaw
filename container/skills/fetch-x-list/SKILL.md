---
name: fetch-x-list
description: Scrape the latest tweets from an X (Twitter) List using the browser, summarize them, and send the report via Telegram. No X API key required.
allowed-tools: Bash(agent-browser:*), mcp__nanoclaw__send_message
---

# Fetch X List Content

Scrape the latest tweets from a public X List, summarize them, and send a structured report to the user via Telegram.

**Target list:** https://x.com/i/lists/1007168688854745088 (AI curators)

## Workflow

### Step 1 — Open the list

```bash
agent-browser open https://x.com/i/lists/1007168688854745088
agent-browser wait --load networkidle
agent-browser wait 3000
```

### Step 2 — Check for login wall

Take a snapshot and inspect what loaded:

```bash
agent-browser snapshot -c
```

- If you see a **login/sign-in prompt** or the page redirects to `x.com/login`, X is blocking public access. Skip to the **Blocked** section below.
- If you see a tweet feed, continue to Step 3.

### Step 3 — Scroll and collect tweets

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

### Step 4 — Analyze and categorize

For each collected tweet, classify it:

| Category | Signal words / patterns |
|----------|------------------------|
| 📄 **Paper** | arxiv.org, huggingface.co/papers, "paper", "research", "published" |
| 🎥 **Demo** | youtube.com, youtu.be, "demo", "try it", "live", colab link |
| 🔬 **Deep-dive** | "thread", long-form post, substack.com, "breakdown", "explained" |
| 📰 **News** | anything else noteworthy |

### Step 5 — Build and send the report

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

### Step 6 — Close the browser

```bash
agent-browser close
```

---

## If X blocks public access (login wall)

Send this message to the user:

```
⚠️ X List Fetch — Login Required

X is now requiring login to view this list. Public access is blocked.

Options to unblock:
1. Add X credentials to .env (X_USERNAME + X_PASSWORD) and I'll log in automatically next time.
2. Export the list RSS via a third-party service (nitter, etc.) — let me know if you'd like me to try that instead.
```

Then close the browser: `agent-browser close`

---

## Notes

- Do **not** use the X API or the `x-integration` skill — this is a Playwright-only scraper.
- If the page loads but tweets are sparse, try waiting longer before scrolling (X lazy-loads content).
- Timestamps on X are relative ("2h", "23h") — treat anything ≤ "23h" as within the last 24 hours.
- If you see a "Something went wrong" error page, reload once: `agent-browser reload` then wait 3000ms.
