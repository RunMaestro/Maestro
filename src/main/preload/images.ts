/**
 * Preload API for session images.
 *
 * Pasted conversation images are stored content-addressed on disk (see
 * src/main/storage/session-image-store.ts) and referenced in the transcript as
 * `maestro-image://store/<sha>.<ext>`. The desktop renderer loads those refs
 * directly via the maestro-image protocol (`<img src>`), so most UI needs
 * nothing here. This namespace exists for the few consumers that need the raw
 * bytes back as a data URL: HTML export, clipboard copy, and re-sending an old
 * message's images to an agent (replay).
 */

import { ipcRenderer } from 'electron';

export function createImagesApi() {
	return {
		/**
		 * Resolve a `maestro-image://` reference to a data URL. Passes through
		 * values that are already data URLs. Resolves to null if the referenced
		 * file is missing.
		 */
		resolve: (ref: string): Promise<string | null> => ipcRenderer.invoke('images:resolve', ref),
	};
}

export type ImagesApi = ReturnType<typeof createImagesApi>;
