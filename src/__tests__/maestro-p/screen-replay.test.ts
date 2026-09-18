/**
 * @file screen-replay.test.ts
 * @description Tests for src/maestro-p/screen-replay.ts - replaying a captured
 * TUI stream onto a screen grid so text a diffing renderer left standing (and
 * never re-sent) survives into the parse.
 */

import { describe, expect, it } from 'vitest';

import { capturedAlternateScreen, replayTerminalScreen } from '../../maestro-p/screen-replay';

describe('replayTerminalScreen', () => {
	it('renders plain text one row per line', () => {
		expect(replayTerminalScreen('one\r\ntwo\nthree\n')).toBe('one\ntwo\nthree');
	});

	it('keeps text a repaint jumped over instead of re-sending', () => {
		// Frame 1 paints the header; frame 2 rewrites only the changed tail and
		// the percentage. Stripping ANSI would read "Fable)18%" as a fragment.
		const raw = 'Current week (Opus)\r\n12% used' + '\x1b[1;15HFable)\x1b[K\x1b[2;1H18%';
		expect(replayTerminalScreen(raw)).toBe('Current week (Fable)\n18% used');
	});

	it('honors relative moves, column jumps, and erase in line', () => {
		const raw = 'abcdef\x1b[3D\x1b[KXY\r\n\x1b[4Cz\x1b[1A\x1b[1Gq';
		expect(replayTerminalScreen(raw)).toBe('qbcXY\n    z');
	});

	it('erases the display from the cursor down, and all of it', () => {
		expect(replayTerminalScreen('keep\r\ngone\r\ngone too\x1b[2;1H\x1b[J')).toBe('keep');
		expect(replayTerminalScreen('old\r\nrows\x1b[2J\x1b[Hnew')).toBe('new');
	});

	it('ignores styling, modes, and OSC strings', () => {
		const raw = '\x1b[?25l\x1b[1mbold\x1b[22m \x1b]0;title\x07\x1b[38;5;153mcolor\x1b[39m';
		expect(replayTerminalScreen(raw)).toBe('bold color');
	});

	it('restores a saved cursor position', () => {
		expect(replayTerminalScreen('ab\x1b7\r\nxyz\x1b8c')).toBe('abc\nxyz');
	});

	it('returns the alternate screen even after the TUI left it', () => {
		const raw = 'shell prompt\r\n\x1b[?1049h\x1b[HCurrent session\r\n23% used\x1b[?1049l';
		expect(replayTerminalScreen(raw)).toBe('Current session\n23% used');
	});
});

describe('capturedAlternateScreen', () => {
	it('is true only for a stream that switched into the alternate screen', () => {
		expect(capturedAlternateScreen('\x1b[?1049h\x1b[HCurrent session')).toBe(true);
		expect(capturedAlternateScreen('\x1b[1mCurrent session\x1b[0m\n23% used')).toBe(false);
	});
});
