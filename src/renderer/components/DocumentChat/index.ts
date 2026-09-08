/**
 * The File Preview's chat bubble.
 *
 * `DocumentChatOverlay` renders the floating button + panel; the conversation
 * itself lives in `services/documentChat` (an ordinary AI tab tagged with
 * `documentOrigin`) and is bound to the panel by `hooks/ui/useDocumentChat`.
 * The open/close plumbing is `useTocOverlay`, shared with the table of contents
 * on the other side of the same preview.
 */

export { DocumentChatOverlay, DOCUMENT_CHAT_WIDTH } from './DocumentChatOverlay';
export type { DocumentChatOverlayProps } from './DocumentChatOverlay';
export {
	DOCUMENT_CHAT_MODES,
	DOCUMENT_CHAT_MODE_HINTS,
	DOCUMENT_CHAT_MODE_LABELS,
	DOCUMENT_CHAT_MODE_STORAGE_KEY,
	DEFAULT_DOCUMENT_CHAT_MODE,
	asDocumentChatMode,
	isPushMode,
} from './modes';
export type { DocumentChatMode } from './modes';
