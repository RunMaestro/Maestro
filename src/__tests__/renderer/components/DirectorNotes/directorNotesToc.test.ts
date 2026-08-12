/**
 * Tests for the Director's Notes table-of-contents entry builders.
 *
 * The invariant that matters: the anchors these produce must match the ids
 * actually rendered on the page, or a TOC click scrolls nowhere.
 * - Rich Mode entries must match the `id` `SectionCard` receives, which comes
 *   from the same `richSectionId()` helper.
 * - Plain Mode entries must match what `rehype-slug` puts on the headings,
 *   which is why extraction goes through the shared `github-slugger` path.
 */

import { describe, it, expect } from 'vitest';
import {
	buildRichTocEntries,
	buildPlainTocEntries,
	richSectionId,
	RICH_WIDGET_SECTION_TITLES,
} from '../../../../renderer/components/DirectorNotes/directorNotesToc';
import type { DirectorNotesNarrative } from '../../../../shared/directorNotesNarrative';

const NARRATIVE: DirectorNotesNarrative = {
	version: 1,
	sections: [
		{ kind: 'accomplishments', title: 'Accomplishments', items: [{ text: 'Shipped' }] },
		{ kind: 'challenges', title: 'Challenges', items: [] },
		{ kind: 'nextSteps', title: 'Next Steps', items: [{ text: 'Keep going' }] },
	],
};

describe('richSectionId', () => {
	it('produces a namespaced, slugified anchor', () => {
		expect(richSectionId('Success vs Failure')).toBe('dn-section-success-vs-failure');
	});

	it('is stable for the same title', () => {
		expect(richSectionId('Agent Activity')).toBe(richSectionId('Agent Activity'));
	});

	it('does not collide across different titles', () => {
		expect(richSectionId('Accomplishments')).not.toBe(richSectionId('Challenges'));
	});
});

describe('buildRichTocEntries', () => {
	it('lists the widget cards followed by the narrative sections', () => {
		const entries = buildRichTocEntries(NARRATIVE);
		expect(entries.map((e) => e.text)).toEqual([
			...RICH_WIDGET_SECTION_TITLES,
			'Accomplishments',
			'Challenges',
			'Next Steps',
		]);
	});

	it('anchors every entry to the id its SectionCard will carry', () => {
		for (const entry of buildRichTocEntries(NARRATIVE)) {
			expect(entry.slug).toBe(richSectionId(entry.text));
		}
	});

	it('lists only the widget cards when there is no narrative', () => {
		for (const narrative of [null, undefined]) {
			const entries = buildRichTocEntries(narrative);
			expect(entries.map((e) => e.text)).toEqual([...RICH_WIDGET_SECTION_TITLES]);
		}
	});

	it('includes an empty narrative section so it can still be jumped to', () => {
		const entries = buildRichTocEntries(NARRATIVE);
		expect(entries.map((e) => e.text)).toContain('Challenges');
	});

	it('gives every entry the same level - the report sections are peers', () => {
		const levels = new Set(buildRichTocEntries(NARRATIVE).map((e) => e.level));
		expect(levels.size).toBe(1);
	});
});

describe('buildPlainTocEntries', () => {
	it('extracts the narrative headings from the rendered markdown', () => {
		const md = '## Accomplishments\n\n- Did a thing\n\n## Challenges\n\n- A blocker\n';
		expect(buildPlainTocEntries(md)).toEqual([
			{ level: 2, text: 'Accomplishments', slug: 'accomplishments' },
			{ level: 2, text: 'Challenges', slug: 'challenges' },
		]);
	});

	it('returns nothing for empty content', () => {
		expect(buildPlainTocEntries('')).toEqual([]);
	});

	it('ignores headings inside code fences', () => {
		const md = '## Real\n\n```\n## Not A Heading\n```\n';
		expect(buildPlainTocEntries(md).map((e) => e.text)).toEqual(['Real']);
	});

	it('disambiguates duplicate headings the way rehype-slug does', () => {
		const entries = buildPlainTocEntries('## Notes\n\n## Notes\n');
		expect(entries.map((e) => e.slug)).toEqual(['notes', 'notes-1']);
	});
});
