import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GitGraphView } from '../../../renderer/components/GitGraphView';
import type { GitGraphNode } from '../../../renderer/services/git';
import type { Theme } from '../../../renderer/types';

const theme = {
	name: 'test-theme',
	colors: {
		accent: 'rgb(1, 2, 3)',
		bgSidebar: 'rgb(10, 11, 12)',
		textMain: 'rgb(255, 255, 255)',
		border: 'rgb(50, 50, 50)',
	},
} as unknown as Theme;

const node = (hash: string, minute: number, parents: string[] = [], refs: string[] = []) => ({
	hash,
	shortHash: hash,
	parents,
	refs,
	author: 'Test Author',
	date: `2026-08-28T10:0${minute}:00Z`,
	subject: `commit ${hash}`,
});

// main:    c1 --- c2 ------ m1 (HEAD)
//                    \     /
// feature:  f1 ------ f2 --
const NODES: GitGraphNode[] = [
	node('m1', 5, ['c2', 'f2'], ['HEAD -> main']),
	node('c1', 1, [], ['main']),
	node('f2', 4, ['f1']),
	node('f1', 2, ['c1'], ['feature']),
	node('c2', 3, ['c1']),
];

beforeAll(() => {
	// @gitgraph measures its labels with getBBox, which jsdom does not implement.
	if (!('getBBox' in SVGElement.prototype)) {
		Object.defineProperty(SVGElement.prototype, 'getBBox', {
			value: () => ({ x: 0, y: 0, width: 40, height: 12 }),
			writable: true,
		});
	}
});

// The core populates the React component from a setTimeout(0) scheduled while it
// is built, so the graph is empty until that flushes.
const renderGraph = async (props: Partial<Parameters<typeof GitGraphView>[0]> = {}) => {
	const view = render(<GitGraphView nodes={NODES} theme={theme} {...props} />);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return view;
};

const dotFor = (hash: string) => document.querySelector(`[data-commit-dot="${hash}"]`)!;

describe('GitGraphView', () => {
	it('draws a dot for every commit', async () => {
		await renderGraph();
		for (const hash of ['c1', 'c2', 'f1', 'f2', 'm1']) {
			expect(dotFor(hash)).toBeTruthy();
		}
	});

	// A 5px dot is a ~10px target. The invisible hit circle is what makes a dot
	// in a dense graph actually clickable, and it has to be CONCENTRIC with the
	// drawn dot or the clickable region sits beside what the user is aiming at.
	it('gives each dot a hit area far larger than the dot, centered on it', async () => {
		await renderGraph();
		const circles = Array.from(dotFor('c2').querySelectorAll('circle'));
		const hit = circles.find((c) => c.getAttribute('fill') === 'transparent')!;
		const drawn = circles[circles.length - 1];

		expect(Number(hit.getAttribute('r'))).toBeGreaterThan(Number(drawn.getAttribute('r')) * 2);
		expect(Number(hit.getAttribute('r'))).toBeGreaterThanOrEqual(10);
		expect(hit.getAttribute('cx')).toBe(drawn.getAttribute('cx'));
		expect(hit.getAttribute('cy')).toBe(drawn.getAttribute('cy'));
	});

	// The dot is centered on `template.commit.dot.size`, which is where @gitgraph
	// offsets the branch paths to. Anywhere else and the dot floats off its line.
	it('centers the dot where the branch line is drawn', async () => {
		await renderGraph();
		const drawn = Array.from(dotFor('c2').querySelectorAll('circle')).pop()!;
		expect(drawn.getAttribute('cx')).toBe('5');
		expect(drawn.getAttribute('cy')).toBe('5');
	});

	it('selects a commit when its dot is clicked', async () => {
		const onCommitClick = vi.fn();
		await renderGraph({ onCommitClick });
		fireEvent.click(dotFor('f1'));
		expect(onCommitClick).toHaveBeenCalledWith('f1');
	});

	it('marks only the selected commit', async () => {
		const { rerender } = await renderGraph({ selectedHash: 'c2' });
		expect(dotFor('c2').getAttribute('data-selected')).toBe('true');
		expect(dotFor('f2').getAttribute('data-selected')).toBeNull();

		rerender(<GitGraphView nodes={NODES} theme={theme} selectedHash="f2" />);
		expect(dotFor('f2').getAttribute('data-selected')).toBe('true');
		expect(dotFor('c2').getAttribute('data-selected')).toBeNull();
	});

	// This is the regression that made the arrow keys look broken. The selection
	// used to be baked into the @gitgraph core, and `<Gitgraph>` reads its `graph`
	// prop only in its constructor - so every keypress swapped the core, remounted
	// the SVG, and the momentarily empty scroll container snapped back to the top
	// of the graph. The user lost their place on every press.
	it('does not rebuild the graph when the selection moves', async () => {
		const { rerender } = await renderGraph({ selectedHash: 'm1' });
		const svg = document.querySelector('svg');
		const dot = dotFor('c1');

		rerender(<GitGraphView nodes={NODES} theme={theme} selectedHash="c1" />);

		// Same DOM nodes, so nothing was torn down and no scroll state was lost.
		expect(document.querySelector('svg')).toBe(svg);
		expect(dotFor('c1')).toBe(dot);
		expect(dot.getAttribute('data-selected')).toBe('true');
	});

	// New commits must still reach the screen, which needs the remount that the
	// selection must not trigger.
	it('rebuilds the graph when the commits change', async () => {
		const { rerender } = await renderGraph();
		expect(dotFor('m1')).toBeTruthy();

		const fewer = NODES.filter((n) => n.hash !== 'm1');
		rerender(<GitGraphView nodes={fewer} theme={theme} />);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(document.querySelector('[data-commit-dot="m1"]')).toBeNull();
		expect(dotFor('c2')).toBeTruthy();
	});

	it('renders each commit subject', async () => {
		await renderGraph();
		expect(screen.getByText('commit c2')).toBeTruthy();
	});
});
