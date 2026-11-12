/**
 * Markdown heading extraction for the table of contents.
 *
 * Lives in the shared TOC library because every surface that renders markdown
 * and offers a jump list needs the same entries: File Preview and Director's
 * Notes today. Slugs come from `github-slugger`, the same slugger `rehype-slug`
 * uses, so these slugs match the `id`s on the rendered headings.
 */

import GithubSlugger from 'github-slugger';
import type { TocEntry } from './types';

/** Extract headings from markdown content for a table of contents. */
export const extractHeadings = (content: string): TocEntry[] => {
	const headings: TocEntry[] = [];
	const lines = content.split('\n');
	let inCodeFence = false;
	const slugger = new GithubSlugger();

	for (const line of lines) {
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;

		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const text = match[2].trim();
			const slug = slugger.slug(text);
			headings.push({ level, text, slug });
		}
	}

	return headings;
};
