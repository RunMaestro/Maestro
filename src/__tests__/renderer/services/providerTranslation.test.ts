import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { canonicalJson } from '../../../shared/canonicalJson';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
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
const request: TranslationRequest = { agentId: 'agent', destination: 'codex', action: 'apply' };
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

	it('resumes a saved clean deferral without granting warning acceptance', async () => {
		const session = useSessionStore.getState().sessions[0];
		session.providerMigration = {
			operationId: plan.id,
			destination: 'codex',
			state: 'deferred',
			verification: 'verified',
			acceptLimitations: false,
			acceptedLimitationCodes: [],
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
			acceptLimitations: false,
			selectedUserResources: undefined,
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
