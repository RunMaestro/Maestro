/**
 * Installed-font detection for the renderer.
 *
 * Three tiers, best first:
 *   1. `queryLocalFonts()` - Chromium's Local Font Access API. Native on every
 *      platform Maestro ships to, needs no external binary, and returns the
 *      real installed set. This is the tier that actually fixes detection on
 *      macOS and Windows.
 *   2. `fonts:detect` in the main process - fontconfig's fc-list, which is the
 *      system font database on Linux and absent basically everywhere else.
 *   3. A hard-coded list, flagged unreliable so callers suppress availability
 *      annotations entirely rather than declaring installed fonts missing.
 *
 * The web client has no main process, so it gets tiers 1 and 3.
 */

import { fallbackFontResult, type FontDetectionResult } from '../../shared/fontDetection';
import { logger } from '../utils/logger';

/**
 * Shape of the Local Font Access API. Typed here rather than pulled from
 * lib.dom because the DOM lib bundled with this TypeScript version predates it.
 */
interface LocalFontData {
	family: string;
	fullName: string;
	postscriptName: string;
	style: string;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

function getQueryLocalFonts(): QueryLocalFonts | null {
	const fn = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
	return typeof fn === 'function' ? fn.bind(window) : null;
}

/**
 * Enumerate installed fonts through Chromium.
 *
 * Returns null (rather than throwing) whenever the API is missing or refuses,
 * so the caller can fall through quietly. A refusal is not an error worth
 * reporting: the API is permission-gated and a user or policy may legitimately
 * decline it, in which case the fallback tier is the correct outcome.
 */
async function detectViaLocalFontAccess(): Promise<FontDetectionResult | null> {
	const queryLocalFonts = getQueryLocalFonts();
	if (!queryLocalFonts) return null;

	try {
		const entries = await queryLocalFonts();
		// One family has many faces (Regular, Bold, Italic...). The picker
		// chooses a FAMILY, so collapse to unique family names - otherwise a
		// machine with 500 fonts renders 4000 dropdown rows.
		const families = new Set<string>();
		for (const entry of entries) {
			const family = entry.family?.trim();
			if (family) families.add(family);
		}
		if (families.size === 0) return null;

		return {
			fonts: [...families],
			source: 'local-font-access',
			reliable: true,
		};
	} catch (error) {
		logger.debug('Local Font Access unavailable, falling back', undefined, error);
		return null;
	}
}

/** Ask the main process (fontconfig), when there is one. */
async function detectViaMainProcess(): Promise<FontDetectionResult | null> {
	const detect = window.maestro?.fonts?.detect;
	if (typeof detect !== 'function') return null;

	try {
		const result = (await detect()) as FontDetectionResult | string[];
		// Older main processes returned a bare array. Treat that as reliable,
		// since that build only returned one when fc-list actually succeeded.
		if (Array.isArray(result)) {
			return { fonts: result, source: 'fc-list', reliable: true };
		}
		if (result && Array.isArray(result.fonts)) return result;
		return null;
	} catch (error) {
		logger.debug('Main-process font detection failed', undefined, error);
		return null;
	}
}

/**
 * Detect installed fonts, best tier available.
 *
 * Never rejects: a failure at every tier still yields a `fallback` result, so
 * the picker always has something to render and always knows not to trust it.
 */
export async function detectSystemFonts(): Promise<FontDetectionResult> {
	const native = await detectViaLocalFontAccess();
	if (native) return native;

	const main = await detectViaMainProcess();
	if (main) return main;

	return fallbackFontResult('no font enumeration API was available');
}
