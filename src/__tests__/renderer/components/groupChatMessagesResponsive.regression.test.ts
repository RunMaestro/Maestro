/**
 * Regression coverage for the group chat message row on a narrow screen.
 *
 * A message row is a timestamp gutter beside a bubble. The gutter is a fixed
 * `w-20` (80px, ~96px with the gap), which is fine beside a mouse and ruinous on
 * a phone: at 390px it eats roughly a quarter of the width and the bubble text
 * wraps every three or four words. The AI Terminal solved this by stacking the
 * row below `sm` - timestamp above, bubble full width - and the group chat had
 * drifted from it, which is the bug reported on 2026-09-14.
 *
 * jsdom cannot catch this. It has no layout engine and never resolves a Tailwind
 * `sm:` prefix, so a render test passes identically whether the gutter is there
 * or not. These assertions are that missing link, and they deliberately check
 * the PAIRING of the two files rather than pixel values, so retuning the
 * breakpoint stays a one-line change that does not touch tests.
 *
 * The cross-file assertion is the one that matters most: the AI Terminal is the
 * reference layout, and the failure being guarded is the group chat silently
 * diverging from it again.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
