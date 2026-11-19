/**
 * File Preview Markers
 *
 * Some files never cross the `fs:readFile` bridge as content: they are binary,
 * often larger than RAM, and their viewer only ever touches a window of them.
 * For those the main process hands back a short marker string in place of the
 * bytes, the file tab stores the marker as its `content`, and the format's own
 * viewer queries the file through a dedicated IPC surface using the tab's path.
 *
 * Parquet (`maestro-parquet://`) and SQLite (`maestro-sqlite://`) both use this.
 * Each format gets its own scheme so a viewer can never be handed a marker
 * meant for another one; the encoding is identical, so it lives here once.
 *
 * A marker grants no capability. It carries the path only so a persisted file
 * tab is self-describing in a debug dump; every query re-resolves the path
 * through the normal IPC surface.
 */

/**
 * Hex-encode UTF-8 text.
 *
 * Paths ride in markers and stream URLs as hex rather than percent-encoding so
 * Unicode filenames, `#`, `?`, and `%` survive URL normalization intact on both
 * sides of the process boundary.
 */
export function utf8ToHex(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** Inverse of {@link utf8ToHex}. Returns `null` for anything that is not clean lowercase hex. */
export function hexToUtf8(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return new TextDecoder().decode(bytes);
}

/** Build, recognise, and decode the preview marker for one file format. */
export interface PreviewMarkerCodec {
	/** The marker's URL scheme, e.g. `maestro-parquet`. */
	readonly scheme: string;
	/** The marker a read returns in place of the file's content. */
	build(filePath: string): string;
	/** Cheap check for "is this `fs:readFile` result one of this format's markers". */
	is(value: string | null | undefined): boolean;
	/** Recover the path from a marker, or `null` when it is malformed or another format's. */
	parse(value: string): string | null;
}

/** Create the marker codec for a format whose markers use `scheme`. */
export function createPreviewMarkerCodec(scheme: string): PreviewMarkerCodec {
	const prefix = `${scheme}://preview/`;
	return Object.freeze({
		scheme,
		build: (filePath: string) => `${prefix}${utf8ToHex(filePath)}`,
		is: (value: string | null | undefined) => typeof value === 'string' && value.startsWith(prefix),
		parse: (value: string) =>
			value.startsWith(prefix) ? hexToUtf8(value.slice(prefix.length)) : null,
	});
}
