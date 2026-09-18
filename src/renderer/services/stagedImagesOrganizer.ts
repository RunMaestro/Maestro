/**
 * stagedImagesOrganizer - ask the composer to open the expanded staged-image
 * organizer (the large "carousel" view behind the strip's Maximize button).
 *
 * The organizer's open state lives inside `StagedImagesStrip`, several levels
 * below the app-level keyboard handler that owns the shortcut. Rather than drill
 * a callback up through InputArea and MainPanel, the request rides one app-level
 * CustomEvent - the same shape `requestHeadingPalette` and
 * `requestTranscriptScrollToBottom` use.
 *
 * Fire-and-forget: the strip only mounts while images are staged, so a keypress
 * with an empty composer is a harmless no-op rather than opening an empty modal.
 */

/** Event name the mounted `StagedImagesStrip` listens for. */
export const OPEN_STAGED_IMAGES_ORGANIZER_EVENT = 'maestro:openStagedImagesOrganizer';

/**
 * Ask the mounted composer strip to open its expanded image organizer. A no-op
 * when no images are staged (the strip is unmounted), which is the intended
 * behavior - there is nothing to organize.
 */
export function requestOpenStagedImagesOrganizer(): void {
	window.dispatchEvent(new CustomEvent(OPEN_STAGED_IMAGES_ORGANIZER_EVENT));
}
