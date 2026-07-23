/**
 * Regression coverage for the single-line Group Chats sidebar header.
 *
 * The header must never wrap onto a second row as the left sidebar narrows.
 * It stays on one line by progressively dropping, in this order:
 *   1. the group chat count badge      (.gc-count-badge)
 *   2. the archived count number       (.gc-archived-count, archive button stays)
 *   3. the "New Chat" label            (.gc-newchat-label, "+" stays)
 *
 * That behaviour is split across two files: the hook classes live in
 * GroupChatList.tsx and the `@container gcheader` rules live in index.css.
 * Nothing in the type system or in a jsdom render ties the two together -
 * jsdom has no layout engine and never evaluates container queries. So a
 * rename or deletion on either side breaks the layout completely silently.
 *
 * These tests are that missing link: they assert the JSX and the CSS still
 * agree. They deliberately check the *pairing*, not the pixel values, so
 * tuning a breakpoint stays a one-line change that does not touch tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENT = 'src/renderer/components/GroupChatList.tsx';
const STYLESHEET = 'src/renderer/index.css';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

/** Every element that is allowed to disappear as the header narrows. */
const droppable = [
	{ name: 'group chat count badge', className: 'gc-count-badge' },
	{ name: 'archived count', className: 'gc-archived-count' },
	{ name: 'New Chat label', className: 'gc-newchat-label' },
];

describe('Group Chats header stays on one line', () => {
	it('declares the container-query context in both the component and the CSS', () => {
		// If either half goes missing, every @container rule below no-ops and
		// the header silently starts wrapping again.
		expect(read(COMPONENT)).toContain('gc-header-container');

		const css = read(STYLESHEET);
		expect(css).toMatch(/\.gc-header-container\s*\{[^}]*container-type:\s*inline-size/);
		expect(css).toMatch(/\.gc-header-container\s*\{[^}]*container-name:\s*gcheader/);
	});

	it('keeps the anti-wrap utilities that hold the line without container queries', () => {
		// whitespace-nowrap on the title + shrink-0 on the controls are the
		// structural guarantee; the container queries only decide *when* each
		// item drops. Losing these reintroduces wrapping even with the CSS intact.
		const source = read(COMPONENT);
		expect(source).toContain('whitespace-nowrap');
		expect(source).toContain('shrink-0');
	});

	it.each(droppable)('$name is hidden by a container query at some width', ({ className }) => {
		const css = read(STYLESHEET);
		// Find a `@container gcheader (...) { ... }` block that hides this class.
		const blocks = css.match(/@container\s+gcheader[^{]*\{[\s\S]*?\n\}/g) ?? [];
		const hidesIt = blocks.some(
			(block) =>
				block.includes(`.${className}`) && /display:\s*none/.test(block.split(`.${className}`)[1])
		);
		expect(hidesIt).toBe(true);
	});

	it.each(droppable)('$name still carries its hook class in the component', ({ className }) => {
		expect(read(COMPONENT)).toContain(className);
	});

	it('does not hide anything the CSS references but the component no longer renders', () => {
		// Catches the reverse drift: a class renamed in the JSX leaves a dead
		// rule behind, and the element it was meant to drop never hides.
		const component = read(COMPONENT);
		const css = read(STYLESHEET);
		const referenced = new Set(
			(css.match(/@container\s+gcheader[^{]*\{[\s\S]*?\n\}/g) ?? [])
				.flatMap((block) => block.match(/\.gc-[a-z-]+/g) ?? [])
				.map((sel) => sel.slice(1))
		);
		const orphaned = [...referenced].filter((className) => !component.includes(className));
		expect(orphaned).toEqual([]);
	});

	it('drops items in widening-scarcity order: badge, then archived count, then label', () => {
		// The drop ORDER is the actual design decision (least informative goes
		// first). Encoded as relative ordering so breakpoints stay tunable.
		const css = read(STYLESHEET);
		const widthFor = (className: string): number => {
			const block = (css.match(/@container\s+gcheader[^{]*\{[\s\S]*?\n\}/g) ?? []).find((b) =>
				b.includes(`.${className}`)
			);
			expect(block, `no @container gcheader rule hides .${className}`).toBeTruthy();
			const width = block?.match(/max-width:\s*(\d+)px/);
			expect(width, `rule for .${className} has no max-width`).toBeTruthy();
			return Number(width?.[1]);
		};

		expect(widthFor('gc-count-badge')).toBeGreaterThan(widthFor('gc-archived-count'));
		expect(widthFor('gc-archived-count')).toBeGreaterThan(widthFor('gc-newchat-label'));
	});

	it('has dropped everything droppable before the minimum sidebar width', () => {
		// useResizablePanel clamps the sidebar to minWidth: 280 in
		// SessionList.tsx. Every drop threshold must sit at or above the
		// resulting container width or the header wraps at the drag floor -
		// exactly the bug this layout was written to fix.
		const MIN_SIDEBAR_WIDTH = 280;
		const sessionList = read('src/renderer/components/SessionList/SessionList.tsx');
		expect(sessionList).toContain(`minWidth: ${MIN_SIDEBAR_WIDTH}`);

		const css = read(STYLESHEET);
		const thresholds = (css.match(/@container\s+gcheader\s*\(max-width:\s*(\d+)px\)/g) ?? []).map(
			(rule) => Number(rule.match(/(\d+)px/)?.[1])
		);
		expect(thresholds.length).toBe(droppable.length);
		// The last thing to drop must still drop at/above the narrowest sidebar.
		expect(Math.min(...thresholds)).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH - 24);
	});
});
