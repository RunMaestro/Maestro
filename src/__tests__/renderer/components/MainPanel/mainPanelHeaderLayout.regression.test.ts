/**
 * Regression coverage for two Main Panel header layout rules that jsdom cannot
 * see (it has no layout engine), so a render test passes while the header is
 * visibly broken:
 *
 * 1. The session name and the branch name truncate with an ellipsis. That only
 *    works while both labels are BLOCK containers: `text-overflow: ellipsis`
 *    does nothing on a flex container, and the text was clipped mid-glyph.
 * 2. The three header zones (left cluster, AUTO pill, right cluster) keep a
 *    minimum gap. `justify-between` alone leaves none once the left cluster
 *    has shrunk, and the AUTO pill sat flush against the context readout.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENT = 'src/renderer/components/MainPanel/MainPanelHeader.tsx';
const STYLESHEET = 'src/renderer/index.css';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

/** Every top-level (non-@container) rule body whose selector list names `className`. */
const baseRulesFor = (rawCss: string, className: string): string[] => {
	// Comments can hold braces, which would throw the depth count off.
	const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
	const bodies: string[] = [];
	const rule = /([^{}]+)\{([^{}]*)\}/g;
	// Skip rules nested in an at-rule: track brace depth between matches.
	let depth = 0;
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = rule.exec(css)) !== null) {
		const between = css.slice(cursor, match.index);
		depth += (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
		cursor = match.index + match[0].length;
		if (depth !== 0) continue;
		if (match[1].split(',').some((s) => s.trim() === `.${className}`)) bodies.push(match[2]);
	}
	return bodies;
};

describe('Main Panel header layout', () => {
	it.each(['header-session-name', 'header-git-branch-text'])(
		'keeps .%s a block container so truncate can draw an ellipsis',
		(className) => {
			expect(read(COMPONENT)).toMatch(new RegExp(`${className} truncate`));
			const bodies = baseRulesFor(read(STYLESHEET), className);
			expect(bodies.length).toBeGreaterThan(0);
			for (const body of bodies) {
				expect(body).not.toMatch(/display:\s*(inline-)?flex/);
			}
		}
	);

	it('keeps a minimum gap between the header zones', () => {
		expect(read(COMPONENT)).toMatch(/header-container[^`]*justify-between gap-\d/);
	});
});
