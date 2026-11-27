import { describe, expect, it } from 'vitest';
import {
	activeAgentAfterRemoval,
	addTabRecord,
	markTurnEnded,
	tabRunsUserEntry,
	turnFateAfter,
	agentsMovingWithParent,
	withAgentInGroup,
	applyAgentConfigPatch,
	applyTabPatch,
	buildAgentConfigPatch,
	buildAgentRecord,
	buildGroupRecord,
	buildImportedAgentRecord,
	buildTabConfigPatch,
	beginTurnRecord,
	buildTabRecord,
	checkAgentCreateInput,
	checkAgentImportInput,
	checkAgentName,
	closeTabRecord,
	reopenTabRecord,
	DEFAULT_TAB_DEFAULTS,
	findConsultTabRecord,
	groupsWithout,
	insertAfterActiveInUnifiedTabOrder,
	MAX_AGENT_NAME_LENGTH,
	mergeSshPatch,
	normalizeGroupName,
	openConsultTabRecord,
	recordConsultAnswerRecord,
	recordTabSession,
	relocateAgentPaths,
	renameTabRecord,
	sshRecordOf,
	switchAgentRecordProvider,
	tabDefaultsFromSettings,
	validateAgentRename,
	validateNewAgent,
	type RuleContext,
} from '../rules';
import type { AgentRecord, GroupRecord } from '../../store/records';
import type { NativeSessionBinding, ProviderTabSession } from '../providerSwap';

function makeContext(): RuleContext {
	let id = 0;
	let now = 1_000;
	return {
		newId: () => `id-${++id}`,
		now: () => ++now,
		random: () => 0.5,
	};
}

function tab(id: string, extra: Record<string, unknown> = {}) {
	return { id, agentSessionId: null, name: null, logs: [], ...extra };
}

function agent(extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: '/work/alpha',
		projectRoot: '/work/alpha',
		aiTabs: [tab('t1'), tab('t2'), tab('t3')],
		activeTabId: 't2',
		unifiedTabOrder: [
			{ type: 'ai', id: 't1' },
			{ type: 'ai', id: 't2' },
			{ type: 'ai', id: 't3' },
		],
		...extra,
	};
}

describe('names and validation', () => {
	it('trims a name and enforces the length limit', () => {
		expect(checkAgentName('  Docs  ')).toEqual({ ok: true, value: 'Docs' });
		expect(checkAgentName('   ')).toMatchObject({ ok: false, code: 'invalid' });
		expect(checkAgentName(undefined)).toMatchObject({ ok: false });
		expect(checkAgentName('x'.repeat(MAX_AGENT_NAME_LENGTH + 1))).toMatchObject({ ok: false });
		expect(checkAgentName('x'.repeat(MAX_AGENT_NAME_LENGTH))).toMatchObject({ ok: true });
	});

	it('refuses a duplicate name on create, ignoring case', () => {
		const result = validateNewAgent('ALPHA', '/elsewhere', [agent()]);
		expect(result).toMatchObject({ valid: false, errorField: 'name' });
		expect(result.error).toContain('"Alpha"');
	});

	it('warns, but does not refuse, when another agent on the same host uses the directory', () => {
		const result = validateNewAgent('Beta', '/WORK/alpha/', [agent()]);
		expect(result).toMatchObject({
			valid: true,
			warningField: 'directory',
			conflictingAgents: ['Alpha'],
		});
	});

	it('does not count an agent on another host as a directory conflict', () => {
		const remote = agent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });
		expect(validateNewAgent('Beta', '/work/alpha', [remote])).toEqual({ valid: true });
		expect(validateNewAgent('Beta', '/work/alpha', [remote], 'r1')).toMatchObject({
			warningField: 'directory',
		});
	});

	it('reads an untrusted SSH config as "no config"', () => {
		const odd = agent({ sessionSshRemoteConfig: 'nonsense' as unknown as never });
		expect(sshRecordOf('nonsense')).toBeUndefined();
		expect(sshRecordOf([])).toBeUndefined();
		expect(validateNewAgent('Beta', '/work/alpha', [odd])).toMatchObject({
			warningField: 'directory',
		});
	});

	it('lets an agent keep its own name on rename but not take another', () => {
		const other = agent({ id: 'a2', name: 'Beta' });
		expect(validateAgentRename('alpha', 'a1', [agent(), other])).toEqual({ valid: true });
		expect(validateAgentRename('beta', 'a1', [agent(), other])).toMatchObject({ valid: false });
	});

	it('checks a create input without the filesystem', () => {
		const base = { name: ' Docs ', provider: 'codex', cwd: ' /p ' };
		expect(checkAgentCreateInput(base)).toEqual({
			ok: true,
			value: { name: 'Docs', provider: 'codex', cwd: '/p' },
		});
		expect(checkAgentCreateInput({ ...base, name: '' })).toMatchObject({
			ok: false,
			message: 'The agent needs a name.',
		});
		expect(checkAgentCreateInput({ ...base, provider: 'terminal' })).toMatchObject({
			ok: false,
			message: 'Unknown provider "terminal".',
		});
		expect(checkAgentCreateInput({ ...base, provider: 'nope' })).toMatchObject({ ok: false });
		expect(checkAgentCreateInput({ ...base, cwd: '  ' })).toMatchObject({
			ok: false,
			message: 'The agent needs a working directory.',
		});
	});
});

describe('building an agent', () => {
	const input = { name: 'Docs', provider: 'claude-code', cwd: '/p/docs' };

	it('writes the record the desktop would: one fresh tab, every path the directory', () => {
		const checked = checkAgentCreateInput(input);
		if (!checked.ok) throw new Error('unreachable');
		const { agent: built, tab: first } = buildAgentRecord(
			input,
			checked.value,
			makeContext(),
			DEFAULT_TAB_DEFAULTS
		);
		expect(built).toMatchObject({
			name: 'Docs',
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/p/docs',
			fullPath: '/p/docs',
			projectRoot: '/p/docs',
			shellCwd: '/p/docs',
			autoRunFolderPath: '/p/docs/.maestro/playbooks',
			activeTabId: first.id,
			unifiedTabOrder: [{ type: 'ai', id: first.id }],
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
			port: 3050,
		});
		expect(built.aiTabs).toEqual([first]);
		expect(first).toMatchObject({ saveToHistory: true, showThinking: 'off', logs: [] });
		expect(built.groupId).toBeUndefined();
	});

	it('applies optional fields, drops blank env values, and records a window as user-edited', () => {
		const full = {
			...input,
			provider: 'codex',
			groupId: 'g1',
			model: 'gpt-x',
			effort: '  high ',
			contextWindow: 200_000,
			customPath: '/bin/codex',
			customArgs: '--flag',
			env: { A: '1', B: '' },
			ssh: { enabled: true, remoteId: null },
			autoRunFolderPath: '/custom/runs',
			nudgeMessage: 'nudge',
		};
		const checked = checkAgentCreateInput(full);
		if (!checked.ok) throw new Error('unreachable');
		const { agent: built } = buildAgentRecord(full, checked.value, makeContext(), {
			...DEFAULT_TAB_DEFAULTS,
			saveToHistory: false,
			showThinking: 'on',
		});
		expect(built).toMatchObject({
			groupId: 'g1',
			customModel: 'gpt-x',
			customEffort: 'high',
			customContextWindow: 200_000,
			contextWindowSource: 'user-edited',
			customPath: '/bin/codex',
			customArgs: '--flag',
			customEnvVars: { A: '1' },
			sessionSshRemoteConfig: { enabled: true, remoteId: null },
			autoRunFolderPath: '/custom/runs',
			nudgeMessage: 'nudge',
		});
		expect(built.claudeInteractive).toBeUndefined();
		expect(built.aiTabs?.[0]).toMatchObject({ saveToHistory: false, showThinking: 'on' });
	});

	it('reads the tab defaults from a settings document, with the desktop defaults for absent keys', () => {
		expect(tabDefaultsFromSettings(undefined)).toEqual(DEFAULT_TAB_DEFAULTS);
		expect(
			tabDefaultsFromSettings({
				defaultSaveToHistory: false,
				defaultShowThinking: 'sticky',
				newTabPlacement: 'after-current',
			})
		).toEqual({ saveToHistory: false, showThinking: 'sticky', placement: 'after-current' });
		expect(tabDefaultsFromSettings({ defaultShowThinking: 'bogus', newTabPlacement: 'x' })).toEqual(
			DEFAULT_TAB_DEFAULTS
		);
	});
});

