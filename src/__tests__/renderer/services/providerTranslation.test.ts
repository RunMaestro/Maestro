import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { useTabStore } from '../../../renderer/stores/tabStore';
import { commitTranslationSession } from '../../../shared/maestro-lib/translation/session';
import { canonicalJson } from '../../../shared/canonicalJson';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	prepareProviderTranslationForSend,
	requestProviderTranslation,
	resumeDeferredProviderTranslations,
} from '../../../renderer/services/providerTranslation';
import type {
	TranslationPlan,
	TranslationReport,
	TranslationRequest,
	TranslationLimitation,
} from '../../../shared/maestro-lib/translation/types';

const plan: TranslationPlan = {
	schemaVersion: 1,
	id: '11111111-1111-4111-8111-111111111111',
	agentId: 'agent',
	source: {
		provider: 'claude-code',
		version: '2.1.296',
		accountRoot: '/synthetic/claude',
		projectRoot: '/synthetic/project',
	},
	destination: {
		provider: 'codex',
		version: '0.162.1',
		accountRoot: '/synthetic/codex',
		projectRoot: '/synthetic/project',
	},
	scope: { projectKnowledge: true, selectedUserResources: [] },
	status: 'deferred',
	// A synthetic certified plan exercises the no-warning path; it certifies no real direction.
	verification: 'verified',
	limitations: [],
	tabs: [{ tabId: 'tab', sourceSessionId: 'source-final', records: 2, newRecords: 2 }],
	counts: { records: 2, artifacts: 1, bytes: 100 },
	fingerprint: 'synthetic-fingerprint',
};
const request: TranslationRequest = {
	agentId: 'agent',
	destination: 'codex',
	action: 'apply',
	projectResourcesIntoRepo: true,
};
const translateProvider = vi.fn<(input: TranslationRequest) => Promise<TranslationReport>>();
let originalMaestro: typeof window.maestro;

