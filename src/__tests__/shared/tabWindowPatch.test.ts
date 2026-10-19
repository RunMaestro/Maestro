/**
 * Tests for shared/tabWindowPatch - the pure logic that streams an agent's
 * Session from its owner window to its tab window (Tab Windows, D2).
 *
 * A wrong splice drops or repeats transcript entries in the tab window. A
 * delta that names a tab that is not popped leaks its transcript. A patch that
 * carries a per-window field overwrites what the user is typing there.
 */

import { describe, it, expect } from 'vitest';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../helpers/mockTab';
import type { AITab, FilePreviewTab, LogEntry, Session } from '../../renderer/types';
import {
	applyTabWindowPatch,
	buildTabWindowSnapshot,
	diffTabWindowSession,
	type TabWindowDeltaChanges,
	type TabWindowMirror,
} from '../../shared/tabWindowPatch';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS, compactToolOutput } from '../../shared/toolOutput';
import type { TabWindowTabRef } from '../../shared/tabWindowTypes';
import type { BrowserTab } from '../../shared/browserPage';

const AGENT = 'agent-1';
const POPPED_REF: TabWindowTabRef = { type: 'ai', id: 'popped' };
const OTHER_REF: TabWindowTabRef = { type: 'ai', id: 'other' };
const FILE_REF: TabWindowTabRef = { type: 'file', id: 'file-1' };
const BROWSER_REF: TabWindowTabRef = { type: 'browser', id: 'browser-1' };
/** The popped set most tests use: one AI tab and one file tab. */
const REFS: TabWindowTabRef[] = [POPPED_REF, FILE_REF];

let nextLogId = 0;
function entry(text: string, overrides: Partial<LogEntry> = {}): LogEntry {
	nextLogId += 1;
	return { id: `log-${nextLogId}`, timestamp: nextLogId, source: 'stdout', text, ...overrides };
}

function toolEntry(output: unknown): LogEntry {
	return entry('Read', {
		source: 'tool',
		metadata: { toolState: { status: 'completed', output } },
	});
}

/** An agent with a popped AI tab, an AI tab that stays in the owner, and a file tab. */
function agent(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({
				id: 'popped',
				name: 'Launch plan',
				logs: [entry('hello', { source: 'user' }), entry('world')],
				inputValue: 'owner draft',
			}),
			createMockAITab({ id: 'other', logs: [entry('a transcript that stays home')] }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'file-1', content: 'v1' })],
		activeTabId: 'other',
		unifiedTabOrder: [POPPED_REF, OTHER_REF, FILE_REF],
		...overrides,
	});
}

function aiTab(session: Session, tabId: string): AITab {
	const tab = session.aiTabs.find((t) => t.id === tabId);
	if (!tab) throw new Error(`no AI tab ${tabId}`);
	return tab;
}

function fileTab(session: Session, tabId: string): FilePreviewTab {
	const tab = session.filePreviewTabs.find((t) => t.id === tabId);
	if (!tab) throw new Error(`no file tab ${tabId}`);
	return tab;
}

function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
	return {
		id: 'browser-1',
		url: 'https://owner.test/',
		title: 'Owner page',
		createdAt: 1,
		canGoBack: true,
		canGoForward: false,
		isLoading: false,
		webContentsId: 5,
		...overrides,
	};
}

/** `session` with one AI tab replaced, the way the owner's store writes it (immutably). */
function withAiTab(session: Session, tabId: string, update: (tab: AITab) => AITab): Session {
	return {
		...session,
		aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? update(tab) : tab)),
	};
}

function withLogs(session: Session, tabId: string, update: (logs: LogEntry[]) => LogEntry[]) {
	return withAiTab(session, tabId, (tab) => ({ ...tab, logs: update(tab.logs) }));
}

/** What a tab window holds after the owner's snapshot of `session`. */
function attach(session: Session, tabRefs: TabWindowTabRef[] = REFS, seq = 0) {
	const mirror = applyTabWindowPatch<Session>(null, {
		form: 'snapshot',
		agentId: session.id,
		seq,
		tabRefs,
		session: buildTabWindowSnapshot(session, tabRefs),
	});
	if (!mirror) throw new Error('snapshot refused');
	return mirror;
}

