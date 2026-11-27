import type { ToolType } from '../../types';
import { resolveTabProvider } from '../agents/providerSwap';
import { translationWarningsAccepted } from './limitations';
import { migrationHoldsTurns, translationSessionTabs, type TranslatableSession } from './session';
import type { TranslationReport, TranslationRequest } from './types';

/** The native source for a missing destination slot. Never guess between parked branches. */
export function pendingTranslationSource(
	session: TranslatableSession,
	tabId: string,
	destination: ToolType
): ToolType | 'ambiguous' | undefined {
	const [tab] = translationSessionTabs(session, tabId);
	if (tab.pendingTranslation && tab.pendingTranslation !== destination) {
		const sourceId =
			tab.pendingTranslation === resolveTabProvider(tab, session)
				? tab.agentSessionId
				: tab.providerSessions?.[tab.pendingTranslation]?.agentSessionId;
		if (!sourceId && tab.state !== 'busy' && !tab.awaitingSessionId)
			throw new Error('Pending translation has no native source identity');
		return tab.pendingTranslation;
	}
	const destinationId =
		destination === resolveTabProvider(tab, session)
			? tab.agentSessionId
			: tab.providerSessions?.[destination]?.agentSessionId;
	if (destinationId) return undefined;
	if (tab.agentSessionId && resolveTabProvider(tab, session) !== destination)
		return resolveTabProvider(tab, session);
	const sources = Object.entries(tab.providerSessions ?? {}).filter(
		([provider, slot]) => provider !== destination && slot?.agentSessionId
	);
	if (sources.length > 1) return 'ambiguous';
	return sources[0]?.[0] as ToolType | undefined;
}

/** A launch refusal: the owner must keep the message and its captured settings. */
export class TranslationSendHeldError extends Error {
	constructor(
		message: string,
		readonly deferred = false,
		readonly report?: TranslationReport
	) {
		super(message);
		this.name = 'TranslationSendHeldError';
	}
}

export interface TranslationSendHost {
	getSession(): TranslatableSession;
	translate(request: TranslationRequest): Promise<TranslationReport>;
	isBusy(): Promise<boolean> | boolean;
	onProgress?(source: ToolType | undefined): void;
}

/** Shared desktop/runtime gate, before consuming a message or assembling its resume arguments. */
export async function prepareTabForSend(
	tabId: string,
	provider: ToolType,
	host: TranslationSendHost
): Promise<string | undefined> {
	const session = host.getSession();
	if (
		migrationHoldsTurns(session.providerMigration) &&
		!(session.providerMigration?.state === 'deferred' && session.providerMigration.tabId === tabId)
	)
		throw new TranslationSendHeldError('Provider translation requires review before sending.');
	let source: ToolType | undefined;
	try {
		const pending = pendingTranslationSource(session, tabId, provider);
		if (pending === 'ambiguous')
			throw new Error('Multiple parked source providers; select the source before translation');
		source = pending;
	} catch (error) {
		throw new TranslationSendHeldError(error instanceof Error ? error.message : String(error));
	}
	const nativeId = () => {
		const current = host.getSession();
		const [tab] = translationSessionTabs(current, tabId);
		return (
			(provider === resolveTabProvider(tab, current)
				? tab.agentSessionId
				: tab.providerSessions?.[provider]?.agentSessionId) || undefined
		);
	};
	if (!source) return nativeId();
	if (await host.isBusy())
		throw new TranslationSendHeldError(
			'Waiting for the source turn to finish before translating context.',
			true
		);
	host.onProgress?.(source);
	try {
		const request: TranslationRequest = {
			agentId: session.id,
			tabId,
			destination: provider,
			action: 'plan',
		};
		const preflight = await host.translate(request);
		const plan = preflight.plan;
		if (!preflight.success || !plan)
			throw new TranslationSendHeldError(
				preflight.error ?? 'Translation preflight failed.',
				false,
				preflight
			);
		if (plan.status === 'deferred')
			throw new TranslationSendHeldError(
				'Waiting for the source turn to finish before translating context.',
				true,
				preflight
			);
		if (
			plan.status === 'blocked' ||
			plan.limitations.some((l) => l.severity === 'block') ||
			!translationWarningsAccepted(plan, host.getSession().providerMigration)
		)
			throw new TranslationSendHeldError(
				'Review context translation before sending this message.',
				false,
				preflight
			);
		const report = await host.translate({
			...request,
			action: 'apply',
			planId: plan.id,
			acceptLimitations: true,
		});
		if (!report.success || report.result?.state !== 'committed')
			throw new TranslationSendHeldError(
				report.error ?? report.result?.error ?? 'Context translation did not commit.',
				report.result?.state === 'deferred',
				report
			);
		const resumed = nativeId();
		if (!resumed)
			throw new TranslationSendHeldError(
				'Context translation returned no native session to resume.',
				false,
				report
			);
		return resumed;
	} finally {
		host.onProgress?.(undefined);
	}
}
