import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { canonicalJson } from '../../shared/canonicalJson';
import {
	commitTranslationSession,
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
	}));
	updateSessionWith(agentId, (s) => ({ ...s, providerTranslationTabInventory: inventory }));
	await window.maestro.sessions.setMany(
		[{ ...session, providerTranslationTabInventory: inventory } as any],
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
		const updated = commitTranslationSession(
			s,
			report.plan!.destination.provider,
			report.plan!.id,
			result.mappings,
			stored?.providerTranslationKnowledgeDirectory,
			report.plan!.source.provider
		);
		return {
			...updated,
			customEnvVars: stored?.customEnvVars,
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
			preflight.plan.limitations.some(
				(l) => l.severity === 'block' || !accepted.has(canonicalJson(l))
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
	options: { waitForDeferred?: boolean } = {}
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
			report.result?.state === 'deferred' &&
			report.plan &&
			(request.acceptLimitations || report.plan.limitations.length === 0)
		) {
			updateSessionWith(request.agentId, (s) => ({
				...s,
				providerMigration: {
					operationId: report.plan!.id,
					destination: request.destination,
					state: 'deferred',
					verification: report.plan!.verification,
					acceptLimitations: request.acceptLimitations === true,
					selectedUserResources: request.selectedUserResources,
					acceptedLimitationCodes: report.plan!.limitations.map(canonicalJson),
				},
			}));
			const completion = finishDeferred(request, report.plan.limitations.map(canonicalJson));
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
			destination: state.destination,
			action: 'apply',
			acceptLimitations: state.acceptLimitations === true,
			selectedUserResources: state.selectedUserResources,
		};
		// Legacy code/artifact keys cannot prove acceptance of the completed source's exact warning.
		pending.set(session.id, finishDeferred(request, state.acceptedLimitationCodes ?? []));
	}
}

export { migrationHoldsTurns };