/** Apply a delta body as the publisher would send it: numbered right after `mirror`. */
function applyDelta(
	mirror: TabWindowMirror<Session> | null,
	changes: TabWindowDeltaChanges<Session>,
	seq = (mirror?.seq ?? 0) + 1
) {
	return applyTabWindowPatch<Session>(mirror, { form: 'delta', agentId: AGENT, seq, ...changes });
}

function diff(prev: Session, next: Session, refs: TabWindowTabRef[] = REFS) {
	return diffTabWindowSession(prev, next, refs);
}

describe('buildTabWindowSnapshot', () => {
	it('keeps the transcript on popped AI tabs and empties it on every other tab', () => {
		const session = agent();
		const snapshot = buildTabWindowSnapshot(session, REFS);

		expect(aiTab(snapshot, 'popped')).toBe(aiTab(session, 'popped'));
		expect(aiTab(snapshot, 'other').logs).toEqual([]);
		expect(aiTab(snapshot, 'other')).toEqual({ ...aiTab(session, 'other'), logs: [] });
		expect(snapshot.filePreviewTabs).toBe(session.filePreviewTabs);
		// The owner's own session is never touched.
		expect(aiTab(session, 'other').logs).toHaveLength(1);
	});

	it('empties the transcripts of closed, snoozed, and orphaned tabs', () => {
		const transcript = () => [entry('old')];
		const closedFile = {
			type: 'file' as const,
			tab: createMockFileTab({ id: 'closed-file' }),
			unifiedIndex: 3,
			closedAt: 2,
		};
		const session = agent({
			closedTabHistory: [
				{ tab: createMockAITab({ id: 'c1', logs: transcript() }), index: 0, closedAt: 1 },
			],
			unifiedClosedTabHistory: [
				{
					type: 'ai',
					tab: createMockAITab({ id: 'c2', logs: transcript() }),
					unifiedIndex: 2,
					closedAt: 1,
				},
				closedFile,
			],
			orphanedThinkingTabs: [createMockAITab({ id: 'o1', state: 'busy', logs: transcript() })],
			snoozedTabs: [
				{
					id: 'z1',
					type: 'ai',
					tab: createMockAITab({ id: 's1', logs: transcript() }),
					unifiedIndex: 1,
					snoozedAt: 1,
					wakeAt: 2,
				},
				{
					id: 'z2',
					type: 'group',
					group: {
						id: 'g1',
						name: 'Pair',
						layout: { kind: 'leaf', id: 'leaf-1', tab: { type: 'ai', id: 's2' } },
						focusedPaneId: null,
						createdAt: 1,
					},
					members: [{ type: 'ai', tab: createMockAITab({ id: 's2', logs: transcript() }) }],
					unifiedIndex: 2,
					snoozedAt: 1,
					wakeAt: 2,
				},
			],
		});

		const snapshot = buildTabWindowSnapshot(session, REFS);

		expect(snapshot.closedTabHistory[0].tab.logs).toEqual([]);
		const closedAi = snapshot.unifiedClosedTabHistory[0];
		expect(closedAi.type === 'ai' && closedAi.tab.logs).toEqual([]);
		expect(snapshot.unifiedClosedTabHistory[1]).toBe(closedFile);
		expect(snapshot.orphanedThinkingTabs?.[0]).toMatchObject({ id: 'o1', state: 'busy', logs: [] });
		const [snoozedAi, snoozedGroup] = snapshot.snoozedTabs ?? [];
		expect(snoozedAi.type === 'ai' && snoozedAi.tab.logs).toEqual([]);
		expect(snoozedGroup.type === 'group' && snoozedGroup.members[0].tab).toMatchObject({
			id: 's2',
			logs: [],
		});
		expect(session.closedTabHistory[0].tab.logs).toHaveLength(1);
	});

	it('carries every other field as the owner has it, per-window fields included', () => {
		const queue = [
			{ id: 'q1', timestamp: 1, tabId: 'popped', type: 'message' as const, text: 'next' },
		];
		const session = agent({ state: 'busy', executionQueue: queue, inputMode: 'terminal' });

		const snapshot = buildTabWindowSnapshot(session, REFS);

		expect(snapshot).toMatchObject({
			id: AGENT,
			name: 'Maestro Marketing',
			state: 'busy',
			activeTabId: 'other',
			inputMode: 'terminal',
		});
		expect(snapshot.executionQueue).toBe(queue);
		expect(aiTab(snapshot, 'popped').inputValue).toBe('owner draft');
	});

	it('sends already capped tool output as it is and caps an oversized one', () => {
		const capped = toolEntry(
			compactToolOutput('x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS * 2)).output
		);
		const oversized = toolEntry('y'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 500));
		const session = withLogs(agent(), 'popped', (logs) => [...logs, capped, oversized]);

		const logs = aiTab(buildTabWindowSnapshot(session, REFS), 'popped').logs;

		expect(logs[2]).toBe(capped);
		const output = logs[3].metadata?.toolState?.output as string;
		expect(output).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
		expect(output).toContain('[tool output truncated');
		expect(oversized.metadata?.toolState?.output).toHaveLength(
			MAX_PERSISTED_TOOL_OUTPUT_CHARS + 500
		);
	});
});

