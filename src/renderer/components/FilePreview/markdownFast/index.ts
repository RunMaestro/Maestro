/**
 * Public surface of the Fast tier markdown preview module.
 *
 * Keeping the barrel intentionally narrow - only the React component is part
 * of the public API. Internal helpers (pipeline, sanitize, linkRouter,
 * proseStyles) are reachable via deep imports for testing but are not
 * re-exported, so adding a new helper does not silently widen the public
 * surface.
 */
export { MarkdownPreviewFast, default } from './MarkdownPreviewFast';
export type { MarkdownPreviewFastProps, MarkdownPreviewFastHandle } from './types';