describe('importing an agent', () => {
	const entry = { id: 'l1', timestamp: 5, source: 'user', text: 'hello' };
	const input = {
		agent: { name: 'Lifted', provider: 'codex', cwd: '/srv/app', model: 'gpt-x' },
		tabs: [
			{ id: 'tA', name: 'Main', agentSessionId: 'sess-A', logs: [entry], createdAt: 7 },
			{
				id: 'tB',
				logs: [],
				showThinking: 'sticky' as const,
				saveToHistory: false,
				effort: 'high',
			},
		],
		activeTabId: 'tB',
	};

	it('builds the create record with the imported tabs in place of a fresh one', () => {
		const checked = checkAgentImportInput(input);
		if (!checked.ok) throw new Error(checked.message);
		const record = buildImportedAgentRecord(
			input,
			checked.value,
			makeContext(),
			DEFAULT_TAB_DEFAULTS
		);
		expect(record).toMatchObject({
			name: 'Lifted',
			toolType: 'codex',
			cwd: '/srv/app',
			customModel: 'gpt-x',
			activeTabId: 'tB',
			unifiedTabOrder: [
				{ type: 'ai', id: 'tA' },
				{ type: 'ai', id: 'tB' },
			],
		});
		expect(record.aiTabs).toEqual([
			expect.objectContaining({
				id: 'tA',
				name: 'Main',
				agentSessionId: 'sess-A',
				logs: [entry],
				createdAt: 7,
				state: 'idle',
				saveToHistory: DEFAULT_TAB_DEFAULTS.saveToHistory,
			}),
			expect.objectContaining({
				id: 'tB',
				agentSessionId: null,
				name: null,
				showThinking: 'sticky',
				saveToHistory: false,
				customEffort: 'high',
				state: 'idle',
			}),
		]);
	});

	it('makes the first tab active when the named one is not imported', () => {
		const other = { ...input, activeTabId: 'nope' };
		const checked = checkAgentImportInput(other);
		if (!checked.ok) throw new Error(checked.message);
		expect(
			buildImportedAgentRecord(other, checked.value, makeContext(), DEFAULT_TAB_DEFAULTS)
				.activeTabId
		).toBe('tA');
	});

	it('copies the transcript instead of sharing the caller array', () => {
		const checked = checkAgentImportInput(input);
		if (!checked.ok) throw new Error(checked.message);
		const record = buildImportedAgentRecord(
			input,
			checked.value,
			makeContext(),
			DEFAULT_TAB_DEFAULTS
		);
		expect(record.aiTabs?.[0]?.logs).not.toBe(input.tabs[0].logs);
	});

	it.each([
		['the create checks', { ...input, agent: { ...input.agent, provider: 'terminal' } }],
		['no tabs', { ...input, tabs: [] }],
		['a blank tab id', { ...input, tabs: [{ id: ' ', logs: [] }] }],
		['a repeated tab id', { ...input, tabs: [input.tabs[0], input.tabs[0]] }],
		['a tab with no transcript', { ...input, tabs: [{ id: 'tA' }] }],
		['a queued message for another tab', { ...input, queue: [{ tabId: 'tZ', text: 'x' }] }],
		['a queued message with no text', { ...input, queue: [{ tabId: 'tA', text: '  ' }] }],
		[
			'an SSH remote',
			{ ...input, agent: { ...input.agent, ssh: { enabled: true, remoteId: 'r' } } },
		],
	])('refuses %s', (_label, bad) => {
		expect(checkAgentImportInput(bad as never)).toMatchObject({ ok: false, code: 'invalid' });
	});
});

