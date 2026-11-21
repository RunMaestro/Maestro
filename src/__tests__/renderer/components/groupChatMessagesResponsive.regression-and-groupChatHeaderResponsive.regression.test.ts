// Source: src/__tests__/renderer/components/groupChatMessagesResponsive.regression.test.ts
// Source: src/__tests__/renderer/components/groupChatHeaderResponsive.regression.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
describeSourceSuite('groupChatMessagesResponsive.regression', () => {
	const GROUP_CHAT = 'src/renderer/components/GroupChatMessages.tsx';
	const AI_TERMINAL = 'src/renderer/components/TerminalOutput/components/LogItem.tsx';

	const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

	describe('group chat message rows stack below sm', () => {
		it('stacks the row and only goes side by side from sm up', () => {
			const source = read(GROUP_CHAT);

			// `flex-col` is the stacked form. Both row directions must be sm-gated,
			// or the row goes side by side on a phone and the gutter comes back.
			expect(source).toContain('flex flex-col gap-1 sm:gap-4');
			expect(source).toContain('sm:flex-row-reverse');
			expect(source).toContain("'sm:flex-row'");
		});

		it('reserves no timestamp gutter below sm', () => {
			const source = read(GROUP_CHAT);

			// The width is what costs the bubble its room, so it must carry the `sm:`
			// prefix. A bare `w-20` on the timestamp is the bug.
			expect(source).toContain('sm:w-20 sm:pt-2 flex gap-1 sm:block');
			expect(source).not.toMatch(/className=\{`w-20 shrink-0 text-2xs/);
		});

		it('hides the typing indicator spacer below sm', () => {
			// The spacer exists only to line the indicator up with the bubbles above
			// it. Left visible once the gutter is gone, it indents the indicator to
			// nothing on a phone.
			expect(read(GROUP_CHAT)).toContain('hidden sm:block w-20 shrink-0');
		});

		it('uses the same breakpoint and gutter width as the AI Terminal', () => {
			// The AI Terminal is the reference layout. Two surfaces disagreeing about
			// where the gutter appears is exactly the drift this file guards.
			const groupChat = read(GROUP_CHAT);
			const aiTerminal = read(AI_TERMINAL);

			for (const shared of ['sm:w-20', 'sm:px-6', 'flex gap-1 sm:block']) {
				expect(aiTerminal).toContain(shared);
				expect(groupChat).toContain(shared);
			}
		});
	});
});
describeSourceSuite('groupChatHeaderResponsive.regression', () => {
	const COMPONENT = 'src/renderer/components/GroupChatList.tsx';
	const STYLESHEET = 'src/renderer/index.css';

	const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

	/** Root font size the `em` thresholds are authored against. */
	const DEFAULT_ROOT_FONT_PX = 16;

	/** Normalize a `@container` threshold written in either `px` or `em` to px. */
	const containerWidthPx = (value: string, unit: string): number =>
		unit === 'em' ? Number(value) * DEFAULT_ROOT_FONT_PX : Number(value);

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
				const width = block?.match(/max-width:\s*([\d.]+)(px|em)/);
				expect(width, `rule for .${className} has no max-width`).toBeTruthy();
				return containerWidthPx(width?.[1] ?? '0', width?.[2] ?? 'px');
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
			const thresholds = [
				...css.matchAll(/@container\s+gcheader\s*\(max-width:\s*([\d.]+)(px|em)\)/g),
			].map((match) => containerWidthPx(match[1], match[2]));
			expect(thresholds.length).toBe(droppable.length);
			// The last thing to drop must still drop at/above the narrowest sidebar.
			expect(Math.min(...thresholds)).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH - 24);
		});
	});
});
