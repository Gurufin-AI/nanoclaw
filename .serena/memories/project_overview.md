# NanoClaw Project Overview

## Purpose
Personal Claude assistant (WhatsApp/Telegram bot) that routes messages to Claude Agent SDK running in isolated containers (Linux VMs). Each group has its own isolated filesystem and memory.

## Tech Stack
- **Runtime**: Node.js >= 20, TypeScript (ES2022, NodeNext modules)
- **Channels**: WhatsApp (via @whiskeysockets/baileys), Telegram (via grammy)
- **Database**: SQLite via better-sqlite3
- **Container**: Docker (or Apple Container on macOS)
- **AI**: Anthropic Claude API (Agent SDK in containers)
- **Testing**: Vitest
- **Formatting**: Prettier (singleQuote: true)
- **Bundling**: tsc (no bundler, ESM output to dist/)

## Architecture
Single Node.js process:
1. Listens on WhatsApp/Telegram channels
2. Routes messages to Claude Agent SDK
3. Agent runs in an isolated container per group
4. IPC watcher handles async container responses

## Key Directories
- `src/` - Main TypeScript source
- `src/channels/` - Channel implementations (whatsapp.ts, telegram.ts)
- `container/` - Docker container for agent (Dockerfile, agent-runner/)
- `groups/` - Per-group isolated memory (CLAUDE.md files)
- `data/` - SQLite DB and state
- `store/` - WhatsApp auth store
- `scripts/` - Utility scripts
- `setup/` - Interactive setup wizard
- `skills-engine/` - Skills processing
- `docs/` - Architecture docs
