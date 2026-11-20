import {
	prepareTabForSend,
	TranslationSendHeldError,
} from '../../shared/maestro-lib/translation/send';
import { notifyToast } from '../stores/notificationStore';
import { probeSessionAiProcesses } from './process';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { canonicalJson } from '../../shared/canonicalJson';
import { limitationsNeedingAcceptance } from '../../shared/maestro-lib/translation/limitations';
import {
	commitTranslationSession,
	recordTranslationCommit,
	translationSessionTabs,
	migrationHoldsTurns,
} from '../../shared/maestro-lib/translation/session';
import { switchAgentProvider } from '../../shared/maestro-lib/agents/providerSwap';
import type {
	TranslationReport,
	TranslationRequest,
} from '../../shared/maestro-lib/translation/types';
import type { Session, ToolType } from '../types';

const pending = new Map<string, Promise<TranslationReport>>();

async function waitForSourceIdle(agentId: string): Promise<void> {
	for (;;) {
		const session = useSessionStore.getState().sessions.find((s) => s.id === agentId);
		if (!session) throw new Error('Agent removed while provider migration was deferred');
		const localBusy =
			[...session.aiTabs, ...(session.orphanedThinkingTabs ?? [])].some(
				(tab) => tab.state === 'busy'
			) ||
			session.state === 'busy' ||
			session.state === 'connecting';
		const active = await window.maestro.process.getActiveProcesses({
			includeChildProcesses: false,
		});
		const managedBusy = active.some(
			(p) =>
				p.sessionId === `${agentId}-ai` ||
				p.sessionId.startsWith(`${agentId}-ai-`) ||
				p.sessionId.startsWith(`${agentId}-batch-`)
		);
		if (!localBusy && !managedBusy) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}
}

/** Inventory retains native ownership of closed tabs without persisting their private transcript twice. */
async function snapshotAgent(agentId: string): Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === agentId);
	if (!session) throw new Error('Agent not found');
	const inventory = translationSessionTabs(session).map((tab) => ({
		id: tab.id,
		agentSessionId: tab.agentSessionId,
		providerSessions: tab.providerSessions,
		pendingTranslation: tab.pendingTranslation,
	}));
	updateSessionWith(agentId, (s) => ({ ...s, providerTranslationTabInventory: inventory }));
	await window.maestro.sessions.setMany(
		[
			{
				...session,
				aiTabs: session.aiTabs.map((tab) => ({ ...tab, translatingFrom: undefined })),
				orphanedThinkingTabs: session.orphanedThinkingTabs?.map((tab) => ({
					...tab,
					translatingFrom: undefined,
				})),
				providerTranslationTabInventory: inventory,
			} as any,
		],
		[]
	);
}

async function applyReport(agentId: string, report: TranslationReport): Promise<void> {
	if (!report.success || report.result?.state !== 'committed' || !report.plan) return;
	const result = report.result;
	// The host resolves the destination account, config and binding. Never infer them in the renderer.
	const stored = (await window.maestro.sessions.getAll()).find((s: any) => s.id === agentId) as any;
	updateSessionWith(agentId, (s) => {
		// The lifecycle push can reach this renderer before the IPC reply.
		const committed = commitTranslationSession(
			s,
			report.plan!.destination.provider,
			report.plan!.id,
			result.mappings,
			stored?.providerTranslationKnowledgeDirectory,
			report.plan!.source.provider,
			report.plan!.tabId,
			report.plan!.deferredTabs
		);
		const updated = recordTranslationCommit(committed, report);
		return {
			...updated,
			customEnvVars: stored?.customEnvVars,
			providerOverrides: stored?.providerOverrides ?? updated.providerOverrides,
			providerTranslationTabInventory: stored?.providerTranslationTabInventory,
			providerMigration: stored?.providerMigration,
			providerTranslationQueuedOrigins: stored?.providerTranslationQueuedOrigins,
		};
	});
}

async function finishDeferred(
	request: TranslationRequest,
	acceptedLimitationCodes: string[]
): Promise<TranslationReport> {
	try {
		await waitForSourceIdle(request.agentId);
		// Allow the final exit/session-id updates in the current event task to settle.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await snapshotAgent(request.agentId);
		const preflight = await window.maestro.agents.translateProvider({
			...request,
			action: 'plan',
			planId: undefined,
		});
		if (!preflight.plan) throw new Error(preflight.error ?? 'Deferred preflight unavailable');
		const accepted = new Set(acceptedLimitationCodes);
		if (
			preflight.plan.status === 'blocked' ||
			preflight.plan.limitations.some((l) => l.severity === 'block') ||
			limitationsNeedingAcceptance(preflight.plan.limitations).some(
				(l) => !accepted.has(canonicalJson(l))
			)
		)
			throw new Error(
				'The completed source has new migration limitations. Review its new preflight before applying.'
			);
		if (preflight.plan.status === 'deferred') {
			await new Promise<void>((resolve) => setTimeout(resolve, 500));
			return await finishDeferred(request, acceptedLimitationCodes);
		}
		const report = await window.maestro.agents.translateProvider({
			...request,
			action: 'apply',
			planId: preflight.plan.id,
		});
		if (report.result?.state === 'deferred')
			return await finishDeferred(request, acceptedLimitationCodes);
		await applyReport(request.agentId, report);
		if (!report.success)
			throw new Error(report.error ?? report.result?.error ?? 'Deferred migration failed');
		return report;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateSessionWith(request.agentId, (s) => ({
			...s,
			providerMigration: s.providerMigration
				? { ...s.providerMigration, state: 'failed', error: message }
				: undefined,
		}));
		await snapshotAgent(request.agentId);
		return { success: false, error: message };
	} finally {
		pending.delete(request.agentId);
	}
}