describe('diffTabWindowSession', () => {
	it('returns null when nothing changed', () => {
		const session = agent();
		expect(diff(session, session)).toBeNull();
		expect(diff(session, { ...session, aiTabs: [...session.aiTabs] })).toBeNull();
	});

	it('sends an appended entry as a splice at the old end of the transcript', () => {
		const prev = agent();
		const appended = entry('third');
		const next = withLogs(prev, 'popped', (logs) => [...logs, appended]);

		expect(diff(prev, next)).toEqual({
			tabs: [{ ref: POPPED_REF, logSplice: { start: 2, entries: [appended] } }],
		});
	});

	it('sends a streamed chunk that rewrote the last entry from that entry on', () => {
		const prev = agent();
		const last = aiTab(prev, 'popped').logs[1];
		const chunk1 = { ...last, text: `${last.text} and` };
		const once = withLogs(prev, 'popped', (logs) => [logs[0], chunk1]);

		expect(diff(prev, once)?.tabs).toEqual([
			{ ref: POPPED_REF, logSplice: { start: 1, entries: [chunk1] } },
		]);

		// Several chunks coalesced into one patch: still one splice from the entry
		// they rewrote, carrying its newest text and the entry appended after it.
		const chunk3 = { ...chunk1, text: `${chunk1.text} more and more` };
		const followUp = entry('next message');
		const coalesced = withLogs(prev, 'popped', (logs) => [logs[0], chunk3, followUp]);

		expect(diff(prev, coalesced)?.tabs).toEqual([
			{ ref: POPPED_REF, logSplice: { start: 1, entries: [chunk3, followUp] } },
		]);
	});

	it('sends a truncation as an empty tail, and a flush that dropped earlier entries from there', () => {
		const user = entry('ask', { source: 'user' });
		const thinking = entry('hmm', { source: 'thinking' });
		const tool = toolEntry('ok');
		const answer = entry('answer');
		const prev = withLogs(agent(), 'popped', () => [user, thinking, tool, answer]);

		const answerMore = { ...answer, text: 'answer, longer' };
		const flushed = withLogs(prev, 'popped', () => [user, answerMore]);
		expect(diff(prev, flushed)?.tabs).toEqual([
			{ ref: POPPED_REF, logSplice: { start: 1, entries: [answerMore] } },
		]);

		const truncated = withLogs(prev, 'popped', (logs) => logs.slice(0, 2));
		expect(diff(prev, truncated)?.tabs).toEqual([
			{ ref: POPPED_REF, logSplice: { start: 2, entries: [] } },
		]);

		const cleared = withLogs(prev, 'popped', () => []);
		expect(diff(prev, cleared)?.tabs).toEqual([
			{ ref: POPPED_REF, logSplice: { start: 0, entries: [] } },
		]);
	});

	it('sends the tab fields that changed, never the per-window draft', () => {
		const prev = withAiTab(agent(), 'popped', (tab) => ({
			...tab,
			agentError: {
				type: 'unknown',
				message: 'boom',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: 1,
			},
		}));
		const next = withAiTab(prev, 'popped', ({ agentError: _cleared, ...tab }) => ({
			...tab,
			state: 'busy',
			thinkingStartTime: 5,
			inputValue: 'owner typed this',
			commandMode: 'shell',
			stagedImages: ['data:image/png;base64,AAAA'],
		}));

		const fields = diff(prev, next)?.tabs?.[0].fields;

		expect(fields).toStrictEqual({ state: 'busy', thinkingStartTime: 5, agentError: undefined });
	});

	it('sends the session-level fields that changed, never a tab list or a per-window field', () => {
		const prev = agent({ statusMessage: 'Agent is synopsizing...' });
		const { statusMessage: _done, ...rest } = prev;
		const next: Session = {
			...rest,
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 10,
			name: 'Renamed',
			activeTabId: 'popped',
			inputMode: 'terminal',
			terminalDraftInput: 'ls -la',
			aiTabs: [...prev.aiTabs],
		};

		expect(diff(prev, next)).toStrictEqual({
			session: {
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 10,
				name: 'Renamed',
				statusMessage: undefined,
			},
		});
	});

	it('never names a tab that is not popped', () => {
		const prev = agent();
		const busyElsewhere = withAiTab(prev, 'other', (tab) => ({
			...tab,
			state: 'busy',
			logs: [...tab.logs, entry('streaming at home')],
		}));

		expect(diff(prev, busyElsewhere)).toBeNull();

		const withState = { ...busyElsewhere, state: 'busy' as const };
		expect(diff(prev, withState)).toEqual({ session: { state: 'busy' } });
	});

	it('sends a tab holder that changed without its transcripts', () => {
		const prev = agent();
		const closed = createMockAITab({ id: 'gone', logs: [entry('closed transcript')] });
		const next = { ...prev, closedTabHistory: [{ tab: closed, index: 2, closedAt: 3 }] };

		expect(diff(prev, next)?.session?.closedTabHistory).toEqual([
			{ tab: { ...closed, logs: [] }, index: 2, closedAt: 3 },
		]);
	});

	it('reports a popped tab that left as removed, and sends it whole when it comes back', () => {
		const prev = agent();
		const popped = aiTab(prev, 'popped');
		const snoozed: Session = {
			...prev,
			aiTabs: prev.aiTabs.filter((tab) => tab.id !== 'popped'),
			snoozedTabs: [{ id: 'z', type: 'ai', tab: popped, unifiedIndex: 0, snoozedAt: 1, wakeAt: 2 }],
		};

		const gone = diff(prev, snoozed);
		expect(gone?.tabs).toEqual([{ ref: POPPED_REF, removed: true }]);
		const parked = gone?.session?.snoozedTabs?.[0];
		expect(parked?.type === 'ai' && parked.tab.logs).toEqual([]);

		const back = diff(snoozed, prev);
		const { logs, ...fields } = popped;
		expect(back?.tabs).toEqual([
			{ ref: POPPED_REF, fields, logSplice: { start: 0, entries: logs } },
		]);
		// The draft rides along: the tab window has none of its own for this tab yet.
		expect(back?.tabs?.[0].fields).toMatchObject({ inputValue: 'owner draft' });
	});

	it('sends a popped file tab as fields only', () => {
		const prev = agent();
		const next = {
			...prev,
			filePreviewTabs: [{ ...fileTab(prev, 'file-1'), customName: 'Notes', isLoading: false }],
		};

		expect(diff(prev, next)?.tabs).toEqual([
			{ ref: FILE_REF, fields: { customName: 'Notes', isLoading: false } },
		]);
	});

	it('never sends the file tab fields the tab window owns while the tab is popped (D5)', () => {
		const prev = agent();
		const owned: Partial<FilePreviewTab> = {
			content: 'v2',
			editContent: 'unsaved',
			editMode: true,
			scrollTop: 120,
			searchQuery: 'needle',
			lastModified: 99,
			path: '/moved/notes.md',
			previewTierOverride: 'fast',
		};
		const next = {
			...prev,
			filePreviewTabs: [{ ...fileTab(prev, 'file-1'), ...owned }],
		};

		// An echo of the owner's copy would undo a newer edit in the tab window.
		expect(diff(prev, next)).toBeNull();
		// The same field names on an AI tab are not the tab window's.
		const ai = withAiTab(prev, 'popped', (tab) => ({ ...tab, scrollTop: 120 }));
		expect(diff(prev, ai)?.tabs).toEqual([{ ref: POPPED_REF, fields: { scrollTop: 120 } }]);
	});

	it('never sends the browser tab fields the tab window owns while the tab is popped (D5)', () => {
		const prev = agent({ browserTabs: [browserTab()] });
		const next = {
			...prev,
			browserTabs: [
				browserTab({
					url: 'https://older.test/',
					title: 'Older',
					favicon: null,
					canGoBack: false,
					isLoading: true,
					webContentsId: 9,
					remotePage: true,
					customTitle: 'Docs',
					hiddenFromAgent: true,
				}),
			],
		};

		// The page and its runtime state are the tab window's webview's; the
		// owner's rename and agent visibility still reach it.
		expect(diff(prev, next, [BROWSER_REF])?.tabs).toEqual([
			{ ref: BROWSER_REF, fields: { customTitle: 'Docs', hiddenFromAgent: true } },
		]);
	});

	it('caps tool output in a splice', () => {
		const prev = agent();
		const next = withLogs(prev, 'popped', (logs) => [
			...logs,
			toolEntry('z'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 1)),
		]);

		const sent = diff(prev, next)?.tabs?.[0].logSplice?.entries[0];

		expect(sent?.metadata?.toolState?.output).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
	});

	it('names a tab once when its ref is listed twice', () => {
		const prev = agent();
		const next = withLogs(prev, 'popped', (logs) => [...logs, entry('again')]);

		expect(diff(prev, next, [POPPED_REF, POPPED_REF])?.tabs).toHaveLength(1);
	});
});

