# Code Style & Conventions

## TypeScript
- Strict mode enabled
- ESM (NodeNext module resolution) — use `.js` extension in imports
- Target: ES2022
- No `any` types (strict mode)

## Formatting
- Prettier with `singleQuote: true`
- Run `npm run format` before committing

## Naming
- camelCase for variables and functions
- PascalCase for types/interfaces/classes
- kebab-case for file names

## Architecture Patterns
- Channels self-register at startup via registry
- Each channel is a skill (separate git fork)
- SQLite for persistence (better-sqlite3)
- Pino for structured logging
- Zod for runtime validation
- Container-per-group isolation for agent execution

## Testing
- Vitest for all tests
- Test files alongside source: `foo.test.ts` next to `foo.ts`
- Channels also tested: `channels/telegram.test.ts`

## Task Completion Checklist
1. `npm run typecheck` — no type errors
2. `npm run format:check` — formatting ok
3. `npm test` — all tests pass
4. `npm run build` — compiles cleanly