describe('tabs', () => {
	it('adds a tab at the end without moving the active tab', () => {
		const { agent: next, tab: added } = addTabRecord(agent(), makeContext(), DEFAULT_TAB_DEFAULTS);
		expect(next.aiTabs?.map((t) => t.id)).toEqual(['t1', 't2', 't3', added.id]);
		expect(next.activeTabId).toBe('t2');
		expect(next.unifiedTabOrder?.at(-1)).toEqual({ type: 'ai', id: added.id });
	});

	it('inserts after the active tab when placement says so, ahead of non-AI tabs', () => {
		const source = agent({
			activeTabId: 't1',
			unifiedTabOrder: [
				{ type: 'ai', id: 't1' },
				{ type: 'terminal', id: 'term' },
				{ type: 'ai', id: 't2' },
			],
		});
		const order = insertAfterActiveInUnifiedTabOrder(
			source,
			{ type: 'ai', id: 'new' },
			'after-current'
		);
		expect(order.map((r) => r.id)).toEqual(['t1', 'new', 'term', 't2']);
		// A terminal tab outranks the AI tab as the thing the person is looking at.
		const onTerminal = { ...source, activeTerminalTabId: 'term' } as AgentRecord;
		expect(
			insertAfterActiveInUnifiedTabOrder(
				onTerminal,
				{ type: 'ai', id: 'new' },
				'after-current'
			).map((r) => r.id)
		).toEqual(['t1', 'term', 'new', 't2']);
		// An active tab that cannot be found appends.
		expect(
			insertAfterActiveInUnifiedTabOrder(
				agent({ activeTabId: 'gone' }),
				{ type: 'ai', id: 'n' },
				'after-current'
			).at(-1)
		).toEqual({ type: 'ai', id: 'n' });
	});

	it('points activeTabId at the new tab only when the agent had none', () => {
		const { agent: next, tab: added } = addTabRecord(
			agent({ activeTabId: '' }),
			makeContext(),
			DEFAULT_TAB_DEFAULTS
		);
		expect(next.activeTabId).toBe(added.id);
	});

	// G5: a reopen from a Federation peer brings an archived tab back in the background, and never
	// opens one conversation twice, where a native binding decides what "the same" is.
	describe('reopenTabRecord', () => {
		const bound = (account: string): NativeSessionBinding =>
			({
				version: 1,
				state: 'bound',
				provider: 'grok',
				nativeSessionId: 's1',
				accountRef: account,
				host: { kind: 'local', identity: 'h' },
				cwd: '/p',
			}) as NativeSessionBinding;
		const base = {
			id: 'a1',
			aiTabs: [{ id: 't1', agentSessionId: 's1', logs: [] }],
			unifiedTabOrder: [{ type: 'ai', id: 't1' }],
			activeTabId: 't1',
		} as unknown as AgentRecord;

		it('puts the tab back where it sat, in the background', () => {
			const outcome = reopenTabRecord(
				{ ...base, aiTabs: [] } as AgentRecord,
				{ tab: { id: 't9', agentSessionId: 's9', logs: [] }, index: 3, closedAt: 1 } as never,
				makeContext()
			);
			expect(outcome.tabId).toBe('t9');
			expect(outcome.agent.aiTabs?.map((tab) => tab.id)).toEqual(['t9']);
			expect(outcome.agent.activeTabId).toBe('t1');
		});

		it('answers the open tab of the same conversation instead of opening it twice', () => {
			const outcome = reopenTabRecord(
				base,
				{ tab: { id: 't2', agentSessionId: 's1', logs: [] }, index: 1, closedAt: 1 } as never,
				makeContext()
			);
			expect(outcome).toMatchObject({ tabId: 't1', wasDuplicate: true });
		});

		it('parks the session of the provider it closed under after a provider switch', () => {
			const outcome = reopenTabRecord(
				{ ...base, toolType: 'claude-code', aiTabs: [] } as unknown as AgentRecord,
				{
					tab: { id: 't2', agentSessionId: 'codex-thread', customModel: 'gpt', logs: [] },
					index: 0,
					closedAt: 1,
					toolType: 'codex',
				} as never,
				makeContext()
			);
			const tab = outcome.agent.aiTabs![0];
			expect(tab.agentSessionId).toBeNull();
			expect(tab.providerSessions?.codex).toMatchObject({
				agentSessionId: 'codex-thread',
				customModel: 'gpt',
			});
		});

		it('records the provider a tab closes under, for that park', () => {
			const outcome = closeTabRecord(
				{ ...agent(), toolType: 'codex' } as AgentRecord,
				't2',
				makeContext(),
				DEFAULT_TAB_DEFAULTS
			)!;
			expect(outcome.closed.toolType).toBe('codex');
		});

		it('matches on the observed binding, not on the session id alone', () => {
			const withBinding = {
				...base,
				aiTabs: [
					{ id: 't1', agentSessionId: 's1', logs: [], nativeSessionBinding: bound('acct-a') },
				],
			} as unknown as AgentRecord;
			const other = reopenTabRecord(
				withBinding,
				{
					tab: { id: 't2', agentSessionId: 's1', logs: [], nativeSessionBinding: bound('acct-b') },
					index: 1,
					closedAt: 1,
				} as never,
				makeContext()
			);
			expect(other.wasDuplicate).toBeUndefined();
			expect(other.agent.aiTabs?.map((tab) => tab.id)).toEqual(['t1', 't2']);
			const same = reopenTabRecord(
				withBinding,
				{
					tab: { id: 't2', agentSessionId: 's1', logs: [], nativeSessionBinding: bound('acct-a') },
					index: 1,
					closedAt: 1,
				} as never,
				makeContext()
			);
			expect(same).toMatchObject({ tabId: 't1', wasDuplicate: true });
		});
	});

	describe('closeTabRecord', () => {
		const ctx = () => makeContext();

		it('moves the active tab to the one on its left', () => {
			const outcome = closeTabRecord(agent(), 't2', ctx(), DEFAULT_TAB_DEFAULTS)!;
			expect(outcome.agent.activeTabId).toBe('t1');
			expect(outcome.agent.aiTabs?.map((t) => t.id)).toEqual(['t1', 't3']);
			expect(outcome.agent.unifiedTabOrder?.map((r) => r.id)).toEqual(['t1', 't3']);
			expect(outcome.closed).toMatchObject({ index: 1, tab: { id: 't2' } });
			expect(outcome.freshTab).toBeUndefined();
		});

		it('moves to the new first tab when the first one closed', () => {
			const outcome = closeTabRecord(
				agent({ activeTabId: 't1' }),
				't1',
				ctx(),
				DEFAULT_TAB_DEFAULTS
			)!;
			expect(outcome.agent.activeTabId).toBe('t2');
		});

		it('leaves the active tab alone when another tab closed', () => {
			const outcome = closeTabRecord(agent(), 't3', ctx(), DEFAULT_TAB_DEFAULTS)!;
			expect(outcome.agent.activeTabId).toBe('t2');
		});

		it('skips a hidden consult tab when choosing the neighbour', () => {
			const source = agent({
				aiTabs: [tab('t1'), tab('hid', { hidden: true }), tab('t2')],
				activeTabId: 't2',
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'ai', id: 'hid' },
					{ type: 'ai', id: 't2' },
				],
			});
			const outcome = closeTabRecord(source, 't2', ctx(), DEFAULT_TAB_DEFAULTS)!;
			expect(outcome.agent.activeTabId).toBe('t1');
			// The hidden tab and its order ref survive: they are the person's data.
			expect(outcome.agent.aiTabs?.map((t) => t.id)).toEqual(['t1', 'hid']);
		});

		it('refuses a hidden or unknown tab', () => {
			const source = agent({ aiTabs: [tab('t1'), tab('hid', { hidden: true })] });
			expect(closeTabRecord(source, 'hid', ctx(), DEFAULT_TAB_DEFAULTS)).toBeNull();
			expect(closeTabRecord(source, 'nope', ctx(), DEFAULT_TAB_DEFAULTS)).toBeNull();
		});

		it('creates a fresh tab only when no tab of any kind survives', () => {
			const lone = agent({
				aiTabs: [tab('t1')],
				activeTabId: 't1',
				unifiedTabOrder: [{ type: 'ai', id: 't1' }],
			});
			const outcome = closeTabRecord(lone, 't1', ctx(), DEFAULT_TAB_DEFAULTS)!;
			expect(outcome.freshTab).toBeDefined();
			expect(outcome.agent.activeTabId).toBe(outcome.freshTab!.id);
			expect(outcome.agent.aiTabs).toEqual([outcome.freshTab]);
			expect(outcome.agent.unifiedTabOrder).toEqual([{ type: 'ai', id: outcome.freshTab!.id }]);
		});

		it('leaves activeTabId empty, and touches no active id, when only non-AI tabs survive', () => {
			const withTerminal = agent({
				aiTabs: [tab('t1')],
				activeTabId: 't1',
				terminalTabs: [{ id: 'term' }],
				activeTerminalTabId: 'term',
				inputMode: 'terminal',
				unifiedTabOrder: [
					{ type: 'ai', id: 't1' },
					{ type: 'terminal', id: 'term' },
				],
			});
			const outcome = closeTabRecord(withTerminal, 't1', ctx(), DEFAULT_TAB_DEFAULTS)!;
			expect(outcome.freshTab).toBeUndefined();
			expect(outcome.agent.activeTabId).toBe('');
			expect(outcome.agent.activeTerminalTabId).toBe('term');
			expect(outcome.agent.inputMode).toBe('terminal');
		});

		it('never mutates its input', () => {
			const source = agent();
			const snapshot = JSON.stringify(source);
			closeTabRecord(source, 't2', ctx(), DEFAULT_TAB_DEFAULTS);
			expect(JSON.stringify(source)).toBe(snapshot);
		});
	});

	it('clears a tab name on an empty rename and ends auto-naming', () => {
		const named = tab('t', { name: 'Old', isGeneratingName: true });
		expect(renameTabRecord(named, '  New  ')).toMatchObject({
			name: 'New',
			isGeneratingName: false,
		});
		expect(renameTabRecord(named, '   ').name).toBeNull();
	});

	describe('applyTabPatch', () => {
		it('maps a TabPatch onto the keys a tab stores', () => {
			expect(
				buildTabConfigPatch({
					readOnly: true,
					thinking: 'sticky',
					model: null,
					effort: 'high',
					saveToHistory: false,
					enterToSend: null,
					agentSessionId: 'wizard-session',
					mergedContext: 'Additional context',
				})
			).toEqual({
				readOnlyMode: true,
				showThinking: 'sticky',
				customModel: null,
				customEffort: 'high',
				saveToHistory: false,
				enterToSend: null,
				agentSessionId: 'wizard-session',
				pendingMergedContext: 'Additional context',
			});
		});

		it("holds a merge's context for the tab's next turn", () => {
			const held = applyTabPatch(tab('t'), { pendingMergedContext: 'Additional context' });
			expect(held.ok && held.value.pendingMergedContext).toBe('Additional context');
			expect(applyTabPatch(tab('t'), { pendingMergedContext: 7 }).ok).toBe(false);
		});

		it("adopts a provider session and drops the old one's binding", () => {
			const binding = { provider: 'claude-code' } as never;
			const source = tab('t', { agentSessionId: 'old', nativeSessionBinding: binding });
			const adopted = applyTabPatch(source, { agentSessionId: 'wizard-session' });
			expect(adopted.ok && adopted.value.agentSessionId).toBe('wizard-session');
			expect(adopted.ok && 'nativeSessionBinding' in adopted.value).toBe(false);
			// The same session again keeps its binding.
			const same = applyTabPatch(source, { agentSessionId: 'old' });
			expect(same.ok && same.value.nativeSessionBinding).toBe(binding);
		});

		it('writes valid values and clears a field on null, which is not false', () => {
			const source = tab('t', { customModel: 'm', enterToSend: false });
			const result = applyTabPatch(source, {
				customModel: null,
				enterToSend: null,
				readOnlyMode: false,
			});
			expect(result.ok && result.value).toMatchObject({ readOnlyMode: false });
			expect(result.ok && 'customModel' in result.value).toBe(false);
			expect(result.ok && 'enterToSend' in result.value).toBe(false);
		});

		it('refuses a wrongly typed value as a whole', () => {
			expect(applyTabPatch(tab('t'), { readOnlyMode: 'yes' })).toMatchObject({
				ok: false,
				code: 'invalid',
			});
			expect(applyTabPatch(tab('t'), { showThinking: 'loud' })).toMatchObject({ ok: false });
			expect(applyTabPatch(tab('t'), { saveToHistory: true, customModel: 7 })).toMatchObject({
				ok: false,
			});
		});

		it('ignores keys outside the allowlist and refuses a patch with none', () => {
			expect(applyTabPatch(tab('t'), { logs: [] })).toMatchObject({ ok: false });
			expect(applyTabPatch(tab('t'), { logs: [], starred: true })).toMatchObject({
				ok: true,
				value: { starred: true, logs: [] },
			});
		});
	});

	it('builds a tab from the defaults', () => {
		expect(
			buildTabRecord(makeContext(), { ...DEFAULT_TAB_DEFAULTS, showThinking: 'on' })
		).toMatchObject({
			id: 'id-1',
			state: 'idle',
			showThinking: 'on',
			name: null,
			starred: false,
		});
	});
});

