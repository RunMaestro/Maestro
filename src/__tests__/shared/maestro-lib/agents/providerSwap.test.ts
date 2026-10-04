/**
 * Provider swap: changing an agent's provider must never lose the user's tabs,
 * transcripts, or configuration.
 *
 * The behavior these lock down: every tab survives with its provider session
 * parked under the old provider, the agent-level overrides are parked instead
 * of cleared, switching back restores both exactly, and a turn already in
 * flight keeps running under the provider it was sent with - so its late
 * events belong to that provider, not to whatever the agent is configured with
 * by the time they land. What cannot be parked is reported, never dropped
 * silently.
 */

import { describe, it, expect } from 'vitest';
import {
	PROVIDER_OVERRIDE_KEYS,
	providerOverridesFor,
	resolveTurnProvider,
	switchAgentProvider,
	switchTabProvider,
	updateProviderSlot,
	type ProviderAgentOverrides,
	type ProviderSwitchAgent,
	type ProviderSwitchQueuedItem,
	type ProviderSwitchTab,
} from '../../../../shared/maestro-lib/agents/providerSwap';
import type { ToolType, UsageStats } from '../../../../shared/types';

/** A tab as the desktop holds it: the switch fields plus fields it must never touch. */
interface TestTab extends ProviderSwitchTab {
	id: string;
	name: string | null;
	starred: boolean;
	logs: Array<{ id: string; text: string }>;
	state: 'idle' | 'busy';
}

interface TestQueuedItem extends ProviderSwitchQueuedItem {
	text: string;
}

/** An agent as the desktop holds it: the switch fields plus fields it must never touch. */
interface TestAgent extends ProviderSwitchAgent {
	id: string;
	name: string;
	cwd: string;
	state: 'idle' | 'busy';
	aiPid: number;
	aiTabs: TestTab[];
	executionQueue: TestQueuedItem[];
	activeTabId: string;
	unifiedTabOrder: Array<{ type: string; id: string }>;
	closedTabHistory: Array<{ id: string }>;
	nudgeMessage?: string;
	newSessionMessage?: string;
	retryOnAvailabilityErrors?: boolean;
	codexAutoResetOnExhaustion?: boolean;
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	additionalDirectories?: Array<{ path: string }>;
}

function usage(inputTokens: number): UsageStats {
	return {
		inputTokens,
		outputTokens: inputTokens * 2,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: inputTokens / 1000,
		contextWindow: 200000,
	};
}

function makeTab(overrides: Partial<TestTab> = {}): TestTab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		state: 'idle',
		...overrides,
	};
}

function makeAgent(toolType: ToolType, overrides: Partial<TestAgent> = {}): TestAgent {
	return {
		id: 'agent-1',
		name: 'Agent',
		cwd: '/work/project',
		toolType,
		state: 'idle',
		aiPid: 0,
		aiTabs: [makeTab()],
		executionQueue: [],
		activeTabId: 'tab-1',
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		closedTabHistory: [],
		...overrides,
	};
}

/** Every override set, with nested values, so a byte-for-byte check has something to catch. */
const CLAUDE_OVERRIDES: Required<ProviderAgentOverrides> = {
	customPath: '/opt/claude/bin/claude',
	customArgs: '--verbose --add-dir "/a b"',
	customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-work', ANTHROPIC_LOG: 'debug' },
	customEnvVarsDisabled: { ANTHROPIC_API_KEY: 'sk-parked' },
	customModel: 'opus',
	customEffort: 'high',
	customProviderPath: '/opt/claude/provider',
	customContextWindow: 1000000,
	contextWindowSource: 'user-edited',
	enableMaestroP: true,
	maestroPMode: 'interactive',
	maestroPPath: '/opt/maestro-p.js',
};

/** The override fields of an agent, in canonical key order, for a byte-level comparison. */
function overridesJson(agent: ProviderSwitchAgent): string {
	return JSON.stringify(PROVIDER_OVERRIDE_KEYS.map((key) => [key, agent[key] ?? null]));
}

/** The provider-specific fields of a tab, for a byte-level comparison. */
function tabSessionJson(tab: ProviderSwitchTab): string {
	return JSON.stringify([
		tab.agentSessionId,
		tab.usageStats ?? null,
		tab.customModel ?? null,
		tab.customEffort ?? null,
	]);
}

