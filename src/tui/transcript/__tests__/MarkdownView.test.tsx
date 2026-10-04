import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { MarkdownView, fitColumnWidths } from '../MarkdownView';

const draw = (text: string, width = 60) => {
	const { lastFrame, unmount } = render(<MarkdownView text={text} width={width} />);
	const frame = lastFrame() ?? '';
	unmount();
	return frame;
};

describe('MarkdownView', () => {
	it('draws headings with their hashes', () => {
		expect(draw('# One\n\n## Two')).toMatch(/# One[\s\S]*## Two/);
	});

	it('draws bullet, ordered, and task lists with markers', () => {
		const frame = draw('- a\n- b\n\n1. x\n2. y\n\n- [x] done\n- [ ] todo');
		expect(frame).toContain('• a');
		expect(frame).toContain('1. x');
		expect(frame).toContain('2. y');
		expect(frame).toContain('[x] done');
		expect(frame).toContain('[ ] todo');
	});

	it('indents a nested list under its parent item', () => {
		const lines = draw('- parent\n  - child').split('\n');
		const parent = lines.find((line) => line.includes('parent'))!;
		const child = lines.find((line) => line.includes('child'))!;
		expect(child.indexOf('•')).toBeGreaterThan(parent.indexOf('•'));
	});

	it('draws a table with aligned columns and a header rule', () => {
		const frame = draw('| name | n |\n|:-|-:|\n| alpha | 1 |\n| b | 22 |');
		const lines = frame.split('\n');
		expect(lines[0]).toBe('┌───────┬────┐');
		expect(lines[1]).toBe('│ name  │  n │');
		expect(lines[2]).toBe('├───────┼────┤');
		expect(lines[3]).toBe('│ alpha │  1 │');
		expect(lines[4]).toBe('│ b     │ 22 │');
		expect(lines[5]).toBe('└───────┴────┘');
	});

	it('shrinks a table that is wider than the pane instead of overflowing it', () => {
		const frame = draw(`| a | b |\n|-|-|\n| ${'x'.repeat(50)} | ${'y'.repeat(50)} |`, 40);
		for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
		expect(frame).toContain('…');
	});

	it('draws fenced code with its language label and the code', () => {
		const frame = draw('```ts\nconst a = 1;\n\nlet b;\n```');
		expect(frame).toContain('ts');
		expect(frame).toContain('const a = 1;');
		expect(frame).toContain('let b;');
	});

	it('draws a blockquote behind a bar', () => {
		const lines = draw('> quoted words').split('\n');
		expect(lines.find((line) => line.includes('quoted words'))).toMatch(/^│ quoted words/);
	});

	it('draws links as text with the URL beside it', () => {
		expect(draw('[docs](https://x.test/a)')).toContain('docs (https://x.test/a)');
	});

	it('draws a rule', () => {
		expect(draw('a\n\n---\n\nb')).toContain('────');
	});

	it('wraps a long paragraph to the width', () => {
		const frame = draw('word '.repeat(30).trim(), 30);
		const lines = frame.split('\n');
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
	});
});

describe('fitColumnWidths', () => {
	it('keeps natural widths when they fit and trims the widest first when they do not', () => {
		expect(fitColumnWidths([5, 2], 40)).toEqual([5, 2]);
		const fitted = fitColumnWidths([30, 10, 4], 30);
		expect(fitted.reduce((a, b) => a + b, 0) + 3 * 3 + 1).toBeLessThanOrEqual(30);
		expect(fitted[0]).toBeLessThan(30);
		expect(Math.min(...fitted)).toBeGreaterThanOrEqual(3);
	});
});