describe('applyTabWindowPatch', () => {
	it('applies a snapshot to a window that holds nothing yet', () => {
		const session = agent();
		const mirror = attach(session, REFS, 4);

		expect(mirror.seq).toBe(4);
		expect(mirror.tabRefs).toEqual(REFS);
		expect(mirror.session).toEqual(buildTabWindowSnapshot(session, REFS));
	});

	it('applies a delta only to the same agent, right after the previous patch', () => {
		const prev = agent();
		const next = withLogs(prev, 'popped', (logs) => [...logs, entry('more')]);
		const changes = diff(prev, next)!;
		const mirror = attach(prev);

		expect(applyDelta(null, changes)).toBeNull();
		expect(applyDelta(mirror, changes, mirror.seq + 2)).toBeNull();
		expect(applyDelta(mirror, changes, mirror.seq)).toBeNull();
		expect(
			applyTabWindowPatch(mirror, { form: 'delta', agentId: 'agent-2', seq: 1, ...changes })
		).toBeNull();

		const applied = applyDelta(mirror, changes);
		expect(applied?.seq).toBe(1);
		expect(aiTab(applied!.session, 'popped').logs).toEqual(aiTab(next, 'popped').logs);
	});

	it('refuses a splice that starts past the end of the transcript it holds', () => {
		const mirror = attach(agent());
		const late = { ref: POPPED_REF, logSplice: { start: 5, entries: [entry('x')] } };
		expect(applyDelta(mirror, { tabs: [late] })).toBeNull();

		// A tab that was not popped at the snapshot holds no transcript to splice onto.
		const notHeld = { ref: OTHER_REF, logSplice: { start: 1, entries: [entry('y')] } };
		expect(applyDelta(mirror, { tabs: [notHeld] })).toBeNull();
	});

	it('removes a field the owner removed', () => {
		const mirror = attach(
			withAiTab(agent({ statusMessage: 'busy...' }), 'popped', (tab) => ({
				...tab,
				hasUnread: true,
			}))
		);

		const applied = applyDelta(mirror, {
			session: { statusMessage: undefined },
			tabs: [{ ref: POPPED_REF, fields: { hasUnread: undefined } }],
		})!;

		expect('statusMessage' in applied.session).toBe(false);
		expect('hasUnread' in aiTab(applied.session, 'popped')).toBe(false);
	});

	it('never lets a delta overwrite a per-window field', () => {
		const mirror = attach(agent());

		const applied = applyDelta(mirror, {
			session: { activeTabId: 'popped', inputMode: 'terminal', state: 'busy' },
			tabs: [{ ref: POPPED_REF, fields: { inputValue: 'from the owner', state: 'busy' } }],
		})!;

		expect(applied.session.state).toBe('busy');
		expect(applied.session.activeTabId).toBe('other');
		expect(applied.session.inputMode).toBe('ai');
		expect(aiTab(applied.session, 'popped')).toMatchObject({
			state: 'busy',
			inputValue: 'owner draft',
		});
	});

	it('never lets a delta overwrite what the tab window owns on a popped file tab', () => {
		const mirror = attach(agent());
		const edited: TabWindowMirror<Session> = {
			...mirror,
			session: {
				...mirror.session,
				filePreviewTabs: [
					{ ...fileTab(mirror.session, 'file-1'), editContent: 'typed here', editMode: true },
				],
			},
		};

		const applied = applyDelta(edited, {
			tabs: [
				{
					ref: FILE_REF,
					fields: { editContent: undefined, editMode: false, content: 'v0', customName: 'Notes' },
				},
			],
		})!;

		expect(fileTab(applied.session, 'file-1')).toMatchObject({
			editContent: 'typed here',
			editMode: true,
			content: 'v1',
			customName: 'Notes',
		});
	});

	it('drops a tab the owner removed and adds a tab it did not hold', () => {
		const prev = agent();
		const without: Session = { ...prev, aiTabs: prev.aiTabs.filter((tab) => tab.id !== 'popped') };
		let mirror = applyDelta(attach(prev), diff(prev, without)!)!;
		expect(mirror.session.aiTabs.map((tab) => tab.id)).toEqual(['other']);

		mirror = applyDelta(mirror, diff(without, prev)!)!;
		expect(aiTab(mirror.session, 'popped')).toEqual(aiTab(prev, 'popped'));
	});

	it('refuses a change to a tab it does not hold instead of building a partial tab', () => {
		const prev = agent();
		const without: Session = { ...prev, aiTabs: prev.aiTabs.filter((tab) => tab.id !== 'popped') };
		const mirror = applyDelta(attach(prev), diff(prev, without)!)!;

		expect(
			applyDelta(mirror, { tabs: [{ ref: POPPED_REF, fields: { state: 'busy' } }] })
		).toBeNull();
		expect(
			applyDelta(mirror, {
				tabs: [{ ref: POPPED_REF, logSplice: { start: 0, entries: [entry('x')] } }],
			})
		).toBeNull();
	});

	it('refuses a malformed delta body instead of throwing', () => {
		const mirror = attach(agent());
		const malformed: unknown[] = [
			{ session: 'not an object' },
			{ tabs: 'not a list' },
			{ tabs: [{}] },
			{ tabs: [{ ref: { type: 'group', id: 'g1' } }] },
			{ tabs: [{ ref: POPPED_REF, fields: 'state' }] },
			{ tabs: [{ ref: POPPED_REF, logSplice: 3 }] },
			{ tabs: [{ ref: POPPED_REF, logSplice: { start: 1.5, entries: [] } }] },
			{ tabs: [{ ref: POPPED_REF, logSplice: { start: 0, entries: 'x' } }] },
		];
		for (const body of malformed) {
			expect(applyDelta(mirror, body as TabWindowDeltaChanges<Session>)).toBeNull();
		}
	});

	it('keeps its own per-window fields across a snapshot of the same agent', () => {
		const first = attach(agent(), [POPPED_REF]);
		// The tab window's own writes: its composer flushed a draft, it shows the popped tab.
		const typed: TabWindowMirror<Session> = {
			...first,
			session: withAiTab({ ...first.session, activeTabId: 'popped' }, 'popped', (tab) => ({
				...tab,
				inputValue: 'typed in the tab window',
				commandMode: 'shell',
			})),
		};
		// The registry changed (a second tab popped in) before the owner saw that draft.
		const owner = withAiTab(agent(), 'other', (tab) => ({
			...tab,
			inputValue: 'other owner draft',
		}));
		const refs = [POPPED_REF, OTHER_REF];

		const mirror = applyTabWindowPatch(typed, {
			form: 'snapshot',
			agentId: AGENT,
			seq: 7,
			tabRefs: refs,
			session: buildTabWindowSnapshot(owner, refs),
		})!;

		expect(mirror.session.activeTabId).toBe('popped');
		expect(aiTab(mirror.session, 'popped')).toMatchObject({
			inputValue: 'typed in the tab window',
			commandMode: 'shell',
		});
		// Just arrived: seeded from the owner, transcript included.
		expect(aiTab(mirror.session, 'other')).toMatchObject({ inputValue: 'other owner draft' });
		expect(aiTab(mirror.session, 'other').logs).toEqual(aiTab(owner, 'other').logs);
		expect(mirror.tabRefs).toEqual(refs);
		expect(mirror.seq).toBe(7);
	});

	it('keeps a popped browser tab its own page across a delta and a snapshot', () => {
		const owner = agent({ browserTabs: [browserTab()] });
		const first = attach(owner, [BROWSER_REF]);
		expect(first.session.browserTabs?.[0]).toMatchObject({ url: 'https://owner.test/' });
		const navigated: TabWindowMirror<Session> = {
			...first,
			session: {
				...first.session,
				browserTabs: [browserTab({ url: 'https://here.test/', title: 'Here', webContentsId: 11 })],
			},
		};

		// An echo of an older write-back moves nothing.
		const applied = applyDelta(navigated, {
			tabs: [
				{
					ref: BROWSER_REF,
					fields: { url: 'https://older.test/', title: 'Older', customTitle: 'Docs' },
				},
			],
		})!;
		expect(applied.session.browserTabs?.[0]).toMatchObject({
			url: 'https://here.test/',
			title: 'Here',
			webContentsId: 11,
			customTitle: 'Docs',
		});

		const again = applyTabWindowPatch(applied, {
			form: 'snapshot',
			agentId: AGENT,
			seq: applied.seq + 1,
			tabRefs: [BROWSER_REF],
			session: buildTabWindowSnapshot(owner, [BROWSER_REF]),
		})!;
		expect(again.session.browserTabs?.[0]).toMatchObject({
			url: 'https://here.test/',
			webContentsId: 11,
		});
	});

	it('keeps a popped file tab its own edits across a snapshot, and seeds one that just arrived', () => {
		const first = attach(agent(), [FILE_REF]);
		const edited: TabWindowMirror<Session> = {
			...first,
			session: {
				...first.session,
				filePreviewTabs: [
					{ ...fileTab(first.session, 'file-1'), editContent: 'typed here', scrollTop: 40 },
				],
			},
		};
		const owner = agent({
			filePreviewTabs: [
				createMockFileTab({ id: 'file-1', content: 'v1', editContent: 'stale', scrollTop: 0 }),
				createMockFileTab({ id: 'file-2', content: 'two', editContent: 'owner edit' }),
			],
		});
		const refs: TabWindowTabRef[] = [FILE_REF, { type: 'file', id: 'file-2' }];

		const mirror = applyTabWindowPatch(edited, {
			form: 'snapshot',
			agentId: AGENT,
			seq: 3,
			tabRefs: refs,
			session: buildTabWindowSnapshot(owner, refs),
		})!;

		expect(fileTab(mirror.session, 'file-1')).toMatchObject({
			editContent: 'typed here',
			scrollTop: 40,
		});
		expect(fileTab(mirror.session, 'file-2')).toMatchObject({ editContent: 'owner edit' });
	});

	it('takes the owner draft for a tab that was docked, and again when it comes back', () => {
		const both = [POPPED_REF, OTHER_REF];
		const first = attach(agent(), both);
		const typed = {
			...first,
			session: withAiTab(first.session, 'other', (tab) => ({ ...tab, inputValue: 'typed here' })),
		};
		const snapshotOf = (session: Session, tabRefs: TabWindowTabRef[], seq: number) => ({
			form: 'snapshot' as const,
			agentId: AGENT,
			seq,
			tabRefs,
			session: buildTabWindowSnapshot(session, tabRefs),
		});

		// Docked: the owner holds the draft again, so its copy replaces the window's.
		const atDock = withAiTab(agent(), 'other', (tab) => ({ ...tab, inputValue: 'owner copy' }));
		const docked = applyTabWindowPatch(typed, snapshotOf(atDock, [POPPED_REF], 1))!;
		expect(aiTab(docked.session, 'other').inputValue).toBe('owner copy');

		// Edited in the owner while docked, then popped again: the owner's edit wins.
		const edited = withAiTab(agent(), 'other', (tab) => ({
			...tab,
			inputValue: 'edited in owner',
		}));
		const repopped = applyTabWindowPatch(docked, snapshotOf(edited, both, 2))!;
		expect(aiTab(repopped.session, 'other').inputValue).toBe('edited in owner');
	});

	it('starts over for another agent, and refuses a snapshot of a different agent than it names', () => {
		const mirror = attach(agent());
		const otherAgent = agent({ id: 'agent-2', name: 'Other' });

		const switched = applyTabWindowPatch(mirror, {
			form: 'snapshot',
			agentId: 'agent-2',
			seq: 0,
			tabRefs: REFS,
			session: buildTabWindowSnapshot(otherAgent, REFS),
		});
		expect(switched?.session).toEqual(buildTabWindowSnapshot(otherAgent, REFS));

		expect(
			applyTabWindowPatch(mirror, {
				form: 'snapshot',
				agentId: AGENT,
				seq: 0,
				tabRefs: REFS,
				session: otherAgent,
			})
		).toBeNull();
	});
});

