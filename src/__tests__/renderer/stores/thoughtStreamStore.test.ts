/**
 * thoughtStreamStore tests
 *
 * Covers the in-memory Thought Stream capture lifecycle:
 * - open / close semantics (there is no minimize)
 * - ambient capture (thoughts buffer with no panel ever opened)
 * - closing keeps the buffer; only clearBuffer discards
 * - per-session entry cap, per-session character cap, session LRU eviction
 * - the selectActivityCount / live selectors
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	useThoughtStreamStore,
	selectActivityCount,
	selectLastAppendAt,
	isThoughtStreamLive,
	groupThoughtsIntoBlocks,
	buildActivityFeed,
	isToolEvent,
	THOUGHT_BLOCK_GAP_MS,
	THOUGHT_LIVE_WINDOW_MS,
	MAX_THOUGHTS_PER_SESSION,
	MAX_THOUGHT_CHARS_PER_SESSION,
	MAX_CAPTURED_SESSIONS,
	type ThoughtEntry,
	type StreamEvent,
	type ToolActivityEntry,
	type ToolActivityStatus,
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
		buffers: {},
	});
}

describe('thoughtStreamStore', () => {
	beforeEach(reset);

	it('starts hidden with no captures', () => {
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.buffers).toEqual({});
	});

	it('openPanel focuses the session and seeds an empty buffer when it has not thought', () => {
		useThoughtStreamStore.getState().openPanel(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBe(SID);
		expect(s.buffers[SID]).toEqual({ entries: [], trimmed: false, chars: 0, lastAppendAt: 0 });
	});

	it('appendThought records into the buffer', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'first thought ');
		store.appendThought(SID, TAB, 'second thought');
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.entries).toHaveLength(2);
		expect(buf.entries[0].text).toBe('first thought ');
		expect(buf.entries[0].tabId).toBe(TAB);
		expect(buf.entries[1].text).toBe('second thought');
		expect(buf.chars).toBe('first thought '.length + 'second thought'.length);
		expect(buf.lastAppendAt).toBeGreaterThan(0);
	});

	// The whole point of the feature: you open the stream BECAUSE a run wedged,
	// so the history has to already be there.
	it('buffers ambiently for a session whose panel was never opened', () => {
		useThoughtStreamStore.getState().appendThought(SID, TAB, 'thought nobody was watching');
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.buffers[SID].entries).toHaveLength(1);

		// Opening later shows that backlog rather than a fresh empty buffer.
		s.openPanel(SID);
		const after = useThoughtStreamStore.getState();
		expect(after.buffers[SID].entries).toHaveLength(1);
		expect(after.buffers[SID].entries[0].text).toBe('thought nobody was watching');
	});

	it('appendThought ignores empty text', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, '');
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(0);
	});

	it('reopening a closed session preserves its existing buffer', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'kept');
		store.closePanel();
		store.openPanel(SID);
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBe(SID);
		expect(s.buffers[SID].entries).toHaveLength(1);
		expect(s.buffers[SID].entries[0].text).toBe('kept');
	});

	it('closePanel hides the panel but keeps the buffer and keeps recording', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'survives the close');
		store.closePanel();
		const s = useThoughtStreamStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.buffers[SID].entries).toHaveLength(1);

		s.appendThought(SID, TAB, ' and after');
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(2);
	});

	it('clearBuffer discards entries and resets the counters', () => {
		const store = useThoughtStreamStore.getState();
		store.openPanel(SID);
		store.appendThought(SID, TAB, 'x');
		store.clearBuffer(SID);
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.entries).toHaveLength(0);
		expect(buf.chars).toBe(0);
		expect(buf.trimmed).toBe(false);
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

	// The entry cap alone does not bound memory - one flush can carry a whole
	// reasoning paragraph - so the character budget is the cap that actually holds.
	it('caps the buffer at MAX_THOUGHT_CHARS_PER_SESSION by dropping whole oldest entries', () => {
		const store = useThoughtStreamStore.getState();
		const chunk = 'x'.repeat(MAX_THOUGHT_CHARS_PER_SESSION / 4);
		for (let i = 0; i < 6; i++) store.appendThought(SID, TAB, chunk);
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.chars).toBeLessThanOrEqual(MAX_THOUGHT_CHARS_PER_SESSION);
		expect(buf.chars).toBe(buf.entries.reduce((n, e) => n + e.text.length, 0));
		expect(buf.entries.length).toBeLessThan(6);
		expect(buf.trimmed).toBe(true);
	});

	it('keeps the newest thought even when it alone blows the character budget', () => {
		const store = useThoughtStreamStore.getState();
		store.appendThought(SID, TAB, 'y'.repeat(MAX_THOUGHT_CHARS_PER_SESSION + 100));
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.entries).toHaveLength(1);
		expect(buf.chars).toBe(MAX_THOUGHT_CHARS_PER_SESSION + 100);
	});

	// Ambient capture means a whole fleet buffers in parallel, so cold sessions
	// have to age out or an all-day app grows without limit.
	describe('cross-session eviction', () => {
		it('evicts the least-recently-active session past MAX_CAPTURED_SESSIONS', () => {
			const store = useThoughtStreamStore.getState();
			for (let i = 0; i < MAX_CAPTURED_SESSIONS + 3; i++) {
				store.appendThought(`sess-${i}`, TAB, `t${i}`);
			}
			const { buffers } = useThoughtStreamStore.getState();
			expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
			// The three oldest are gone, the newest survive.
			expect(buffers['sess-0']).toBeUndefined();
			expect(buffers['sess-2']).toBeUndefined();
			expect(buffers[`sess-${MAX_CAPTURED_SESSIONS + 2}`]).toBeDefined();
		});

		it('never evicts the session the panel is focused on', () => {
			const store = useThoughtStreamStore.getState();
			store.appendThought('watched', TAB, 'the run being diagnosed');
			store.openPanel('watched');
			for (let i = 0; i < MAX_CAPTURED_SESSIONS + 5; i++) {
				store.appendThought(`noise-${i}`, TAB, `n${i}`);
			}
			const { buffers } = useThoughtStreamStore.getState();
			expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
			expect(buffers['watched'].entries).toHaveLength(1);
		});
	});

	// N parallel Auto Runs must each capture into their own buffer - a thought
	// from one run must never leak into another. The store is keyed by sessionId
	// in `buffers`, and the capture listener routes every
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

		it('closing one run leaves every buffer intact', () => {
			const store = useThoughtStreamStore.getState();
			['run-a', 'run-b', 'run-c'].forEach((sid) => store.openPanel(sid));
			store.appendThought('run-a', 'tab-a', 'a');
			store.appendThought('run-b', 'tab-b', 'b');
			store.appendThought('run-c', 'tab-c', 'c');

			// Panel is focused on run-c (last opened); closing it must not touch a/b.
			expect(useThoughtStreamStore.getState().panelSessionId).toBe('run-c');
			store.closePanel();

			const s = useThoughtStreamStore.getState();
			expect(s.buffers['run-a'].entries).toHaveLength(1);
			expect(s.buffers['run-b'].entries).toHaveLength(1);
			expect(s.buffers['run-c'].entries).toHaveLength(1);
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

	it('selectActivityCount reports how much is buffered', () => {
		const store = useThoughtStreamStore.getState();
		expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(0);
		expect(selectActivityCount(undefined)(useThoughtStreamStore.getState())).toBe(0);
		store.appendThought(SID, TAB, 'a');
		store.appendThought(SID, TAB, 'b');
		expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(2);
	});

	it('selectLastAppendAt drives the live indicator', () => {
		const store = useThoughtStreamStore.getState();
		expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(0);
		store.appendThought(SID, TAB, 'thinking');
		const at = selectLastAppendAt(SID)(useThoughtStreamStore.getState());
		expect(isThoughtStreamLive(at, at)).toBe(true);
		expect(isThoughtStreamLive(at, at + THOUGHT_LIVE_WINDOW_MS + 1)).toBe(false);
		// A session that never thought is never "live".
		expect(isThoughtStreamLive(0)).toBe(false);
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

/**
 * The action half of the timeline.
 *
 * The design constraint these pin down: reasoning and tool calls live in ONE
 * array in arrival order. A previous attempt at this feature kept them in two
 * lists and merged at display time, which cannot place a tool call inside a
 * block of reasoning - the block has a single timestamp, so a fast tool call
 * rendered AFTER the reasoning that actually followed it. For a feed whose
 * whole purpose is "watch what the agent is doing, in order", that is the bug.
 */
