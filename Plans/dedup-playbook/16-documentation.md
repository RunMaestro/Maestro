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

Priority 108 is complete; each factual reference table/provider list has a named owner; duplicates are links or explicitly justified embeds; generated documentation is source-derived and publication links resolve. Render pages when local Mintlify tooling is available.

## P108 investigated content manifest

| Repeated subject                     | Canonical owner                                                                                                                                                        | Consolidated publication copies and explicit justification                                                                                                                                                                                                                                                                                                                                                                      | Proof and rollback                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Template variables                   | Runtime: `src/shared/templateVariables.ts` (`TEMPLATE_VARIABLES`); public reference: `docs/prompt-customization.md#template-variables`.                                | `docs/slash-commands.md` and internal `docs/agent-guides/PROMPTS-SPECS.md` now link to the public reference. Cue-only availability remains source-owned because it is assembled from the runtime event payload.                                                                                                                                                                                                                 | Verify public and internal anchors plus registry names; restore the linked table only if a publication context cannot resolve its canonical reference.                                                                                                       |
| Agent creation instructions          | Desktop creation: `docs/getting-started.md#2-create-an-agent`; provider configuration: `docs/provider-notes.md#custom-configuration`; CLI syntax: generated reference. | `docs/general-usage.md` links to the desktop and provider owners. CLI examples remain in `docs/cli.md` because terminal invocation is a distinct audience and runtime contract.                                                                                                                                                                                                                                                 | Verify desktop and CLI anchors, generated CLI reference, and provider registry names; restore the local context sentence rather than reintroducing a second configuration catalog.                                                                           |
| Provider/model lists                 | IDs/capabilities: `src/shared/agentRegistry.ts`; display names: `src/shared/agentMetadata.ts`; public capability guide: `docs/provider-notes.md`.                      | `docs/getting-started.md`, `docs/installation.md`, `docs/index.md`, `docs/features.md`, and `docs/cli.md` link to the registry-backed capability guide instead of repeating a provider catalog. `autorun-playbooks.md`, `director-notes.md`, and `feedback.md` retain only their feature-specific “installed provider” context. Provider Notes retains per-provider capability tables because that is its named public purpose. | Compare identifiers and names against both registries; validate provider, installation, and getting-started links; render those pages if local Mintlify tooling is available. Revert each link replacement independently if a public audience loses context. |
| BMAD/OpenSpec/SpecKit workflow prose | Public workflow owners: `docs/bmad-commands.md`, `docs/openspec-commands.md`, and `docs/speckit-commands.md`; runtime metadata/prompt directories own command facts.   | Internal `PROMPTS-SPECS.md` now links to the public SpecKit/OpenSpec workflows and runtime metadata rather than duplicating command catalogs. BMAD remains its own public workflow page.                                                                                                                                                                                                                                        | Validate public/internal links and run isolated refresh smokes. Restore only the affected owner/link if an audience requires a standalone offline copy.                                                                                                      |

### Completion rule

P108 is complete only when repository search finds no duplicate factual table/provider list outside the named canonical or generated artifact, every replaced section has a valid link in all publication contexts, and source regeneration plus the repository’s standard Markdown normalization leaves a clean tree. Prose duplication with a distinct audience purpose may remain with an explicit owner note.
