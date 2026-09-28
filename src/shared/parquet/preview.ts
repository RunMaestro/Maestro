/**
 * Parquet Preview Handoff
 *
 * `fs:readFile` cannot hand a parquet file back as text. The format is binary,
 * columnar, and routinely larger than the machine's RAM, and the whole point
 * of previewing one is to touch only the columns and row groups being looked
 * at. So the read short-circuits: the main process returns a short marker
 * string, the file tab stores that instead of content, and the renderer's
 * ParquetViewer talks to the `parquet:*` query IPC using the tab's own path.
 *
 * This is the same trick audio and video use (see src/shared/mediaTypes.ts)
 * for the same reason - the difference is that media hands the renderer a URL
 * Chromium range-requests, while parquet hands it a marker and keeps every
 * byte on the main-process side of the bridge.
 *
 * The marker grants no capability. It carries the path only so a persisted
 * file tab is self-describing in a debug dump; every query re-resolves the
 * path through the normal IPC surface.
 */

/** Marker scheme stored in a file tab's `content` in place of parquet bytes. */
export const PARQUET_SCHEME = 'maestro-parquet';

/** Extensions routed to the parquet viewer. */
const PARQUET_EXTENSIONS = new Set(['parquet', 'parq', 'pq']);

/**
 * Extract a lowercase extension, or `null` when there is none.
 *
 * Mirrors the media helper rather than a bare `split('.').pop()` so an
 * extensionless file named `parquet` inside a `foo.parquet/` directory is not
 * mistaken for one.
 */
function getExtension(filePath: string): string | null {
	const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	const name = filePath.slice(lastSlash + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return null;
	return name.slice(dot + 1).toLowerCase();
}

/** Whether a path names a parquet file. */
export function isParquetFile(filePath: string): boolean {
	const ext = getExtension(filePath);
	return ext !== null && PARQUET_EXTENSIONS.has(ext);
}

/** Hex-encode UTF-8 text so any filename survives round-tripping intact. */
function toHex(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** Inverse of {@link toHex}. Returns `null` for anything that is not clean hex. */
function fromHex(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return new TextDecoder().decode(bytes);
}

/** Build the marker a parquet read returns in place of file content. */
export function buildParquetPreviewMarker(filePath: string): string {
	return `${PARQUET_SCHEME}://preview/${toHex(filePath)}`;
}

/** Cheap check for "is this `fs:readFile` result a parquet marker". */
export function isParquetPreviewMarker(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.startsWith(`${PARQUET_SCHEME}://preview/`);
}

/** Recover the path from a marker, or `null` when it is malformed. */
export function parseParquetPreviewMarker(value: string): string | null {
	const prefix = `${PARQUET_SCHEME}://preview/`;
	if (!value.startsWith(prefix)) return null;
	return fromHex(value.slice(prefix.length));
}
