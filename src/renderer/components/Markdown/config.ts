/**
 * Shared types for the unified <Markdown> renderer.
 *
 * Presets bundle the plugin defaults, component map, and link behavior for a
 * rendering surface. The chat preset is the most feature-rich (Shiki, file
 * links, context menus, chat math/line-breaks, local images); document is the
 * Prism-highlighted preset for file/doc preview; wizard-bubble and release-notes
 * are minimal, tightly-styled presets.
 *
 * Note for future web/mobile adoption: the IPC-bound pieces (local image
 * loading via window.maestro.fs, shell.openPath) live in the chat/document
 * component maps. A platform adapter ({ readFile, openExternalUrl,
 * openFilePath, copyText }) would let a web build reuse this shell - tracked as
 * out-of-scope for the desktop-first consolidation.
 */

export type MarkdownPreset = 'chat' | 'document' | 'wizard-bubble' | 'release-notes';
