# Stage 16 - Documentation Sources of Truth

## Objective

Remove duplicated documentation reference tables and provider lists after code contracts stabilize, leaving one authoritative section per subject and links elsewhere.

## Priority

- **108:** Consolidate duplicate documentation reference tables and provider lists.

## Dependencies

Stages 03, 05, 12, and 15 complete so provider IDs, build/CLI commands, and public contracts are stable.

## Investigation

1. Inventory repeated tables/lists across root engineering docs, `docs/`, agent guides, CLI docs, prompt source documents, and generated documentation inputs.
2. Record audience, publication system, source/generator, and whether exact duplication is required for offline/generated contexts.
3. Compare content for drift: provider IDs/names, install commands, features, links, defaults, and capability labels.
4. Identify the canonical owner for each subject. Prefer code-derived generation only when a stable existing generator/source exists; do not add a generator for one small table.
5. Treat prompt source documents separately when embedding content is a runtime requirement.

## Implementation

- Keep one complete authoritative table per subject.
- Replace repeated prose/tables with direct links and a short context sentence.
- For generated docs, edit the source and regenerate; never hand-edit output.
- For public versus internal docs, retain audience-specific guidance but link shared factual references.
- Align provider names/IDs with the canonical registry from Stage 05/12.
- Update CLI examples to Bun/Bunx and current command behavior after Stage 15.
- Verify links, anchors, navigation, and Mintlify config.

## Verification

- Search repeated table headings/provider lists and classify any remaining duplicate as intentional.
- Run documentation generation/build/link checks if available.
- Verify `docs/docs.json`, navigation, and `.mintignore` behavior.
- Inspect rendered pages for tables, anchors, and code blocks.
- Regenerate prompt/docs artifacts and confirm source/output synchronization.
- Ensure internal plans and attribution/license files are not deleted as "duplicate docs."

## Rollback

Documentation consolidation is reversible by subject. Restore content rather than leaving broken links if a target cannot be published in every required context.

## Exit criteria

Priority 108 is complete; each factual reference table/provider list has a named owner; duplicates are links or explicitly justified embeds; generated/public docs build and render correctly.

## P108 investigated content manifest

| Repeated subject                     | Observed owners/copies                                                                                                                                 | Canonical action                                                                                                               | Proof and rollback                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Template variables                   | `slash-commands.md` and `prompt-customization.md` repeat the same variable table while source/generation owns actual names.                            | Generate or link one reference table from the source-owned schema; replace prose copies with context plus link.                | Run prompt/docs generators, scan names/defaults against source, render both documents. Restore content if a published context cannot resolve the link. |
| Agent creation instructions          | `docs/agent-guides/**` repeat agent type, directory, guided/manual setup, naming, and advanced-option instructions; some duplication is near-verbatim. | Choose one agent-creation guide as owner; retain guide-specific deltas; replace repeated general sections with links.          | Link check, docs render, manually follow each guide cold; preserve offline/public embeds only with documented requirement.                             |
| Provider/model lists                 | Getting-started, troubleshooting, feature docs, and generated prompts repeat provider lists that drift from registries.                                | Generate factual lists from canonical agent/provider registries; docs explain selection policy and link/embed generated table. | Compare generated IDs/display names/aliases to source and render docs/prompts; no hand-maintained second list.                                         |
| BMAD/OpenSpec/SpecKit workflow prose | User docs and command docs repeat bundled workflow mechanics while runtime loaders remain source-owned.                                                | Keep one conceptual workflow page; command docs own syntax/examples and link the concept.                                      | Validate every command/example against CLI help/fixtures and run docs link check.                                                                      |

### Completion rule

P108 is complete only when repository search finds no duplicate factual table/provider list outside the named canonical or generated artifact, every replaced section has a valid link in all publication contexts, and generated prompts/docs are reproducible with a clean-tree check. Prose duplication with a distinct audience purpose may remain with an explicit owner note.
