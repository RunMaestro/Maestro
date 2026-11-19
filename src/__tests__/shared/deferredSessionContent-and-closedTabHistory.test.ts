// Source: src/__tests__/shared/deferredSessionContent.test.ts
// Source: src/__tests__/shared/closedTabHistory.test.ts
// Source: src/__tests__/shared/toolOutput.test.ts
// Source: src/__tests__/shared/sessionPersistenceMerge.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { mergeDeferredItems } from '../../shared/deferredSessionContent';
import { MAX_CLOSED_TAB_HISTORY } from '../../shared/closedTabHistory';
import { closedTabHistoryContext } from '../../shared/closedTabHistory';
import { isClosedAiTabReloadable } from '../../shared/closedTabHistory';
import { normalizeStoredClosedTabs } from '../../shared/closedTabHistory';
import { projectClosedTabHistory } from '../../shared/closedTabHistory';
import type { ClosedTabHistoryContext } from '../../shared/closedTabHistory';
import { MAX_PERSISTED_SESSION_LOGS } from '../../shared/deferredSessionContent';
import { mergeSessionPersistenceChanges } from '../../shared/sessionPersistenceMerge';
import { MAX_PERSISTED_TOOL_INPUT_STRING_CHARS } from '../../shared/toolOutput';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS } from '../../shared/toolOutput';
import { compactSessionToolOutputs } from '../../shared/toolOutput';
import { compactToolInput } from '../../shared/toolOutput';
import { compactToolOutput } from '../../shared/toolOutput';
describeSourceSuite('deferredSessionContent', () => {
	type Item = { id?: string; v: number };
	const keyOf = (item: Item) => item.id;

	describe('mergeDeferredItems', () => {
		it('keeps stored order, replaces matching keys in place, and appends new ones', () => {
			const merged = mergeDeferredItems<Item>(
				[
					{ id: 'a', v: 1 },
					{ id: 'b', v: 1 },
				],
				[
					{ id: 'b', v: 2 },
					{ id: 'c', v: 1 },
				],
				keyOf
			);
			expect(merged).toEqual([
				{ id: 'a', v: 1 },
				{ id: 'b', v: 2 },
				{ id: 'c', v: 1 },
			]);
		});

		it('appends keyless items rather than collapsing them', () => {
			expect(mergeDeferredItems<Item>([{ v: 1 }], [{ v: 2 }], keyOf)).toEqual([{ v: 1 }, { v: 2 }]);
		});

		it('keeps the newest entries when a limit applies', () => {
			const merged = mergeDeferredItems(['a', 'b'], ['c'], (s) => s, 2);
			expect(merged).toEqual(['b', 'c']);
		});

		it('treats missing sides as empty', () => {
			expect(mergeDeferredItems<Item>(undefined, undefined, keyOf)).toEqual([]);
		});
	});
});
describeSourceSuite('closedTabHistory', () => {
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
				expect(stored.tab.logs[stored.tab.logs.length - 1].id, label).toBe(
					long[long.length - 1].id
				);
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
						tab: {
							id: 't',
							cwd: '/w',
							pid: 42,
							state: 'exited',
							exitCode: 1,
							ptyInitialized: true,
						},
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
			const history = Array.from({ length: MAX_CLOSED_TAB_HISTORY + 5 }, (_, i) =>
				aiEntry(`t${i}`)
			);
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
});
describeSourceSuite('toolOutput', () => {
	describe('tool output compaction', () => {
		it('bounds oversized strings and objects', () => {
			const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);

			for (const value of [oversized, { oversized }]) {
				const result = compactToolOutput(value);
				expect(result.truncated).toBe(true);
				expect(result.output).toContain('[tool output truncated');
				expect(result.output).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
				expect(compactToolOutput(result.output)).toEqual({
					output: result.output,
					truncated: false,
				});
			}
		});

		it('replaces unserializable output with a persistence-safe marker', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;

			expect(compactToolOutput(circular)).toEqual({
				output: '[tool output omitted: serialization failed]',
				truncated: true,
			});
		});

		it('compacts nested session tool results without mutating the session', () => {
			const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
			const session = {
				aiTabs: [
					{
						id: 'tab-1',
						logs: [{ metadata: { toolState: { output } } }],
					},
				],
			};

			const result = compactSessionToolOutputs(session);
			expect(result.compacted).toBe(1);
			expect(result.session).not.toBe(session);
			expect(result.session.aiTabs[0].logs[0].metadata.toolState.output).toContain(
				'[tool output truncated'
			);
			expect(session.aiTabs[0].logs[0].metadata.toolState.output).toBe(output);
		});

		it('caps long strings in a tool input but keeps its shape and short fields', () => {
			const content = 'y'.repeat(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS + 500);
			const input = {
				file_path: '/repo/big.ts',
				content,
				edits: [{ old_string: content, new_string: 'short' }],
				replace_all: false,
			};

			const result = compactToolInput(input);
			expect(result.truncated).toBe(true);
			const capped = result.input as typeof input;
			expect(capped.file_path).toBe('/repo/big.ts');
			expect(capped.replace_all).toBe(false);
			expect(capped.edits[0].new_string).toBe('short');
			expect(capped.content).toHaveLength(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS);
			expect(capped.content).toContain('[tool input truncated, 4500 chars total]');
			expect(capped.edits[0].old_string).toHaveLength(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS);
			expect(compactToolInput(capped)).toEqual({ input: capped, truncated: false });
			expect(input.content).toBe(content);

			const small = { todos: [{ content: 'Write tests', status: 'pending' }] };
			expect(compactToolInput(small)).toEqual({ input: small, truncated: false });
			expect(compactToolInput('patch')).toEqual({ input: 'patch', truncated: false });
		});

		it('compacts session tool inputs and trims a transcript past its stored tail', () => {
			const content = 'z'.repeat(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS + 1);
			const logs = Array.from({ length: MAX_PERSISTED_SESSION_LOGS + 8 }, (_, i) => ({
				id: `l${i}`,
			}));
			logs.push({
				id: 'write',
				metadata: { toolState: { input: { file_path: '/a', content }, status: 'completed' } },
			} as never);
			const untouched = { id: 'small', logs: [{ id: 'only' }] };
			const session = { aiTabs: [{ id: 'big', logs }, untouched] };

			const result = compactSessionToolOutputs(session);
			const tab = result.session.aiTabs[0] as { logs: any[] };
			expect(tab.logs).toHaveLength(MAX_PERSISTED_SESSION_LOGS);
			expect(tab.logs.at(-1).id).toBe('write');
			expect(tab.logs[0].id).toBe(`l${logs.length - MAX_PERSISTED_SESSION_LOGS}`);
			expect(tab.logs.at(-1).metadata.toolState.input.file_path).toBe('/a');
			expect(tab.logs.at(-1).metadata.toolState.input.content).toContain('[tool input truncated');
			expect(tab.logs.at(-1).metadata.toolState.status).toBe('completed');
			expect(result.session.aiTabs[1]).toBe(untouched);
			expect(result.compacted).toBe(2);
			expect(session.aiTabs[0].logs).toHaveLength(MAX_PERSISTED_SESSION_LOGS + 9);

			// Already compact: same object back, so the load path skips its rewrite.
			expect(compactSessionToolOutputs(result.session)).toEqual({
				session: result.session,
				compacted: 0,
			});
		});

		it('compacts tool results in closed AI tabs kept with their logs', () => {
			const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
			const terminal = { type: 'terminal', tab: { id: 't' }, unifiedIndex: 0, closedAt: 1 };
			const session = {
				aiTabs: [],
				unifiedClosedTabHistory: [
					{
						type: 'ai',
						tab: { id: 'closed', logs: [{ metadata: { toolState: { output } } }] },
						unifiedIndex: 0,
						closedAt: 1,
					},
					terminal,
				],
			};

			const result = compactSessionToolOutputs(session);
			expect(result.compacted).toBe(1);
			const closed = result.session.unifiedClosedTabHistory;
			expect(closed[0].tab.logs[0].metadata.toolState.output).toContain('[tool output truncated');
			expect(closed[1]).toBe(terminal);
			expect(session.unifiedClosedTabHistory[0].tab.logs[0].metadata.toolState.output).toBe(output);
		});
	});
});
describeSourceSuite('sessionPersistenceMerge', () => {
	describe('observed session changes', () => {
		it('does not mint host release evidence from renderer additions or saves without a baseline', () => {
			const incoming = {
				executionQueue: [
					{
						id: 'item',
						tabId: 'tab',
						pendingAdmissionId: 'dispatch',
						admissionRelease: { generation: 'forged' },
					},
				],
			};
			for (const stored of [
				undefined,
				{ executionQueue: [] },
				{ executionQueue: [{ id: 'item', tabId: 'tab', pendingAdmissionId: 'dispatch' }] },
			]) {
				const merged = mergeSessionPersistenceChanges(incoming, stored, undefined);
				expect(merged.executionQueue[0].admissionRelease).toBeUndefined();
			}
		});

		it('preserves only unchanged Host-observed human queue origins on remote saves', () => {
			const item = { id: 'human', type: 'message', text: 'Read mail', querySource: 'user' };
			const stored = { executionQueue: [item] };
			expect(
				mergeSessionPersistenceChanges(stored, stored, stored, true, false, true).executionQueue[0]
			).toEqual(item);
			for (const changed of [
				{ ...item, text: 'Different operation' },
				{ ...item, tabId: 'other-tab' },
				{ ...item, id: 'new-item' },
			]) {
				const incoming = { executionQueue: [changed] };
				const merged = mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true);
				expect(merged.executionQueue[0].querySource).toBe('auto');
			}
			const incoming = { executionQueue: [item] };
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined, true, false, true)
					.executionQueue[0].querySource
			).toBe('auto');
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined).executionQueue[0].querySource
			).toBe('user');
			expect(
				mergeSessionPersistenceChanges(incoming, undefined, undefined, true).executionQueue[0]
					.querySource
			).toBe('user');
		});

		it('does not accept a remote user claim for existing automatic or legacy queue items', () => {
			for (const querySource of ['auto', undefined]) {
				const stored = { executionQueue: [{ id: 'item', text: 'Read mail', querySource }] };
				const incoming = { executionQueue: [{ ...stored.executionQueue[0], querySource: 'user' }] };
				expect(
					mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true)
						.executionQueue[0].querySource
				).toBe('auto');
			}
		});

		it('accepts tab and queue drag order and new-tab insertion without stealing host group focus', () => {
			const baseline = {
				id: 'shared',
				activeGroupId: 'host-group',
				aiTabs: [
					{ id: 'a', inputValue: 'host draft' },
					{ id: 'b', inputValue: '' },
				],
				unifiedTabOrder: [
					{ id: 'a', type: 'ai' },
					{ id: 'b', type: 'ai' },
				],
				executionQueue: [{ id: 'first' }, { id: 'second' }],
			};
			const incoming = {
				...baseline,
				activeGroupId: 'remote-group',
				aiTabs: [{ id: 'new', inputValue: 'remote draft' }, ...[...baseline.aiTabs].reverse()],
				unifiedTabOrder: [{ id: 'new', type: 'ai' }, ...[...baseline.unifiedTabOrder].reverse()],
				executionQueue: [...baseline.executionQueue].reverse(),
			};
			const remote = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
			expect(remote.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(remote.unifiedTabOrder.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(remote.executionQueue.map((item) => item.id)).toEqual(['second', 'first']);
			expect(remote.activeGroupId).toBe('host-group');
			expect(remote.aiTabs[0].inputValue).toBe('');
			expect(remote.aiTabs[2].inputValue).toBe('host draft');
			const desktop = mergeSessionPersistenceChanges(incoming, baseline, baseline);
			expect(desktop.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
			expect(desktop.activeGroupId).toBe('remote-group');
		});

		it('retains peer-only tabs and does not revive removed tabs during a stale drag', () => {
			const baseline = { aiTabs: [{ id: 'a' }, { id: 'b' }, { id: 'removed' }] };
			const stored = { aiTabs: [{ id: 'a' }, { id: 'peer' }, { id: 'b' }] };
			const incoming = { aiTabs: [{ id: 'new' }, ...[...baseline.aiTabs].reverse()] };
			const merged = mergeSessionPersistenceChanges(incoming, stored, baseline);
			expect(merged.aiTabs.map((tab) => tab.id)).toEqual(['new', 'peer', 'b', 'a']);
		});

		it('keeps the host order when another client already reordered the same queue', () => {
			const baseline = { executionQueue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
			const stored = { executionQueue: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] };
			const incoming = { executionQueue: [...baseline.executionQueue].reverse() };
			expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
				stored.executionQueue
			);
		});

		it('does not rebase a stale drag across a newly installed admission hold', () => {
			const before = { id: 'a', tabId: 'tab-1', type: 'message' };
			const held = { id: 'held', tabId: 'tab-1', type: 'message' };
			const after = { id: 'b', tabId: 'tab-1', type: 'message' };
			const baseline = { executionQueue: [before, held, after] };
			const stored = {
				executionQueue: [before, { ...held, pendingAdmissionId: 'dispatch' }, after],
			};
			const incoming = { executionQueue: [after, before, held] };
			expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
				stored.executionQueue
			);
		});

		it('retains an existing admission hold across observed and baseline-less renderer saves', () => {
			const item = { id: 'held', type: 'message', tabId: 'tab', pendingAdmissionId: 'dispatch' };
			const stored = { executionQueue: [item] };
			for (const replacement of [undefined, 'different-dispatch']) {
				const incoming = { executionQueue: [{ ...item, pendingAdmissionId: replacement }] };
				for (const baseline of [stored, undefined]) {
					expect(
						mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue[0]
							.pendingAdmissionId
					).toBe('dispatch');
				}
			}
			const renamedType: {
				executionQueue: { id: string; type: string; tabId: string; pendingAdmissionId?: string }[];
			} = {
				executionQueue: [{ ...item, type: 'other', pendingAdmissionId: undefined }],
			};
			expect(
				mergeSessionPersistenceChanges(renamedType, stored, undefined).executionQueue[0]
					.pendingAdmissionId
			).toBe('dispatch');
		});

		it('still permits cancellation of a held item without transferring its hold to another row', () => {
			const held = { id: 'held', type: 'message', pendingAdmissionId: 'dispatch' };
			const other = { id: 'other', type: 'message' };
			const stored = { executionQueue: [held, other] };
			const incoming = { executionQueue: [other] };
			expect(mergeSessionPersistenceChanges(incoming, stored, stored).executionQueue).toEqual([
				other,
			]);
		});

		it('keeps the exact held operation across changed payload, tab and type while allowing pause', () => {
			const held = {
				id: 'held',
				type: 'message',
				tabId: 'tab',
				text: 'original',
				images: ['original-image'],
				pendingAdmissionId: 'dispatch',
			};
			const stored = { executionQueue: [held] };
			const incoming = {
				executionQueue: [
					{
						...held,
						type: 'command',
						tabId: 'other',
						text: 'changed',
						images: ['changed-image'],
						pendingAdmissionId: 'other-dispatch',
						paused: true,
					},
				],
			};
			for (const baseline of [stored, undefined]) {
				expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual([
					{ ...held, paused: true },
				]);
			}
		});

		it('does not allow a changed tab or removed hold to bypass the queue order barrier', () => {
			const before = { id: 'before', type: 'message', tabId: 'tab' };
			const held = { id: 'held', type: 'message', tabId: 'tab', pendingAdmissionId: 'dispatch' };
			const after = { id: 'after', type: 'message', tabId: 'tab' };
			const stored = { executionQueue: [before, held, after] };
			const incoming = {
				executionQueue: [after, before, { ...held, tabId: 'other', pendingAdmissionId: '' }],
			};
			expect(mergeSessionPersistenceChanges(incoming, stored, stored).executionQueue).toEqual(
				stored.executionQueue
			);
		});

		it('does not move same-tab work across a peer-only admission hold during a stale drag', () => {
			const before = { id: 'a', tabId: 'tab-1', type: 'message' };
			const after = { id: 'b', tabId: 'tab-1', type: 'message' };
			const held = { id: 'held', tabId: 'tab-1', type: 'message', pendingAdmissionId: 'dispatch' };
			const baseline = { executionQueue: [before, after] };
			const stored = { executionQueue: [before, held, after] };
			const incoming = { executionQueue: [after, before] };
			expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
				stored.executionQueue
			);
		});

		it('keeps independent tab reordering when rebasing around an admission hold', () => {
			const held = { id: 'held', tabId: 'tab-1', type: 'message', pendingAdmissionId: 'dispatch' };
			const other = { id: 'other', tabId: 'tab-2', type: 'message' };
			const baseline = { executionQueue: [held, other] };
			const incoming = { executionQueue: [other, held] };
			expect(mergeSessionPersistenceChanges(incoming, baseline, baseline).executionQueue).toEqual(
				incoming.executionQueue
			);
		});

		it('preserves an owning ConPTY terminal with PID zero across stale remote saves and live peer reconciliation', () => {
			const baseline = {
				terminalTabs: [{ id: 'owned', pid: 0, ptyInitialized: true, name: 'Terminal' }],
			};
			const incoming = {
				terminalTabs: [
					{ ...baseline.terminalTabs[0], ptyInitialized: false, name: 'Renamed' },
					{ id: 'new', pid: 0, ptyInitialized: true, name: 'New' },
				],
			};
			const saved = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
			expect(saved.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
				pid: 0,
				ptyInitialized: true,
				name: 'Renamed',
			});
			expect(saved.terminalTabs.find((tab) => tab.id === 'new')).not.toHaveProperty(
				'ptyInitialized'
			);
			const firstTerminal = mergeSessionPersistenceChanges<{
				terminalTabs?: typeof incoming.terminalTabs;
			}>(incoming, {}, {}, true);
			expect(firstTerminal.terminalTabs?.[0]).not.toHaveProperty('ptyInitialized');
			const live = mergeSessionPersistenceChanges(incoming, baseline, baseline, true, true);
			expect(live.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
				pid: 0,
				ptyInitialized: true,
				name: 'Renamed',
			});
			expect(live.terminalTabs.find((tab) => tab.id === 'new')?.ptyInitialized).toBe(true);
		});

		it('retains live incognito tabs and client focus across persisted normal-tab updates and closure', () => {
			const normal = { id: 'normal', title: 'Before', url: 'https://example.test/' };
			const privateTab = {
				id: 'private',
				title: 'Private',
				url: 'https://private.test/',
				ephemeral: true,
			};
			const baseline = { browserTabs: [normal], activeBrowserTabId: 'normal' };
			const local = { browserTabs: [normal, privateTab], activeBrowserTabId: 'private' };
			const updated = mergeSessionPersistenceChanges(
				{ ...baseline, browserTabs: [{ ...normal, title: 'After' }] },
				local,
				baseline,
				true,
				true
			);
			expect(updated.browserTabs).toEqual([{ ...normal, title: 'After' }, privateTab]);
			expect(updated.activeBrowserTabId).toBe('private');
			const closedNormal = mergeSessionPersistenceChanges(
				{ ...baseline, browserTabs: [] },
				local,
				baseline,
				true,
				true
			);
			expect(closedNormal.browserTabs).toEqual([privateTab]);
			expect(closedNormal.activeBrowserTabId).toBe('private');
		});
	});

	describe('consumed execution queue entries', () => {
		it.each([{ waitingForConnection: undefined }, { paused: true }, { text: 'edited' }])(
			'does not retain a consumed ID after a local metadata edit %j',
			(edit) => {
				const item = {
					id: 'consumed',
					type: 'message',
					text: 'Ja bitte',
					waitingForConnection: true,
				};
				const baseline = { executionQueue: [item] };
				const unsent = { id: 'unsent', type: 'message', text: 'new work' };
				const client = { executionQueue: [{ ...item, ...edit }, unsent] };
				expect(
					mergeSessionPersistenceChanges({ executionQueue: [] }, client, baseline, true, true)
						.executionQueue
				).toEqual([unsent]);
			}
		);

		it('persists a host dequeue even if a browser updated the stored queued item', () => {
			const item = { id: 'consumed', text: 'Ja bitte' };
			const baseline = { executionQueue: [item] };
			const stored = { executionQueue: [{ ...item, paused: true }] };
			expect(
				mergeSessionPersistenceChanges({ executionQueue: [] }, stored, baseline).executionQueue
			).toEqual([]);
		});

		it('still retains edited rows in other collections', () => {
			const baseline = { aiLogs: [{ id: 'edited', text: 'before' }] };
			const stored = { aiLogs: [{ id: 'edited', text: 'after' }] };
			expect(mergeSessionPersistenceChanges({ aiLogs: [] }, stored, baseline).aiLogs).toEqual(
				stored.aiLogs
			);
		});
	});

	describe('closed tabs (#2008)', () => {
		it.each([
			['aiTabs', 'ai'],
			['filePreviewTabs', 'file'],
			['browserTabs', 'browser'],
			['terminalTabs', 'terminal'],
		] as const)(
			'a close the client observed removes the %s record even when the stored copy changed',
			(field, type) => {
				const tab = { id: 'closed', name: 'before' };
				const kept = { id: 'kept' };
				const baseline = {
					[field]: [tab, kept],
					unifiedTabOrder: [
						{ type, id: 'closed' },
						{ type, id: 'kept' },
					],
				};
				// A newer turn (or a stored normalization) changed the record after the
				// client's baseline; the ref is unchanged, as refs always are.
				const stored = { ...baseline, [field]: [{ ...tab, name: 'after' }, kept] };
				const incoming = { [field]: [kept], unifiedTabOrder: [{ type, id: 'kept' }] };
				const merged = mergeSessionPersistenceChanges(incoming, stored, baseline);
				expect(merged[field]).toEqual([kept]);
				expect(merged.unifiedTabOrder).toEqual([{ type, id: 'kept' }]);
			}
		);

		it('keeps a tab a peer opened that this client never saw', () => {
			const baseline = { aiTabs: [{ id: 'a' }], unifiedTabOrder: [{ type: 'ai', id: 'a' }] };
			const stored = {
				aiTabs: [{ id: 'a' }, { id: 'peer' }],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a' },
					{ type: 'ai', id: 'peer' },
				],
			};
			const incoming = { aiTabs: [], unifiedTabOrder: [] };
			const merged = mergeSessionPersistenceChanges(incoming, stored, baseline);
			expect(merged.aiTabs).toEqual([{ id: 'peer' }]);
			expect(merged.unifiedTabOrder).toEqual([{ type: 'ai', id: 'peer' }]);
		});

		it('does not leave a snoozed tab behind in aiTabs', () => {
			const tab = { id: 'parked', name: 'before' };
			const baseline = { aiTabs: [tab], snoozedTabs: [] };
			const stored = { aiTabs: [{ ...tab, name: 'after' }], snoozedTabs: [] };
			const incoming = { aiTabs: [], snoozedTabs: [{ id: 's1', type: 'ai', tab }] };
			const merged = mergeSessionPersistenceChanges<Record<string, unknown>>(
				incoming,
				stored,
				baseline
			);
			expect(merged.aiTabs).toEqual([]);
			expect(merged.snoozedTabs).toEqual([{ id: 's1', type: 'ai', tab }]);
		});
	});

	describe('queue recovery generations', () => {
		it('does not resurrect an already consumed recovery from an older peer baseline', () => {
			const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
			expect(
				mergeSessionPersistenceChanges(
					{ executionQueue: [item] },
					{ executionQueue: [] },
					{ executionQueue: [{ id: item.id }] },
					true,
					true
				).executionQueue
			).toEqual([]);
		});

		it('does not restore an older recovered attempt after its removal', () => {
			const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
			expect(
				mergeSessionPersistenceChanges(
					{ executionQueue: [{ ...item, dispatchRecoveryGeneration: 0 }] },
					{ executionQueue: [] },
					{ executionQueue: [item] },
					true,
					true
				).executionQueue
			).toEqual([]);
		});
	});
});
