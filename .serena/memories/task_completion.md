# Task Completion Checklist - NanoClaw

When finishing a coding task:

1. **Type check**: `npm run typecheck`
2. **Format**: `npm run format`
3. **Test**: `npm test`
4. If container-related changes: `./container/build.sh`
5. If service needs restart: `systemctl --user restart nanoclaw`

## Notes
- No linter (ESLint) configured — only Prettier for formatting
- Husky pre-commit hooks are set up (check `.husky/` for hooks)
- Container buildkit caches aggressively — if COPY steps seem stale, run `docker builder prune` first
