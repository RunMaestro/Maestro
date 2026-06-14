/**
 * Public surface of the Giant tier preview module.
 *
 * Like the Fast tier barrels, this exports only the component + its
 * imperative handle type. Internal helpers (languageLoader, themeAdapter,
 * extensions, searchBridge) are reachable via deep imports for testing
 * but are not part of the public API.
 */
export { GiantPreview, default } from './GiantPreview';
export type { GiantPreviewProps, GiantPreviewHandle } from './types';