describe('switchTabProvider', () => {
	it('parks the outgoing provider session and clears the live slot', () => {
		const tab = makeTab({
			agentSessionId: 'claude-abc',
			usageStats: usage(5),
			customModel: 'sonnet',
			customEffort: 'high',
		});

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.usageStats).toBeUndefined();
		expect(result.customModel).toBeUndefined();
		expect(result.customEffort).toBeUndefined();
		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			usageStats: usage(5),
			customModel: 'sonnet',
			customEffort: 'high',
		});
	});

	it('never leaves the tab transcript behind', () => {
		const logs = [{ id: 'l1', text: 'keep me' }];
		const tab = makeTab({ logs, name: 'My Tab', starred: true });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.logs).toBe(logs);
		expect(result.name).toBe('My Tab');
		expect(result.starred).toBe(true);
		expect(result.id).toBe('tab-1');
	});

	it('restores a previously parked session on the way back', () => {
		const tab = makeTab({
			agentSessionId: 'codex-xyz',
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = switchTabProvider(tab, 'codex', 'claude-code');

		expect(result.agentSessionId).toBe('claude-abc');
		expect(result.customModel).toBe('opus');
		expect(result.providerSessions?.['codex']?.agentSessionId).toBe('codex-xyz');
		// The live provider owns the live fields, so it holds no parked entry.
		expect(result.providerSessions?.['claude-code']).toBeUndefined();
	});

	it('survives a round trip through a third provider', () => {
		let tab = makeTab({ agentSessionId: 'claude-abc' });

		tab = switchTabProvider(tab, 'claude-code', 'codex');
		tab = switchTabProvider(tab, 'codex', 'opencode');
		tab = switchTabProvider(tab, 'opencode', 'claude-code');

		expect(tab.agentSessionId).toBe('claude-abc');
	});

	it('does not resume a session the incoming provider never had', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.awaitingSessionId).toBe(false);
	});

	it('returns the tab untouched when the provider did not change', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		expect(switchTabProvider(tab, 'claude-code', 'claude-code')).toBe(tab);
	});
});

describe('resolveTurnProvider', () => {
	it('attributes an in-flight turn to the provider it was sent with', () => {
		const tab = makeTab({ turnProvider: 'claude-code' });
		// The user switched the agent to Codex while Claude was still working.
		expect(resolveTurnProvider(tab, makeAgent('codex'))).toBe('claude-code');
	});

	it('falls back to the current provider for a tab that never sent', () => {
		expect(resolveTurnProvider(makeTab(), makeAgent('codex'))).toBe('codex');
		expect(resolveTurnProvider(undefined, makeAgent('codex'))).toBe('codex');
	});
});

describe('updateProviderSlot', () => {
	it('writes to the live fields when the turn provider is still current', () => {
		const tab = makeTab();
		const result = updateProviderSlot(tab, makeAgent('codex'), 'codex', {
			agentSessionId: 'codex-new',
		});

		expect(result.agentSessionId).toBe('codex-new');
		expect(result.providerSessions).toBeUndefined();
	});

	it('parks a late session ID from a provider the agent switched away from', () => {
		// Mid-turn switch: Claude's turn finishes and reports its session ID after
		// the agent is already on Codex. Writing it live would hand Codex a resume
		// token it has never heard of.
		const tab = makeTab({ agentSessionId: null, turnProvider: 'claude-code' });

		const result = updateProviderSlot(tab, makeAgent('codex'), 'claude-code', {
			agentSessionId: 'claude-late',
		});

		expect(result.agentSessionId).toBeNull();
		expect(result.providerSessions?.['claude-code']?.agentSessionId).toBe('claude-late');
	});

	it('merges into an existing parked entry without dropping its other fields', () => {
		const tab = makeTab({
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = updateProviderSlot(tab, makeAgent('codex'), 'claude-code', {
			usageStats: usage(3),
		});

		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			customModel: 'opus',
			usageStats: usage(3),
		});
	});
});

describe('PROVIDER_OVERRIDE_KEYS', () => {
	it('names the overrides a switch parks, and nothing that is not provider-specific', () => {
		expect([...PROVIDER_OVERRIDE_KEYS].sort()).toEqual(
			[
				'contextWindowSource',
				'customArgs',
				'customContextWindow',
				'customEffort',
				'customEnvVars',
				'customEnvVarsDisabled',
				'customModel',
				'customPath',
				'customProviderPath',
				'enableMaestroP',
				'maestroPMode',
				'maestroPPath',
			].sort()
		);
	});
});

