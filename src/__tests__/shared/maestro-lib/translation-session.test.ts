import { describe, it, expect } from 'vitest';
import {
	commitTranslationSession,
	recordTranslationCommit,
	migrationHoldsTurns,
	translationSessionTabs,
	translatedHistorySessionId,
	resolveHistorySession,
	type TranslatableSession,
} from '../../../shared/maestro-lib/translation/session';
import type {
	TranslationPlan,
	TranslationReport,
} from '../../../shared/maestro-lib/translation/types';

describe('committed translation transcript marker', () => {
	const plan: TranslationPlan = {
		schemaVersion: 1,
		id: 'op',
		agentId: 'agent',
		tabId: 'one',
		source: {
			provider: 'claude-code',
			version: '2.1.296',
			accountRoot: '/private/source',
			projectRoot: '/private/project',
		},
		destination: {
			provider: 'codex',
			version: '0.162.1',
			accountRoot: '/private/destination',
			projectRoot: '/private/project',
		},
		scope: { projectKnowledge: true, selectedUserResources: [] },
		status: 'ready',
		verification: 'unverified',
		limitations: [
			{ code: 'unverified', severity: 'warning', message: 'Native resume is unverified.' },
		],
		tabs: [{ tabId: 'one', sourceSessionId: 'source', records: 2, newRecords: 2 }],
		counts: { records: 2, artifacts: 1, bytes: 128 },
		fingerprint: 'synthetic',
	};
	const mapping = {
		tabId: 'one',
		sourceSessionId: 'source',
		destinationSessionId: 'destination',
		artifacts: [],
		lineage: {},
	};
	const report: TranslationReport = {
		success: true,
		plan,
		result: { success: true, state: 'committed', plan, mappings: [mapping] },
	};

	it.each(['claude-code', 'codex'] as const)(
		'records one marker with %s selected, including report replay',
		(live) => {
			const previous = { id: 'user', timestamp: 1, source: 'user' as const, text: 'Continue' };
			const other = { id: 'other', agentSessionId: null, logs: [] };
			const session: TranslatableSession = {
				id: 'agent',
				toolType: live,
				aiTabs: [
					{
						id: 'one',
						logs: [previous],
						...(live === 'claude-code'
							? { agentSessionId: 'source' }
							: {
									agentSessionId: null,
									providerSessions: { 'claude-code': { agentSessionId: 'source' } },
								}),
					},
					other,
				],
			};
			const imported = commitTranslationSession(
				session,
				'codex',
				'op',
				[mapping],
				undefined,
				'claude-code',
				'one'
			);
			// Native IDs alone do not prove that journal finalization succeeded.
			expect(imported.aiTabs[0].logs).toEqual([previous]);
			const committed = recordTranslationCommit(imported, report);
			const logs = committed.aiTabs[0].logs!;
			expect(logs).toHaveLength(2);
			expect(logs[0]).toBe(previous);
			expect(logs[1]).toMatchObject({
				id: 'translation:op:one',
				source: 'system',
				text: 'Context translated from Claude Code',
				contextTranslation: {
					operationId: 'op',
					source: { provider: 'claude-code', version: '2.1.296' },
					destination: { provider: 'codex', version: '0.162.1' },
					verification: 'unverified',
					limitations: plan.limitations,
					counts: plan.counts,
				},
			});
			expect(JSON.stringify(logs[1])).not.toContain('/private/');
			expect(committed.aiTabs[1]).toBe(other);
			expect(session.aiTabs[0].logs).toEqual([previous]);
			expect(recordTranslationCommit(committed, report).aiTabs[0].logs).toEqual(logs);
		}
	);

	it.each(['failed', 'deferred', 'staged', 'recovery-required', 'rolled-back', 'noop'] as const)(
		'does not mark a %s result even when native IDs already committed',
		(state) => {
			const session: TranslatableSession = {
				id: 'agent',
				toolType: 'codex',
				aiTabs: [{ id: 'one', agentSessionId: 'destination', logs: [] }],
			};
			expect(
				recordTranslationCommit(session, {
					...report,
					success: false,
					result: { ...report.result!, success: false, state },
				})
			).toBe(session);
		}
	);

	it('retains the marker on closed, snoozed and orphan tabs without copying logs into native inventory', () => {
		const tab = { id: 'one', agentSessionId: 'destination', logs: [null, { future: true }] };
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'codex',
			aiTabs: [],
			closedTabHistory: [{ tab }],
			orphanedThinkingTabs: [tab],
			snoozedTabs: [{ type: 'group', members: [{ type: 'ai', tab }] }],
			providerTranslationTabInventory: [{ id: 'one', agentSessionId: 'destination' }],
		};
		const updated = recordTranslationCommit(session, report);
		const logs = updated.closedTabHistory![0].tab.logs!;
		expect(logs.slice(0, 2)).toEqual(tab.logs);
		expect(logs).toHaveLength(3);
		expect(updated.orphanedThinkingTabs[0].logs).toEqual(logs);
		expect(updated.snoozedTabs![0].members![0].tab.logs).toEqual(logs);
		expect(updated.providerTranslationTabInventory).toBe(session.providerTranslationTabInventory);
	});

	it('does not mark an empty conversation or a report without its plan', () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'codex',
			aiTabs: [{ id: 'one', agentSessionId: 'destination', logs: [] }],
		};
		expect(
			recordTranslationCommit(session, {
				...report,
				result: { ...report.result!, mappings: [{ ...mapping, sourceSessionId: null }] },
			}).aiTabs[0].logs
		).toEqual([]);
		expect(recordTranslationCommit(session, { ...report, plan: undefined })).toBe(session);
		expect(
			recordTranslationCommit(session, {
				...report,
				result: { ...report.result!, mappings: [{ ...mapping, destinationSessionId: 'stale' }] },
			}).aiTabs[0].logs
		).toEqual([]);
	});
});

