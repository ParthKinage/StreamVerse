# StreamVerse (Tesor_gp): instructions for Claude Code

Read these before changing anything; they stay in force:

- `.agents/rules/followedrule.md`, `architecturerules.md`, `creativeboundries.md`, `dependencies.md`
- `TEAM_WORKFLOW.md`
- `STREAMVERSE_BUILD_SPEC.md` is the build spec (phases, approved decisions A1 to A12, acceptance checks).

Working rules: architectural changes not approved in the spec need owner approval. Never invent addresses, ABIs,
versions or credentials. Money is `bigint` in code, `Decimal(38,18)` in the database, decimal wei strings in the API.
Only `apps/api` imports `@tesor_gp/database`. Use `path.join`, spawn FFmpeg with argument arrays, prefer pure-JS packages.
Checks: `npm run lint && npm run typecheck && npm test && npm run build`.
