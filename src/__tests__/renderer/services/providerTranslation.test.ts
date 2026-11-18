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

// Grok carry-over through the renderer client, the path Edit Agent and the
// remote settings edit share. Deterministic tests, not native qualification.
describe('Grok provider translation client', () => {
	const grokPlan: TranslationPlan = {
		...plan,
		id: '22222222-2222-4222-8222-222222222222',
		status: 'ready',
		verification: 'unverified',
		destination: {
			provider: 'grok',
			version: '1.0.70',
			accountRoot: '/synthetic/grok',
			nativeSessionRoot: '/synthetic/grok/sessions',
			projectRoot: '/synthetic/project',
		},
		limitations: [
			{
				code: 'grok-native-replay-absent',
				severity: 'warning',
				message: 'Grok replay may be empty.',
			},
		],
	};
	const grokRequest: TranslationRequest = {
		agentId: 'agent',
		destination: 'grok',
		action: 'apply',
	};
	const stored = () => useSessionStore.getState().sessions[0];
	function hostStores(migration: object) {
		vi.mocked(window.maestro.sessions.getAll).mockResolvedValue([
			{
				...stored(),
				toolType: 'grok',
				customEnvVars: { GROK_HOME: grokPlan.destination.accountRoot },
				providerMigration: migration,
			},
		] as any);
	}

	it('plans Grok without switching the agent or recording a migration', async () => {
		translateProvider.mockResolvedValueOnce({ success: true, plan: grokPlan });
		const report = await requestProviderTranslation({ ...grokRequest, action: 'plan' });
		expect(report.plan?.verification).toBe('unverified');
		expect(stored()).toMatchObject({ toolType: 'claude-code' });
		expect(stored().providerMigration).toBeUndefined();
		expect(stored().aiTabs[0].agentSessionId).toBe('source-final');
	});

	it.each([
		{ name: 'an unaccepted plan', state: 'refused' as const, accept: false },
		{ name: 'a blocked plan', state: 'refused' as const, accept: true },
		{ name: 'a stale reviewed plan', state: undefined, accept: true },
	])('leaves the Claude agent intact after $name', async ({ state, accept }) => {
		translateProvider.mockResolvedValueOnce({
			success: false,
			plan: grokPlan,
			...(state && { result: { success: false, state, plan: grokPlan, mappings: [] } }),
			error: 'Synthetic refusal',
		});
		const report = await requestProviderTranslation({
			...grokRequest,
			acceptLimitations: accept,
			planId: 'reviewed',
		});
		expect(report).toMatchObject({ success: false, error: 'Synthetic refusal' });
		expect(window.maestro.sessions.getAll).not.toHaveBeenCalled();
		expect(stored()).toMatchObject({ toolType: 'claude-code' });
		expect(stored().providerMigration).toBeUndefined();
		expect(stored().aiTabs[0]).toMatchObject({
			agentSessionId: 'source-final',
			inputValue: 'draft stays',
		});
	});

	it('applies a committed Grok report with the host account and keeps it unverified', async () => {
		const migration = {
			operationId: grokPlan.id,
			destination: 'grok',
			state: 'committed',
			verification: 'unverified',
			// Only the host records accepted codes, so this proves its record is the one kept.
			acceptedLimitationCodes: ['host-recorded'],
		};
		hostStores(migration);
		translateProvider.mockResolvedValueOnce({
			success: true,
			plan: grokPlan,
			result: {
				success: true,
				state: 'committed',
				plan: grokPlan,
				mappings: [
					{
						tabId: 'tab',
						sourceSessionId: 'source-final',
						destinationSessionId: 'grok-native',
						artifacts: [],
						lineage: {},
					},
				],
			},
		});
		await requestProviderTranslation({ ...grokRequest, acceptLimitations: true });
		const migrated = stored();
		expect(migrated.toolType).toBe('grok');
		// The renderer never infers the account: it takes the host's binding as stored.
		expect(migrated.customEnvVars).toEqual({ GROK_HOME: '/synthetic/grok' });
		expect(migrated.providerMigration).toEqual(migration);
		// The Claude session is parked, so switching back restores it rather than a copy.
		expect(migrated.aiTabs[0]).toMatchObject({
			agentSessionId: 'grok-native',
			inputValue: 'draft stays',
			providerSessions: { 'claude-code': { agentSessionId: 'source-final' } },
		});
	});

	it.each(['accepted', 'new-block'] as const)(
		'restores a saved Grok deferral after reload (%s)',
		async (variant) => {
			const warning = grokPlan.limitations[0];
			const session = stored();
			session.providerMigration = {
				operationId: grokPlan.id,
				destination: 'grok',
				state: 'deferred',
				verification: 'unverified',
				acceptLimitations: true,
				acceptedLimitationCodes: [canonicalJson(warning)],
			};
			translateProvider.mockResolvedValueOnce({
				success: true,
				plan: {
					...grokPlan,
					...(variant === 'new-block' && {
						status: 'blocked' as const,
						limitations: [
							warning,
							{
								code: 'destination-account-missing',
								severity: 'block' as const,
								message: 'The selected Grok CLI account folder does not exist yet.',
							},
						],
					}),
				},
			});
			if (variant === 'accepted')
				translateProvider.mockResolvedValueOnce({
					success: false,
					error: 'Synthetic staging refusal',
				});
			resumeDeferredProviderTranslations([session]);
			const completion = requestProviderTranslation(grokRequest, { waitForDeferred: true });
			await vi.runAllTimersAsync();
			const report = await completion;
			expect(translateProvider).toHaveBeenNthCalledWith(1, {
				...grokRequest,
				acceptLimitations: true,
				selectedUserResources: undefined,
				action: 'plan',
				planId: undefined,
			});
			if (variant === 'accepted') {
				expect(report.error).toBe('Synthetic staging refusal');
				expect(translateProvider).toHaveBeenLastCalledWith({
					...grokRequest,
					acceptLimitations: true,
					selectedUserResources: undefined,
					planId: grokPlan.id,
				});
			} else {
				expect(report.error).toContain('new migration limitations');
				expect(translateProvider).toHaveBeenCalledTimes(1);
			}
			expect(stored()).toMatchObject({
				toolType: 'claude-code',
				providerMigration: { destination: 'grok', state: 'failed', verification: 'unverified' },
			});
		}
	);
});