describe('switchAgentProvider', () => {
	function claudeAgent(): TestAgent {
		return makeAgent('claude-code', {
			...CLAUDE_OVERRIDES,
			nudgeMessage: 'Be terse.',
			newSessionMessage: 'Read AGENTS.md first.',
			retryOnAvailabilityErrors: false,
			codexAutoResetOnExhaustion: true,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			additionalDirectories: [{ path: '/shared/docs' }],
			aiTabs: [
				makeTab({
					id: 'tab-1',
					agentSessionId: 'claude-session-1',
					usageStats: usage(100),
					customModel: 'sonnet',
					customEffort: 'low',
					logs: [{ id: 'l1', text: 'first conversation' }],
				}),
				makeTab({
					id: 'tab-2',
					name: 'Refactor',
					starred: true,
					agentSessionId: 'claude-session-2',
					usageStats: usage(7),
					logs: [{ id: 'l2', text: 'second conversation' }],
				}),
				// A tab that never sent a turn.
				makeTab({ id: 'tab-3' }),
			],
			activeTabId: 'tab-2',
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'tab-2' },
				{ type: 'ai', id: 'tab-3' },
			],
			closedTabHistory: [{ id: 'closed-1' }],
		});
	}

	it('switch A to B to A restores every tab provider session and every override byte for byte', () => {
		const original = claudeAgent();
		const originalJson = JSON.stringify(original);

		const toCodex = switchAgentProvider(original, 'codex');
		expect(toCodex.unparked).toEqual([]);
		const onCodex = toCodex.agent;

		// On Codex: nothing of Claude's is live, all of it is parked.
		expect(onCodex.toolType).toBe('codex');
		for (const key of PROVIDER_OVERRIDE_KEYS) {
			expect(onCodex[key]).toBeUndefined();
		}
		expect(onCodex.providerOverrides?.['claude-code']).toStrictEqual(CLAUDE_OVERRIDES);
		expect(onCodex.providerOverrides?.codex).toBeUndefined();
		for (const tab of onCodex.aiTabs) {
			expect(tab.agentSessionId).toBeNull();
			expect(tab.usageStats).toBeUndefined();
			expect(tab.customModel).toBeUndefined();
			expect(tab.customEffort).toBeUndefined();
		}

		// Work on Codex for a while: configure it and run a turn in tab 1.
		const codexWork: TestAgent = {
			...onCodex,
			customModel: 'gpt-5-codex',
			customEnvVars: { CODEX_HOME: '/Users/me/.codex-work' },
			aiTabs: onCodex.aiTabs.map((tab) =>
				tab.id === 'tab-1'
					? { ...tab, agentSessionId: 'thread_codex1', usageStats: usage(9), customEffort: 'xhigh' }
					: tab
			),
		};

		const back = switchAgentProvider(codexWork, 'claude-code');
		expect(back.unparked).toEqual([]);
		const restored = back.agent;

		expect(restored.toolType).toBe('claude-code');
		expect(overridesJson(restored)).toBe(overridesJson(original));
		for (const key of PROVIDER_OVERRIDE_KEYS) {
			expect(restored[key]).toStrictEqual(original[key]);
		}
		expect(restored.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-3']);
		restored.aiTabs.forEach((tab, index) => {
			const before = original.aiTabs[index];
			expect(tabSessionJson(tab)).toBe(tabSessionJson(before));
			expect(tab.logs).toBe(before.logs);
			expect(tab.name).toBe(before.name);
			expect(tab.starred).toBe(before.starred);
			// The live provider never keeps a parked entry.
			expect(tab.providerSessions?.['claude-code']).toBeUndefined();
		});

		// Codex's state went into the parking spots on the way out.
		expect(restored.providerOverrides).toStrictEqual({
			codex: {
				customModel: 'gpt-5-codex',
				customEnvVars: { CODEX_HOME: '/Users/me/.codex-work' },
			},
		});
		expect(restored.aiTabs[0].providerSessions?.codex).toEqual({
			agentSessionId: 'thread_codex1',
			usageStats: usage(9),
			customModel: undefined,
			customEffort: 'xhigh',
		});

		// Neither switch mutated what it was handed.
		expect(JSON.stringify(original)).toBe(originalJson);
	});

	it('restores the other provider too, so any number of round trips loses nothing', () => {
		const onCodex = switchAgentProvider(claudeAgent(), 'codex').agent;
		const codexConfigured: TestAgent = {
			...onCodex,
			customModel: 'gpt-5-codex',
			customArgs: '--search',
		};

		const onClaude = switchAgentProvider(codexConfigured, 'claude-code').agent;
		const onCodexAgain = switchAgentProvider(onClaude, 'codex').agent;

		expect(overridesJson(onCodexAgain)).toBe(overridesJson(codexConfigured));
		expect(onCodexAgain.providerOverrides?.['claude-code']).toStrictEqual(CLAUDE_OVERRIDES);
	});

	it('survives a round trip through a third provider', () => {
		let agent: TestAgent = claudeAgent();

		agent = switchAgentProvider(agent, 'codex').agent;
		agent = { ...agent, customModel: 'gpt-5-codex' };
		agent = switchAgentProvider(agent, 'opencode').agent;
		agent = { ...agent, customModel: 'anthropic/claude-sonnet-4' };
		agent = switchAgentProvider(agent, 'claude-code').agent;

		expect(overridesJson(agent)).toBe(overridesJson(claudeAgent()));
		expect(agent.aiTabs.map((tab) => tab.agentSessionId)).toEqual([
			'claude-session-1',
			'claude-session-2',
			null,
		]);
		expect(agent.providerOverrides).toStrictEqual({
			codex: { customModel: 'gpt-5-codex' },
			opencode: { customModel: 'anthropic/claude-sonnet-4' },
		});
	});

	it('never carries an override into a provider that did not have it', () => {
		// A Claude binary path handed to Codex would launch the wrong program.
		const onCodex = switchAgentProvider(claudeAgent(), 'codex').agent;

		expect(onCodex.customPath).toBeUndefined();
		expect(onCodex.customEnvVars).toBeUndefined();
		expect(onCodex.enableMaestroP).toBeUndefined();
		// Provenance travels with the window it describes (finding AD1).
		expect(onCodex.customContextWindow).toBeUndefined();
		expect(onCodex.contextWindowSource).toBeUndefined();
	});

	it('clears parked overrides even when the result is merged over the old agent', () => {
		// The renderer applies patches with `{ ...s, ...patch }`. A cleared
		// override has to be an explicit undefined, or that merge resurrects it.
		const original = claudeAgent();
		const merged = { ...original, ...switchAgentProvider(original, 'codex').agent };

		for (const key of PROVIDER_OVERRIDE_KEYS) {
			expect(merged[key]).toBeUndefined();
		}
	});

	it('keeps no parked map when there is nothing to park', () => {
		const result = switchAgentProvider(makeAgent('claude-code'), 'codex');

		expect(result.agent.providerOverrides).toBeUndefined();
		expect(result.unparked).toEqual([]);
	});

	it('lets the live values win over a stale entry for the outgoing provider', () => {
		// The map should never hold the live provider; if a foreign write left
		// one behind, the live fields are what that provider actually ran with.
		const agent = makeAgent('claude-code', {
			customModel: 'opus',
			providerOverrides: { 'claude-code': { customModel: 'stale', customArgs: '--old' } },
		});

		const parked = switchAgentProvider(agent, 'codex').agent.providerOverrides;

		expect(parked).toStrictEqual({ 'claude-code': { customModel: 'opus' } });
	});

	it('leaves every setting that is not provider-specific alone', () => {
		const original = claudeAgent();
		const switched = switchAgentProvider(original, 'codex').agent;

		expect(switched.id).toBe(original.id);
		expect(switched.name).toBe(original.name);
		expect(switched.cwd).toBe(original.cwd);
		expect(switched.nudgeMessage).toBe(original.nudgeMessage);
		expect(switched.newSessionMessage).toBe(original.newSessionMessage);
		expect(switched.retryOnAvailabilityErrors).toBe(false);
		expect(switched.codexAutoResetOnExhaustion).toBe(true);
		expect(switched.sessionSshRemoteConfig).toBe(original.sessionSshRemoteConfig);
		expect(switched.additionalDirectories).toBe(original.additionalDirectories);
		// Tab structure, order, focus, and closed-tab history all survive.
		expect(switched.activeTabId).toBe('tab-2');
		expect(switched.unifiedTabOrder).toBe(original.unifiedTabOrder);
		expect(switched.closedTabHistory).toBe(original.closedTabHistory);
		expect(switched.aiTabs).toHaveLength(3);
	});

	it('leaves a turn in flight running under the provider that started it', () => {
		const busy = makeAgent('claude-code', {
			state: 'busy',
			aiPid: 4242,
			aiTabs: [
				makeTab({
					agentSessionId: 'claude-session-1',
					state: 'busy',
					turnProvider: 'claude-code',
				}),
			],
		});

		const onCodex = switchAgentProvider(busy, 'codex').agent;
		const [tab] = onCodex.aiTabs;

		// No process state is touched: the turn keeps running.
		expect(onCodex.state).toBe('busy');
		expect(onCodex.aiPid).toBe(4242);
		expect(tab.state).toBe('busy');
		// Its late events still resolve to Claude.
		expect(resolveTurnProvider(tab, onCodex)).toBe('claude-code');

		// Claude's turn reports a new session ID after the switch; it lands in
		// Claude's parked slot and comes back when the agent returns to Claude.
		const afterLateEvent: TestAgent = {
			...onCodex,
			aiTabs: [updateProviderSlot(tab, onCodex, 'claude-code', { agentSessionId: 'claude-late' })],
		};
		expect(afterLateEvent.aiTabs[0].agentSessionId).toBeNull();

		const backOnClaude = switchAgentProvider(afterLateEvent, 'claude-code').agent;
		expect(backOnClaude.aiTabs[0].agentSessionId).toBe('claude-late');
	});

	it('clears and reports the settings a queued message was frozen with', () => {
		const agent = makeAgent('claude-code', {
			executionQueue: [
				{
					id: 'q1',
					tabId: 'tab-1',
					text: 'explicit',
					turnSettings: { model: 'opus', effort: 'high' },
				},
				{ id: 'q2', tabId: 'tab-1', text: 'default', turnSettings: {} },
				{ id: 'q3', tabId: 'tab-1', text: 'legacy' },
				{ id: 'q4', tabId: 'tab-2', text: 'effort only', turnSettings: { effort: 'max' } },
			],
		});

		const { agent: onCodex, unparked } = switchAgentProvider(agent, 'codex');

		// Every queued message survives, in order, and runs on Codex's settings:
		// a Claude model name is not one Codex can run.
		expect(onCodex.executionQueue.map((item) => [item.id, item.text])).toEqual([
			['q1', 'explicit'],
			['q2', 'default'],
			['q3', 'legacy'],
			['q4', 'effort only'],
		]);
		for (const item of onCodex.executionQueue) {
			expect(item.turnSettings).toBeUndefined();
		}

		// Only the messages that named a setting of their own lost something.
		expect(unparked).toEqual([
			{
				kind: 'queued-turn-settings',
				provider: 'claude-code',
				tabId: 'tab-1',
				queuedItemId: 'q1',
				model: 'opus',
				effort: 'high',
				message:
					'A queued message was set to run with model "opus" and effort "high" on Claude Code. ' +
					"It will run with the agent's Codex settings instead.",
			},
			{
				kind: 'queued-turn-settings',
				provider: 'claude-code',
				tabId: 'tab-2',
				queuedItemId: 'q4',
				model: undefined,
				effort: 'max',
				message:
					'A queued message was set to run with effort "max" on Claude Code. ' +
					"It will run with the agent's Codex settings instead.",
			},
		]);
	});

	it('returns the same agent and nothing to report when the provider did not change', () => {
		const agent = claudeAgent();

		const result = switchAgentProvider(agent, 'claude-code');

		expect(result.agent).toBe(agent);
		expect(result.unparked).toEqual([]);
	});
});

