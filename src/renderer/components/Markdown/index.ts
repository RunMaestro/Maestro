/**
 * Unified Markdown renderer - public surface.
 *
 * `Markdown` is the single component every desktop markdown surface should use,
 * selected by `preset`. The leaf modules and plugin/preprocess helpers are
 * exported for the document-factory wiring and tests.
 */

export { Markdown, type MarkdownProps } from './Markdown';
export type { MarkdownPreset } from './config';
export { buildMarkdownPlugins } from './plugins';
export type {
	BuildMarkdownPluginsOptions,
	MarkdownPluginLists,
	MarkdownFileLinkOptions,
} from './plugins';
export { preprocessMarkdown, fixMarkdownLinkSpaces } from './preprocess';
export { createChatMarkdownComponents } from './chatComponents';
