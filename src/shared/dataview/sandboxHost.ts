/**
 * The DataviewJS guest's naming contract (D4, DV-11): the scheme, document URL, and session partition of the
 * isolated `<webview>` where note scripts run, the CSP its document is served with, the attachment gate main
 * runs in `will-attach-webview`, and the host's run limits. Pure strings, shared by the renderer (which builds
 * the `<webview>` attributes in `DataviewJsFrame`) and main (which checks the attachment and serves the
 * document in `src/main/dataview/guest-host.ts`), as `src/shared/plugins/panel-host.ts` does for plugin panels.
 *
 * - **Partition** `dataview-guest:<hash>`: one in-memory session per vault root (never `persist:`), so scripts
 *   of two vaults never share storage and nothing outlives the app. The root is hashed to keep the name short;
 *   Electron never frees a session, so their number is bounded by the roots a user opens (R-4). The prefix
 *   matches neither the plugin-panel partitions nor the browser-tab ones.
 * - **Document** `dataview-guest://sandbox/guest.html`: the only URL a guest may load. The scheme is not
 *   registered as privileged, so the document has an opaque origin.
 * - **CSP**: D4's four directives plus every fetch and navigation directive that does not fall back to
 *   `default-src` (the guide, D4). Never add a nonce, a hash, or `'strict-dynamic'` to `script-src` (any of
 *   them turns `'unsafe-inline'` off, and scripts run as inline elements, DEV-6), and never `'unsafe-eval'`.
 */

/** The scheme main serves the guest document on, in every guest session. */
export const DATAVIEW_GUEST_SCHEME = 'dataview-guest';

/** The one document a guest may load. */
export const DATAVIEW_GUEST_URL = `${DATAVIEW_GUEST_SCHEME}://sandbox/guest.html`;

/** Prefix of every guest session partition. */
export const DATAVIEW_GUEST_PARTITION_PREFIX = 'dataview-guest:';

/**
 * The guest document's Content-Security-Policy, sent as a response header and a meta tag. Chromium does not
 * implement `webrtc` yet and logs it as unrecognized; it is kept for when it does, and the guest removes the
 * WebRTC constructors itself (`lockDownScriptGlobal()`).
 */
export const DATAVIEW_GUEST_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
	"connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; " +
	"form-action 'none'; base-uri 'none'; webrtc 'block'";

/** A run that has not answered `render.done` or `render.error` within this long loses its guest (D4). */
export const DATAVIEW_JS_RUN_TIMEOUT_MS = 5000;

/** The tallest a guest frame grows, in CSS pixels; taller output scrolls inside the frame. */
export const DATAVIEW_JS_MAX_FRAME_HEIGHT = 10_000;

/** Guests one window keeps mounted at once (R-3). A block past the cap waits for a slot. */
export const DATAVIEW_JS_MAX_GUESTS_PER_WINDOW = 8;

const PARTITION_PATTERN = /^dataview-guest:[0-9a-f]{16}$/;

const FNV64_OFFSET = BigInt('0xcbf29ce484222325');
const FNV64_PRIME = BigInt('0x100000001b3');
const MASK64 = BigInt('0xffffffffffffffff');

/** FNV-1a, 64-bit, over the UTF-8 bytes of `text`, as 16 hex digits. Not a security hash: a short, stable name. */
function fnv1a64(text: string): string {
	let hash = FNV64_OFFSET;
	for (const byte of new TextEncoder().encode(text)) {
		hash = ((hash ^ BigInt(byte)) * FNV64_PRIME) & MASK64;
	}
	return hash.toString(16).padStart(16, '0');
}

/** The session partition of the guests of one vault root, on one host. */
export function dataviewGuestPartition(root: string, sshRemoteId: string | null): string {
	return `${DATAVIEW_GUEST_PARTITION_PREFIX}${fnv1a64(`${sshRemoteId ?? ''}\0${root}`)}`;
}

/** Whether `partition` is a guest partition `dataviewGuestPartition()` could have made. */
export function isDataviewGuestPartition(partition: string): boolean {
	return PARTITION_PATTERN.test(partition);
}

/**
 * The attachment gate: a `<webview>` may attach with this partition and document only when the partition is a
 * guest partition AND the document is exactly the guest URL. So a renderer bug can never point a guest at
 * another URL, and a guest partition can never host anything but the guest.
 */
export function isAllowedDataviewGuestAttachment(partition: string, src: string): boolean {
	return isDataviewGuestPartition(partition) && src === DATAVIEW_GUEST_URL;
}
