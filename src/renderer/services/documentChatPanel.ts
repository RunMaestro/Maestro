/**
 * documentChatPanel - ask the open file preview to show its chat bubble.
 *
 * Same arrangement, and the same reason, as `headingPalette.ts`: the preview
 * owns the panel's open state locally, its ref is created three levels below the
 * command palette, and the palette is a modal whose whole job is taking focus
 * away from the surface it wants to act on. Drilling a setter up through
 * MainPanel and App so a modal can reach a sibling would be worse than one
 * app-level `CustomEvent`, and exactly one `FilePreview` is mounted at a time
 * (the active file tab), so there is no ambiguity about who answers.
 *
 * Fire-and-forget on purpose. The SENDER decides whether the command should
 * exist - the palette only offers it for a previewed file with text in it - and
 * a request that lands on a preview which cannot honor it is a no-op rather than
 * an error, which is the right behaviour when the user can close the preview
 * between opening the palette and picking the command.
 *
 * Distinct from `services/documentChat`, which owns the CONVERSATION and is
 * callable from anywhere. This module only moves a panel on screen.
 */

/** Event name the mounted `FilePreview` listens for. */
export const DOCUMENT_CHAT_PANEL_EVENT = 'maestro:openDocumentChat';

/** Ask the mounted file preview to open its chat bubble. */
export function requestDocumentChatPanel(): void {
	window.dispatchEvent(new CustomEvent(DOCUMENT_CHAT_PANEL_EVENT));
}
