/**
 * Public surface of the Fast tier text/code preview module.
 *
 * The barrel intentionally exports only the component + the imperative
 * handle type. Internal modules (pagination, codeHighlighter, searchHits,
 * proseStyles) are reachable via deep imports for testing but are not part
 * of the public surface.
 */
export { TextPreviewFast, default } from './TextPreviewFast';
export type { TextPreviewFastProps, TextPreviewFastHandle } from './types';
