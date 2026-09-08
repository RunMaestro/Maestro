/**
 * Tests for src/renderer/utils/logEntries.ts
 *
 * This is the single rule every coalescing site shares: a LogEntry may be
 * appended to only if it is a plain stream of the same source. Cards keep a
 * natural `source` (a `!` command's card is `stdout` because its body really is
 * terminal output), so source alone is not a safe test - which is exactly how
 * agent replies ended up rendered inside a command's output box.
 */

import { describe, it, expect } from 'vitest';
import { canAppendToLogEntry, isSelfContainedCard } from '../../../renderer/utils/logEntries';
import type { LogEntry } from '../../../renderer/types';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: 'log-1',
		timestamp: 0,
		source: 'stdout',
		text: 'some output',
		...overrides,
	};
}

describe('isSelfContainedCard', () => {
	it('is false for plain streamed output', () => {
		expect(isSelfContainedCard(entry({ source: 'stdout' }))).toBe(false);
		expect(isSelfContainedCard(entry({ source: 'stderr' }))).toBe(false);
		expect(isSelfContainedCard(entry({ source: 'thinking' }))).toBe(false);
	});

	it('is false for an interactive-TUI stream, which is still a stream', () => {
		expect(isSelfContainedCard(entry({ renderStyle: 'text-stream' }))).toBe(false);
	});

	it.each([
		['command output card', { shellCommand: { command: 'ls', cwd: '/repo', status: 'finished' } }],
		['retry outage card', { retryOutageId: 'outage-1' }],
		['session recovery prompt', { recoveryAction: { lastUserPrompt: 'hi', tabId: 't1' } }],
		['custom AI command chip', { aiCommand: { command: '/commit', description: 'commit' } }],
		['hidden progress placeholder', { metadata: { hiddenProgress: { kind: 'tool' as const } } }],
		['tool call card', { metadata: { toolState: { status: 'running' as const } } }],
		[
			'back-from-snooze card',
			{
				snoozeReturn: {
					snoozedAt: 1,
					wakeAt: 2,
					resolution: 'woke' as const,
				},
			},
		],
	])('is true for a %s', (_label, overrides) => {
		expect(isSelfContainedCard(entry(overrides as Partial<LogEntry>))).toBe(true);
	});

	describe("Claude's plan-limit banner", () => {
		// The banner reaches the transcript as a plain `stdout` entry with no
		// marker (Claude forwards it on the `result` envelope after the failure
		// was already raised), so text is the only thing that can identify it.
		it('is a card, so the retried answer is not glued to its front', () => {
			const banner = entry({
				source: 'stdout',
				text: "You've hit your session limit · resets 12:50am (America/Chicago)",
			});

			expect(isSelfContainedCard(banner)).toBe(true);
			expect(canAppendToLogEntry(banner, 'stdout')).toBe(false);
		});

		it('is a card for the weekly and legacy wordings too', () => {
			expect(
				isSelfContainedCard(entry({ text: "You've hit your weekly limit · resets Monday at 9am" }))
			).toBe(true);
			expect(isSelfContainedCard(entry({ text: 'Claude AI usage limit reached|1755500000' }))).toBe(
				true
			);
		});

		it('is NOT a card when an agent merely discusses limits', () => {
			// Maestro's own agents write about quota constantly. A reply that
			// quotes the banner carries surrounding prose, so it stays a stream and
			// keeps coalescing normally.
			const reply = entry({
				text: 'Fixed. "You\'ve hit your session limit · resets 11:40am (America/Chicago)" now classifies as rate_limited, so resilience picks it up instead of letting the turn look successful.',
			});

			expect(isSelfContainedCard(reply)).toBe(false);
			expect(canAppendToLogEntry(reply, 'stdout')).toBe(true);
		});
	});
});

describe('canAppendToLogEntry', () => {
	it('allows appending to a plain entry of the same source', () => {
		expect(canAppendToLogEntry(entry({ source: 'stdout' }), 'stdout')).toBe(true);
		expect(canAppendToLogEntry(entry({ source: 'stderr' }), 'stderr')).toBe(true);
	});

	it('refuses across different sources', () => {
		expect(canAppendToLogEntry(entry({ source: 'stdout' }), 'stderr')).toBe(false);
		expect(canAppendToLogEntry(entry({ source: 'thinking' }), 'stdout')).toBe(false);
	});

	it('refuses when there is no previous entry', () => {
		expect(canAppendToLogEntry(undefined, 'stdout')).toBe(false);
	});

	it('refuses a command card even though its source matches', () => {
		// The regression. Source says stdout, but the card owns its own text.
		const card = entry({
			source: 'stdout',
			shellCommand: { command: 'ls', cwd: '/repo', status: 'finished', exitCode: 0 },
		});

		expect(card.source).toBe('stdout');
		expect(canAppendToLogEntry(card, 'stdout')).toBe(false);
	});

	it('refuses a still-running command card', () => {
		const card = entry({
			source: 'stdout',
			text: '',
			shellCommand: { command: 'tail -f log', cwd: '/repo', status: 'running' },
		});

		expect(canAppendToLogEntry(card, 'stdout')).toBe(false);
	});

	it('refuses every card kind, whatever source it carries', () => {
		// Cards are excluded by their marker, not by which source they happen to
		// use - so a future card that reuses a streaming source is safe by
		// construction rather than needing a new check at each call site.
		const cards: LogEntry[] = [
			entry({ source: 'stdout', shellCommand: { command: 'ls', cwd: '/', status: 'finished' } }),
			entry({ source: 'stdout', retryOutageId: 'o1' }),
			entry({ source: 'stderr', metadata: { toolState: { status: 'error' } } }),
			// A system-source card: the snooze marker shares its source with plain
			// system chatter, so only the marker can tell them apart.
			entry({
				source: 'system',
				snoozeReturn: { snoozedAt: 1, wakeAt: 2, resolution: 'woke' },
			}),
		];

		for (const card of cards) {
			expect(canAppendToLogEntry(card, card.source)).toBe(false);
		}
	});
});
