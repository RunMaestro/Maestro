/**
 * Surface Gloss
 *
 * One vocabulary for how much light the app chrome catches, shared by the
 * renderer (which publishes the level onto `<html data-gloss>`), the Settings
 * slider, and `maestro-cli gloss`. A click and a CLI call cannot disagree about
 * what the levels are or what order they sit in, because there is only one
 * list.
 *
 * The levels are a LADDER, ordered least to most. That ordering is what makes
 * the Settings control a slider rather than four unrelated buttons, so index
 * and value convert both ways and the control stays a plain numeric range
 * input.
 *
 * Two traps, both of which have bitten this codebase before in other guises:
 *
 * 1. `'off'` is a truthy string. Never test a gloss value for truthiness.
 *    Compare against the literals or call `isGlossOff()`.
 * 2. Anything arriving from disk, the CLI, or the web bridge goes through
 *    `asGlossLevel()` rather than a cast. An unrecognized value written
 *    straight onto `<html>` matches no rule, so the user sees the setting
 *    silently do nothing rather than get a rejected command.
 *
 * The CSS that consumes this lives in `src/renderer/index.css` under the
 * "SURFACE GLOSS" banner; every level named here must have rules there, or the
 * slider offers a stop that renders identically to the one before it.
 */

/** Every gloss level, ordered least to most intense. The order is the ladder. */
export const GLOSS_LEVELS = ['off', 'sheen', 'strong', 'max'] as const;

export type GlossLevel = (typeof GLOSS_LEVELS)[number];

/** Shipped default. Gloss is opt-in: an install that never opens Settings looks exactly as it always has. */
export const DEFAULT_GLOSS_LEVEL: GlossLevel = 'off';

export interface GlossLevelMeta {
	/** Short control label. Sentence case, no trailing period. */
	label: string;
	/** One sentence describing what the user will actually see. */
	description: string;
}

/**
 * Labels and descriptions for each level. Shared so the Settings slider and
 * `maestro-cli gloss --list` describe the same thing in the same words.
 */
export const GLOSS_LEVEL_META: Record<GlossLevel, GlossLevelMeta> = {
	off: {
		label: 'Off',
		description: 'Flat surfaces, exactly as Maestro has always rendered.',
	},
	sheen: {
		label: 'Sheen',
		description: 'A hairline highlight along the top of each bar and a short wash below it.',
	},
	strong: {
		label: 'Strong',
		description: 'A brighter highlight, a deeper wash, and a drop edge under every bar.',
	},
	max: {
		label: 'Max',
		description: 'Everything in Strong, plus an accent ring and glow around the active tab.',
	},
};

/** True when the level is the shipped, unlit rendering. Use this instead of `!level`, which is always false. */
export function isGlossOff(level: GlossLevel): boolean {
	return level === 'off';
}

/**
 * Narrow an untrusted value to a gloss level, falling back to the default.
 *
 * Use at every boundary: the settings hydration, the CLI, and the web bridge.
 */
export function asGlossLevel(value: unknown): GlossLevel {
	return typeof value === 'string' && (GLOSS_LEVELS as readonly string[]).includes(value)
		? (value as GlossLevel)
		: DEFAULT_GLOSS_LEVEL;
}

/** Position of a level on the ladder, for a slider's numeric value. */
export function glossLevelIndex(level: GlossLevel): number {
	const index = GLOSS_LEVELS.indexOf(level);
	return index === -1 ? GLOSS_LEVELS.indexOf(DEFAULT_GLOSS_LEVEL) : index;
}

/** The level at a ladder position, clamped. A range input cannot produce an out-of-range value, but a CLI or a test can. */
export function glossLevelAtIndex(index: number): GlossLevel {
	if (!Number.isFinite(index)) return DEFAULT_GLOSS_LEVEL;
	const clamped = Math.min(GLOSS_LEVELS.length - 1, Math.max(0, Math.round(index)));
	return GLOSS_LEVELS[clamped];
}