beforeEach(() => {
	vi.useFakeTimers();
	translateProvider.mockReset();
	const session = createMockSession({
		id: 'agent',
		aiTabs: [
			createMockAITab({
				id: 'tab',
				agentSessionId: 'source-final',
				inputValue: 'draft stays',
			}),
		],
		activeTabId: 'tab',
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	originalMaestro = window.maestro;
	window.maestro = {
		...originalMaestro,
		agents: { ...originalMaestro.agents, translateProvider },
		process: {
			...originalMaestro.process,
			getActiveProcesses: vi.fn().mockResolvedValue([]),
		},
		sessions: {
			...originalMaestro.sessions,
			setMany: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockResolvedValue([
				{
					...session,
					toolType: 'codex',
					customEnvVars: { CODEX_HOME: plan.destination.accountRoot },
					providerMigration: {
						operationId: plan.id,
						destination: 'codex',
						state: 'committed',
						verification: plan.verification,
					},
				},
			]),
		},
	};
});

afterEach(async () => {
	// Let each deferred client finish before resetting its shared pending map and mocks.
	await vi.runAllTimersAsync();
	vi.useRealTimers();
	window.maestro = originalMaestro;
	useSessionStore.setState({ sessions: [] });
});

describe('deferred provider translation client', () => {
	it.each([false, true])(
		'reopens and wakes parked tabs, translating on first send (older destination: %s)',
		async (olderDestination) => {
			const original = useSessionStore.getState().sessions[0];
			const closed = createMockAITab({
				id: 'closed',
				agentSessionId: 'closed-source',
				inputValue: 'closed draft',
				providerSessions: olderDestination
					? { codex: { agentSessionId: 'older-codex' } }
					: undefined,
			});
			const sleeping = createMockAITab({ id: 'sleeping', agentSessionId: 'sleep-source' });
			const source = {
				...original,
				unifiedClosedTabHistory: [
					{ type: 'ai' as const, tab: closed, unifiedIndex: 1, closedAt: 1 },
				],
				snoozedTabs: [
					{
						id: 'snooze',
						type: 'ai' as const,
						tab: sleeping,
						unifiedIndex: 2,
						snoozedAt: 1,
						wakeAt: 999999,
					},
				],
			};
			const switched = commitTranslationSession(source, 'codex', plan.id, [
				{
					tabId: 'tab',
					sourceSessionId: 'source-final',
					destinationSessionId: 'open-codex',
					artifacts: [],
					lineage: {},
				},
			]);
			useSessionStore.setState({ sessions: [switched] });
			const reopenedTabId = useTabStore.getState().reopenClosedTab()!.tabId;
			const wokenTabId = useTabStore.getState().unsnoozeTab('agent', 'snooze')!.tabId;
			expect(translateProvider).not.toHaveBeenCalled();
			const reopened = useSessionStore.getState().sessions[0];
			expect(reopened.aiTabs.find((tab) => tab.id === reopenedTabId)?.agentSessionId).toBe(
				olderDestination ? 'older-codex' : null
			);
			expect(reopened.aiTabs.find((tab) => tab.id === reopenedTabId)?.pendingTranslation).toBe(
				'claude-code'
			);
			expect(
				reopened.aiTabs.find((tab) => tab.id === wokenTabId)?.providerSessions?.['claude-code']
					?.agentSessionId
			).toBe('sleep-source');
			const scoped = {
				...plan,
				status: 'ready' as const,
				tabId: reopenedTabId,
				tabs: [
					{ tabId: reopenedTabId, sourceSessionId: 'closed-source', records: 2, newRecords: 2 },
				],
			};
			translateProvider.mockImplementation(async (request) =>
				request.action === 'plan'
					? { success: true, plan: scoped }
					: {
							success: true,
							plan: scoped,
							result: {
								success: true,
								state: 'committed',
								plan: scoped,
								mappings: [
									{
										tabId: reopenedTabId,
										sourceSessionId: 'closed-source',
										destinationSessionId: 'closed-codex',
										artifacts: [],
										lineage: {},
									},
								],
							},
						}
			);
			expect(await prepareProviderTranslationForSend('agent', reopenedTabId, 'codex')).toBe(
				'closed-codex'
			);
			expect(translateProvider.mock.calls.map(([request]) => request.action)).toEqual([
				'plan',
				'apply',
			]);
			expect(
				useSessionStore.getState().sessions[0].aiTabs.find((tab) => tab.id === reopenedTabId)
					?.inputValue
			).toBe('closed draft');
		}
	);
	it('prepares a pending destination and returns the translated resume ID', async () => {
		const original = useSessionStore.getState().sessions[0];
		const session = {
			...original,
			toolType: 'codex' as const,
			aiTabs: original.aiTabs.map((tab) => ({
				...tab,
				agentSessionId: null,
				providerSessions: { 'claude-code': { agentSessionId: 'source-final' } },
				state: 'busy' as const,
			})),
		};
		useSessionStore.setState({ sessions: [session] });
		const scoped = { ...plan, tabId: 'tab', status: 'ready' as const };
		translateProvider.mockImplementation(async (request) => {
			expect(useSessionStore.getState().sessions[0].aiTabs[0].translatingFrom).toBe('claude-code');
			expect(
				vi.mocked(window.maestro.sessions.setMany).mock.calls.at(-1)?.[0][0].aiTabs?.[0]
					.translatingFrom
			).toBeUndefined();
			return request.action === 'plan'
				? { success: true, plan: scoped }
				: {
						success: true,
						plan: scoped,
						result: {
							success: true,
							state: 'committed',
							plan: scoped,
							mappings: [
								{
									tabId: 'tab',
									sourceSessionId: 'source-final',
									destinationSessionId: 'resumed',
									artifacts: [],
									lineage: {},
								},
							],
						},
					};
		});
		expect(await prepareProviderTranslationForSend('agent', 'tab', 'codex')).toBe('resumed');
		expect(useSessionStore.getState().sessions[0].aiTabs[0].inputValue).toBe('draft stays');
		expect(useSessionStore.getState().sessions[0].aiTabs[0].translatingFrom).toBeUndefined();
	});
	it('applies one tab mapping without switching the agent or touching another tab', async () => {
		const original = useSessionStore.getState().sessions[0];
		const other = createMockAITab({ id: 'other', agentSessionId: 'untouched' });
		const session = {
			...original,
			aiTabs: [...original.aiTabs, other],
			customModel: 'agent-model',
		};
		useSessionStore.setState({ sessions: [session] });
		const scopedPlan = { ...plan, tabId: 'tab', status: 'ready' as const };
		const result = {
			success: true,
			state: 'committed' as const,
			plan: scopedPlan,
			mappings: [
				{
					tabId: 'tab',
					sourceSessionId: 'source-final',
					destinationSessionId: 'translated-tab',
					artifacts: [],
					lineage: {},
				},
			],
		};
		vi.mocked(window.maestro.sessions.getAll).mockResolvedValue([
			{
				...session,
				providerMigration: {
					operationId: plan.id,
					tabId: 'tab',
					destination: 'codex',
					state: 'committed',
					verification: 'unverified',
				},
			},
		] as any);
		translateProvider.mockResolvedValue({ success: true, plan: scopedPlan, result });
		await requestProviderTranslation({ ...request, tabId: 'tab' });
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.toolType).toBe(session.toolType);
		expect(updated.customModel).toBe('agent-model');
		expect(updated.aiTabs[1]).toBe(other);
		expect(updated.aiTabs[0].providerSessions?.codex?.agentSessionId).toBe('translated-tab');
		expect(updated.aiTabs[0].agentSessionId).toBe('source-final');
		expect(updated.aiTabs[0].logs).toEqual([
			expect.objectContaining({
				source: 'system',
				contextTranslation: expect.objectContaining({
					operationId: scopedPlan.id,
					source: { provider: 'claude-code', version: scopedPlan.source.version },
					destination: { provider: 'codex', version: scopedPlan.destination.version },
				}),
			}),
		]);
		await requestProviderTranslation({ ...request, tabId: 'tab' });
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual(updated.aiTabs[0].logs);
		expect(translateProvider).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab' }));
	});
	it.each([false, true])(
		'ignores changed and new notes after deferral with warnings=%s',
		async (withWarning) => {
			const warning: TranslationLimitation = {
				code: 'unverified-native-resume',
				severity: 'warning',
				message: 'Unverified',
			};
			const warnings = withWarning ? [warning] : [];
			const deferredPlan: TranslationPlan = {
				...plan,
				limitations: [
					...warnings,
					{ code: 'native-cwd-drift', severity: 'info', message: 'Original note' },
				],
			};
			const readyPlan: TranslationPlan = {
				...deferredPlan,
				status: 'ready',
				limitations: [
					...warnings,
					{ code: 'native-cwd-drift', severity: 'info', message: 'Changed note' },
					{ code: 'historical-instructions', severity: 'info', message: 'New note' },
				],
			};
			translateProvider
				.mockResolvedValueOnce({
					success: false,
					plan: deferredPlan,
					result: { success: false, state: 'deferred', plan: deferredPlan, mappings: [] },
				})
				.mockResolvedValueOnce({ success: true, plan: readyPlan })
				.mockResolvedValueOnce({
					success: true,
					plan: readyPlan,
					result: {
						success: true,
						state: 'committed',
						plan: readyPlan,
						mappings: [
							{
								tabId: 'tab',
								sourceSessionId: 'source-final',
								destinationSessionId: 'destination-native',
								artifacts: [],
								lineage: {},
							},
						],
					},
				});
			await requestProviderTranslation({ ...request, acceptLimitations: withWarning });
			expect(
				useSessionStore.getState().sessions[0].providerMigration?.acceptedLimitationCodes
			).toEqual(warnings.map(canonicalJson));
			const completion = requestProviderTranslation(request, { waitForDeferred: true });
			await vi.runAllTimersAsync();
			expect((await completion).result?.state).toBe('committed');
			expect(translateProvider).toHaveBeenCalledTimes(3);
		}
	);
	it.each([undefined, false, true])(
		'finishes a clean deferral with acceptance=%s and keeps the final source identity',
		async (acceptLimitations) => {
			const readyPlan = { ...plan, status: 'ready' as const };
			translateProvider
				.mockResolvedValueOnce({
					success: false,
					plan,
					result: { success: false, state: 'deferred', plan, mappings: [] },
				})
				.mockResolvedValueOnce({ success: true, plan: readyPlan })
				.mockResolvedValueOnce({
					success: true,
					plan: readyPlan,
					result: {
						success: true,
						state: 'committed',
						plan: readyPlan,
						mappings: [
							{
								tabId: 'tab',
								sourceSessionId: 'source-final',
								destinationSessionId: 'destination-native',
								artifacts: [],
								lineage: {},
							},
						],
					},
				});
			await requestProviderTranslation({ ...request, acceptLimitations });
			expect(useSessionStore.getState().sessions[0].providerMigration).toMatchObject({
				state: 'deferred',
				verification: 'verified',
				acceptLimitations: acceptLimitations === true,
				projectResourcesIntoRepo: true,
			});
			const completion = requestProviderTranslation(request, { waitForDeferred: true });
			await vi.runAllTimersAsync();
			expect((await completion).result?.state).toBe('committed');
			expect(translateProvider).toHaveBeenLastCalledWith({
				...request,
				acceptLimitations,
				planId: readyPlan.id,
			});
			const migrated = useSessionStore.getState().sessions[0];
			expect(migrated.toolType).toBe('codex');
			expect(migrated.aiTabs[0]).toMatchObject({
				agentSessionId: 'destination-native',
				inputValue: 'draft stays',
				providerSessions: { 'claude-code': { agentSessionId: 'source-final' } },
			});
		}
	);

	it('resumes saved tab scope and resource consent without granting warning acceptance', async () => {
		const session = useSessionStore.getState().sessions[0];
		session.providerMigration = {
			operationId: plan.id,
			tabId: 'tab',
			destination: 'codex',
			state: 'deferred',
			verification: 'verified',
			acceptLimitations: false,
			acceptedLimitationCodes: [],
			projectResourcesIntoRepo: true,
		};
		translateProvider
			.mockResolvedValueOnce({ success: true, plan: { ...plan, status: 'ready' } })
			.mockResolvedValueOnce({ success: false, error: 'Synthetic staging refusal' });
		resumeDeferredProviderTranslations([session]);
		const completion = requestProviderTranslation(request, { waitForDeferred: true });
		await vi.runAllTimersAsync();
		expect((await completion).error).toBe('Synthetic staging refusal');
		expect(translateProvider).toHaveBeenLastCalledWith({
			...request,
			tabId: 'tab',
			acceptLimitations: false,
			selectedUserResources: undefined,
			projectResourcesIntoRepo: true,
			planId: plan.id,
		});
		expect(useSessionStore.getState().sessions[0].toolType).toBe('claude-code');
	});

	it('refuses new warnings discovered after a clean deferred source finishes', async () => {
		translateProvider
			.mockResolvedValueOnce({
				success: false,
				plan,
				result: { success: false, state: 'deferred', plan, mappings: [] },
			})
			.mockResolvedValueOnce({
				success: true,
				plan: {
					...plan,
					status: 'ready',
					verification: 'unverified',
					limitations: [{ code: 'opaque-runtime-state', severity: 'warning', message: 'Opaque' }],
				},
			});
		await requestProviderTranslation(request);
		const completion = requestProviderTranslation(request, { waitForDeferred: true });
		await vi.runAllTimersAsync();
		expect((await completion).error).toContain('new migration limitations');
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual([]);
		expect(translateProvider).toHaveBeenCalledTimes(2);
		expect(useSessionStore.getState().sessions[0]).toMatchObject({
			toolType: 'claude-code',
			providerMigration: { state: 'failed' },
		});
	});

	it.each([
		{ tabId: 'other-tab' },
		{ message: 'A different opaque native record cannot be resumed.' },
		{ severity: 'block' as const },
	])('requires review when an accepted warning changes: %j', async (change) => {
		const warning: TranslationLimitation = {
			code: 'opaque-runtime-state',
			artifactId: 'same-artifact',
			tabId: 'tab',
			severity: 'warning',
			message: 'An opaque native record cannot be resumed.',
		};
		const acceptedPlan = { ...plan, limitations: [warning] };
		translateProvider
			.mockResolvedValueOnce({
				success: false,
				plan: acceptedPlan,
				result: { success: false, state: 'deferred', plan: acceptedPlan, mappings: [] },
			})
			.mockResolvedValueOnce({
				success: true,
				plan: { ...acceptedPlan, status: 'ready', limitations: [{ ...warning, ...change }] },
			});
		await requestProviderTranslation({ ...request, acceptLimitations: true });
		expect(
			useSessionStore.getState().sessions[0].providerMigration?.acceptedLimitationCodes
		).toEqual([canonicalJson(warning)]);
		const completion = requestProviderTranslation(request, { waitForDeferred: true });
		await vi.runAllTimersAsync();
		expect((await completion).error).toContain('new migration limitations');
		expect(translateProvider).toHaveBeenCalledTimes(2);
		expect(useSessionStore.getState().sessions[0].toolType).toBe('claude-code');
	});

	it.each(['exact', 'legacy'] as const)(
		'restores %s saved warning acceptance without broadening it',
		async (encoding) => {
			const warning: TranslationLimitation = {
				code: 'opaque-runtime-state',
				artifactId: 'artifact:with:colons',
				tabId: 'tab',
				severity: 'warning',
				message: 'An opaque native record cannot be resumed.',
			};
			const session = useSessionStore.getState().sessions[0];
			session.providerMigration = {
				operationId: plan.id,
				destination: 'codex',
				state: 'deferred',
				verification: 'unverified',
				acceptLimitations: true,
				acceptedLimitationCodes: [
					encoding === 'exact' ? canonicalJson(warning) : `${warning.code}:${warning.artifactId}`,
				],
			};
			translateProvider
				.mockResolvedValueOnce({
					success: true,
					plan: {
						...plan,
						status: 'ready',
						limitations: [
							{
								message: warning.message,
								severity: warning.severity,
								tabId: warning.tabId,
								artifactId: warning.artifactId,
								code: warning.code,
							},
						],
					},
				})
				.mockResolvedValueOnce({ success: false, error: 'Synthetic staging refusal' });
			resumeDeferredProviderTranslations([session]);
			const completion = requestProviderTranslation(request, { waitForDeferred: true });
			await vi.runAllTimersAsync();
			expect((await completion).error).toContain(
				encoding === 'exact' ? 'Synthetic staging refusal' : 'new migration limitations'
			);
			expect(translateProvider).toHaveBeenCalledTimes(encoding === 'exact' ? 2 : 1);
			expect(useSessionStore.getState().sessions[0].toolType).toBe('claude-code');
		}
	);
});