describe('providerOverridesFor', () => {
	it('reads the live overrides for the provider the agent is on', () => {
		const agent = makeAgent('claude-code', { ...CLAUDE_OVERRIDES });

		expect(providerOverridesFor(agent, 'claude-code')).toStrictEqual(CLAUDE_OVERRIDES);
	});

	it('leaves out the overrides the agent has not set', () => {
		const agent = makeAgent('claude-code', { customModel: 'opus', customPath: undefined });

		expect(providerOverridesFor(agent, 'claude-code')).toStrictEqual({ customModel: 'opus' });
	});

	it('reads what another provider parked, which is exactly what a switch to it restores', () => {
		// An edit form seeds its fields from this. If it showed anything else, an
		// untouched save would write it over the values the switch restores.
		const onCodex = switchAgentProvider(
			makeAgent('claude-code', { ...CLAUDE_OVERRIDES }),
			'codex'
		).agent;

		const preview = providerOverridesFor(onCodex, 'claude-code');
		const restored = switchAgentProvider(onCodex, 'claude-code').agent;

		expect(preview).toStrictEqual(CLAUDE_OVERRIDES);
		expect(preview).toStrictEqual(providerOverridesFor(restored, 'claude-code'));
	});

	it('is empty for a provider the agent never ran on', () => {
		const agent = makeAgent('claude-code', { customModel: 'opus' });

		expect(providerOverridesFor(agent, 'codex')).toStrictEqual({});
	});

	it('hands back a copy, so editing it cannot change what is parked', () => {
		const onCodex = switchAgentProvider(
			makeAgent('claude-code', { customModel: 'opus' }),
			'codex'
		).agent;

		const preview = providerOverridesFor(onCodex, 'claude-code');
		preview.customModel = 'edited';

		expect(onCodex.providerOverrides?.['claude-code']?.customModel).toBe('opus');
	});
});