describe('tool activity capture', () => {
	beforeEach(reset);

	const label = (verb: string, target = '') => ({ verb, target });

	function tool(
		sessionId: string,
		tabId: string,
		toolName: string,
		status: ToolActivityStatus,
		extra: { toolCallId?: string; timestamp?: number; target?: string } = {}
	) {
		useThoughtStreamStore.getState().appendToolActivity(sessionId, tabId, {
			toolName,
			label: label(toolName, extra.target ?? ''),
			status,
			toolCallId: extra.toolCallId,
			timestamp: extra.timestamp,
		});
	}

	it('records a tool call onto the same timeline as the reasoning', () => {
		const store = useThoughtStreamStore.getState();
		store.appendThought(SID, TAB, 'thinking ');
		tool(SID, TAB, 'Bash', 'running');

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(2);
		expect(isToolEvent(entries[0])).toBe(false);
		expect(isToolEvent(entries[1])).toBe(true);
	});

	it('ignores an event with no tool name', () => {
		tool(SID, TAB, '   ', 'running');
		expect(useThoughtStreamStore.getState().buffers[SID]).toBeUndefined();
	});

	it('merges a completion into the running entry by toolCallId', () => {
		tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
		tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 5000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		// One ACTION, not two state transitions.
		expect(entries).toHaveLength(1);
		const event = entries[0] as ToolActivityEntry;
		expect(event.tool.status).toBe('completed');
		expect(event.tool.endedAt).toBe(5000);
	});

	it('keeps the START timestamp when a call completes, so the row does not jump', () => {
		tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
		tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 90_000 });

		const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
		expect(event.timestamp).toBe(1000);
	});

	it('merges into its ORIGINAL slot, leaving later events after it', () => {
		const store = useThoughtStreamStore.getState();
		tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
		store.appendThought(SID, TAB, 'while that runs');
		tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 9000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(2);
		// The completed call stays FIRST - a long build must not leapfrog the
		// reasoning that happened while it ran.
		expect(isToolEvent(entries[0])).toBe(true);
		expect((entries[0] as ToolActivityEntry).tool.status).toBe('completed');
		expect(isToolEvent(entries[1])).toBe(false);
	});

	it('merges by newest running call of the same name when the provider sends no id', () => {
		tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
		tool(SID, TAB, 'shell', 'running', { timestamp: 2000 });
		tool(SID, TAB, 'shell', 'failed', { timestamp: 3000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(2);
		// The NEWEST running call is the one that finished.
		expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
		expect((entries[1] as ToolActivityEntry).tool.status).toBe('failed');
	});

	it('never merges a completion across tabs', () => {
		tool(SID, 'tab-a', 'shell', 'running', { timestamp: 1000 });
		tool(SID, 'tab-b', 'shell', 'completed', { timestamp: 2000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(2);
		expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
	});

	it('appends a completion with no matching start rather than dropping it', () => {
		tool(SID, TAB, 'Read', 'completed', { timestamp: 1000 });
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(1);
	});

	it('prefers a descriptive label when the running event carried no target', () => {
		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: '' },
			status: 'running',
			toolCallId: 'c1',
		});
		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test' },
			status: 'completed',
			toolCallId: 'c1',
		});
		const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
		expect(event.tool.label.target).toBe('npm test');
	});

	it('merges an id-carrying completion into a start the provider sent without one', () => {
		// Some providers only stamp the id on the completion. Bailing out on the
		// id miss rendered ONE action as two rows: a phantom "still running" call
		// sitting above its own result, which reads exactly like a hung tool.
		tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
		tool(SID, TAB, 'shell', 'completed', { toolCallId: 'late-id', timestamp: 2000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(1);
		const event = entries[0] as ToolActivityEntry;
		expect(event.tool.status).toBe('completed');
		expect(event.tool.toolCallId).toBe('late-id');
	});

	it('never steals a running call that already belongs to a different id', () => {
		tool(SID, TAB, 'shell', 'running', { toolCallId: 'call-a', timestamp: 1000 });
		tool(SID, TAB, 'shell', 'completed', { toolCallId: 'call-b', timestamp: 2000 });

		const { entries } = useThoughtStreamStore.getState().buffers[SID];
		expect(entries).toHaveLength(2);
		expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
		expect((entries[0] as ToolActivityEntry).tool.toolCallId).toBe('call-a');
	});

	it('re-derives the character total when a merge replaces the label', () => {
		// The merged row is LONGER than the one it replaced. Carrying the old
		// total forward undercounts what the buffer holds, which is what decides
		// when the budget trims and whether the panel admits it trimmed anything.
		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: '' },
			status: 'running',
			toolCallId: 'c1',
		});
		expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe('Ran'.length);

		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test' },
			status: 'completed',
			toolCallId: 'c1',
		});
		expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe(
			'Ran'.length + 'npm test'.length
		);
	});

	it('counts tool calls toward the timeline cap', () => {
		for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
			tool(SID, TAB, `tool-${i}`, 'completed', { timestamp: 1000 + i });
		}
		const buf = useThoughtStreamStore.getState().buffers[SID];
		expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
		expect(buf.trimmed).toBe(true);
	});

	it('a tool call keeps the session out of LRU eviction', () => {
		tool(SID, TAB, 'Bash', 'running', { timestamp: 5000 });
		expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(1);
		expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(5000);
	});
});

