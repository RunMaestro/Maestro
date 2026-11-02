import { describe, expect, it } from 'vitest';
import {
	MAX_CLOSED_TAB_HISTORY,
	closedTabHistoryContext,
	isClosedAiTabReloadable,
	normalizeStoredClosedTabs,
	projectClosedTabHistory,
	type ClosedTabHistoryContext,
} from '../../shared/closedTabHistory';
import { MAX_PERSISTED_SESSION_LOGS } from '../../shared/deferredSessionContent';
import { mergeSessionPersistenceChanges } from '../../shared/sessionPersistenceMerge';

const local: ClosedTabHistoryContext = { toolType: 'claude-code', sshRemote: false };

const logs = (count: number) =>
	Array.from({ length: count }, (_, i) => ({ id: `log-${i}`, text: `m${i}`, source: 'user' }));

const aiEntry = (id: string, tab: Record<string, unknown> = {}, entry = {}) => ({
	type: 'ai',
	tab: {
		id,
		agentSessionId: `provider-${id}`,
		name: null,
		logs: logs(3),
		state: 'busy',
		thinkingStartTime: 123,
		scrollTop: 400,
		isAtBottom: false,
		inputValue: 'draft',
		...tab,
	},
	unifiedIndex: 1,
	closedAt: 1000,
	...entry,
});

describe('projectClosedTabHistory', () => {
	it('drops the logs of an AI tab its provider can give back, and resets runtime state', () => {
		const [stored] = projectClosedTabHistory<any>([aiEntry('a')], local)!;
		expect(stored.tab.logs).toEqual([]);
		expect(stored.tab.state).toBe('idle');
		expect(stored.tab).not.toHaveProperty('thinkingStartTime');
		expect(stored.tab).not.toHaveProperty('scrollTop');
		expect(stored.tab).not.toHaveProperty('isAtBottom');
		// The draft and the provider session id survive: reopen needs them.
		expect(stored.tab.inputValue).toBe('draft');
		expect(stored.tab.agentSessionId).toBe('provider-a');
	});

	it('keeps the newest logs when nothing else can give the transcript back', () => {
		const long = logs(MAX_PERSISTED_SESSION_LOGS + 20);
		const cases: Array<[string, Record<string, unknown>, ClosedTabHistoryContext]> = [
			['no session id', { agentSessionId: null, logs: long }, local],
			['provider without storage', { logs: long, turnProvider: 'hermes' }, local],
			['SSH agent', { logs: long }, { toolType: 'claude-code', sshRemote: true }],
		];
		for (const [label, tab, context] of cases) {
			const [stored] = projectClosedTabHistory<any>([aiEntry('a', tab)], context)!;
			expect(stored.tab.logs, label).toHaveLength(MAX_PERSISTED_SESSION_LOGS);
			expect(stored.tab.logs[stored.tab.logs.length - 1].id, label).toBe(long[long.length - 1].id);
		}
	});

	it('reads the provider from turnProvider before the agent toolType', () => {
		expect(isClosedAiTabReloadable({ agentSessionId: 'x', turnProvider: 'hermes' }, local)).toBe(
			false
		);
		expect(
			isClosedAiTabReloadable(
				{ agentSessionId: 'x', turnProvider: 'claude-code' },
				{ toolType: 'hermes', sshRemote: false }
			)
		).toBe(true);
	});

	it('drops file content, browser page state, and terminal PTY state', () => {
		const stored = projectClosedTabHistory<any>(
			[
				{
					type: 'file',
					tab: { id: 'f', path: '/a.md', content: 'big', editContent: 'x', isLoading: true },
					unifiedIndex: 0,
					closedAt: 1,
				},
				{
					type: 'browser',
					tab: {
						id: 'b',
						url: 'https://x.dev',
						webContentsId: 7,
						isLoading: true,
						canGoBack: true,
					},
					unifiedIndex: 0,
					closedAt: 1,
				},
				{
					type: 'terminal',
					tab: { id: 't', cwd: '/w', pid: 42, state: 'exited', exitCode: 1, ptyInitialized: true },
					unifiedIndex: 0,
					closedAt: 1,
				},
			],
			local
		)!;
		expect(stored[0].tab).toEqual({ id: 'f', path: '/a.md', content: '' });
		expect(stored[1].tab).toEqual({
			id: 'b',
			url: 'https://x.dev',
			isLoading: false,
			canGoBack: false,
			canGoForward: false,
		});
		expect(stored[2].tab).toEqual({ id: 't', cwd: '/w', pid: 0, state: 'idle' });
	});

	it('never stores an incognito browser tab', () => {
		const incognito = [
			{ type: 'browser', tab: { id: 'b1', ephemeral: true }, unifiedIndex: 0, closedAt: 1 },
			{
				type: 'browser',
				tab: { id: 'b2', partition: 'maestro-ephemeral-agent-abcd1234' },
				unifiedIndex: 0,
				closedAt: 1,
			},
		];
		expect(projectClosedTabHistory(incognito, local)).toBeUndefined();
	});

	it('caps the stack at MAX_CLOSED_TAB_HISTORY, keeping the newest entries', () => {
		const history = Array.from({ length: MAX_CLOSED_TAB_HISTORY + 5 }, (_, i) => aiEntry(`t${i}`));
		const stored = projectClosedTabHistory<any>(history, local)!;
		expect(stored).toHaveLength(MAX_CLOSED_TAB_HISTORY);
		expect(stored[0].tab.id).toBe('t0');
	});

	it('drops malformed entries and coerces bad positions', () => {
		const stored = projectClosedTabHistory<any>(
			[
				null,
				'nope',
				{ type: 'mystery', tab: { id: 'x' } },
				{ type: 'ai', tab: { name: 'no id' } },
				aiEntry('a', {}, { unifiedIndex: -1, closedAt: Number.NaN }),
				aiEntry('b', { agentSessionId: 42 }, { tilePlacement: { groupId: 'g' } }),
				aiEntry(
					'c',
					{},
					{
						tilePlacement: {
							groupId: 'g',
							groupName: 'G',
							anchorRef: { type: 'ai', id: 'z' },
							direction: 'row',
							before: true,
						},
					}
				),
			],
			local
		)!;
		expect(stored.map((entry) => entry.tab.id)).toEqual(['a', 'b', 'c']);
		expect(stored[0].unifiedIndex).toBe(Number.MAX_SAFE_INTEGER);
		expect(stored[0].closedAt).toBe(0);
		expect(stored[1].tab.agentSessionId).toBeNull();
		expect(stored[1]).not.toHaveProperty('tilePlacement');
		expect(stored[2].tilePlacement.anchorRef).toEqual({ type: 'ai', id: 'z' });
	});

	it('is canonical when empty: undefined, never []', () => {
		expect(projectClosedTabHistory([], local)).toBeUndefined();
		expect(projectClosedTabHistory(undefined, local)).toBeUndefined();
		expect(projectClosedTabHistory({ not: 'an array' }, local)).toBeUndefined();
	});

	it('is idempotent and reference-stable for entries already in stored form', () => {
		const history = [
			aiEntry('a'),
			aiEntry('b', { agentSessionId: null, logs: logs(MAX_PERSISTED_SESSION_LOGS + 1) }),
			{ type: 'file', tab: { id: 'f', path: '/a', content: 'x' }, unifiedIndex: 2, closedAt: 3 },
		];
		const once = projectClosedTabHistory<any>(history, local)!;
		const twice = projectClosedTabHistory<any>(once, local)!;
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
		twice.forEach((entry, i) => expect(entry).toBe(once[i]));
	});
});