describe('one provider mapping commit', () => {
	it.each(['claude-code', 'codex'] as const)(
		'commits one tab with %s live, preserving every other slot',
		(live) => {
			const source = { agentSessionId: 'claude-one', customModel: 'source-model' };
			const other = {
				id: 'other',
				tabProvider: live,
				agentSessionId: 'other-native',
				providerSessions: { codex: { agentSessionId: 'parked-other' } },
			};
			const session: TranslatableSession = {
				id: 'agent',
				toolType: live,
				aiTabs: [
					{
						id: 'one',
						...(live === 'claude-code'
							? source
							: { agentSessionId: null, providerSessions: { 'claude-code': source } }),
					},
					other,
				],
				closedTabHistory: [{ tab: other }],
				unifiedClosedTabHistory: [{ type: 'ai', tab: other }],
				snoozedTabs: [{ type: 'group', members: [{ type: 'ai', tab: other }] }],
				customModel: 'agent-model',
				customEnvVars: { CUSTOM: 'preserved' },
				executionQueue: [
					{ id: 'q', tabId: 'other', turnSettings: { provider: live, model: 'queued' } },
				],
				providerTranslationHistoryMappings: [
					{
						tabId: 'history:other',
						sourceSessionId: 'old-other',
						destinationSessionId: 'other-native',
					},
				],
			};
			const mapping = {
				tabId: 'one',
				sourceSessionId: 'claude-one',
				destinationSessionId: 'codex-one',
				artifacts: [],
				lineage: {},
			};
			const result = commitTranslationSession(
				session,
				'codex',
				'op',
				[mapping],
				'/knowledge',
				'claude-code',
				'one'
			);
			expect(result.toolType).toBe(live);
			expect(result.customModel).toBe(session.customModel);
			expect(result.customEnvVars).toBe(session.customEnvVars);
			expect(result.executionQueue).toBe(session.executionQueue);
			expect(result.aiTabs[1]).toBe(other);
			expect(result.providerTranslationTabInventory).toContainEqual(
				expect.objectContaining({ id: 'other', tabProvider: live })
			);
			expect(result.closedTabHistory?.[0].tab).toBe(other);
			expect(result.unifiedClosedTabHistory?.[0].tab).toBe(other);
			expect(result.snoozedTabs?.[0].members?.[0].tab).toBe(other);
			expect(result.providerTranslationHistoryMappings?.[0]).toEqual(
				session.providerTranslationHistoryMappings?.[0]
			);
			const translated = result.aiTabs[0];
			expect(
				live === 'codex'
					? translated.agentSessionId
					: translated.providerSessions?.codex?.agentSessionId
			).toBe('codex-one');
			expect(
				live === 'codex' ? translated.providerSessions?.['claude-code'] : translated
			).toMatchObject(source);
			expect(
				commitTranslationSession(
					result,
					'codex',
					'op',
					[mapping],
					'/knowledge',
					'claude-code',
					'one'
				)
			).toEqual(result);
			expect(() =>
				commitTranslationSession(
					session,
					'codex',
					'op',
					[mapping, { ...mapping, tabId: 'other' }],
					undefined,
					'claude-code',
					'one'
				)
			).toThrow('exactly one');
		}
	);
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
		expect(result.aiTabs[0].turnSessionId).toBe('claude-open');
		expect(result.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-open');
		expect(result.executionQueue).toBe(session.executionQueue);
		expect(result.providerTranslationQueuedOrigins).toEqual({ queued: 'claude-code' });
		expect(result.filePreviewTabs).toBe(session.filePreviewTabs);
		expect(result.closedTabHistory![0].tab.agentSessionId).toBe('new-codex-closed');
		expect(translationSessionTabs(session)).toHaveLength(2);
	});
	it('parks closed, unified, snoozed and History identities without native mappings', () => {
		const closed = { id: 'closed', agentSessionId: 'closed-source', customModel: 'source-model' };
		const sleeping = { id: 'sleeping', agentSessionId: 'sleeping-source' };
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [],
			closedTabHistory: [{ tab: closed }],
			unifiedClosedTabHistory: [
				{ type: 'ai', tab: closed },
				{ type: 'file', tab: { id: 'file' } },
			],
			snoozedTabs: [
				{ type: 'ai', tab: sleeping },
				{ type: 'group', members: [{ type: 'ai', tab: sleeping }] },
			],
		};
		const deferred = [
			...translationSessionTabs(session),
			{ id: 'history:older', agentSessionId: 'older' },
		];
		const result = commitTranslationSession(
			session,
			'codex',
			'op',
			[],
			undefined,
			'claude-code',
			undefined,
			deferred
		);
		for (const tab of translationSessionTabs(result)) {
			expect(tab.agentSessionId).toBeNull();
			expect(tab.providerSessions?.['claude-code']?.agentSessionId).toBeTruthy();
		}
		expect(result.closedTabHistory?.[0].tab.providerSessions?.['claude-code']?.customModel).toBe(
			'source-model'
		);
		expect(result.unifiedClosedTabHistory?.[1]).toBe(session.unifiedClosedTabHistory?.[1]);
		expect(resolveHistorySession(result, 'older')).toMatchObject({
			provider: 'claude-code',
			agentSessionId: 'older',
		});
		expect(resolveHistorySession(result, 'closed-source')).toMatchObject({
			provider: 'claude-code',
			agentSessionId: 'closed-source',
		});
		expect(
			commitTranslationSession(
				result,
				'codex',
				'op',
				[],
				undefined,
				'claude-code',
				undefined,
				deferred
			)
		).toEqual(result);
		const returned = commitTranslationSession(
			result,
			'claude-code',
			'back',
			[],
			undefined,
			'codex',
			undefined,
			translationSessionTabs(result)
		);
		expect(returned.closedTabHistory?.[0].tab.agentSessionId).toBe('closed-source');
	});
	it('resolves pending History from the latest source while retaining the older destination', () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'codex',
			aiTabs: [],
			providerTranslationTabInventory: [
				{
					id: 'history:source',
					agentSessionId: 'older-codex',
					pendingTranslation: 'claude-code',
					providerSessions: { 'claude-code': { agentSessionId: 'source', customModel: 'opus' } },
				},
			],
		};
		expect(resolveHistorySession(session, 'source')).toMatchObject({
			provider: 'claude-code',
			agentSessionId: 'source',
			providerSessions: {
				codex: { agentSessionId: 'older-codex' },
				'claude-code': { agentSessionId: 'source', customModel: 'opus' },
			},
		});
	});
	it('rejects an open tab that was not part of native staging', () => {
		expect(() =>
			commitTranslationSession(
				{ id: 'a', toolType: 'claude-code', aiTabs: [{ id: 'new', agentSessionId: null }] },
				'codex',
				'op',
				[]
			)
		).toThrow('Missing native translation mapping');
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

describe('Ensemble translation commits', () => {
	it('keeps a single-tab destination live when its pin differs from the agent default', () => {
		const pinned = {
			id: 'tab',
			tabProvider: 'codex' as const,
			agentSessionId: 'stale-codex',
			pendingTranslation: 'claude-code' as const,
			providerSessions: { 'claude-code': { agentSessionId: 'source' } },
		};
		const session: TranslatableSession = { id: 'agent', toolType: 'claude-code', aiTabs: [pinned] };
		const result = commitTranslationSession(
			session,
			'codex',
			'operation',
			[
				{
					tabId: 'tab',
					sourceSessionId: 'source',
					destinationSessionId: 'fresh-codex',
					artifacts: [],
					lineage: {},
				},
			],
			undefined,
			'claude-code',
			'tab'
		);
		expect(result.toolType).toBe('claude-code');
		expect(result.aiTabs[0]).toMatchObject({ tabProvider: 'codex', agentSessionId: 'fresh-codex' });
		expect(result.aiTabs[0].providerSessions?.codex).toBeUndefined();
		expect(result.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('source');
		expect(resolveHistorySession(result, 'fresh-codex').provider).toBe('codex');
	});

	it('leaves explicit pins alone during agent-wide commits, including closed tabs', () => {
		const pinned = { id: 'pin', tabProvider: 'codex' as const, agentSessionId: 'codex-live' };
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [pinned],
			closedTabHistory: [{ tab: pinned }],
		};
		const result = commitTranslationSession(session, 'codex', 'operation', []);
		expect(result.aiTabs[0]).toBe(pinned);
		expect(result.closedTabHistory?.[0].tab).toBe(pinned);
	});
});

describe('provider-scoped native History', () => {
	it('resolves a parked identity independently of the live tab and agent default', () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [
				{
					id: 'tab',
					tabProvider: 'codex',
					agentSessionId: 'codex-live',
					providerSessions: { opencode: { agentSessionId: 'opencode-parked' } },
				},
			],
		};
		expect(resolveHistorySession(session, 'opencode-parked')).toMatchObject({
			provider: 'opencode',
			agentSessionId: 'opencode-parked',
			providerSessions: { codex: { agentSessionId: 'codex-live' } },
		});
	});

	it('preserves an explicit native owner when providers have matching IDs', () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [
				{
					id: 'tab',
					tabProvider: 'codex',
					agentSessionId: 'same',
					pendingTranslation: 'claude-code',
					providerSessions: { 'claude-code': { agentSessionId: 'same' } },
				},
			],
		};
		expect(resolveHistorySession(session, 'same', 'codex')).toMatchObject({
			provider: 'codex',
			agentSessionId: 'same',
		});
		expect(resolveHistorySession(session, 'same', 'opencode')).toMatchObject({
			provider: 'opencode',
			agentSessionId: 'same',
			providerSessions: undefined,
		});
	});
});
