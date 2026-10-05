import { describe, expect, it } from 'vitest';
import {
	activeAgentAfterRemoval,
	addTabRecord,
	agentsMovingWithParent,
	applyAgentConfigPatch,
	applyTabPatch,
	buildAgentConfigPatch,
	buildAgentRecord,
	buildGroupRecord,
	buildTabConfigPatch,
	buildTabRecord,
	checkAgentCreateInput,
	checkAgentName,
	closeTabRecord,
	DEFAULT_TAB_DEFAULTS,
	groupsWithout,
	insertAfterActiveInUnifiedTabOrder,
	MAX_AGENT_NAME_LENGTH,
	mergeSshPatch,
	normalizeGroupName,
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
				})
			).toEqual({
				readOnlyMode: true,
				showThinking: 'sticky',
				customModel: null,
				customEffort: 'high',
				saveToHistory: false,
				enterToSend: null,
			});
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