describe('agent config and location', () => {
	it('maps an AgentPatch onto stored keys, with window provenance', () => {
		const built = buildAgentConfigPatch({
			model: 'm',
			contextWindow: 1000,
			env: { A: '1', B: '' },
			bookmarked: true,
			name: 'ignored here',
		});
		expect(built.fields).toEqual(['model', 'contextWindow', 'env', 'bookmarked']);
		expect(built.patch).toEqual({
			customModel: 'm',
			customContextWindow: 1000,
			contextWindowSource: 'user-edited',
			customEnvVars: { A: '1' },
			bookmarked: true,
		});
		expect(buildAgentConfigPatch({ contextWindow: null }).patch).toEqual({
			customContextWindow: null,
			contextWindowSource: null,
		});
	});

	it('clears on null, trims an effort, and clears the provenance with the window', () => {
		const source = agent({
			customModel: 'm',
			customEffort: 'low',
			customContextWindow: 5,
			contextWindowSource: 'user-edited',
		});
		const result = applyAgentConfigPatch(source, {
			customModel: null,
			customEffort: '   ',
			customContextWindow: null,
			nudgeMessage: 'hi',
			toolType: 'codex',
		});
		if (!result.ok) throw new Error('unreachable');
		expect(result.value).toMatchObject({ nudgeMessage: 'hi', toolType: 'claude-code' });
		for (const key of [
			'customModel',
			'customEffort',
			'customContextWindow',
			'contextWindowSource',
		]) {
			expect(key in result.value).toBe(false);
		}
		expect(applyAgentConfigPatch(source, { toolType: 'codex' })).toMatchObject({ ok: false });
	});

	it('carries the provenance, maestro-p, and transport fields a patch states', () => {
		const built = buildAgentConfigPatch({
			contextWindowSource: 'user-edited',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			maestroPPath: '/opt/maestro-p',
			codexTransport: 'app-server',
		});
		expect(built.fields).toEqual([
			'contextWindowSource',
			'enableMaestroP',
			'maestroPMode',
			'maestroPPath',
			'codexTransport',
		]);
		expect(built.patch).toEqual({
			contextWindowSource: 'user-edited',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			maestroPPath: '/opt/maestro-p',
			codexTransport: 'app-server',
		});
		// A stated provenance outranks the one the window edit implies.
		expect(
			buildAgentConfigPatch({ contextWindow: 9, contextWindowSource: 'provider' }).patch
		).toEqual({ customContextWindow: 9, contextWindowSource: 'provider' });
	});

	it('writes a known Codex transport, stores exec as unset, and refuses any other value', () => {
		const source = agent({ toolType: 'codex' });
		const opted = applyAgentConfigPatch(source, { codexTransport: 'app-server' });
		if (!opted.ok) throw new Error('unreachable');
		expect(opted.value.codexTransport).toBe('app-server');

		// `exec` is the default: stored the way the Edit Agent form stores it, as no field.
		for (const cleared of ['exec', null]) {
			const back = applyAgentConfigPatch(opted.value, { codexTransport: cleared });
			if (!back.ok) throw new Error('unreachable');
			expect('codexTransport' in back.value).toBe(false);
		}

		// An unknown transport must never reach the spawner, and nothing beside it is applied.
		for (const bad of ['websocket', '', 1, true, {}]) {
			expect(applyAgentConfigPatch(source, { codexTransport: bad, customModel: 'm' })).toEqual({
				ok: false,
				code: 'invalid',
				message: "Invalid value for field 'codexTransport'",
			});
		}
	});

	it('keeps keys it was not asked about (DD-5)', () => {
		const source = agent({ rcOnlyField: { deep: [1, 2] } });
		const result = applyAgentConfigPatch(source, { bookmarked: true });
		expect(result.ok && result.value.rcOnlyField).toEqual({ deep: [1, 2] });
	});

	it('merges an SSH patch and always carries enabled and remoteId', () => {
		expect(mergeSshPatch(undefined, { workingDirOverride: '/r' })).toEqual({
			enabled: false,
			remoteId: null,
			workingDirOverride: '/r',
		});
		expect(mergeSshPatch({ enabled: true, remoteId: 'r1', extra: 1 }, { remoteId: 'r2' })).toEqual({
			enabled: true,
			remoteId: 'r2',
			extra: 1,
		});
	});

	describe('relocateAgentPaths', () => {
		const moved = () =>
			relocateAgentPaths(
				agent({
					fullPath: '/work/alpha',
					shellCwd: '/work/alpha/sub',
					autoRunFolderPath: '/work/alpha/.maestro/playbooks',
					remoteCwd: '/old/remote',
					isGitRepo: true,
				}),
				' /work/beta '
			);

		it('moves every path field together', () => {
			expect(moved()).toMatchObject({
				cwd: '/work/beta',
				fullPath: '/work/beta',
				shellCwd: '/work/beta',
				projectRoot: '/work/beta',
				autoRunFolderPath: '/work/beta/.maestro/playbooks',
				isGitRepo: false,
			});
			expect(moved().remoteCwd).toBeUndefined();
		});

		it('leaves an Auto Run folder outside the project where it was', () => {
			const result = relocateAgentPaths(
				agent({ autoRunFolderPath: '/elsewhere/runs' }),
				'/work/beta'
			);
			expect(result.autoRunFolderPath).toBe('/elsewhere/runs');
		});

		it('moves the SSH working directory only when SSH is on', () => {
			const remote = relocateAgentPaths(
				agent({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r', workingDirOverride: '/r/old' },
				}),
				'/r/new'
			);
			expect(remote.sessionSshRemoteConfig).toMatchObject({ workingDirOverride: '/r/new' });
			const off = relocateAgentPaths(
				agent({ sessionSshRemoteConfig: { enabled: false, remoteId: null } }),
				'/work/beta'
			);
			expect(off.sessionSshRemoteConfig).toEqual({ enabled: false, remoteId: null });
		});

		it('returns the same agent for a blank dir, a trailing-slash no-op, or an agent already there', () => {
			const source = agent({ fullPath: '/work/alpha' });
			expect(relocateAgentPaths(source, '  ')).toBe(source);
			expect(relocateAgentPaths(source, '/work/alpha/')).toBe(source);
		});

		it('repairs an agent a partial move left split', () => {
			const split = agent({
				cwd: '/work/beta',
				projectRoot: '/work/alpha',
				fullPath: '/work/alpha',
			});
			expect(relocateAgentPaths(split, '/work/alpha')).toMatchObject({ cwd: '/work/alpha' });
		});
	});

	it('switches provider through the library swap and reports what it could not park', () => {
		const source = agent({
			customModel: 'opus',
			executionQueue: [{ id: 'q1', tabId: 't1', turnSettings: { model: 'opus' } }],
		});
		const { agent: next, notices } = switchAgentRecordProvider(source, 'codex');
		expect(next.toolType).toBe('codex');
		expect(next.customModel).toBeUndefined();
		expect(notices).toHaveLength(1);
		const back = switchAgentRecordProvider(next, 'claude-code');
		expect(back.agent.customModel).toBe('opus');
		expect(back.agent.aiTabs).toHaveLength(3);
	});
});

