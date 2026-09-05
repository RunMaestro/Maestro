/**
 * headingPalette - ask the open markdown preview to open its heading palette.
 *
 * Two surfaces offer the same jump list: the bare `#` key inside the preview,
 * and the "Jump to Heading" command in the Cmd+K palette. The key path is easy
 * because the preview already has focus; the command path is not, because the
 * command palette is a modal whose whole job is taking focus away from the
 * preview it wants to act on.
 *
 * The preview owns the palette's open state locally, and its ref
 * (`filePreviewRef`) is created inside `MainPanel` - three levels below the
 * command palette. Rather than drill a callback up through MainPanel and App
 * just so a modal can reach a sibling, the request rides one app-level
 * CustomEvent, the same shape `requestFileTreeRefresh` uses. Exactly one
 * FilePreview is mounted at a time (the active file tab), so there is no
 * ambiguity about who answers.
 *
 * The event is fire-and-forget: the SENDER decides whether the command should
 * exist at all (see `buildFilePreviewCommands`, which only offers it for a
 * markdown tab in preview mode that actually has headings). A request that
 * lands on a preview which cannot honor it is a no-op rather than an error.
 */

/** Event name the mounted `FilePreview` listens for. */
export const HEADING_PALETTE_EVENT = 'maestro:openHeadingPalette';

/**
 * Ask the mounted markdown preview to open its heading palette.
 *
 * No-op when nothing is listening, which is the correct behavior for a
 * keyboard-first app where the user can close the preview between opening the
 * command palette and picking the command.
 */
export function requestHeadingPalette(): void {
	window.dispatchEvent(new CustomEvent(HEADING_PALETTE_EVENT));
}
