/**
 * @file steering.test.ts
 * @description Tests for src/maestro-p/steering.ts - the chat-steering wire
 * protocol and the screen predicates that decide whether a turn in flight can
 * safely be typed into.
 *
 * The screen fixtures below are TRIMMED CAPTURES of claude 2.1.261 rendered
 * through replayTerminalScreen, not invented text. That matters for the editor
 * predicate in particular: it keys on the box's STRUCTURE (rule / prompt / rule),
 * and a hand-written approximation would pass while the real screen failed.
 */

import { describe, expect, it } from 'vitest';

import {
	classifyQueueOperation,
	describeBlockingDialog,
	editorIsAcceptingInput,
	parseSteeringRequest,
	screenShowsTypedText,
	STEERING_MAX_TEXT_BYTES,
} from '../../maestro-p/steering';

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

describe('parseSteeringRequest', () => {
	it('parses a well-formed frame', () => {
		expect(parseSteeringRequest('{"type":"steer","id":"a1","text":"go left"}')).toEqual({
			type: 'steer',
			id: 'a1',
			text: 'go left',
		});
	});

	it('ignores blank lines and malformed JSON', () => {
		// The socket is reachable by anything holding the path, so a bad line must
		// never be able to kill a turn that is midway through real work.
		expect(parseSteeringRequest('')).toBeNull();
		expect(parseSteeringRequest('   ')).toBeNull();
		expect(parseSteeringRequest('{not json')).toBeNull();
		expect(parseSteeringRequest('null')).toBeNull();
		expect(parseSteeringRequest('[]')).toBeNull();
	});

	it('ignores a frame of the wrong type or missing fields', () => {
		expect(parseSteeringRequest('{"type":"other","id":"a","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"a"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"a","text":""}')).toBeNull();
	});

	it('rejects text past the byte cap', () => {
		// Every byte is TYPED into a live PTY at 256 bytes per repaint, so an
		// unbounded frame would hold the turn's keyboard for minutes.
		const tooBig = 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: tooBig }))
		).toBeNull();
		const justFits = 'x'.repeat(STEERING_MAX_TEXT_BYTES);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: justFits }))
		).not.toBeNull();
	});

	it('measures the cap in BYTES, not characters', () => {
		// A multi-byte prompt is typed as bytes and queued as bytes, so a
		// character-counted cap would let through several times the intended size.
		const multibyte = '“'.repeat(STEERING_MAX_TEXT_BYTES / 3 + 1);
		expect(multibyte.length).toBeLessThan(STEERING_MAX_TEXT_BYTES);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: multibyte }))
		).toBeNull();
	});
});

describe('classifyQueueOperation', () => {
	const TEXT = 'stop reading and answer instead';

	it('reads absorbed_mid_turn as absorbed', () => {
		// Claude's own word for it. The only verdict meaning the running turn
		// changed course.
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: TEXT,
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toEqual({ verdict: 'absorbed', matchedContent: true });
	});

	it('reads a removal for another reason as queued, not absorbed', () => {
		// Only `absorbed_mid_turn` proves the in-flight loop took it. Anything else
		// must not be reported as a steer.
		expect(
			classifyQueueOperation(
				{ type: 'queue-operation', operation: 'remove', content: TEXT, reason: 'user_cleared' },
				TEXT
			)
		).toEqual({ verdict: 'queued', matchedContent: true });
	});

	it('ignores a removal naming different text', () => {
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: 'somebody else',
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toBeNull();
	});

	it('compares content ignoring surrounding whitespace', () => {
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: `  ${TEXT}\n`,
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toEqual({ verdict: 'absorbed', matchedContent: true });
	});

	it('reports a bare dequeue as queued and unattributed', () => {
		// The row carries no content, so it cannot name its own injection; the
		// caller resolves it positionally.
		expect(classifyQueueOperation({ type: 'queue-operation', operation: 'dequeue' }, TEXT)).toEqual(
			{
				verdict: 'queued',
				matchedContent: false,
			}
		);
	});

	it('treats enqueue as not a verdict', () => {
		// It only proves claude accepted the keystrokes, which `delivered` already
		// said. Resolving on it would report every steer as queued.
		expect(
			classifyQueueOperation({ type: 'queue-operation', operation: 'enqueue', content: TEXT }, TEXT)
		).toBeNull();
	});

	it('ignores rows that are not queue operations', () => {
		expect(classifyQueueOperation({ type: 'assistant' }, TEXT)).toBeNull();
		expect(classifyQueueOperation(null, TEXT)).toBeNull();
		expect(classifyQueueOperation('queue-operation', TEXT)).toBeNull();
	});
});