describe('which agent is active, and who moves with a parent', () => {
	it('moves the pointer only when the active agent was removed', () => {
		const survivors = [{ id: 'b' }, { id: 'c' }];
		expect(activeAgentAfterRemoval(survivors, 'a', 'a')).toBe('b');
		expect(activeAgentAfterRemoval(survivors, 'a', 'c')).toBe('c');
		expect(activeAgentAfterRemoval([], 'a', 'a')).toBe('');
		expect(activeAgentAfterRemoval(survivors, 'a', undefined)).toBeUndefined();
	});

	it('includes worktree children', () => {
		const agents = [
			agent({ id: 'p' }),
			agent({ id: 'c1', parentSessionId: 'p' }),
			agent({ id: 'c2', parentSessionId: 'other' }),
		];
		expect([...agentsMovingWithParent(agents, 'p')].sort()).toEqual(['c1', 'p']);
	});

	it('moves an agent and its worktree children into a group, and back to Ungrouped', () => {
		const agents = [{ id: 'p' }, { id: 'c1', parentSessionId: 'p' }, { id: 'x', groupId: 'g0' }];
		const moved = withAgentInGroup(agents, 'p', 'g1');
		expect(moved.map((a) => a.groupId)).toEqual(['g1', 'g1', 'g0']);
		expect(moved[2]).toBe(agents[2]);

		const ungrouped = withAgentInGroup(moved, 'p', '');
		expect(ungrouped.slice(0, 2).every((a) => !('groupId' in a))).toBe(true);
		expect(withAgentInGroup(moved, 'p', null)).toEqual(ungrouped);
	});

	it('returns the same list when nothing moves', () => {
		const agents = [
			{ id: 'p', groupId: 'g1' },
			{ id: 'c1', parentSessionId: 'p', groupId: 'g1' },
		];
		expect(withAgentInGroup(agents, 'p', 'g1')).toBe(agents);
		expect(withAgentInGroup(agents, 'missing', 'g2')).toBe(agents);
	});
});

