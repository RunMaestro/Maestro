/**
 * Helpers for handling files dragged into Maestro from the OS (Finder on macOS,
 * Explorer on Windows, file managers on Linux).
 *
 * Electron removed the non-standard `File.path` property, so the absolute
 * filesystem path of a dropped file must be recovered via `webUtils`, which is
 * only reachable from the preload context. `window.maestro.fs.getPathForFile`
 * bridges to it. Folders dropped from the OS arrive as a single `File` entry
 * (the directory itself); the resolved path points at the folder and the main
 * process copies it recursively.
 *
 * In the web-desktop (browser) build there is no `webUtils` and no path to
 * recover, so `uploadPathlessFile` uploads the bytes to the machine running
 * Maestro instead.
 */

/** True when a drag carries OS files (as opposed to an internal element drag). */
export function dragHasOsFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types).includes('Files');
}

/**
 * Resolve the absolute paths of every OS file/folder in a drop. Entries whose
 * path cannot be resolved (e.g. synthesized File objects with no disk backing)
 * are dropped from the result.
 */
export function getDroppedPaths(dataTransfer: DataTransfer | null): string[] {
	if (!dataTransfer) return [];
	const out: string[] = [];
	const files = dataTransfer.files;
	for (let i = 0; i < files.length; i++) {
		const path = window.maestro.fs.getPathForFile(files[i]);
		if (path) out.push(path);
	}
	return out;
}

/**
 * Largest browser upload we accept. The bytes travel to the host as base64
 * inside a single WebSocket bridge message, so an unbounded file would stall
 * the bridge for every other call.
 */
export const MAX_BROWSER_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Read a `File` as raw base64, with the `data:<mime>;base64,` prefix stripped. */
function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = typeof reader.result === 'string' ? reader.result : '';
			const comma = result.indexOf(',');
			if (comma === -1) {
				reject(new Error(`Could not read ${file.name}`));
				return;
			}
			resolve(result.slice(comma + 1));
		};
		// Folders dragged into a browser arrive as `File` entries that cannot be
		// read, so this is the folder case as well as genuine read failures.
		reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
		reader.readAsDataURL(file);
	});
}

/**
 * Copy a dropped `File` that has no filesystem path onto the machine running
 * Maestro, and resolve with the absolute path it landed on.
 *
 * The web-desktop build runs the renderer in a plain browser, where `File`
 * objects carry no path (`getPathForFile` returns `''`) and the file may not
 * even live on the same machine as the agent. Uploading the bytes into the
 * session's attachments directory gives the agent a real path to read. Rejects
 * with a user-readable message so callers can surface the failure instead of
 * dropping the file silently.
 *
 * @param ownerId - Session (or group chat) id the attachment belongs to.
 */
export async function uploadPathlessFile(file: File, ownerId: string): Promise<string> {
	if (file.size > MAX_BROWSER_UPLOAD_BYTES) {
		const limitMb = Math.round(MAX_BROWSER_UPLOAD_BYTES / (1024 * 1024));
		throw new Error(`${file.name} is larger than the ${limitMb} MB upload limit`);
	}
	const base64 = await readFileAsBase64(file);
	const result = await window.maestro.attachments.save(ownerId, base64, file.name);
	if (!result.success || !result.path) {
		throw new Error(result.error || `Could not attach ${file.name}`);
	}
	return result.path;
}
