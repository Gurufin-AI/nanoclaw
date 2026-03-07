# Suggested Commands - NanoClaw

## Development
```bash
npm run dev          # Run with hot reload (tsx src/index.ts)
npm run build        # Compile TypeScript (tsc)
npm start            # Run compiled output
npm run auth         # WhatsApp auth flow
```

## Testing & Quality
```bash
npm test             # Run tests (vitest run)
npm run test:watch   # Watch mode tests
npm run typecheck    # Type check without emit (tsc --noEmit)
npm run format       # Format src/**/*.ts with Prettier
npm run format:check # Check formatting
```

## Container
```bash
./container/build.sh # Rebuild agent container
# Force clean rebuild (avoids buildkit cache issues):
docker builder prune && ./container/build.sh
```

## Service Management
```bash
# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Setup
```bash
npm run setup        # Interactive setup wizard
./setup.sh           # Shell-based setup
```