describe('groups', () => {
	const group = (id: string, extra: Partial<GroupRecord> = {}): GroupRecord => ({
		id,
		name: id.toUpperCase(),
		emoji: 'x',
		...extra,
	});

	it('normalizes a name to upper case and refuses an empty one', () => {
		expect(normalizeGroupName('  my group ')).toBe('MY GROUP');
		expect(normalizeGroupName('  ')).toBeNull();
		expect(normalizeGroupName(3)).toBeNull();
	});

	it('builds a user group with the default emoji, an id, and collapsed false', () => {
		const built = buildGroupRecord({ name: 'infra' }, [], makeContext());
		expect(built).toEqual({
			ok: true,
			value: {
				id: 'group-id-1',
				name: 'INFRA',
				emoji: '\u{1F4C2}',
				kind: 'user',
				collapsed: false,
			},
		});
		expect(buildGroupRecord({ name: 'a', emoji: '🚀' }, [], makeContext())).toMatchObject({
			value: { emoji: '🚀' },
		});
	});

	it('allows one level of nesting and no more', () => {
		const root = group('root');
		const child = group('child', { parentGroupId: 'root' });
		expect(
			buildGroupRecord({ name: 'n', parentGroupId: 'root' }, [root], makeContext())
		).toMatchObject({
			ok: true,
			value: { parentGroupId: 'root' },
		});
		expect(
			buildGroupRecord({ name: 'n', parentGroupId: 'child' }, [root, child], makeContext())
		).toMatchObject({
			ok: false,
			code: 'invalid',
		});
		expect(
			buildGroupRecord({ name: 'n', parentGroupId: 'missing' }, [root], makeContext())
		).toMatchObject({
			ok: false,
		});
		expect(buildGroupRecord({ name: '  ' }, [], makeContext())).toMatchObject({ ok: false });
	});

	it('removes a group, promotes its children, and records no undefined parent key', () => {
		const root = group('root');
		const child = group('child', { parentGroupId: 'root' });
		const other = group('other');
		const next = groupsWithout([root, child, other], 'root');
		expect(next.map((g) => g.id)).toEqual(['child', 'other']);
		expect('parentGroupId' in next[0]).toBe(false);
		expect(next[1]).toBe(other);
	});
});

describe('beginTurnRecord', () => {
	const userEntry = { id: 'u1', timestamp: 5, source: 'user', text: 'hello' };

	it('adds the message to the transcript and names the provider that owns the turn', () => {
		const before = tab('t1', {
			logs: [{ id: 'old', timestamp: 1, source: 'ai', text: 'earlier' }],
		});
		const after = beginTurnRecord(before, {
			turnId: 'attempt-1',
			userEntry,
			provider: 'claude-code',
			consumedMergedContext: false,
		});
		expect((after.logs as { id: string }[]).map((entry) => entry.id)).toEqual(['old', 'u1']);
		expect(after.turnProvider).toBe('claude-code');
		expect(after.runtimeTurnId).toBe('attempt-1');
		expect(before.logs).toHaveLength(1);
	});

	it('writes no second entry for a resend of a message the transcript holds (R13)', () => {
		const before = tab('t1', { logs: [userEntry] });
		const after = beginTurnRecord(before, {
			turnId: 'attempt-2',
			userEntry,
			provider: 'claude-code',
			consumedMergedContext: false,
		});
		expect((after.logs as { id: string }[]).map((entry) => entry.id)).toEqual(['u1']);
		expect(after.runtimeTurnId).toBe('attempt-2');
	});

	it('never drops a message on its id alone: another message under that id is still written', () => {
		const before = tab('t1', { logs: [{ ...userEntry, text: 'something else' }] });
		const after = beginTurnRecord(before, {
			userEntry,
			provider: 'claude-code',
			consumedMergedContext: false,
		});
		expect((after.logs as { text: string }[]).map((entry) => entry.text)).toEqual([
			'something else',
			'hello',
		]);
	});

	it('clears a merged context the prompt carried, and keeps one it did not', () => {
		const pending = tab('t1', { pendingMergedContext: 'from another tab' });
		const spent = beginTurnRecord(pending, {
			userEntry,
			provider: 'codex',
			consumedMergedContext: true,
		});
		expect(spent).not.toHaveProperty('pendingMergedContext');
		const kept = beginTurnRecord(pending, {
			userEntry,
			provider: 'codex',
			consumedMergedContext: false,
		});
		expect(kept.pendingMergedContext).toBe('from another tab');
	});

	it('starts a transcript without retaining an old attempt when turnId is omitted', () => {
		const after = beginTurnRecord(
			{ id: 't1', runtimeTurnId: 'old-attempt' },
			{ userEntry, provider: 'claude-code', consumedMergedContext: false }
		);
		expect(after.logs).toEqual([userEntry]);
		expect(after.runtimeTurnId).toBeUndefined();
	});
});