describe('closedTabHistoryContext', () => {
	it('reads the provider and the SSH switch from the agent record', () => {
		expect(
			closedTabHistoryContext({ toolType: 'codex', sessionSshRemoteConfig: { enabled: true } })
		).toEqual({ toolType: 'codex', sshRemote: true });
		expect(closedTabHistoryContext(null)).toEqual({ toolType: undefined, sshRemote: false });
	});
});

describe('normalizeStoredClosedTabs', () => {
	it('returns the same record when it already conforms', () => {
		const plain = { id: 's', toolType: 'claude-code' };
		expect(normalizeStoredClosedTabs(plain)).toBe(plain);
		const stored = {
			id: 's',
			toolType: 'claude-code',
			unifiedClosedTabHistory: projectClosedTabHistory([aiEntry('a')], local),
		};
		expect(normalizeStoredClosedTabs(stored)).toBe(stored);
	});

	it('heals a raw stack, drops the legacy key, and removes an empty stack', () => {
		const raw = {
			id: 's',
			toolType: 'claude-code',
			closedTabHistory: [{ tab: { id: 'a', logs: logs(3) }, index: 0, closedAt: 1 }],
			unifiedClosedTabHistory: [aiEntry('a')],
		};
		const healed = normalizeStoredClosedTabs(raw) as any;
		expect(healed).not.toHaveProperty('closedTabHistory');
		expect(healed.unifiedClosedTabHistory[0].tab.logs).toEqual([]);
		expect(raw.unifiedClosedTabHistory[0].tab.logs).toHaveLength(3);

		const empty = normalizeStoredClosedTabs({ id: 's', unifiedClosedTabHistory: [] });
		expect(empty).not.toHaveProperty('unifiedClosedTabHistory');
	});

	it('lets the next close merge after healing a store written before this change', () => {
		// Stores as they exist in the field: no key, an empty array, a raw stack.
		const variants = [
			{ id: 's', toolType: 'claude-code' },
			{ id: 's', toolType: 'claude-code', unifiedClosedTabHistory: [] },
			{ id: 's', toolType: 'claude-code', unifiedClosedTabHistory: [aiEntry('old')] },
		];
		for (const variant of variants) {
			const stored = normalizeStoredClosedTabs(variant) as Record<string, unknown>;
			// The renderer restores the projection, then closes a tab.
			const restored = projectClosedTabHistory(stored.unifiedClosedTabHistory, local) ?? [];
			const baseline = { ...stored };
			const next = projectClosedTabHistory([aiEntry('new'), ...restored], local);
			const incoming = { ...stored, unifiedClosedTabHistory: next };
			const merged = normalizeStoredClosedTabs(
				mergeSessionPersistenceChanges(incoming, stored, baseline)
			) as any;
			expect(merged.unifiedClosedTabHistory[0].tab.id).toBe('new');
		}
	});
});