/**
 * buildActivityFeed - the ordering guarantee.
 *
 * These are the regression tests for the defect that sank the first attempt at
 * this feature: a tool call that happens in the MIDDLE of a run of reasoning
 * has to render between the two halves of it. That is only expressible because
 * both kinds of event come off one array in arrival order.
 */
describe('buildActivityFeed', () => {
	const toolEvent = (
		id: string,
		timestamp: number,
		name: string,
		tabId = TAB,
		status: ToolActivityStatus = 'completed'
	): StreamEvent => ({
		id,
		timestamp,
		tabId,
		tool: { name, label: { verb: name, target: '' }, status },
	});

	it('returns an empty feed for no events', () => {
		expect(buildActivityFeed([])).toEqual([]);
	});

	it('splits a block of reasoning around a tool call that interrupted it', () => {
		// All three thoughts are inside the gap window, so WITHOUT the tool they
		// would coalesce into a single block and the call would have nowhere to go.
		const feed = buildActivityFeed([
			entry('t1', 1000, 'I should check the tests. '),
			toolEvent('x1', 1100, 'Bash'),
			entry('t2', 1200, 'They passed, so '),
			entry('t3', 1300, 'the bug is elsewhere.'),
		]);

		expect(feed.map((i) => i.kind)).toEqual(['thought', 'tool', 'thought']);
		expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('I should check the tests. ');
		expect(feed[1].kind === 'tool' && feed[1].activity.id).toBe('x1');
		// The reasoning AFTER the call is its own block, below it.
		expect(feed[2].kind === 'thought' && feed[2].block.text).toBe(
			'They passed, so the bug is elsewhere.'
		);
	});

	it('renders a fast tool call before the reasoning that followed it', () => {
		// The exact failure of the two-list design: `x1` is 1ms after the block
		// started, so a feed sorted by block START time buried it underneath.
		const feed = buildActivityFeed([
			entry('t1', 1000, 'first'),
			toolEvent('x1', 1001, 'Read'),
			entry('t2', 1002, 'second'),
		]);
		const toolIndex = feed.findIndex((i) => i.kind === 'tool');
		const afterIndex = feed.findIndex(
			(i) => i.kind === 'thought' && i.block.text.includes('second')
		);
		expect(toolIndex).toBeLessThan(afterIndex);
	});

	it('keeps consecutive tool calls as separate rows in order', () => {
		const feed = buildActivityFeed([
			toolEvent('x1', 1000, 'Read'),
			toolEvent('x2', 1100, 'Bash'),
			toolEvent('x3', 1200, 'Edit'),
		]);
		expect(feed).toHaveLength(3);
		expect(feed.map((i) => (i.kind === 'tool' ? i.activity.tool.name : null))).toEqual([
			'Read',
			'Bash',
			'Edit',
		]);
	});

	it('is emitted oldest-first so the panel can reverse for newest-on-top', () => {
		const feed = buildActivityFeed([entry('t1', 1000, 'old'), toolEvent('x1', 2000, 'Bash')]);
		expect(feed[0].kind).toBe('thought');
		expect(feed[1].kind).toBe('tool');
	});

	it('still coalesces reasoning when no tool interrupts it', () => {
		const feed = buildActivityFeed([entry('a', 1000, 'one '), entry('b', 1500, 'two')]);
		expect(feed).toHaveLength(1);
		expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('one two');
	});

	it('groupThoughtsIntoBlocks projects the same walk, dropping tool rows', () => {
		const events: StreamEvent[] = [
			entry('t1', 1000, 'before '),
			toolEvent('x1', 1100, 'Bash'),
			entry('t2', 1200, 'after'),
		];
		// A tool call still SPLITS the reasoning here, because both views are the
		// one walk - they can never disagree about where a block starts.
		expect(groupThoughtsIntoBlocks(events).map((b) => b.text)).toEqual(['before ', 'after']);
	});
});