describe('recordTabSession', () => {
	const usage = (input: number) => ({
		inputTokens: input,
		outputTokens: 1,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.5,
		contextWindow: 0,
	});

	it("writes the live fields when the provider is the agent's current one", () => {
		const after = recordTabSession(tab('t1'), agent(), 'claude-code', { agentSessionId: 'S1' });
		expect(after.agentSessionId).toBe('S1');
		expect(after).not.toHaveProperty('providerSessions');
	});

	it("writes a parked slot when the turn's provider is no longer the agent's, leaving the live one alone", () => {
		const live = tab('t1', { agentSessionId: 'CODEX-1' });
		const after = recordTabSession(live, agent({ toolType: 'codex' }), 'claude-code', {
			agentSessionId: 'CLAUDE-LATE',
		});
		expect(after.agentSessionId).toBe('CODEX-1');
		expect(after.providerSessions).toEqual({
			'claude-code': { agentSessionId: 'CLAUDE-LATE' },
		});
	});

	it('folds one turn of usage into the provider running total, live or parked', () => {
		const once = recordTabSession(tab('t1'), agent(), 'claude-code', { addUsage: usage(10) });
		const twice = recordTabSession(once, agent(), 'claude-code', { addUsage: usage(5) });
		expect((twice.usageStats as { inputTokens: number }).inputTokens).toBe(15);
		expect((twice.usageStats as { totalCostUsd: number }).totalCostUsd).toBe(1);

		const parkedOnce = recordTabSession(tab('t1'), agent({ toolType: 'codex' }), 'claude-code', {
			addUsage: usage(10),
		});
		const parkedTwice = recordTabSession(parkedOnce, agent({ toolType: 'codex' }), 'claude-code', {
			addUsage: usage(5),
		});
		const parked = (
			parkedTwice.providerSessions as Record<string, { usageStats: { inputTokens: number } }>
		)['claude-code'];
		expect(parked.usageStats.inputTokens).toBe(15);
		expect(parkedTwice).not.toHaveProperty('usageStats');
	});

	it.each(['grok', 'codex'] as const)(
		'atomically records detached Grok identity and usage with %s current',
		(currentProvider) => {
			const previous = { agentSessionId: 'OLD', usageStats: usage(10) };
			const live = { agentSessionId: 'OTHER', usageStats: usage(90) };
			const source = tab('t1', {
				runtimeTurnId: 'attempt-1',
				...(currentProvider === 'grok' ? previous : live),
				providerSessions: currentProvider === 'grok' ? { codex: live } : { grok: previous },
			});
			const saved = structuredClone(source);
			const binding = {
				version: 1,
				state: 'bound',
				provider: 'grok',
				nativeSessionId: 'NEW',
				accountRef: 'account-a',
				host: { kind: 'ssh', identity: 'endpoint-a' },
				cwd: agent().cwd!,
			} satisfies NativeSessionBinding;
			const after = recordTabSession(source, agent({ toolType: currentProvider }), 'grok', {
				agentSessionId: 'NEW',
				nativeSessionBinding: binding,
				addUsage: usage(5),
				expected: { turnId: 'attempt-1', agentSessionId: 'OLD' },
			});
			const slots = after.providerSessions as Record<string, ProviderTabSession>;
			const recorded = currentProvider === 'grok' ? after : slots.grok;
			expect(recorded).toMatchObject({
				agentSessionId: 'NEW',
				nativeSessionBinding: binding,
				usageStats: { inputTokens: 15, totalCostUsd: 1 },
			});
			binding.host.identity = 'mutated-after-write';
			expect(recorded.nativeSessionBinding).toMatchObject({ host: { identity: 'endpoint-a' } });
			expect(currentProvider === 'grok' ? slots.codex : after).toMatchObject(live);
			expect(source).toEqual(saved);
		}
	);

	describe.each(['grok', 'codex'] as const)(
		'Grok recording fences with %s current',
		(currentProvider) => {
			it.each(['turn', 'id', 'binding'] as const)(
				'refuses a changed %s before every write or check',
				(changed) => {
					const binding = { version: 1, state: 'unknown', reason: 'unobserved' } as const;
					const owned = {
						agentSessionId: 'OLD',
						nativeSessionBinding: binding,
						usageStats: usage(10),
					};
					const source = tab('t1', {
						runtimeTurnId: 'attempt-1',
						...(currentProvider === 'grok' ? owned : { agentSessionId: 'OTHER' }),
						providerSessions: currentProvider === 'grok' ? {} : { grok: owned },
					});
					const saved = structuredClone(source);
					const expected = {
						turnId: changed === 'turn' ? 'stale-attempt' : 'attempt-1',
						agentSessionId: changed === 'id' ? 'stale-id' : 'OLD',
						nativeSessionBinding: changed === 'binding' ? undefined : binding,
					};
					for (const fields of [
						{},
						{ agentSessionId: 'NEW', nativeSessionBinding: binding, addUsage: usage(5) },
					]) {
						expect(() =>
							recordTabSession(source, agent({ toolType: currentProvider }), 'grok', {
								...fields,
								expected,
							})
						).toThrow('The native session owner changed before the turn could be recorded.');
						expect(source).toEqual(saved);
					}
				}
			);

			it('checks equal binding values regardless of key order without changing the slot', () => {
				const binding = { version: 1, state: 'unknown', reason: 'unobserved' } as const;
				const owned = { agentSessionId: 'OLD', nativeSessionBinding: binding };
				const source = tab('t1', {
					runtimeTurnId: 'attempt-1',
					...(currentProvider === 'grok' ? owned : { agentSessionId: 'OTHER' }),
					providerSessions: currentProvider === 'grok' ? {} : { grok: owned },
				});
				expect(
					recordTabSession(source, agent({ toolType: currentProvider }), 'grok', {
						expected: {
							turnId: 'attempt-1',
							agentSessionId: 'OLD',
							nativeSessionBinding: { reason: 'unobserved', state: 'unknown', version: 1 },
						},
					})
				).toBe(source);
			});
		}
	);

	it('returns the tab itself when there is nothing to record', () => {
		const same = tab('t1');
		expect(recordTabSession(same, agent(), 'claude-code', {})).toBe(same);
	});
});

describe('consult tab records', () => {
	const key = { sourceSessionId: 'src', sourceTabId: 'src-t1' };
	const question = (text: string) => ({ id: `q-${text}`, timestamp: 9, source: 'user', text });
	const open = (text = 'why?') => ({ key, name: '↩ Source', question: question(text) });

	it('creates a hidden, unfocused tab keyed by its origin and filed under the ordered tabs', () => {
		const before = agent();
		const opened = openConsultTabRecord(before, open(), makeContext(), DEFAULT_TAB_DEFAULTS);

		expect(opened.created).toBe(true);
		expect(opened.tab).toMatchObject({
			hidden: true,
			name: '↩ Source',
			saveToHistory: false,
			consultOrigin: key,
			agentSessionId: null,
		});
		expect(opened.tab.logs).toEqual([question('why?')]);
		// Nothing the person looks at moves, even with the `after-current` placement setting.
		expect(opened.agent.activeTabId).toBe('t2');
		expect(opened.agent.unifiedTabOrder?.at(-1)).toEqual({ type: 'ai', id: opened.tab.id });
		expect(
			openConsultTabRecord(before, open(), makeContext(), {
				...DEFAULT_TAB_DEFAULTS,
				placement: 'after-current',
			}).agent.unifiedTabOrder?.at(-1)
		).toEqual({ type: 'ai', id: opened.tab.id });
		// The input is untouched.
		expect(before.aiTabs).toHaveLength(3);
	});

	it('does not give a tab-less agent a hidden tab to look at', () => {
		const bare = agent({ aiTabs: [], unifiedTabOrder: [], activeTabId: undefined });
		const opened = openConsultTabRecord(bare, open(), makeContext(), DEFAULT_TAB_DEFAULTS);
		expect(opened.agent.activeTabId).toBeUndefined();
	});

	it('finds the tab for the same pairing and appends to it, handing back the session to resume', () => {
		const first = openConsultTabRecord(agent(), open('one'), makeContext(), DEFAULT_TAB_DEFAULTS);
		const withSession = {
			...first.agent,
			aiTabs: first.agent.aiTabs!.map((t) =>
				t.id === first.tab.id ? { ...t, agentSessionId: 'sess-1' } : t
			),
		};

		const again = openConsultTabRecord(
			withSession,
			open('two'),
			makeContext(),
			DEFAULT_TAB_DEFAULTS
		);

		expect(again.created).toBe(false);
		expect(again.tab.id).toBe(first.tab.id);
		expect(again.resumeAgentSessionId).toBe('sess-1');
		expect((again.tab.logs as { text: string }[]).map((l) => l.text)).toEqual(['one', 'two']);
		expect(again.agent.aiTabs).toHaveLength(4);
		expect(findConsultTabRecord(again.agent, key)?.id).toBe(first.tab.id);
		expect(
			findConsultTabRecord(again.agent, { sourceSessionId: 'src', sourceTabId: 'other' })
		).toBeUndefined();
	});

	it('records an answer, storing the session only when the consult succeeded', () => {
		const opened = openConsultTabRecord(agent(), open(), makeContext(), DEFAULT_TAB_DEFAULTS);
		const entry = { id: 'a1', timestamp: 10, source: 'ai', text: 'because' };

		const failed = recordConsultAnswerRecord(opened.tab, opened.agent, {
			entry: { ...entry, source: 'error' },
			provider: 'claude-code',
		});
		expect(failed.agentSessionId).toBeNull();
		expect((failed.logs as { source: string }[]).map((l) => l.source)).toEqual(['user', 'error']);

		const ok = recordConsultAnswerRecord(opened.tab, opened.agent, {
			entry,
			provider: 'claude-code',
			agentSessionId: 'sess-9',
		});
		expect(ok.agentSessionId).toBe('sess-9');
		// A consult is answered in the background: never unread, never un-hidden.
		expect(ok.hasUnread).toBeUndefined();
		expect(ok.hidden).toBe(true);
	});

	it("writes the session to the provider's own slot when the agent has since changed provider", () => {
		const opened = openConsultTabRecord(agent(), open(), makeContext(), DEFAULT_TAB_DEFAULTS);
		const swapped = { ...opened.agent, toolType: 'codex' };

		const after = recordConsultAnswerRecord(opened.tab, swapped, {
			entry: { id: 'a1', timestamp: 10, source: 'ai', text: 'late' },
			provider: 'claude-code',
			agentSessionId: 'sess-claude',
		});

		// The live slot belongs to codex now; the old provider's token is parked.
		expect(after.agentSessionId).toBeNull();
		expect(JSON.stringify(after.providerSessions)).toContain('sess-claude');
	});
});