describe('round trip', () => {
	/** Every session-level field a delta carries (not a tab list, not a per-window field). */
	function sessionLevel(session: Session) {
		const {
			aiTabs: _ai,
			filePreviewTabs: _files,
			terminalTabs: _terminals,
			browserTabs: _browsers,
			...rest
		} = session;
		return rest;
	}

	it('snapshot then deltas equals the final session for the popped tabs', () => {
		const s0 = agent();
		const user = entry('ship it', { source: 'user' });
		const thinking = entry('planning', { source: 'thinking' });
		const answer = entry('On');
		const tool = entry('Bash', { source: 'tool', metadata: { toolState: { status: 'running' } } });
		const after = entry('Done');

		const steps: Array<(s: Session) => Session> = [
			// The user sends: the message lands and the turn starts.
			(s) => ({
				...withAiTab(s, 'popped', (tab) => ({
					...tab,
					state: 'busy',
					thinkingStartTime: 100,
					logs: [...tab.logs, user],
				})),
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 100,
			}),
			(s) => withLogs(s, 'popped', (logs) => [...logs, thinking]),
			(s) => withLogs(s, 'popped', (logs) => [...logs, answer]),
			// Stream coalescing rewrites the last entry.
			(s) => withLogs(s, 'popped', (logs) => [...logs.slice(0, -1), { ...answer, text: 'On it' }]),
			// Only the tab that stayed home changes: nothing to send.
			(s) => withLogs(s, 'other', (logs) => [...logs, entry('elsewhere')]),
			(s) => withLogs(s, 'popped', (logs) => [...logs, tool]),
			// The tool finishes and a new answer streams after it, in one coalesced patch.
			(s) =>
				withLogs(s, 'popped', (logs) => [
					...logs.slice(0, -1),
					{ ...tool, metadata: { toolState: { status: 'completed', output: 'done' } } },
					after,
				]),
			// The flush drops the thinking entry and the tool entry.
			(s) =>
				withLogs(s, 'popped', (logs) =>
					logs.filter((log) => log.source !== 'thinking' && log.source !== 'tool')
				),
			(s) => ({
				...s,
				filePreviewTabs: s.filePreviewTabs.map((tab) => ({ ...tab, customName: 'Notes' })),
			}),
			// The turn ends.
			(s) => {
				const { thinkingStartTime: _t, busySource: _b, ...idle } = s;
				return withAiTab(
					{ ...idle, state: 'idle' },
					'popped',
					({ thinkingStartTime: _tt, ...tab }) => ({
						...tab,
						state: 'idle',
						name: 'Shipped',
						hasUnread: true,
					})
				);
			},
			// A delete trims the transcript.
			(s) => withLogs(s, 'popped', (logs) => logs.slice(0, 2)),
		];

		let mirror: TabWindowMirror<Session> | null = attach(s0);
		let prev = s0;
		let silentSteps = 0;
		for (const step of steps) {
			const next = step(prev);
			const changes = diff(prev, next);
			if (changes) mirror = applyDelta(mirror, changes);
			else silentSteps += 1;
			expect(mirror).not.toBeNull();
			prev = next;
		}
		const final = prev;
		const held = mirror!.session;

		expect(silentSteps).toBe(1);
		expect(mirror!.seq).toBe(steps.length - silentSteps);
		expect(aiTab(held, 'popped')).toEqual(aiTab(final, 'popped'));
		expect(fileTab(held, 'file-1')).toEqual(fileTab(final, 'file-1'));
		expect(sessionLevel(held)).toEqual(sessionLevel(final));
		// The tab that stayed home never sent its transcript.
		expect(aiTab(held, 'other').logs).toEqual([]);
	});
});
