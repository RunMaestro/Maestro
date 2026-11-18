import { describe, it, expect } from 'vitest';
import {
	commitTranslationSession,
	migrationHoldsTurns,
	translationSessionTabs,
	translatedHistorySessionId,
	type TranslatableSession,
} from '../../../shared/maestro-lib/translation/session';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import {
	getDeclaredTranslationDirection,
	TRANSLATION_PROVIDER_VERSIONS,
} from '../../../shared/maestro-lib/translation/support';
import { switchTabProvider as rendererSwitch } from '../../../renderer/utils/providerTabSessions';
import { switchTabProvider } from '../../../shared/maestro-lib/translation/session';

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
		expect(rendererSwitch).toBe(switchTabProvider);
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

describe('native ownership in translation snapshots', () => {
	const sourceBinding: NativeSessionBinding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: 'shared-id',
		accountRef: 'account:grok-fixture',
		host: { kind: 'ssh', identity: 'endpoint:fixture' },
		cwd: '/remote/project',
	};
	const destinationBinding: NativeSessionBinding = {
		...sourceBinding,
		provider: 'codex',
		accountRef: 'account:codex-fixture',
		host: { kind: 'local', identity: 'machine:fixture' },
		cwd: '/local/project',
	};
	const mappings = [
		{
			tabId: 'tab',
			sourceSessionId: 'shared-id',
			destinationSessionId: 'shared-id',
			artifacts: [],
			lineage: {},
		},
	];

	describe.each([
		['bound', sourceBinding],
		['absent legacy', undefined],
		['explicit unknown', { version: 1, state: 'unknown', reason: 'legacy' }],
	] as const)('%s source scope', (_name, nativeSessionBinding) => {
		it.each(['open', 'closed', 'unified', 'snoozed', 'group', 'inventory', 'orphaned'])(
			'preserves %s source ownership and leaves an equal-ID destination unobserved',
			(location) => {
				const tab = {
					id: 'tab',
					agentSessionId: 'shared-id',
					nativeSessionBinding,
					providerSessions: {
						codex: {
							agentSessionId: 'shared-id',
							nativeSessionBinding: destinationBinding,
						},
					},
				};
				const session: TranslatableSession = {
					id: 'agent',
					toolType: 'grok',
					aiTabs: location === 'open' ? [tab] : [],
					closedTabHistory: location === 'closed' ? [{ tab }] : [],
					unifiedClosedTabHistory: location === 'unified' ? [{ type: 'ai', tab }] : [],
					snoozedTabs:
						location === 'snoozed'
							? [{ type: 'ai', tab }]
							: location === 'group'
								? [{ type: 'group', members: [{ type: 'ai', tab }] }]
								: [],
					providerTranslationTabInventory: location === 'inventory' ? [tab] : [],
					orphanedThinkingTabs: location === 'orphaned' ? [tab] : [],
				};
				const before = structuredClone(session);
				const result = commitTranslationSession(session, 'codex', 'operation', mappings);
				const [translated] = translationSessionTabs(result);
				expect(translated.nativeSessionBinding).toEqual({
					version: 1,
					state: 'unknown',
					reason: 'unobserved',
				});
				expect(translated.providerSessions?.grok?.nativeSessionBinding).toEqual(
					nativeSessionBinding
				);
				expect(translated.providerSessions?.codex).toBeUndefined();
				expect(result.providerTranslationTabInventory).toEqual([
					{
						id: 'tab',
						agentSessionId: 'shared-id',
						nativeSessionBinding: translated.nativeSessionBinding,
						providerSessions: translated.providerSessions,
					},
				]);
				expect(session).toEqual(before);
				// Committing an already supplied mapping does not declare or certify a native
				// migration route: the Grok routes are the static, unverified declarations.
				for (const [source, destination] of [
					['grok', 'codex'],
					['codex', 'grok'],
				])
					expect(getDeclaredTranslationDirection(source, destination)).toEqual({
						source,
						destination,
						sourceVersions: TRANSLATION_PROVIDER_VERSIONS[source as 'grok' | 'codex'],
						destinationVersions: TRANSLATION_PROVIDER_VERSIONS[destination as 'grok' | 'codex'],
						verification: 'unverified',
					});
			}
		);
	});

	it.each(['same committed', 'new operation', 'staged', 'other destination'])(
		'retains observed destination ownership only on the same committed replay: %s',
		(replay) => {
			const session: TranslatableSession = {
				id: 'agent',
				toolType: 'codex',
				aiTabs: [
					{
						id: 'tab',
						agentSessionId: 'shared-id',
						nativeSessionBinding: destinationBinding,
						providerSessions: {
							grok: {
								agentSessionId: 'shared-id',
								nativeSessionBinding: sourceBinding,
							},
						},
					},
				],
				providerMigration: {
					operationId: 'operation',
					destination: replay === 'other destination' ? 'claude-code' : 'codex',
					state: replay === 'staged' ? 'staged' : 'committed',
					verification: 'unverified',
				},
			};
			const before = structuredClone(session);
			const result = commitTranslationSession(
				session,
				'codex',
				replay === 'new operation' ? 'new-operation' : 'operation',
				mappings,
				undefined,
				'grok'
			);
			expect(result.aiTabs[0].nativeSessionBinding).toEqual(
				replay === 'same committed'
					? destinationBinding
					: { version: 1, state: 'unknown', reason: 'unobserved' }
			);
			expect(result.aiTabs[0].providerSessions?.grok?.nativeSessionBinding).toEqual(sourceBinding);
			expect(result.providerTranslationTabInventory[0].nativeSessionBinding).toEqual(
				result.aiTabs[0].nativeSessionBinding
			);
			expect(session).toEqual(before);
		}
	);
});