// Parity R36: one reader of how a message's turn ended, for both host kinds.
describe('turnFateAfter', () => {
	const u1 = { id: 'u1', timestamp: 1, source: 'user', text: 'Summarize' };
	const partial = { id: 'o1', timestamp: 2, source: 'stdout', text: 'The docs s' };
	const stamped = (entry: object) => ({ ...entry, turnEnded: true });
	const error = { id: 'e1', timestamp: 3, source: 'error', text: 'Rate limited' };
	const stop = { id: 's1', timestamp: 3, source: 'system', text: 'Canceled by user' };
	const u2 = { id: 'u2', timestamp: 4, source: 'user', text: 'And the tests?' };
	const a2 = stamped({ id: 'a2', timestamp: 5, source: 'ai', text: 'The tests...' });

	it.each([
		['an answer stamped', [u1, stamped(partial)], 'desktop', 'answered'],
		['its own error stamped', [u1, partial, stamped(error)], 'desktop', 'errored'],
		['the Stop note stamped', [u1, stamped(stop)], 'headless', 'stopped'],
		['the message itself stamped (nothing of its own)', [stamped(u1)], 'headless', 'answered'],
		['streamed text, no stamp, desktop', [u1, partial], 'desktop', 'unended'],
		// Its text, then a later message: a turn written before the host stamped (CodeRabbit on #2167).
		['streamed text, no stamp, then a later turn', [u1, partial, u2, a2], 'desktop', 'answered'],
		[
			'a headless turn from before stamping, then a stamped turn',
			[u1, partial, u2, a2],
			'headless',
			'answered',
		],
		// A retry runs into the same entry: the LAST attempt decides (CodeRabbit on #2167).
		[
			'an errored attempt, then a retry answered',
			[u1, stamped(error), stamped(partial)],
			'desktop',
			'answered',
		],
		[
			'an answered attempt, then a retry that errored',
			[u1, stamped(partial), stamped(error)],
			'headless',
			'errored',
		],
		[
			'an errored attempt, then a retry mid-stream',
			[u1, stamped(error), partial],
			'desktop',
			'unended',
		],
		// An empty retry after an errored attempt: its end is on the message, timed after it.
		[
			'an errored attempt, then a retry that answered empty',
			[{ ...stamped(u1), turnEndedAt: 9 }, stamped(error)],
			'headless',
			'answered',
		],
		[
			'an empty attempt, then a retry that errored',
			[{ ...stamped(u1), turnEndedAt: 2 }, stamped(error)],
			'headless',
			'errored',
		],
		// CodeRabbit on #2167: a retry's thinking or tool card after an earlier end is that retry,
		// running or lost; a card of the same attempt written before its end is not.
		[
			'an errored attempt, then a retry that streamed a tool card',
			[
				u1,
				{ ...stamped(error), turnEndedAt: 3 },
				{ id: 't9', timestamp: 4, source: 'tool', text: '' },
			],
			'desktop',
			'unended',
		],
		[
			'an answer stamped before a card of the same attempt',
			[
				u1,
				{ ...stamped(partial), turnEndedAt: 9 },
				{ id: 't9', timestamp: 8, source: 'tool', text: '' },
			],
			'desktop',
			'answered',
		],
		['nothing after it', [u1], 'headless', 'unended'],
		['only a later message answered', [u1, u2, a2], 'headless', 'unended'],
		['a host too old to stamp: headless text is its answer', [u1, partial], 'headless', 'answered'],
		[
			'a host too old to stamp: desktop text, then another message',
			[u1, partial, u2],
			'desktop',
			'answered',
		],
		['a host too old to stamp: its own error', [u1, error], 'desktop', 'errored'],
		[
			'a steer into it is part of it',
			[u1, { ...u2, steered: true }, stamped(partial)],
			'desktop',
			'answered',
		],
	] as const)('%s', (_how, logs, hostKind, fate) => {
		expect(turnFateAfter(logs, 0, hostKind)).toBe(fate);
	});

	it('stamps an entry a later exit keeps, never a thinking or tool card (CodeRabbit on #2167)', () => {
		const tool = { id: 't1', timestamp: 2, source: 'tool', text: 'ran' };
		expect(markTurnEnded([u1, tool])).toEqual([{ ...u1, turnEnded: true }, tool]);
		expect(markTurnEnded([tool])).toEqual([tool]);
	});

	it('stamps only the last entry, once', () => {
		const logs = [u1, partial];
		const once = markTurnEnded(logs);
		expect(once).toEqual([u1, { ...partial, turnEnded: true }]);
		expect(markTurnEnded(once)).toBe(once);
		expect(markTurnEnded([])).toEqual([]);
	});
});

// Parity R38: one check, on both host kinds, that a resend is the message running now.
describe('tabRunsUserEntry', () => {
	const u1 = { id: 'u1', timestamp: 1, source: 'user', text: 'Summarize', queuedItemId: 'q1' };
	const sent = { id: 'u1', text: 'Summarize' };
	const partial = { id: 'o1', timestamp: 2, source: 'stdout', text: 'The docs s' };

	it.each([
		['a desktop tab running it, mid-stream', [u1, partial], { busy: true }, true],
		['a desktop tab that is idle', [u1, partial], { busy: false }, false],
		[
			'a desktop tab whose turn ended (stamped)',
			[u1, { ...partial, turnEnded: true }],
			{ busy: true },
			false,
		],
		[
			'a desktop tab running a LATER message',
			[u1, { id: 'u2', timestamp: 3, source: 'user', text: 'Next' }],
			{ busy: true },
			false,
		],
		['a headless tab running its item', [u1], { busy: true, itemId: 'q1' }, true],
		['a headless tab running another item', [u1], { busy: true, itemId: 'q2' }, false],
		['a tab without the message', [partial], { busy: true }, false],
		// A turn that writes no message of its own (a command) started after it (CodeRabbit on #2167).
		[
			'a desktop tab whose running turn began after the message',
			[u1, partial],
			{ busy: true, startedAt: 60_000 },
			false,
		],
		[
			'a desktop tab whose running turn began with the message',
			[u1, partial],
			{ busy: true, startedAt: 1 },
			true,
		],
	] as const)('%s', (_how, logs, running, runs) => {
		expect(tabRunsUserEntry(logs, sent, running)).toBe(runs);
	});
});
