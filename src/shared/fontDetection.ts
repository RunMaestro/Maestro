/**
 * Font-detection result types, shared by the main-process probe and the
 * renderer that consumes it.
 *
 * The `source` field is the important part. Detection has three tiers and only
 * the first two actually enumerate the machine; the third is a hard-coded guess
 * used when nothing else worked. A caller that cannot tell them apart will
 * cheerfully annotate Arial "(Not Found)" on a Mac that has Arial, because the
 * fallback list happens not to mention it - which reads to the user as a broken
 * feature rather than as failed detection.
 *
 * So: a result whose source is `fallback` means "we do not know what is
 * installed", NOT "these seven fonts are what is installed". The UI must
 * suppress availability annotations entirely in that case.
 */

export type FontDetectionSource =
	/** Chromium's Local Font Access API. Native, complete, no external binary. */
	| 'local-font-access'
	/** fontconfig's fc-list. Complete where fontconfig exists (mainly Linux). */
	| 'fc-list'
	/** Nothing enumerated the machine. The list is a guess; availability is unknown. */
	| 'fallback';

export interface FontDetectionResult {
	fonts: string[];
	source: FontDetectionSource;
	/**
	 * Whether `fonts` reflects the real machine. False for `fallback`, which is
	 * the single flag every availability check should gate on.
	 */
	reliable: boolean;
	/** Why detection degraded, for the Settings hint and the logs. */
	reason?: string;
}

/**
 * Last-resort list. Deliberately NOT presented as "what is installed" - see the
 * module comment. These are the faces most likely to exist somewhere, used only
 * so the picker has something to show.
 */
export const FALLBACK_SYSTEM_FONTS = [
	'Monaco',
	'Menlo',
	'Courier New',
	'Consolas',
	'Roboto Mono',
	'Fira Code',
	'JetBrains Mono',
];

export function fallbackFontResult(reason: string): FontDetectionResult {
	return {
		fonts: FALLBACK_SYSTEM_FONTS,
		source: 'fallback',
		reliable: false,
		reason,
	};
}

/** Human sentence for the Settings hint under a font picker. */
export function describeFontDetection(result: FontDetectionResult): string {
	switch (result.source) {
		case 'local-font-access':
			return `${result.fonts.length} installed fonts detected.`;
		case 'fc-list':
			return `${result.fonts.length} installed fonts detected via fontconfig.`;
		case 'fallback':
			return "Couldn't read the installed font list, so fonts aren't marked available or missing. Bundled fonts always work.";
	}
}
