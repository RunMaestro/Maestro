/**
 * thoughtStreamStore tests
 *
 * Covers the in-memory Thought Stream capture lifecycle:
 * - open / minimize / restore / close semantics
 * - capture gating (appendThought is a no-op unless capturing)
 * - minimize keeps capturing; close stops AND clears
 * - per-session buffer cap / trimmed flag
 * - the selectIsCapturing selector
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	useThoughtStreamStore,
	selectIsCapturing,
	groupThoughtsIntoBlocks,
	THOUGHT_BLOCK_GAP_MS,
	MAX_THOUGHTS_PER_SESSION,
	type ThoughtEntry,
} from '../../../renderer/stores/thoughtStreamStore';

const SID = 'session-1';
const TAB = 'tab-a';

/** Build a ThoughtEntry with explicit timestamp/tab for block-grouping tests. */
function entry(id: string, timestamp: number, text: string, tabId = TAB): ThoughtEntry {
	return { id, timestamp, tabId, text };
}

function reset() {
	useThoughtStreamStore.setState({
		panelSessionId: null,
		minimized: false,
		buffers: {},
		capturing: {},
	});
}

describe('thoughtStreamStore', () => {
	beforeEach(reset);

	it('starts hidden with no captures', () => {
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.minimized).toBe(false);
		expect(s.buffers).toEqual({});
		expect(s.capturing).toEqual({});
	});

	it('openPanel focuses the session, starts capture, and seeds an empty buffer', () => {
		useThoughtStreamStore.getState().openPanel(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBe(SID);
		expect(s.minimized).toBe(false);
		expect(s.capturing[SID]).toBe(true);
		expect(s.buffers[SID]).toEqual({ entries: [], trimmed: false });
	});

	it('appendThought records into the buffer while capturing', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'first thought ');
		store.appendThought(SID, TAB, 'second thought');
		const entries = useThoughtStreamStore.getState().buffers[SID].entries;
		expect(entries).toHaveLength(2);
		expect(entries[0].text).toBe('first thought ');
		expect(entries[0].tabId).toBe(TAB);
		expect(entries[1].text).toBe('second thought');
	});

	it('appendThought is a no-op when the session is not capturing', () => {
		useThoughtStreamStore.getState().appendThought(SID, TAB, 'ignored');
		expect(useThoughtStreamStore.getState().buffers[SID]).toBeUndefined();
	});

	it('appendThought ignores empty text', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, '');
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(0);
	});

	it('minimize keeps capturing and preserves the buffer', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'thinking...');
		store.minimizePanel();
		const s = useThoughtStreamStore.getState();
		expect(s.minimized).toBe(true);
		expect(s.panelSessionId).toBe(SID);
		expect(s.capturing[SID]).toBe(true);
		// capture continues while minimized
		s.appendThought(SID, TAB, ' more');
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(2);
	});

	it('restore un-minimizes without touching capture', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.minimizePanel();
		store.restorePanel();
		const s = useThoughtStreamStore.getState();
		expect(s.minimized).toBe(false);
		expect(s.capturing[SID]).toBe(true);
	});

	it('reopening a minimized session preserves its existing buffer', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'kept');
		store.minimizePanel();
		store.openPanel(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.minimized).toBe(false);
		expect(s.buffers[SID].entries).toHaveLength(1);
		expect(s.buffers[SID].entries[0].text).toBe('kept');
	});

	it('closePanel stops capture, clears the buffer, and hides the panel', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'gone after close');
		store.closePanel();
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.minimized).toBe(false);
		expect(s.capturing[SID]).toBeUndefined();
		expect(s.buffers[SID]).toBeUndefined();
	});

	it('stopCapture clears one session without disturbing another', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'a');
		// background-capture a second session
		useThoughtStreamStore.setState((prev) => ({
			capturing: { ...prev.capturing, 'session-2': true },
			buffers: { ...prev.buffers, 'session-2': { entries: [], trimmed: false } },
		}));
		store.appendThought('session-2', 'tab-b', 'b');
		store.stopCapture(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.capturing[SID]).toBeUndefined();
		expect(s.buffers[SID]).toBeUndefined();
		expect(s.capturing['session-2']).toBe(true);
		expect(s.buffers['session-2'].entries).toHaveLength(1);
	});

	it('clearBuffer empties entries but keeps capturing', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'x');
		store.clearBuffer(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.buffers[SID].entries).toHaveLength(0);
		expect(s.capturing[SID]).toBe(true);
	});

	it('caps the buffer at MAX_THOUGHTS_PER_SESSION and sets trimmed', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
			store.appendThought(SID, TAB, `thought-${i}`);
		}
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
		expect(buf.trimmed).toBe(true);
		// oldest dropped, newest retained
		expect(buf.entries[0].text).toBe('thought-5');
		expect(buf.entries[buf.entries.length - 1].text).toBe(
			`thought-${MAX_THOUGHTS_PER_SESSION + 4}`
		);
	});

	// N parallel Auto Runs must each capture into their own buffer - a thought
	// from one run must never leak into another. The store is keyed by sessionId
	// on both `capturing` and `buffers`, and the capture listener routes every
	// IPC chunk by its parsed sessionId, so independence is structural; these
	// tests guard against a regression that reintroduces a shared accumulator.
	describe('parallel Auto Run independence', () => {
		it('keeps interleaved thoughts from N sessions in separate buffers', () => {
			const store = useThoughtStreamStore.getState();
			const sessions = ['run-a', 'run-b', 'run-c'];
			sessions.forEach((sid) => store.openPanel(sid));

			// Interleave appends across all three runs, as parallel streams would arrive.
			for (let i = 0; i < 4; i++) {
				store.appendThought('run-a', 'tab-a', `a${i} `);
				store.appendThought('run-b', 'tab-b', `b${i} `);
				store.appendThought('run-c', 'tab-c', `c${i} `);
			}

			const { buffers } = useThoughtStreamStore.getState();
			expect(buffers['run-a'].entries).toHaveLength(4);
			expect(buffers['run-b'].entries).toHaveLength(4);
			expect(buffers['run-c'].entries).toHaveLength(4);

			// Each buffer contains ONLY its own session's thoughts.
			expect(buffers['run-a'].entries.every((e) => e.text.startsWith('a'))).toBe(true);
			expect(buffers['run-b'].entries.every((e) => e.text.startsWith('b'))).toBe(true);
			expect(buffers['run-c'].entries.every((e) => e.text.startsWith('c'))).toBe(true);
			// ...and every entry is tagged with its own tab.
			expect(buffers['run-a'].entries.every((e) => e.tabId === 'tab-a')).toBe(true);
			expect(buffers['run-b'].entries.every((e) => e.tabId === 'tab-b')).toBe(true);
		});

		it('closing one run leaves the others capturing untouched', () => {
			const store = useThoughtStreamStore.getState();
			['run-a', 'run-b', 'run-c'].forEach((sid) => store.openPanel(sid));
			store.appendThought('run-a', 'tab-a', 'a');
			store.appendThought('run-b', 'tab-b', 'b');
			store.appendThought('run-c', 'tab-c', 'c');

			// Panel is focused on run-c (last opened); closing it must not touch a/b.
			expect(useThoughtStreamStore.getState().panelSessionId).toBe('run-c');
			store.closePanel();

			const s = useThoughtStreamStore.getState();
			expect(s.capturing['run-c']).toBeUndefined();
			expect(s.buffers['run-c']).toBeUndefined();
			expect(s.capturing['run-a']).toBe(true);
			expect(s.capturing['run-b']).toBe(true);
			expect(s.buffers['run-a'].entries).toHaveLength(1);
			expect(s.buffers['run-b'].entries).toHaveLength(1);
		});

		it('per-session cap trims only the overflowing run', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel('run-big');
			store.openPanel('run-small');
			for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 3; i++) {
				store.appendThought('run-big', 'tab', `x${i}`);
			}
			store.appendThought('run-small', 'tab', 'only one');

			const { buffers } = useThoughtStreamStore.getState();
			expect(buffers['run-big'].trimmed).toBe(true);
			expect(buffers['run-big'].entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
			expect(buffers['run-small'].trimmed).toBe(false);
			expect(buffers['run-small'].entries).toHaveLength(1);
		});
	});

	it('selectIsCapturing reflects capture state', () => {
		const store = useThoughtStreamStore.getState();
		expect(selectIsCapturing(SID)(useThoughtStreamStore.getState())).toBe(false);
		store.openPanel(SID);
		expect(selectIsCapturing(SID)(useThoughtStreamStore.getState())).toBe(true);
		expect(selectIsCapturing(undefined)(useThoughtStreamStore.getState())).toBe(false);
		store.closePanel();
		expect(selectIsCapturing(SID)(useThoughtStreamStore.getState())).toBe(false);
	});
});

