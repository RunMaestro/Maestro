import { describe, it, expect } from 'vitest';
import {
	MAX_MESSAGE_PINS,
	addMessagePin,
	createMessagePin,
	findPinForRow,
	isPinnableRow,
	messagePinExcerpt,
	messagePinLabel,
	messagePinMatchesFilter,
	messagePinTitle,
	normalizeMessagePins,
	removeMessagePin,
	renameMessagePin,
	resolvePinnedRow,
	resolvePinnedRows,
	type MessagePin,
	type PinnableRow,
} from '../../shared/messagePins';

const row = (id: string, source: string, text: string, timestamp = 1000): PinnableRow => ({
	id,
	source,
	text,
	timestamp,
});

describe('messagePins', () => {
	describe('what can be pinned', () => {
		it('accepts user messages and agent replies only', () => {
			expect(isPinnableRow(row('a', 'user', 'hi'))).toBe(true);
			expect(isPinnableRow(row('b', 'stdout', 'reply'))).toBe(true);
			for (const source of ['tool', 'thinking', 'system', 'error', 'stderr']) {
				expect(isPinnableRow(row('c', source, 'x'))).toBe(false);
			}
		});

		it('refuses an empty message', () => {
			expect(isPinnableRow(row('a', 'user', '   '))).toBe(false);
		});

		it('throws when asked to pin an entry that cannot be pinned', () => {
			expect(() => createMessagePin(row('t', 'tool', 'ran ls'), 'p', 1)).toThrow();
		});
	});

	describe('title and excerpt', () => {
		it('takes the first line of plain text as the title', () => {
			const text = '## Sleipnir already does this\n\nYou are asking for **memory**.';
			expect(messagePinTitle(text)).toBe('Sleipnir already does this');
			expect(messagePinExcerpt(text)).toBe('Sleipnir already does this You are asking for memory.');
		});

		it('clips a long first line', () => {
			const title = messagePinTitle('x'.repeat(500));
			expect(title.length).toBeLessThanOrEqual(120);
			expect(title.endsWith('…')).toBe(true);
		});

		it('labels a pin with its rename, else its title', () => {
			const pin = createMessagePin(row('a', 'user', 'Hello there'), 'p', 5);
			expect(messagePinLabel(pin)).toBe('Hello there');
			expect(messagePinLabel({ ...pin, label: 'Greeting' })).toBe('Greeting');
		});
	});

	describe('resolvePinnedRow', () => {
		const pin = createMessagePin(row('live-1', 'stdout', 'The answer is 42', 5000), 'p', 6000);

		it('finds the row it was made on by id', () => {
			const rows = [row('live-1', 'stdout', 'changed text', 1)];
			expect(resolvePinnedRow(pin, rows)?.id).toBe('live-1');
		});

		it('finds the message again after the tab was rebuilt with new ids', () => {
			const rows = [
				row('uuid-a', 'user', 'question', 4000),
				row('uuid-b', 'stdout', 'The answer is 42', 5003),
			];
			expect(resolvePinnedRow(pin, rows)?.id).toBe('uuid-b');
		});

		it('picks the nearest in time among identical messages', () => {
			const repeated = createMessagePin(row('old', 'user', 'continue', 2000), 'p', 1);
			const rows = [
				row('u1', 'user', 'continue', 1000),
				row('u2', 'user', 'continue', 2010),
				row('u3', 'user', 'continue', 3000),
			];
			expect(resolvePinnedRow(repeated, rows)?.id).toBe('u2');
		});

		it('does not match across sources', () => {
			const rows = [row('u', 'user', 'The answer is 42', 5000)];
			expect(resolvePinnedRow(pin, rows)).toBeNull();
		});

		it('is null when the message is not loaded', () => {
			expect(resolvePinnedRow(pin, [row('x', 'stdout', 'something else')])).toBeNull();
		});
	});

	describe('resolvePinnedRows', () => {
		it('never lets two pins claim the same row', () => {
			const a = createMessagePin(row('gone-1', 'user', 'same', 100), 'a', 1);
			const b = createMessagePin(row('gone-2', 'user', 'same', 100), 'b', 2);
			const resolved = resolvePinnedRows([a, b], [row('only', 'user', 'same', 100)]);
			expect([...resolved.keys()]).toEqual(['a']);
		});

		it('agrees with findPinForRow', () => {
			const rows = [row('r1', 'user', 'one'), row('r2', 'stdout', 'two')];
			const pin = createMessagePin(rows[1], 'p', 1);
			expect(findPinForRow([pin], rows[1], rows)?.id).toBe('p');
			expect(findPinForRow([pin], rows[0], rows)).toBeNull();
		});
	});

	describe('changing pins', () => {
		const make = (id: string, timestamp: number, pinnedAt = timestamp): MessagePin =>
			createMessagePin(row(`log-${id}`, 'user', `message ${id}`, timestamp), id, pinnedAt);

		it('keeps pins in transcript order', () => {
			const pins = addMessagePin([make('late', 300)], make('early', 100));
			expect(pins.map((p) => p.id)).toEqual(['early', 'late']);
		});

		it('drops the pin made longest ago past the cap', () => {
			let pins: MessagePin[] = [];
			for (let i = 0; i < MAX_MESSAGE_PINS; i++)
				pins = addMessagePin(pins, make(`p${i}`, i, i + 10));
			pins = addMessagePin(pins, make('newest', 5, 10_000));
			expect(pins).toHaveLength(MAX_MESSAGE_PINS);
			expect(pins.some((p) => p.id === 'p0')).toBe(false);
			expect(pins.some((p) => p.id === 'newest')).toBe(true);
		});

		it('removes a pin and returns the same array when nothing matched', () => {
			const pins = [make('a', 1)];
			expect(removeMessagePin(pins, 'a')).toEqual([]);
			expect(removeMessagePin(pins, 'zzz')).toBe(pins);
		});

		it('renames a pin, and a blank label restores the title', () => {
			const pins = [make('a', 1)];
			const renamed = renameMessagePin(pins, 'a', '  Key   decision ');
			expect(renamed[0].label).toBe('Key decision');
			const cleared = renameMessagePin(renamed, 'a', '');
			expect(cleared[0].label).toBeUndefined();
			expect(messagePinLabel(cleared[0])).toBe('message a');
		});
	});

	describe('messagePinMatchesFilter', () => {
		const pin = {
			...createMessagePin(row('a', 'stdout', 'Evidence graph plan'), 'p', 1),
			label: 'O2',
		};

		it('matches every term, case-insensitively, across label and text', () => {
			expect(messagePinMatchesFilter(pin, '')).toBe(true);
			expect(messagePinMatchesFilter(pin, 'o2 GRAPH')).toBe(true);
			expect(messagePinMatchesFilter(pin, 'graph missing')).toBe(false);
		});

		it('searches the full message when it is loaded', () => {
			expect(messagePinMatchesFilter(pin, 'deep detail')).toBe(false);
			expect(messagePinMatchesFilter(pin, 'deep detail', 'Plan\n...a deep detail far down')).toBe(
				true
			);
		});
	});

	describe('normalizeMessagePins', () => {
		it('keeps valid pins, drops malformed and duplicate ones, and sorts', () => {
			const good = createMessagePin(row('l1', 'user', 'first', 200), 'p1', 1);
			const earlier = createMessagePin(row('l2', 'stdout', 'second', 100), 'p2', 1);
			const result = normalizeMessagePins([
				good,
				{ ...good },
				{ id: 'bad', logId: 'x', source: 'tool', timestamp: 1 },
				null,
				'junk',
				earlier,
			]);
			expect(result.map((p) => p.id)).toEqual(['p2', 'p1']);
		});

		it('reads a non-array as no pins', () => {
			expect(normalizeMessagePins(undefined)).toEqual([]);
			expect(normalizeMessagePins({})).toEqual([]);
		});
	});
});
