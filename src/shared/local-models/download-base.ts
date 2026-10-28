/**
 * Where model files are downloaded from: the `localModelsDownloadBase` setting.
 *
 * The catalog pins every file to a Hugging Face URL, and that never changes:
 * the revision and the hash are the contract. A network that blocks Hugging Face
 * points the setting at a mirror that serves the same paths (`/<repo>/resolve/
 * <revision>/<file>` and `/api/models/<repo>`), and the downloader and the
 * Add from Hugging Face lookup swap the host at request time. The hash check
 * does not move: a mirror that serves different bytes is a failed download, not
 * a model.
 *
 * Pure; the main process reads the setting and the settings and CLI surfaces
 * validate with the same functions, so no surface can save a value another
 * would ignore.
 */

import { endpointBaseUrlProblem, normalizeEndpointBaseUrl } from './endpoints';
import { HUGGING_FACE_BASE_URL } from './model-catalog';

/** The settings key. Read through `resolveDownloadBase()`, never raw. */
export const LOCAL_MODELS_DOWNLOAD_BASE_SETTING = 'localModelsDownloadBase';

/** The base every catalog URL is spelled with, and what an empty setting means. */
export const DEFAULT_DOWNLOAD_BASE = HUGGING_FACE_BASE_URL;

/** Typed in the CLI or the field to put the default back. */
export const DOWNLOAD_BASE_DEFAULT_WORD = 'default';

/**
 * Why a download base is unusable, or `null` when it is fine. An empty value is
 * fine: it means the default.
 *
 * It shares the endpoint URL rules (http or https, a host, no query or
 * fragment) and adds the sentence that fits here: credentials in the URL would
 * be written to settings in the clear.
 */
export function downloadBaseProblem(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed.toLowerCase() === DOWNLOAD_BASE_DEFAULT_WORD) return null;
	if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(trimmed)) {
		return 'Do not put credentials in the URL.';
	}
	return endpointBaseUrlProblem(trimmed)?.replace('Base URL', 'Download base') ?? null;
}

/**
 * The canonical spelling of a download base, or the default for an empty value.
 * Call after {@link downloadBaseProblem} returned `null`; `default` is the word
 * for the default, so a CLI value needs no empty-string spelling.
 */
export function normalizeDownloadBase(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed.toLowerCase() === DOWNLOAD_BASE_DEFAULT_WORD) {
		return DEFAULT_DOWNLOAD_BASE;
	}
	return normalizeEndpointBaseUrl(trimmed);
}

/**
 * The base in force for a stored value. A value that is not a string or fails
 * validation (a hand-edited settings file) reads as the default rather than
 * pointing the downloader at a URL no surface would have accepted.
 */
export function resolveDownloadBase(stored: unknown): string {
	if (typeof stored !== 'string') return DEFAULT_DOWNLOAD_BASE;
	return downloadBaseProblem(stored) === null
		? normalizeDownloadBase(stored)
		: DEFAULT_DOWNLOAD_BASE;
}

/** Whether a base is a mirror: anything that is not the catalog's own host. */
export function isMirrorDownloadBase(base: string): boolean {
	return resolveDownloadBase(base) !== DEFAULT_DOWNLOAD_BASE;
}

/**
 * A catalog file URL, requested from `base` instead of Hugging Face. A URL that
 * is not under the catalog base (nothing today) is returned unchanged.
 */
export function rebaseSourceUrl(sourceUrl: string, base: string): string {
	const prefix = `${DEFAULT_DOWNLOAD_BASE}/`;
	if (!sourceUrl.startsWith(prefix)) return sourceUrl;
	return `${resolveDownloadBase(base)}/${sourceUrl.slice(prefix.length)}`;
}

/** The name a message uses for the source: "Hugging Face", or the mirror's host. */
export function downloadSourceName(base: string): string {
	const resolved = resolveDownloadBase(base);
	return resolved === DEFAULT_DOWNLOAD_BASE ? 'Hugging Face' : new URL(resolved).host;
}
