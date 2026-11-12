/**
 * Tests for src/shared/markdown.ts: `firstHeadingSection`, which cuts the verdict out of the report
 * file a launched playbook writes.
 */

import { describe, expect, it } from 'vitest';
import { firstHeadingSection } from '../../shared/markdown';

describe('firstHeadingSection', () => {
	it('returns the first heading and the text under it', () => {
		const content = ['# Report', '', 'All checks passed.', '', 'Nothing to fix.'].join('\n');

		expect(firstHeadingSection(content)).toEqual({
			heading: 'Report',
			level: 1,
			body: 'All checks passed.\n\nNothing to fix.',
		});
	});

	it('stops at the next heading of any level, so a subsection is not part of the body', () => {
		const content = [
			'## Status',
			'INSTALLED-ACTIVE',
			'### Details',
			'More.',
			'## Next',
			'Later.',
		].join('\n');

		expect(firstHeadingSection(content)).toEqual({
			heading: 'Status',
			level: 2,
			body: 'INSTALLED-ACTIVE',
		});
	});

	it('passes over a title with nothing under it for the section after it', () => {
		const content = [
			'# LifeOS Setup',
			'',
			'## Status',
			'',
			'INSTALLED-ACTIVE',
			'',
			'## Notes',
			'x',
		].join('\n');

		expect(firstHeadingSection(content)).toEqual({
			heading: 'Status',
			level: 2,
			body: 'INSTALLED-ACTIVE',
		});
	});

	it('passes over every heading that has only whitespace under it', () => {
		const content = ['# A', '   ', '## B', '', '### C', 'Found.'].join('\n');

		expect(firstHeadingSection(content)?.heading).toBe('C');
	});

	it('returns null when no heading has text under it', () => {
		expect(firstHeadingSection('# Title\n\n## Empty\n')).toBeNull();
		expect(firstHeadingSection('# Only a title')).toBeNull();
	});

	it('returns null for text with no heading at all', () => {
		expect(firstHeadingSection('Just some prose.\nAnd more of it.')).toBeNull();
	});

	it('returns null for an empty document', () => {
		expect(firstHeadingSection('')).toBeNull();
	});

	it('ignores text before the first heading', () => {
		const content = ['Preface that is not a section.', '', '# Verdict', 'Ship it.'].join('\n');

		expect(firstHeadingSection(content)).toEqual({
			heading: 'Verdict',
			level: 1,
			body: 'Ship it.',
		});
	});

	it('does not read a # line inside a fenced code block as a heading', () => {
		const content = [
			'# Report',
			'',
			'Run this:',
			'',
			'```sh',
			'# install the thing',
			'make install',
			'```',
			'',
			'## Next',
			'Later.',
		].join('\n');

		const section = firstHeadingSection(content);

		expect(section?.heading).toBe('Report');
		expect(section?.body).toBe(
			['Run this:', '', '```sh', '# install the thing', 'make install', '```'].join('\n')
		);
	});

	it('does not read a heading inside a tilde fence, or inside a longer fence', () => {
		const content = [
			'# Report',
			'~~~',
			'## not a heading',
			'~~~',
			'````',
			'```',
			'## nor this',
			'````',
		].join('\n');

		const section = firstHeadingSection(content);

		expect(section?.heading).toBe('Report');
		expect(section?.body).toContain('## not a heading');
		expect(section?.body).toContain('## nor this');
	});

	it('does not find a heading in a fence that never closes', () => {
		expect(firstHeadingSection('Intro\n```\n# Hidden\ntext')).toBeNull();
	});

	it('keeps a markdown table under the heading as written', () => {
		const content = [
			'## Verdict',
			'',
			'| Check | Result |',
			'| --- | --- |',
			'| Lint | pass |',
		].join('\n');

		expect(firstHeadingSection(content)?.body).toBe(
			'| Check | Result |\n| --- | --- |\n| Lint | pass |'
		);
	});

	it('reads CRLF line endings', () => {
		const content = '# Report\r\n\r\nDone.\r\n\r\n## Next\r\nLater.\r\n';

		expect(firstHeadingSection(content)).toEqual({ heading: 'Report', level: 1, body: 'Done.' });
	});

	it('reads a lone carriage return as a line break', () => {
		expect(firstHeadingSection('# Report\rDone.')).toEqual({
			heading: 'Report',
			level: 1,
			body: 'Done.',
		});
	});

	describe('what counts as a heading', () => {
		it.each([
			['#', 1],
			['##', 2],
			['###', 3],
			['####', 4],
			['#####', 5],
			['######', 6],
		])('reads %s as level %i', (marks, level) => {
			expect(firstHeadingSection(`${marks} Title\nText`)).toEqual({
				heading: 'Title',
				level,
				body: 'Text',
			});
		});

		it('does not read seven marks as a heading', () => {
			expect(firstHeadingSection('####### Title\nText')).toBeNull();
		});

		it('needs a space or tab after the marks, so #hashtag is text', () => {
			expect(firstHeadingSection('#hashtag\nText')).toBeNull();
			expect(firstHeadingSection('#\tTabbed\nText')?.heading).toBe('Tabbed');
		});

		it('allows up to three spaces before the marks, and no more', () => {
			expect(firstHeadingSection('   # Indented\nText')?.heading).toBe('Indented');
			expect(firstHeadingSection('    # Code block\nText')).toBeNull();
		});

		it('drops a closing run of # and trailing spaces from the heading text', () => {
			expect(firstHeadingSection('## Title ##  \nText')?.heading).toBe('Title');
			expect(firstHeadingSection('## Title   \nText')?.heading).toBe('Title');
		});

		it('keeps a # that is part of the text', () => {
			expect(firstHeadingSection('# C#\nText')?.heading).toBe('C#');
			expect(firstHeadingSection('# Issue #12\nText')?.heading).toBe('Issue #12');
		});

		it('does not read underlined (setext) headings', () => {
			expect(firstHeadingSection('Title\n=====\nText')).toBeNull();
		});
	});
});
