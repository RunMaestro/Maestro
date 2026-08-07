/**
 * Table-of-contents entries for the Director's Notes AI Overview.
 *
 * Both reading modes present the same jump list, so switching Rich <-> Plain
 * doesn't change what the TOC offers or how it looks. The two modes derive it
 * differently:
 *
 * - Plain renders `narrativeToMarkdown` output, whose sections are `##`
 *   headings, so entries come straight from the markdown (and `rehype-slug`
 *   puts the matching ids in the DOM).
 * - Rich renders widget and narrative `SectionCard`s, which are not headings at
 *   all, so entries are derived from the cards that are actually on screen and
 *   the cards carry matching `id`s as scroll anchors.
 */

import GithubSlugger from 'github-slugger';
import { extractHeadings, type TocEntry } from '../Toc';
import type { DirectorNotesNarrative } from '../../../shared/directorNotesNarrative';

/**
 * Every entry uses the same level, because every section of the report is a
 * peer. It matches the `##` depth that `narrativeToMarkdown` emits, so the
 * panel renders identically in Rich and Plain mode.
 */
const SECTION_LEVEL = 2;

/** Prefix for Rich Mode anchor ids, namespaced so they can't collide. */
const RICH_ID_PREFIX = 'dn-section-';

/** Anchor id for a Rich Mode section card. */
export function richSectionId(title: string): string {
	return `${RICH_ID_PREFIX}${new GithubSlugger().slug(title)}`;
}

/**
 * Titles of the deterministic widget cards, in render order. Kept here rather
 * than inferred from the DOM so the TOC can be built during render, and so a
 * renamed card fails loudly at the call site instead of silently dropping out
 * of the list.
 */
export const RICH_WIDGET_SECTION_TITLES = [
	'Activity Timeline',
	'Success vs Failure',
	'Source Breakdown',
	'Agent Activity',
] as const;

/**
 * Build the Rich Mode jump list: the widget cards, then whichever narrative
 * sections exist. `narrative` is null when the run produced no parseable
 * narrative, in which case only the widgets are listed.
 */
export function buildRichTocEntries(narrative?: DirectorNotesNarrative | null): TocEntry[] {
	const titles: string[] = [...RICH_WIDGET_SECTION_TITLES];
	for (const section of narrative?.sections ?? []) {
		titles.push(section.title);
	}
	return titles.map((text) => ({
		level: SECTION_LEVEL,
		text,
		slug: richSectionId(text),
	}));
}

/**
 * Build the Plain Mode jump list from the rendered markdown. Uses the shared
 * heading extractor, so the slugs match the ids `rehype-slug` puts on the
 * rendered headings.
 */
export function buildPlainTocEntries(markdown: string): TocEntry[] {
	if (!markdown) return [];
	return extractHeadings(markdown);
}
