/**
 * @file steering-screen.test.ts
 * @description Tests for src/maestro-p/steering-screen.ts - the predicates that
 * decide whether claude's TUI can safely be typed into while a turn is running.
 *
 * The screen fixtures below are TRIMMED CAPTURES of claude 2.1.261 rendered
 * through replayTerminalScreen, not invented text. That matters for the editor
 * predicate in particular: it keys on the box's STRUCTURE (rule / prompt / rule),
 * and a hand-written approximation would pass while the real screen failed.
 */

import { describe, expect, it } from 'vitest';

import {
	describeBlockingDialog,
	editorIsAcceptingInput,
	screenShowsTypedText,
} from '../../maestro-p/steering-screen';

const RULE = '─'.repeat(120);

/** The idle editor, as captured. */
const IDLE_SCREEN = [
	' ▐▛███▛█   Claude Code v2.1.261',
	'▝▜██████▀  Fable 5.1 · Claude Max',
	'  ▝▝ ▝▝    ~/Scratch/mp-lab',
	'                                                                      ● high · /effort',
	RULE,
	'❯',
	RULE,
	'  [pedram:~/Scratch/mp-lab]',
	'  ⏸ manual mode on · ← for agents',
].join('\n');

/** Mid-turn, tools streaming. The editor box is still drawn. */
const STREAMING_SCREEN = [
	'❯ Read data1.txt through data4.txt with the Read tool.',
	'⏺ Reading them one at a time now.',
	'⏺ Read(data1.txt)',
	'  ⎿  Read 120 lines',
	'⏺ File 1 done (120 lines).',
	RULE,
	'❯',
	RULE,
	'  ✢ Cooking… (9s · ↓ 420 tokens)',
].join('\n');

/**
 * A permission prompt, as captured. Note what is MISSING: the editor box. Every
 * blocking dialog observed replaces it rather than drawing beside it, which is
 * the whole reason the gate is an allowlist.
 */
const PERMISSION_SCREEN = [
	'❯ Use the Write tool to create probe-perm.txt containing the word HELLO.',
	'⏺ Writing the file now.',
	'⏺ Write(probe-perm.txt)',
	RULE,
	' Create file',
	' probe-perm.txt',
	'╌'.repeat(120),
	'  1 HELLO',
	'╌'.repeat(120),
	' Do you want to create probe-perm.txt?',
	' ❯ 1. Yes',
	'   2. Yes, and switch to accept edits (auto-approve file edits) for this session (shift+tab)',
	'   3. No',
	' Esc to cancel · Tab to amend',
].join('\n');

/** The workspace-trust prompt. Defaults to "No, exit". */
const TRUST_SCREEN = [
	RULE,
	' Accessing workspace:',
	' /private/tmp/mp-lab',
	' Quick safety check: Is this a project you created or one you trust?',
	' ❯ No, exit',
	'   Yes, I trust this folder',
	' Enter to confirm · Esc to cancel',
].join('\n');

describe('editorIsAcceptingInput', () => {
	it('accepts the idle editor', () => {
		expect(editorIsAcceptingInput(IDLE_SCREEN)).toBe(true);
	});

	it('accepts a turn that is streaming tool calls', () => {
		// The case the whole feature exists for: the box stays drawn while claude
		// works, which is what makes mid-turn typing land in the composer.
		expect(editorIsAcceptingInput(STREAMING_SCREEN)).toBe(true);
	});

	it('refuses a permission prompt', () => {
		expect(editorIsAcceptingInput(PERMISSION_SCREEN)).toBe(false);
	});

	it('refuses the workspace-trust prompt', () => {
		expect(editorIsAcceptingInput(TRUST_SCREEN)).toBe(false);
	});

	it('refuses an unrecognized dialog that merely hides the editor', () => {
		// The point of the allowlist: a dialog nobody has seen before, quoting none
		// of the known wording, still refuses because it does not draw the box.
		const unknown = [RULE, ' Something entirely new', ' ❯ 1. Proceed', '   2. Abort'].join('\n');
		expect(editorIsAcceptingInput(unknown)).toBe(false);
		expect(describeBlockingDialog(unknown)).toBeNull();
	});

	it('does not mistake a dialog selector for the editor prompt', () => {
		// `❯ 1. Yes` opens with the same glyph as the editor. Without the enclosing
		// rules it must not count, or an Enter lands on an approval prompt.
		expect(editorIsAcceptingInput(' ❯ 1. Yes\n   2. No')).toBe(false);
	});

	it('accepts the legacy › prompt glyph', () => {
		// Claude has shipped both. A glyph change must not silently disable steering.
		expect(editorIsAcceptingInput([RULE, '› ', RULE].join('\n'))).toBe(true);
	});

	it('refuses an empty screen', () => {
		// What a trimmed raw capture replays to. Refusing is the safe answer.
		expect(editorIsAcceptingInput('')).toBe(false);
	});
});

describe('describeBlockingDialog', () => {
	it('names a permission prompt', () => {
		expect(describeBlockingDialog(PERMISSION_SCREEN)).toBe('a permission prompt');
	});

	it('names the trust prompt', () => {
		expect(describeBlockingDialog(TRUST_SCREEN)).toBe('a workspace-trust prompt');
	});

	it('names the bypass-permissions gate', () => {
		expect(describeBlockingDialog('Bypass Permissions mode\n 1. No, exit')).toBe(
			'the bypass-permissions gate'
		);
	});

	it('returns null on an ordinary screen', () => {
		expect(describeBlockingDialog(STREAMING_SCREEN)).toBeNull();
	});
});

describe('screenShowsTypedText', () => {
	it('matches text the editor is showing', () => {
		const screen = [RULE, '❯ stop reading files and answer instead', RULE].join('\n');
		expect(screenShowsTypedText(screen, 'stop reading files and answer instead')).toBe(true);
	});

	it('matches across a soft wrap', () => {
		// The editor wraps at the pane width, so the text is never one contiguous
		// run on screen. Whitespace is squashed for exactly this.
		const screen = [RULE, '❯ stop reading files and', '  answer instead please', RULE].join('\n');
		expect(screenShowsTypedText(screen, 'stop reading files and answer instead please')).toBe(true);
	});

	it('matches by TAIL when the composer has scrolled the opening away', () => {
		// A long steer pushes its first words out of view, so the composer shows a
		// contiguous SUFFIX of it. A prefix-only check would report "never landed"
		// for text that landed perfectly, and that false negative leaves the user's
		// words sitting unsent.
		// Deliberately non-repeating, so the head cannot coincidentally reappear
		// inside the visible tail and make the guard below vacuous.
		const text = `${Array.from({ length: 20 }, (_, i) => `clause number ${i}`).join(', ')}, and the final words here`;
		const visibleSuffix = text.slice(-60);
		const screen = [RULE, `❯ ${visibleSuffix}`, RULE].join('\n');
		expect(screenShowsTypedText(screen, text)).toBe(true);
		// The head is genuinely gone from this screen, so the tail branch is what
		// carried it rather than an incidental match.
		expect(screen).not.toContain(text.slice(0, 24));
	});

	it('rejects a screen the text never reached', () => {
		expect(screenShowsTypedText(PERMISSION_SCREEN, 'Actually name it something else')).toBe(false);
	});

	it('treats empty text as present', () => {
		expect(screenShowsTypedText(IDLE_SCREEN, '')).toBe(true);
	});
});
