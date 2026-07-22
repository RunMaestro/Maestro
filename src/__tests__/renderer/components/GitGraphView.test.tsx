import { describe, it, expect } from 'vitest';
import {
	buildGitGraphTemplate,
	GIT_GRAPH_BRANCH_COLORS,
} from '../../../renderer/components/GitGraphView';
import type { Theme } from '../../../renderer/types';

// Minimal theme stub - only the color fields the template reads.
const theme = {
	colors: {
		accent: 'rgb(1, 2, 3)',
		bgSidebar: 'rgb(10, 11, 12)',
		textMain: 'rgb(255, 255, 255)',
		border: 'rgb(50, 50, 50)',
	},
} as unknown as Theme;

describe('buildGitGraphTemplate (issue #1278)', () => {
	const template = buildGitGraphTemplate(theme);

	it('uses the Maestro monospace stack for message, branch label, and tag fonts', () => {
		expect(template.commit.message.font).toContain('JetBrains Mono');
		expect(template.commit.message.font).toContain('monospace');
		expect(template.branch.label.font).toContain('monospace');
		expect(template.tag.font).toContain('monospace');
		// No sans-serif should remain anywhere in the typography.
		expect(template.commit.message.font).not.toContain('sans-serif');
		expect(template.branch.label.font).not.toContain('sans-serif');
	});

	it('does not hardcode a flat message color, so text inherits its branch color', () => {
		// @gitgraph only fills the message with the branch color when it is left
		// undefined (withDefaultColor). A static textMain would break branch coloring.
		expect(template.commit.message.color).toBeUndefined();
		expect(template.commit.message.color).not.toBe(theme.colors.textMain);
	});

	it('leaves branch label text/stroke unset so the pill matches its branch color', () => {
		expect(template.branch.label.color).toBeUndefined();
		expect(template.branch.label.strokeColor).toBeUndefined();
		// The pill background stays themed for legibility.
		expect(template.branch.label.bgColor).toBe(theme.colors.bgSidebar);
	});

	it('drives every branch color from the shared palette (line + text single source)', () => {
		const palette = GIT_GRAPH_BRANCH_COLORS(theme);
		expect(template.colors).toEqual(palette);
		// Theme accent leads the palette so the primary lane matches the app accent.
		expect(template.colors[0]).toBe(theme.colors.accent);
	});
});
