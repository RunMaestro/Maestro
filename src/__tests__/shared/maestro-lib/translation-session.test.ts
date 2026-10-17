import { describe, it, expect } from 'vitest';
import {
	commitTranslationSession,
	migrationHoldsTurns,
	translationSessionTabs,
	translatedHistorySessionId,
	type TranslatableSession,
} from '../../../shared/maestro-lib/translation/session';

describe('one provider mapping commit', () => {
	it.each(['open', 'closed', 'inventory'] as const)(
		'refuses a stale source mapping for a %s tab without mutating the agent',
		(location) => {
			const tab = { id: 'tab', agentSessionId: 'claude-later' };
			const session = {
				id: 'agent',
				toolType: 'claude-code' as const,
				aiTabs: location === 'open' ? [tab] : [],
				closedTabHistory: location === 'closed' ? [{ tab }] : [],
				providerTranslationTabInventory: location === 'inventory' ? [tab] : [],
			};
			const before = structuredClone(session);
			expect(() =>
				commitTranslationSession(session, 'codex', 'operation', [
					{
						tabId: 'tab',
						sourceSessionId: 'claude-staged',
						destinationSessionId: 'codex-staged',
						artifacts: [],
						lineage: {},
					},
				])
			).toThrow('Native source identity changed');
			expect(session).toEqual(before);
		}
	);
	it('refuses a native identity that arrived after an empty-tab snapshot', () => {
		const session = {
			id: 'agent',
			toolType: 'claude-code' as const,
			aiTabs: [{ id: 'tab', agentSessionId: 'claude-late' }],
		};
		expect(() =>
			commitTranslationSession(session, 'codex', 'operation', [
				{
					tabId: 'tab',
					sourceSessionId: null,
					destinationSessionId: null,
					artifacts: [],
					lineage: {},
				},
			])
		).toThrow('Native source identity changed');
		expect(session.aiTabs[0].agentSessionId).toBe('claude-late');
		expect(session.toolType).toBe('claude-code');
	});
	it('requires the parked source identity to match when a peer already applied the destination', () => {
		const session = {
			id: 'agent',
			toolType: 'codex' as const,
			aiTabs: [
				{
					id: 'tab',
					agentSessionId: 'codex-staged',
					providerSessions: { 'claude-code': { agentSessionId: 'claude-later' } },
				},
			],
		};
		expect(() =>
			commitTranslationSession(
				session,
				'codex',
				'operation',
				[
					{
						tabId: 'tab',
						sourceSessionId: 'claude-staged',
						destinationSessionId: 'codex-staged',
						artifacts: [],
						lineage: {},
					},
				],
				undefined,
				'claude-code'
			)
		).toThrow('Native source identity changed');
		expect(session.aiTabs[0].providerSessions['claude-code'].agentSessionId).toBe('claude-later');
	});
	it('carries open-tab History aliases across later provider hops and blocks missing native counterparts', () => {
		const original: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code' as const,
			aiTabs: [{ id: 'tab', agentSessionId: 'claude-original' }],
		};
		const first = commitTranslationSession(original, 'codex', 'one', [
			{
				tabId: 'tab',
				sourceSessionId: 'claude-original',
				destinationSessionId: 'codex-one',
				artifacts: [],
				lineage: {},
			},
		]);
		const second = commitTranslationSession(first, 'claude-code', 'two', [
			{
				tabId: 'tab',
				sourceSessionId: 'codex-one',
				destinationSessionId: 'claude-two',
				artifacts: [],
				lineage: {},
			},
		]);
		expect(translatedHistorySessionId(second, 'claude-original')).toBe('claude-two');
		expect(translatedHistorySessionId(second, 'codex-one')).toBe('claude-two');
		const peer = commitTranslationSession(
			second,
			'claude-code',
			'two',
			[
				{
					tabId: 'tab',
					sourceSessionId: 'codex-one',
					destinationSessionId: 'claude-two',
					artifacts: [],
					lineage: {},
				},
			],
			undefined,
			'codex'
		);
		expect(translatedHistorySessionId(peer, 'claude-original')).toBe('claude-two');
		expect(() =>
			translatedHistorySessionId(
				{
					providerTranslationHistoryMappings: [
						{ tabId: 'history:unknown', sourceSessionId: 'unknown', destinationSessionId: null },
					],
				},
				'unknown'
			)
		).toThrow('no native mapping');
	});
	it('repairs local closed-tab pointers after a peer already committed the active provider', () => {
		const open = {
			id: 'open',
			agentSessionId: 'codex-open',
			providerSessions: { 'claude-code': { agentSessionId: 'claude-open' } },
		};
		const closed = { id: 'closed', agentSessionId: 'claude-closed' };
		const session = {
			id: 'agent',
			toolType: 'codex' as const,
			aiTabs: [open],
			closedTabHistory: [{ tab: closed }],
		};
		const mappings = ['open', 'closed'].map((id) => ({
			tabId: id,
			sourceSessionId: `claude-${id}`,
			destinationSessionId: `codex-${id}`,
			artifacts: [],
			lineage: {},
		}));
		const result = commitTranslationSession(
			session,
			'codex',
			'operation',
			mappings,
			undefined,
			'claude-code'
		);
		expect(result.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-open');
		expect(result.closedTabHistory[0].tab.agentSessionId).toBe('codex-closed');
		expect(
			translatedHistorySessionId(
				{ providerTranslationHistoryMappings: [{ ...mappings[0], tabId: 'history:original' }] },
				'original'
			)
		).toBe('codex-open');
	});

	it('preserves identity, drafts, queues, file previews and closed history', () => {
		const tab = {
			id: 'open',
			agentSessionId: 'claude-open',
			logs: [{ text: 'same' }],
			inputValue: 'draft',
			turnProvider: 'claude-code',
			providerSessions: { codex: { agentSessionId: 'older-codex' } },
		};
		const closed = { ...tab, id: 'closed', agentSessionId: 'claude-closed' };
		const session = {
			id: 'agent',
			toolType: 'claude-code' as const,
			aiTabs: [tab],
			closedTabHistory: [{ tab: closed, index: 1 }],
			unifiedClosedTabHistory: [{ type: 'ai', tab: closed }],
			executionQueue: [{ id: 'queued', tabId: 'open' }],
			filePreviewTabs: [{ id: 'file', path: '/project/a' }],
			activeTabId: 'open',
		};
		const mappings = ['open', 'closed'].map((id) => ({
			tabId: id,
			sourceSessionId: 'claude-' + id,
			destinationSessionId: 'new-codex-' + id,
			artifacts: [],
			lineage: {},
		}));
		const result: TranslatableSession = commitTranslationSession(
			session,
			'codex',
			'operation',
			mappings
		);
		expect(result.aiTabs[0]).toMatchObject({
			id: 'open',
			inputValue: 'draft',
			agentSessionId: 'new-codex-open',
			turnProvider: 'claude-code',
		});
		expect(result.aiTabs[0].providerSessions?.codex).toBeUndefined();
		expect(result.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-open');
		expect(result.executionQueue).toBe(session.executionQueue);
		expect(result.providerTranslationQueuedOrigins).toEqual({ queued: 'claude-code' });
		expect(result.filePreviewTabs).toBe(session.filePreviewTabs);
		expect(result.closedTabHistory![0].tab.agentSessionId).toBe('new-codex-closed');
		expect(translationSessionTabs(session)).toHaveLength(2);
	});
	it('holds next turns until deferred/staged migrations settle', () => {
		const base = {
			operationId: 'operation',
			destination: 'codex' as const,
			verification: 'unverified' as const,
		};
		expect(migrationHoldsTurns({ ...base, state: 'deferred' })).toBe(true);
		expect(migrationHoldsTurns({ ...base, state: 'committed' })).toBe(false);
		expect(migrationHoldsTurns(undefined)).toBe(false);
	});
});

describe('provider-specific model routing after translation', () => {
	const target = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' } as const;
	const session: TranslatableSession = {
		id: 'agent',
		toolType: 'claude-code',
		aiTabs: [],
		runOn: target,
		tierTargets: { low: target, high: { type: 'provider-model', model: 'opus' } },
		gatewayUrl: 'http://127.0.0.1:48123/anthropic',
		tokenProxyMode: 'passthrough',
		backgroundRequests: { target },
	};
	it('keeps the source target when the destination harness has a recipe', () => {
		expect(commitTranslationSession(session, 'codex', 'migration', []).runOn).toEqual(target);
	});
	it('drops a source target the destination harness cannot run', () => {
		expect(commitTranslationSession(session, 'gemini-cli', 'migration', []).runOn).toBeUndefined();
	});
	it('clears source-provider tier model names', () => {
		expect(commitTranslationSession(session, 'codex', 'migration', []).tierTargets).toBeUndefined();
	});
	it('clears the source API gateway, proxy mode and background request target', () => {
		const updated = commitTranslationSession(session, 'codex', 'migration', []);
		expect(updated.gatewayUrl).toBeUndefined();
		expect(updated.tokenProxyMode).toBeUndefined();
		expect(updated.backgroundRequests).toBeUndefined();
		expect(session.gatewayUrl).toBe('http://127.0.0.1:48123/anthropic');
	});
});
