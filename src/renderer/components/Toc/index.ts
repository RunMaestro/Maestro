/**
 * Shared table-of-contents control.
 *
 * `TocOverlay` renders the floating button + panel; `useTocOverlay`
 * (`hooks/ui/useTocOverlay`) owns the hotkey, Escape, and click-outside
 * behavior. Use both together so every surface behaves identically.
 */

export { TocOverlay } from './TocOverlay';
export { computeTocWidth } from './tocWidth';
export { extractHeadings } from './extractHeadings';
export type { TocEntry } from './types';
