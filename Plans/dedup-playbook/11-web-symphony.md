# Stage 11 - Web Contracts, Feedback Uploads, and Symphony

## Objective

Consolidate web and Symphony transport mechanics while preserving browser/main trust boundaries, GitHub policy, and repository path containment.

## Priorities

- **7:** Shared web wire-contract modules.
- **77:** Feedback GitHub upload construction.
- **112:** Symphony document-reference validation.
- **115:** Symphony GitHub API request headers.

## Dependencies

Stages 02, 04, and 05 complete.

## Priority 7 - Web wire contracts

1. Inventory server callback types, WebSocket messages, web hooks, preload exposures, and web-desktop shims by domain.
2. Build a producer/consumer matrix including discriminant, payload, optionality, and validation.
3. Create transport-only shared modules by domain; do not import Electron/main internals into browser code.
4. Derive message unions from typed payload maps when practical.
5. Keep runtime decoder/validation at the boundary.
6. Migrate one domain at a time, verify server send and client dispatch, then remove local declarations.
7. Test unknown type, malformed payload, reconnect, ordering, and backwards-compatible fields.

## Priority 77 - Feedback upload construction

Compare GitHub content URL, path encoding, headers, branch/SHA semantics, commit body, base64 conversion, response parsing, and errors. Extract a feature-local request builder/upload helper, not a universal GitHub client. Keep authentication acquisition and UI error mapping outside. Test create/update, Unicode/binary attachment, missing SHA, 401/403/404/409, and oversized payload.

## Priority 112 - Document references

1. Separate syntactic input validation from resolved repository containment.
2. Extract common validation for repo slug, issue number, external GitHub URL allowlist, and document path shape.
3. Preserve downstream `path.resolve` plus containment check as the authoritative security boundary.
4. Test `..`, encoded traversal, absolute paths, mixed separators, symlink behavior, untrusted external hosts, allowed GitHub hosts, and missing files.
5. Reuse the extracted validator in create/clone/contribution flows without replacing stronger downstream checks.

## Priority 115 - GitHub headers

Define one Symphony-local request-header builder for exact repeated headers (`Accept` version and `User-Agent`) plus optional auth. Preserve endpoint-specific content types and conditional headers. Test authenticated/anonymous, pagination, error response, and representative API calls. Do not merge host allowlists with header construction.

## Security and runtime verification

- WebSocket contract type checks and runtime malformed-message tests.
- Browser reconnect and message-flow smoke.
- GitHub calls mocked for request exactness; optional live read-only smoke when credentials/environment permit.
- Symphony path traversal and host allowlist negative tests.
- Contribution/document flows verified end to end with a temporary repository.

## Rollback

Wire migrations revert by domain. Keep compatibility decoding only for a documented client version window. Document-reference validation and containment revert together; never retain a weaker upstream validator after removing stronger checks.

## Exit criteria

All four priorities have dispositions; wire types have clear domain owners; feedback upload mechanics are singular; Symphony headers are local and canonical; path containment remains independently enforced and negative tests pass.

## Investigated execution cards

|   P | Observed locations                                                                                                                                                                                                               | Canonical target and order                                                                                                                                         | Focused proof / rollback                                                                                                                                              |
| --: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   7 | Serializable duplicates span `src/main/preload/web.ts`, `src/main/web-server/types.ts`, `src/web/hooks/useWebSocket.ts`, `useCue.ts`, `useGitStatus.ts`, and `useAutoRun.ts` (`AutoRunState`, Cue, Git, session, command types). | Create domain modules under `src/shared/web-protocol`; migrate server producer, preload, client decoder, then hooks per domain; keep socket `WebClient` main-only. | Contract/discriminant tests, `bun run build:web-desktop`, browser connect/reconnect/message smoke. Revert by domain.                                                  |
|  77 | Feedback GitHub content upload code repeats URL/path/header/base64/body/response construction in feedback handlers.                                                                                                              | Add feature-local GitHub content uploader; migrate attachment then issue/submission paths; leave auth/UI mapping local.                                            | Feedback handler tests for create/update, Unicode/binary, SHA, 401/403/404/409, size. Revert uploader and callers together.                                           |
| 112 | `src/main/ipc/handlers/symphony.ts` repeats document-reference validation in contribution/create flows; downstream clone path uses `path.resolve` containment.                                                                   | Extract syntax/host/path-shape validator, migrate both callers, retain resolved containment as separate final gate.                                                | Symphony tests for `..`, encoded/mixed traversal, absolute/symlink, untrusted/allowed hosts, missing file. Revert validator and callers without removing containment. |
| 115 | At least eight Symphony GitHub requests repeat `Accept: application/vnd.github.v3+json` and `User-Agent: Maestro-Symphony`.                                                                                                      | Add Symphony-local header/request helper merging caller headers without overwrite; migrate reads/pagination, then mutations.                                       | Symphony mocked request tests for method/body/custom header/auth/pagination/error; optional live read smoke. Revert helper/callers as one module.                     |