describe('groupThoughtsIntoBlocks', () => {
	it('returns an empty list for no entries', () => {
		expect(groupThoughtsIntoBlocks([])).toEqual([]);
	});

	it('merges entries within the gap window into one block', () => {
		const blocks = groupThoughtsIntoBlocks([
			entry('a', 1000, 'one '),
			entry('b', 1500, 'two '),
			entry('c', 2000, 'three'),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].id).toBe('a'); // keyed by first entry
		expect(blocks[0].text).toBe('one two three');
		expect(blocks[0].startTimestamp).toBe(1000);
		expect(blocks[0].endTimestamp).toBe(2000);
	});

	it('starts a new block when the gap exceeds THOUGHT_BLOCK_GAP_MS', () => {
		const blocks = groupThoughtsIntoBlocks([
			entry('a', 1000, 'first block'),
			entry('b', 1000 + THOUGHT_BLOCK_GAP_MS + 1, 'second block'),
		]);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe('first block');
		expect(blocks[1].text).toBe('second block');
		expect(blocks[1].startTimestamp).toBe(1000 + THOUGHT_BLOCK_GAP_MS + 1);
	});

	it('keeps a gap exactly at the threshold in the same block', () => {
		const blocks = groupThoughtsIntoBlocks([
			entry('a', 1000, 'a'),
			entry('b', 1000 + THOUGHT_BLOCK_GAP_MS, 'b'),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe('ab');
	});

	it('splits on a tab change even within the gap window', () => {
		const blocks = groupThoughtsIntoBlocks([
			entry('a', 1000, 'tab-a thought', 'tab-a'),
			entry('b', 1200, 'tab-b thought', 'tab-b'),
		]);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].tabId).toBe('tab-a');
		expect(blocks[1].tabId).toBe('tab-b');
	});

	it('honors a custom gap argument', () => {
		const blocks = groupThoughtsIntoBlocks(
			[entry('a', 0, 'a'), entry('b', 100, 'b')],
			50 // tighter than the 100ms spacing -> two blocks
		);
		expect(blocks).toHaveLength(2);
	});
});
