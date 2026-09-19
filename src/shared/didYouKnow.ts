/**
 * Shared data model for Did You Know? discovery tips.
 *
 * Tip ids are permanent: renaming one re-shows a tip everyone already dismissed.
 * The pinned list is a deliberate editorial choice, not an accident of array order.
 */
import type { UiSurfaceEncoreFlag } from './uiSurfaces';

export interface DidYouKnowTip {
	/** Stable kebab-case id persisted in the seen list. Never rename once shipped. */
	id: string;
	/** Feature name as spelled in the app. */
	title: string;
	/** One-sentence hook that works even if the body is never read. */
	headline: string;
	/** Two to four short paragraphs of plain text, without markdown. */
	body: string[];
	/** lucide-react export name, resolved by the card. */
	icon: string;
	/** Screenshot filename under src/renderer/assets/did-you-know/, cropped to the frame aperture aspect. Omit for an icon plate. */
	art?: string;
	/** Live element CSS selector, reusing data-tour attributes when a static image is less helpful. */
	spotlightSelector?: string;
	/** UiSurface.id used by the primary button. */
	surface?: string;
	/** Key in DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS for the keystroke chip. */
	shortcutId?: string;
	/** Page under docs/ without .md, opened by the in-app Read more action. */
	docsSlug?: string;
	/** Example maestro-cli invocation displayed as a copyable code chip. */
	cli?: string;
	/** When disabled, the card offers Turn it on instead of Open it. */
	encore?: UiSurfaceEncoreFlag;
}

export const DID_YOU_KNOW_TIPS: readonly DidYouKnowTip[] = [];

export const PINNED_TIP_IDS: readonly string[] = [
	'maestro-cue',
	'auto-run',
	'cross-agent-mentions',
	'group-chat',
	'remote-agents',
];