/** Edit Agent and update_session_config share this client and the same main/library operation. */
export async function requestProviderTranslation(
	request: TranslationRequest,
	options: { waitForDeferred?: boolean; deferAutomatically?: boolean } = {}
): Promise<TranslationReport> {
	if (request.action === 'apply' && pending.has(request.agentId))
		return options.waitForDeferred
			? pending.get(request.agentId)!
			: { success: false, error: 'Provider migration is already deferred for this agent' };
	try {
		if (request.action === 'plan' || request.action === 'apply')
			await snapshotAgent(request.agentId);
		const report = await window.maestro.agents.translateProvider(request);
		await applyReport(request.agentId, report);
		if (
			options.deferAutomatically !== false &&
			report.result?.state === 'deferred' &&
			report.plan &&
			(request.acceptLimitations ||
				limitationsNeedingAcceptance(report.plan.limitations).length === 0)
		) {
			const acceptedLimitationCodes = limitationsNeedingAcceptance(report.plan.limitations).map(
				canonicalJson
			);
			updateSessionWith(request.agentId, (s) => ({
				...s,
				providerMigration: {
					operationId: report.plan!.id,
					acceptedDirections: s.providerMigration?.acceptedDirections,
					tabId: request.tabId,
					destination: request.destination,
					state: 'deferred',
					verification: report.plan!.verification,
					acceptLimitations: request.acceptLimitations === true,
					selectedUserResources: request.selectedUserResources,
					projectResourcesIntoRepo: request.projectResourcesIntoRepo,
					acceptedLimitationCodes,
				},
			}));
			const completion = finishDeferred(request, acceptedLimitationCodes);
			pending.set(request.agentId, completion);
			if (options.waitForDeferred) return completion;
		}
		return report;
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Switch an agent's provider WITHOUT converting memory or session history.
 *
 * Every tab keeps its transcript. Each tab's provider session is parked under
 * the old provider (switching back resumes it) and its next turn starts a fresh
 * conversation on the new one. Agent-level overrides are parked the same way.
 * Refused while a conversion is in flight for the agent, since that operation
 * owns the provider fields until it settles.
 *
 * Returns one line per piece of state that could not be parked.
 */
export function switchProviderWithoutConversion(agentId: string, destination: ToolType): string[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === agentId);
	if (!session) throw new Error('Agent not found');
	if (pending.has(agentId) || migrationHoldsTurns(session.providerMigration))
		throw new Error('A provider conversion is in progress for this agent. Wait for it to finish.');
	if (session.toolType === destination) return [];
	let notices: string[] = [];
	updateSessionWith(agentId, (s) => {
		const { agent, unparked } = switchAgentProvider(s, destination);
		notices = unparked.map((item) => item.message);
		// A settled conversion record describes a provider move this switch replaces.
		return { ...agent, providerMigration: undefined };
	});
	return notices;
}

/** Persisted deferrals survive reload; newly discovered warnings still require review. */
export function resumeDeferredProviderTranslations(sessions: Session[]): void {
	for (const session of sessions) {
		const state = session.providerMigration;
		if (state?.state !== 'deferred' || pending.has(session.id)) continue;
		const request: TranslationRequest = {
			agentId: session.id,
			tabId: state.tabId,
			destination: state.destination,
			action: 'apply',
			acceptLimitations: state.acceptLimitations === true,
			selectedUserResources: state.selectedUserResources,
			projectResourcesIntoRepo: state.projectResourcesIntoRepo,
		};
		// Legacy code/artifact keys cannot prove acceptance of the completed source's exact warning.
		pending.set(session.id, finishDeferred(request, state.acceptedLimitationCodes ?? []));
	}
}

export { migrationHoldsTurns };

/** Both desktop send paths use the library gate before building resume arguments. */
export async function prepareProviderTranslationForSend(
	agentId: string,
	tabId: string,
	provider: ToolType
): Promise<string | undefined> {
	const getSession = () => {
		const session = useSessionStore.getState().sessions.find((s) => s.id === agentId);
		if (!session) throw new Error('Agent removed before sending');
		return session;
	};
	try {
		return await prepareTabForSend(tabId, provider, {
			getSession,
			translate: (request) => requestProviderTranslation(request, { deferAutomatically: false }),
			isBusy: async () => {
				const probe = await probeSessionAiProcesses(agentId, tabId);
				if (probe.probeFailed) throw new Error('Cannot verify the source turn has finished');
				return probe.anyActive;
			},
			onProgress: (source) =>
				updateSessionWith(agentId, (s) => ({
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === tabId ? { ...tab, translatingFrom: source } : tab
					),
					orphanedThinkingTabs: s.orphanedThinkingTabs?.map((tab) =>
						tab.id === tabId ? { ...tab, translatingFrom: source } : tab
					),
				})),
		});
	} catch (error) {
		const held =
			error instanceof TranslationSendHeldError
				? error
				: new TranslationSendHeldError(error instanceof Error ? error.message : String(error));
		if (!held.deferred)
			notifyToast({
				color: 'yellow',
				title: 'Context translation needs review',
				message: held.message,
				sessionId: agentId,
				tabId,
				clickAction: { kind: 'review-translation', sessionId: agentId, tabId, provider },
			});
		throw held;
	}
}
