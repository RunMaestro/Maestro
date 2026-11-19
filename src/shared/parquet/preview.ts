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

import { createPreviewMarkerCodec } from '../previewMarker';

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

/** The one codec behind the parquet marker; see src/shared/previewMarker.ts. */
const parquetMarker = createPreviewMarkerCodec(PARQUET_SCHEME);

/** Build the marker a parquet read returns in place of file content. */
export function buildParquetPreviewMarker(filePath: string): string {
	return parquetMarker.build(filePath);
}

/** Cheap check for "is this `fs:readFile` result a parquet marker". */
export function isParquetPreviewMarker(value: string | null | undefined): boolean {
	return parquetMarker.is(value);
}

/** Recover the path from a marker, or `null` when it is malformed. */
export function parseParquetPreviewMarker(value: string): string | null {
	return parquetMarker.parse(value);
}
