# Code Style & Conventions - NanoClaw

## TypeScript
- Strict mode enabled
- ES2022 target, NodeNext module resolution
- ESM modules (`.js` extensions in imports)
- No bundler — compiles directly to `dist/`

## Formatting (Prettier)
- `singleQuote: true`
- Default Prettier settings otherwise (2-space indent, 80 char line width)

## Naming Conventions
- **camelCase** for variables, functions
- **PascalCase** for interfaces, types, classes
- **UPPER_SNAKE_CASE** for constants (config/env vars)
- Files: kebab-case or camelCase `.ts`

## File Structure Patterns
- Channel implementations live in `src/channels/`
- Each channel exports a class or object conforming to a channel interface
- Config constants centralized in `src/config.ts` (read from env via `src/env.ts`)
- Types centralized in `src/types.ts`

## Testing
- Test files colocated with source: `foo.test.ts` alongside `foo.ts`
- Uses Vitest
- Config: `vitest.config.ts`

## General
- No docstrings (not a pattern in this codebase)
- Minimal comments — only where logic is non-obvious
- Prefer explicit types over `any`
