/**
 * Tests for src/main/shell-integration/oscParser.ts
 *
 * These tests pin the contract PtySpawner relies on: each OSC sequence type
 * the shell integration scripts emit, partial-sequence buffering across
 * chunk boundaries, and resilience against malformed input.
 */

import { describe, it, expect } from 'vitest';
import { OscStreamParser, type OscEvent } from '../../../main/shell-integration/oscParser';

const ESC = '\x1b';
const BEL = '\x07';
const ST = '\x1b\\';

/** Build the OSC sequence the way the shell scripts do (BEL-terminated). */
function osc(body: string): string {
	return `${ESC}]${body}${BEL}`;
}

/** Hex-encode a UTF-8 string the way the shell `od -An -tx1` pipeline does. */
function hex(s: string): string {
	const bytes = new TextEncoder().encode(s);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('OscStreamParser', () => {
	describe('OSC 133 (semantic prompt)', () => {
		it('parses 133;A as prompt-start', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;A')).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('parses 133;C as command-output', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;C')).events).toEqual([
				{ type: 'command-output' },
			] satisfies OscEvent[]);
		});

		it('parses 133;B with hex-encoded cmd= as command-start with decoded text', () => {
			const p = new OscStreamParser();
			const cmd = 'echo hello';
			expect(p.parse(osc(`133;B;cmd=${hex(cmd)}`)).events).toEqual([
				{ type: 'command-start', command: cmd },
			] satisfies OscEvent[]);
		});

		it('parses 133;B with no cmd= as command-start without command field', () => {
			// Shells could emit a bare `133;B` (no parameters); accept that too.
			const p = new OscStreamParser();
			expect(p.parse(osc('133;B')).events).toEqual([
				{ type: 'command-start' },
			] satisfies OscEvent[]);
		});

		it('decodes multi-byte UTF-8 in cmd= (emoji, CJK)', () => {
			// The whole point of the hex envelope: arbitrary bytes survive.
			const p = new OscStreamParser();
			const cmd = 'echo 你好 🚀';
			const events = p.parse(osc(`133;B;cmd=${hex(cmd)}`)).events;
			expect(events).toEqual([{ type: 'command-start', command: cmd }] satisfies OscEvent[]);
		});

		it('preserves embedded semicolons in cmd= via hex encoding', () => {
			// Without hex, semicolons in the command would be confused with the
			// OSC parameter separator. With hex they ride safely.
			const p = new OscStreamParser();
			const cmd = "echo 'a;b;c' && true";
			expect(p.parse(osc(`133;B;cmd=${hex(cmd)}`)).events).toEqual([
				{ type: 'command-start', command: cmd },
			] satisfies OscEvent[]);
		});

		it('treats malformed hex in cmd= as empty string (does not crash)', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;B;cmd=zzzz')).events).toEqual([
				{ type: 'command-start', command: '' },
			] satisfies OscEvent[]);
			expect(p.parse(osc('133;B;cmd=abc')).events).toEqual([
				{ type: 'command-start', command: '' },
			] satisfies OscEvent[]);
		});

		it('parses 133;D with exit code', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;D;0')).events).toEqual([
				{ type: 'command-finished', exitCode: 0 },
			] satisfies OscEvent[]);
			expect(p.parse(osc('133;D;127')).events).toEqual([
				{ type: 'command-finished', exitCode: 127 },
			] satisfies OscEvent[]);
		});

		it('parses 133;D with no exit code as command-finished without exitCode', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;D')).events).toEqual([
				{ type: 'command-finished' },
			] satisfies OscEvent[]);
		});

		it('ignores unknown 133;X subcommands', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('133;X;junk')).events).toEqual([]);
		});
	});

	describe('OSC 7 (cwd)', () => {
		it('extracts the path from a file:// URI with host', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('7;file://hostname/Users/alice')).events).toEqual([
				{ type: 'cwd-change', cwd: '/Users/alice' },
			] satisfies OscEvent[]);
		});

		it('extracts the path when host is empty (file:///path)', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('7;file:///tmp')).events).toEqual([
				{ type: 'cwd-change', cwd: '/tmp' },
			] satisfies OscEvent[]);
		});

		it('percent-decodes spaces and other reserved chars in the path', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('7;file://h/Users/alice/Code%20Projects')).events).toEqual([
				{ type: 'cwd-change', cwd: '/Users/alice/Code Projects' },
			] satisfies OscEvent[]);
		});

		it('falls back to raw path when percent-decoding fails (literal % in path)', () => {
			// `%xy` where xy isn't valid hex throws in decodeURIComponent; we'd
			// rather emit the raw path than drop the cwd update.
			const p = new OscStreamParser();
			expect(p.parse(osc('7;file://h/weird%path')).events).toEqual([
				{ type: 'cwd-change', cwd: '/weird%path' },
			] satisfies OscEvent[]);
		});

		it('ignores OSC 7 without file:// scheme', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('7;http://example.com')).events).toEqual([]);
		});

		it('ignores OSC 7 with no path component', () => {
			const p = new OscStreamParser();
			expect(p.parse(osc('7;file://hostonly')).events).toEqual([]);
		});
	});

	describe('mixed and multiple sequences', () => {
		it('emits all events in order from a single chunk with multiple OSCs', () => {
			// Mimics a real prompt cycle: prev command finished → prompt drawn
			// → cwd → user types → command starts → output begins.
			const p = new OscStreamParser();
			const stream =
				osc('133;D;0') +
				osc('133;A') +
				osc('7;file:///home/u') +
				'normal terminal text\n' +
				osc(`133;B;cmd=${hex('ls -la')}`) +
				osc('133;C');
			expect(p.parse(stream).events).toEqual([
				{ type: 'command-finished', exitCode: 0 },
				{ type: 'prompt-start' },
				{ type: 'cwd-change', cwd: '/home/u' },
				{ type: 'command-start', command: 'ls -la' },
				{ type: 'command-output' },
			] satisfies OscEvent[]);
		});

		it('passes plain ANSI/CSI sequences through without misinterpreting them', () => {
			// `\x1b[31m` (CSI red) shares the ESC with OSC but uses `[`, not `]`.
			// The parser must not be tricked into matching it.
			const p = new OscStreamParser();
			const stream = `\x1b[31mred\x1b[0m ${osc('133;A')} \x1b[1mbold\x1b[0m`;
			expect(p.parse(stream).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('accepts ST (ESC \\\\) terminator as well as BEL', () => {
			const p = new OscStreamParser();
			const stream = `${ESC}]133;A${ST}`;
			expect(p.parse(stream).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});
	});

	describe('partial sequences across chunks (residual buffering)', () => {
		it('buffers a partial OSC at end-of-chunk and completes on the next chunk', () => {
			const p = new OscStreamParser();
			// Split right in the middle of the OSC body.
			expect(p.parse(`${ESC}]133;`).events).toEqual([]);
			expect(p.parse(`A${BEL}`).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('buffers a lone trailing ESC (could be the start of OSC)', () => {
			const p = new OscStreamParser();
			expect(p.parse(`hello${ESC}`).events).toEqual([]);
			// The next chunk completes the intro and the body.
			expect(p.parse(`]133;A${BEL}`).events).toEqual([
				{ type: 'prompt-start' },
			] satisfies OscEvent[]);
		});

		it('buffers ESC alone, then a chunk that turns out to be CSI (not OSC) — no false event', () => {
			// Lone ESC at chunk-end + next chunk starting with `[` would form a
			// CSI sequence, not OSC. We must not emit anything OSC-like.
			const p = new OscStreamParser();
			expect(p.parse(`hi${ESC}`).events).toEqual([]);
			expect(p.parse('[31mred').events).toEqual([]);
		});

		it('produces the same events whether a stream is one chunk or split byte-by-byte', () => {
			const events: OscEvent[] = [
				{ type: 'command-finished', exitCode: 0 },
				{ type: 'prompt-start' },
				{ type: 'cwd-change', cwd: '/tmp' },
				{ type: 'command-start', command: 'echo hi' },
				{ type: 'command-output' },
			];
			const stream =
				osc('133;D;0') +
				osc('133;A') +
				osc('7;file:///tmp') +
				osc(`133;B;cmd=${hex('echo hi')}`) +
				osc('133;C');

			const oneShot = new OscStreamParser();
			expect(oneShot.parse(stream).events).toEqual(events);

			const byByte = new OscStreamParser();
			const collected: OscEvent[] = [];
			for (const ch of stream) {
				collected.push(...byByte.parse(ch).events);
			}
			expect(collected).toEqual(events);
		});

		it('handles split exactly across the BEL terminator', () => {
			const p = new OscStreamParser();
			expect(p.parse(`${ESC}]133;A`).events).toEqual([]);
			expect(p.parse(BEL).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('handles ST terminator split across chunks (ESC | \\\\)', () => {
			const p = new OscStreamParser();
			expect(p.parse(`${ESC}]133;A${ESC}`).events).toEqual([]);
			expect(p.parse(`\\`).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('emits earlier complete sequences and buffers only the trailing partial', () => {
			const p = new OscStreamParser();
			// Two complete + one truncated.
			const events1 = p.parse(osc('133;A') + osc('133;C') + `${ESC}]7;file:///part`).events;
			expect(events1).toEqual([
				{ type: 'prompt-start' },
				{ type: 'command-output' },
			] satisfies OscEvent[]);
			// Completion of the trailing OSC.
			expect(p.parse(`ial${BEL}`).events).toEqual([
				{ type: 'cwd-change', cwd: '/partial' },
			] satisfies OscEvent[]);
		});
	});

	describe('resilience', () => {
		it('drops a partial OSC body that exceeds the safety cap and resumes scanning', () => {
			// Simulates a stray ESC] that never gets terminated. The parser
			// must not buffer indefinitely and must still pick up later, valid
			// OSC sequences.
			const p = new OscStreamParser();
			const giant = `${ESC}]` + 'x'.repeat(20 * 1024); // 20KB > MAX_OSC_BODY_LEN
			expect(p.parse(giant).events).toEqual([]);
			// Now feed a real, complete OSC. It should be recognized.
			const followup = osc('133;A');
			const events = p.parse(followup).events;
			// Depending on how the parser drops the giant, it may emit the
			// followup either immediately (giant dropped) or it may have to
			// scan past the residual first. Either way, exactly one event.
			expect(events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});

		it('returns empty events for a chunk with no OSC content', () => {
			const p = new OscStreamParser();
			expect(p.parse('').events).toEqual([]);
			expect(p.parse('plain text only\nno escapes').events).toEqual([]);
		});

		it('does not emit an event for a stand-alone OSC start with no body or terminator', () => {
			const p = new OscStreamParser();
			// Just the intro — should be buffered, not emitted.
			expect(p.parse(`${ESC}]`).events).toEqual([]);
		});

		it('reset() drops any in-flight partial', () => {
			const p = new OscStreamParser();
			expect(p.parse(`${ESC}]133;`).events).toEqual([]);
			p.reset();
			// After reset, the trailing chunk no longer completes the prior
			// OSC — it must be parsed as a fresh stream.
			expect(p.parse(`A${BEL}`).events).toEqual([]);
		});

		it('ignores non-133/non-7 OSC sequences (e.g. OSC 0 title-set)', () => {
			// Terminals get a lot of OSC 0/2 (window title) traffic; we should
			// pass over them without emitting events.
			const p = new OscStreamParser();
			const stream = osc('0;Some Window Title') + osc('2;Tab Title') + osc('133;A');
			expect(p.parse(stream).events).toEqual([{ type: 'prompt-start' }] satisfies OscEvent[]);
		});
	});
});
