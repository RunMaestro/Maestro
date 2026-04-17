# Phase 02: Desktop Surface Rollout

This phase expands the prototype into the other large-text desktop surfaces where people actually read, compare, and review content in Maestro. The goal is to turn the Phase 01 proof into a coherent desktop feature by reusing the shared foundation across history, prompt/document viewers, and modal readers while preserving editing ergonomics and existing UI behavior.

## Tasks

- [x] Map the remaining desktop rollout targets before changing code:
  - Search for existing `MarkdownRenderer` usages plus plain-text readers and long-form modal views.
  - Prioritize concrete in-scope surfaces already present in the repo, especially `src/renderer/components/HistoryDetailModal.tsx`, `src/renderer/components/HistoryPanel.tsx`, `src/renderer/components/PromptComposerModal.tsx`, `src/renderer/components/AgentPromptComposerModal.tsx`, `src/renderer/components/SaveMarkdownModal.tsx`, and any large inline-wizard document preview/viewer flows.
  - Explicitly note any candidate surface that should stay out of scope because it is primarily an input control, terminal-like output, or formatting-sensitive diagnostic text.
  - Notes from repo mapping on 2026-04-17:
    - Shared Bionify foundation already exists in `src/renderer/utils/bionifyReadingMode.tsx`, with markdown opt-in plumbing in `src/renderer/components/MarkdownRenderer.tsx` and `src/renderer/utils/markdownConfig.ts`.
    - Existing opted-in desktop readers today are `src/renderer/components/FilePreview.tsx` and `src/renderer/components/AutoRun.tsx`, so Phase 02 should extend that same abstraction instead of creating new per-surface logic.
    - Highest-priority in-scope reader surfaces:
      - `src/renderer/components/HistoryDetailModal.tsx` because it already renders long-form saved responses through `MarkdownRenderer` inside a dedicated scrollable reader.
      - `src/renderer/components/InlineWizard/StreamingDocumentPreview.tsx` because it exposes both raw and markdown preview modes for generated long-form documents.
      - `src/renderer/components/Wizard/screens/PhaseReviewScreen.tsx` preview mode because it is a document-reading surface with an explicit preview/editor split.
      - `src/renderer/components/AutoRunExpandedModal.tsx` preview mode because it is another large document reader with an explicit edit/preview split.
      - `src/renderer/components/DocumentGraph/DocumentGraphView.tsx` markdown detail pane because it already uses `MarkdownRenderer` for longer-form document content.
    - Lower-priority or conditional in-scope surfaces:
      - `src/renderer/components/HistoryPanel.tsx` itself is mostly a searchable/indexed list, so the rollout should target the detail modal rather than the list rows.
      - `src/renderer/components/InlineWizard/DocumentGenerationView.tsx` is a container/orchestrator around document generation; the actual reader surface is `StreamingDocumentPreview`, plus any final preview panes it delegates to.
    - Explicit out-of-scope candidates for this phase:
      - `src/renderer/components/PromptComposerModal.tsx` because it is a live composition textarea with mention handling, cursor movement, staged images, and keyboard shortcuts.
      - `src/renderer/components/AgentPromptComposerModal.tsx` because it is a raw prompt editor textarea with template insertion and cursor-sensitive editing behavior.
      - `src/renderer/components/SaveMarkdownModal.tsx` because it is a save-path/filename form, not a content reader.
      - `src/renderer/components/DocumentsPanel.tsx` because it is a document selector/queue manager rather than a long-form reading surface.
      - `src/renderer/components/TerminalOutput.tsx`, `src/renderer/components/GroupChatMessages.tsx`, and similar terminal/chat transcript surfaces because they are terminal-like, streaming, or formatting-sensitive and should not be pulled into the desktop reading rollout without a separate decision.

- [ ] Extend the shared reading-mode abstraction instead of adding one-off per-component hacks:
  - Refine the Phase 01 utility/wrapper so plain text, rendered markdown, and mixed viewer layouts can all opt in consistently.
  - Reuse the same tokenization and exclusion rules for links, code, checklists, and selectable text.
  - Keep component-specific logic thin so future surfaces can adopt the feature by configuration rather than copy/pasted rendering code.

- [ ] Roll the feature out across history and document-reading surfaces:
  - Apply the shared Bionify mode to history/detail readers where long responses or saved content are reviewed.
  - Cover expanded document viewers and markdown save/review flows that display large blocks of text for reading rather than live editing.
  - Make sure text selection, scrolling, search, and existing affordances still work after the styling change.

- [ ] Add support for large prompt/document editors and viewers without violating the user’s exclusion rule:
  - Apply the mode only to long-form prompt/document editors or preview panes where the user is reading substantial content, not to the normal bottom chat input or other compact entry fields.
  - Favor preview/read modes over mutating raw editable inputs when that keeps cursor behavior and copy/paste safer.
  - If a specific editor must receive the feature, constrain it carefully so composition, IME behavior, and keyboard shortcuts remain correct.

- [ ] Polish the desktop UX around the new setting:
  - Make sure all newly opted-in surfaces react live when the global toggle changes, without requiring an app restart.
  - Check spacing, line breaks, bold-weight balance, and theme compatibility so the emphasized text remains readable in existing light/dark/custom themes.
  - Reuse Maestro’s existing theme tokens and avoid introducing styling that fights current typography or layout conventions.

- [ ] Add targeted desktop coverage and regression checks:
  - Write or extend renderer/unit tests around the transformation helper and at least the highest-risk desktop readers touched in this phase.
  - Verify that excluded surfaces remain excluded and that markdown-specific constructs still render correctly.
  - Run the relevant tests plus lint/type-check coverage for the touched desktop components and fix regressions before moving on.
