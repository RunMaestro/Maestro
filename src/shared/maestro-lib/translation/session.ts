import { canonicalJson } from '../../canonicalJson';
import { getAgentDisplayName } from '../../agentMetadata';
import { agentRunOnSupport } from '../../local-models/run-on';
import { OFF_TOKEN_PROXY_FIELDS } from '../../local-models/token-proxy';
import type { ToolType } from '../../types';
import { resolveTabProvider, type ProviderSwitchTab } from '../agents/providerSwap';
import type {
	ProviderMigrationState,
	TranslationTabMapping,
	HistoryTranslationMapping,
	TranslationReport,
} from './types';

export interface TranslationTab extends ProviderSwitchTab {
	id: string;
	/** Preserve unknown entries from newer clients, as the runtime store does. */
	logs?: unknown[];
}

/** Shared parking invariant: live ID belongs to the active provider; its slot is removed. */
export function switchTabProvider<T extends Omit<TranslationTab, 'id' | 'tabProvider'>>(
	tab: T,
	fromProvider: ToolType,
	toProvider: ToolType
): T {
	if (fromProvider === toProvider) return tab;
	const parked = { ...(tab.providerSessions ?? {}) };
	parked[fromProvider] = {
		agentSessionId: tab.agentSessionId,
		usageStats: tab.usageStats,
		customModel: tab.customModel,
		customEffort: tab.customEffort,
		runOn: tab.runOn,
	};
	const restored = parked[toProvider];
	delete parked[toProvider];
	return {
		...tab,
		agentSessionId: restored?.agentSessionId ?? null,
		usageStats: restored?.usageStats,
		customModel: restored?.customModel,
		customEffort: restored?.customEffort,
		runOn: restored?.runOn,
		awaitingSessionId: false,
		providerSessions: parked,
	};
}

export interface TranslatableSession {
	id: string;
	toolType: ToolType;
	aiTabs: TranslationTab[];
	closedTabHistory?: Array<{ tab: TranslationTab }>;
	unifiedClosedTabHistory?: Array<{ type: string; tab?: any }>;
	snoozedTabs?: Array<{ type: string; tab?: any; members?: any[] }>;
	providerMigration?: ProviderMigrationState;
	providerTranslationHistoryMappings?: HistoryTranslationMapping[];
	[key: string]: any;
}

export function translationSessionTabs(
	session: TranslatableSession,
	tabId?: string
): TranslationTab[] {
	const tabs = [
		...(session.providerTranslationTabInventory ?? []),
		...(session.closedTabHistory ?? []).map((c) => c.tab),
		...(session.unifiedClosedTabHistory ?? []).filter((c) => c.type === 'ai').map((c) => c.tab),
		...(session.snoozedTabs ?? []).flatMap((c) =>
			c.type === 'ai'
				? [c.tab]
				: c.type === 'group'
					? (c.members ?? []).filter((t) => t.type === 'ai').map((t) => t.tab)
					: []
		),
		...(session.orphanedThinkingTabs ?? []),
		...(session.aiTabs ?? []),
	];

	const unique: TranslationTab[] = [
		...new Map(tabs.filter(Boolean).map((t) => [t.id, t])).values(),
	];
	if (tabId === undefined) return unique;
	const selected = unique.filter((tab) => tab.id === tabId);
	if (selected.length !== 1) throw new Error(`Translation tab not found: ${tabId}`);
	return selected;
}

/** The places an agent keeps AI tabs: open, orphaned mid-turn, closed, and snoozed. */
export interface AiTabContainers {
	aiTabs?: any[];
	orphanedThinkingTabs?: any[];
	closedTabHistory?: Array<{ tab?: any }>;
	unifiedClosedTabHistory?: Array<{ type: string; tab?: any }>;
	snoozedTabs?: Array<{ type: string; tab?: any; members?: any[] }>;
}

/**
 * Map every AI tab an agent holds, wherever it lives. Returns only the
 * containers the agent has, so spreading the result over the agent replaces
 * them and leaves every other field alone. An entry without a tab is kept as is.
 */
export function mapAgentAiTabs<S extends AiTabContainers>(
	session: S,
	map: (tab: any) => any
): Partial<Pick<S, keyof AiTabContainers>> {
	return {
		...(session.aiTabs && { aiTabs: session.aiTabs.map(map) }),
		...(session.orphanedThinkingTabs && {
			orphanedThinkingTabs: session.orphanedThinkingTabs.map(map),
		}),
		...(session.closedTabHistory && {
			closedTabHistory: session.closedTabHistory.map((c) =>
				c.tab ? { ...c, tab: map(c.tab) } : c
			),
		}),
		...(session.unifiedClosedTabHistory && {
			unifiedClosedTabHistory: session.unifiedClosedTabHistory.map((c) =>
				c.type === 'ai' && c.tab ? { ...c, tab: map(c.tab) } : c
			),
		}),
		...(session.snoozedTabs && {
			snoozedTabs: session.snoozedTabs.map((c) =>
				c.type === 'ai' && c.tab
					? { ...c, tab: map(c.tab) }
					: c.type === 'group'
						? {
								...c,
								members: c.members?.map((t) =>
									t.type === 'ai' && t.tab ? { ...t, tab: map(t.tab) } : t
								),
							}
						: c
			),
		}),
	} as Partial<Pick<S, keyof AiTabContainers>>;
}

/** Apply the same mutation to live and retained copies without touching native-only inventory. */
function mapTranslationSessionTabs<T extends TranslatableSession>(
	session: T,
	translate: (tab: TranslationTab) => TranslationTab
): T {
	return { ...session, ...mapAgentAiTabs(session, translate) };
}

/** Record only finalized native imports, once per operation/tab, across desktop and runtime. */
export function recordTranslationCommit<T extends TranslatableSession>(
	session: T,
	report: TranslationReport
): T {
	const { plan, result } = report;
	if (
		!report.success ||
		!plan ||
		!result?.success ||
		result.state !== 'committed' ||
		plan.agentId !== session.id ||
		plan.status !== 'ready' ||
		plan.source.provider === plan.destination.provider
	)
		return session;
	const mappings = new Map(result.mappings.map((mapping) => [mapping.tabId, mapping]));
	const timestamp = Date.now();
	return mapTranslationSessionTabs(session, (tab) => {
		const mapping = mappings.get(tab.id);
		const markerId = `translation:${plan.id}:${tab.id}`;
		const logs = tab.logs ?? [];
		const liveProvider = resolveTabProvider(tab, session);
		const destinationId =
			liveProvider === plan.destination.provider
				? tab.agentSessionId
				: tab.providerSessions?.[plan.destination.provider]?.agentSessionId;
		if (
			(plan.tabId !== undefined && plan.tabId !== tab.id) ||
			(plan.tabId === undefined && tab.tabProvider !== undefined) ||
			!mapping?.sourceSessionId ||
			!mapping.destinationSessionId ||
			destinationId !== mapping.destinationSessionId ||
			logs.some(
				(log) => typeof log === 'object' && log !== null && 'id' in log && log.id === markerId
			)
		)
			return tab;
		return {
			...tab,
			logs: [
				...logs,
				{
					id: markerId,
					timestamp,
					source: 'system',
					text: `Context translated from ${getAgentDisplayName(plan.source.provider)}`,
					contextTranslation: {
						operationId: plan.id,
						source: { provider: plan.source.provider, version: plan.source.version },
						destination: { provider: plan.destination.provider, version: plan.destination.version },
						verification: plan.verification,
						counts: { ...plan.counts },
						limitations: plan.limitations.map((limitation) => ({ ...limitation })),
					},
				},
			],
		};
	});
}

export function commitTranslationSession<T extends TranslatableSession>(
	session: T,
	destination: ToolType,
	operationId: string,
	mappings: TranslationTabMapping[],
	knowledgeDirectory?: string,
	sourceProvider: ToolType = session.toolType,
	tabId?: string,
	deferredTabs: TranslationTab[] = []
): T {
	if (
		tabId !== undefined &&
		(mappings.length !== 1 ||
			mappings[0].tabId !== tabId ||
			!translationSessionTabs(session).some((tab) => tab.id === tabId))
	)
		throw new Error('Single-tab commit requires exactly one existing tab mapping');
	const map = new Map(mappings.map((m) => [m.tabId, m]));
	const translate = (tab: TranslationTab): TranslationTab => {
		if (tabId !== undefined && tab.id !== tabId) return tab;
		if (tabId === undefined && tab.tabProvider !== undefined) return tab;
		const liveProvider = resolveTabProvider(tab, session);
		const mapping = map.get(tab.id);
		if (!mapping) {
			if (session.aiTabs.some((open) => open.id === tab.id))
				throw new Error(`Missing native translation mapping for tab ${tab.id}`);
			const pending = deferredTabs.find((candidate) => candidate.id === tab.id);
			// Renderer lifecycle updates can arrive before the IPC response. Only
			// park a stale local copy if it still matches the reviewed source slot.
			const stillSource =
				session.toolType !== destination ||
				(pending &&
					tab.agentSessionId === pending.agentSessionId &&
					canonicalJson(tab.providerSessions ?? {}) ===
						canonicalJson(pending.providerSessions ?? {}));
			if (!stillSource) return tab;
			const pendingSource =
				tab.pendingTranslation ?? (tab.agentSessionId ? sourceProvider : undefined);
			return {
				...switchTabProvider(tab, sourceProvider, destination),
				pendingTranslation: pendingSource === destination ? undefined : pendingSource,
			};
		}
		if (tabId !== undefined) {
			const sourceId =
				sourceProvider === liveProvider
					? tab.agentSessionId
					: tab.providerSessions?.[sourceProvider]?.agentSessionId;
			const destinationId =
				destination === liveProvider
					? tab.agentSessionId
					: tab.providerSessions?.[destination]?.agentSessionId;
			if (sourceId !== mapping.sourceSessionId)
				throw new Error(
					`Native source identity changed before translation commit for tab ${tab.id}`
				);
			if (destinationId === mapping.destinationSessionId)
				return { ...tab, pendingTranslation: undefined };
			const sourceTab = switchTabProvider(tab, liveProvider, sourceProvider);
			const translated = {
				...switchTabProvider(sourceTab, sourceProvider, destination),
				agentSessionId: mapping.destinationSessionId,
				turnSessionId: tab.turnSessionId ?? tab.agentSessionId ?? undefined,
				pendingTranslation: undefined,
			};
			// Until a caller selects the destination, keep its new native ID parked.
			return switchTabProvider(translated, destination, liveProvider);
		}
		if (
			session.toolType === destination &&
			tab.agentSessionId === mapping.destinationSessionId &&
			tab.providerSessions?.[sourceProvider]?.agentSessionId === mapping.sourceSessionId
		)
			return tab;
		if (tab.agentSessionId !== mapping.sourceSessionId)
			throw new Error(`Native source identity changed before translation commit for tab ${tab.id}`);
		const switched = switchTabProvider(tab, sourceProvider, destination);
		return {
			...switched,
			agentSessionId: mapping.destinationSessionId,
			turnSessionId: tab.turnSessionId ?? tab.agentSessionId ?? undefined,
			pendingTranslation: undefined,
		};
	};
	const historyMappings = new Map<string, HistoryTranslationMapping>();
	for (const previous of session.providerTranslationHistoryMappings ?? []) {
		const next = mappings.find(
			(m) =>
				m.tabId === previous.tabId ||
				(previous.destinationSessionId &&
					(m.sourceSessionId === previous.destinationSessionId ||
						(session.toolType === destination &&
							m.destinationSessionId === previous.destinationSessionId)))
		);
		historyMappings.set(
			previous.tabId,
			next
				? { ...previous, destinationSessionId: next.destinationSessionId }
				: tabId !== undefined ||
					  translationSessionTabs(session).some(
							(tab) =>
								tab.tabProvider !== undefined &&
								(tab.agentSessionId === previous.destinationSessionId ||
									Object.values(tab.providerSessions ?? {}).some(
										(slot) => slot?.agentSessionId === previous.destinationSessionId
									))
					  )
					? previous
					: { ...previous, destinationSessionId: null }
		);
	}
	for (const mapping of mappings) {
		const key = mapping.tabId.startsWith('history:')
			? mapping.tabId
			: mapping.sourceSessionId
				? `history:${mapping.sourceSessionId}`
				: undefined;
		if (key && !historyMappings.has(key))
			historyMappings.set(key, {
				tabId: key,
				sourceSessionId: mapping.sourceSessionId,
				destinationSessionId: mapping.destinationSessionId,
			});
	}
	return {
		...mapTranslationSessionTabs(session, translate),
		toolType: tabId === undefined ? destination : session.toolType,
		...(tabId === undefined && {
			providerTranslationQueuedOrigins: Object.fromEntries(
				(session.executionQueue ?? []).map((item: { id: string }) => [
					item.id,
					session.providerTranslationQueuedOrigins?.[item.id] ?? sourceProvider,
				])
			),
		}),
		providerMigration: {
			operationId,
			destination,
			tabId,
			state: 'committed',
			verification: 'unverified',
		},
		providerTranslationKnowledgeDirectory: knowledgeDirectory,
		providerTranslationHistoryMappings:
			tabId !== undefined && destination !== session.toolType
				? session.providerTranslationHistoryMappings
				: [...historyMappings.values()],
		providerTranslationTabInventory: translationSessionTabs({
			...session,
			providerTranslationTabInventory: [
				...deferredTabs,
				...(session.providerTranslationTabInventory ?? []),
			],
		})
			.map(translate)
			.map((tab) => ({
				id: tab.id,
				tabProvider: tab.tabProvider,
				agentSessionId: tab.agentSessionId,
				providerSessions: tab.providerSessions,
				pendingTranslation: tab.pendingTranslation,
			})),
		// Model names and API gateways belong to the source provider. A source
		// target survives only when the destination has a recipe for it.
		...(tabId === undefined && {
			gatewayUrl: undefined,
			...OFF_TOKEN_PROXY_FIELDS,
			tierTargets: undefined,
			...(agentRunOnSupport(destination).supported ? {} : { runOn: undefined }),
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
			customEnvVarsDisabled: undefined,
			customModel: undefined,
			customEffort: undefined,
			customContextWindow: undefined,
			contextWindowSource: undefined,
			enableMaestroP: undefined,
			maestroPPath: undefined,
			maestroPMode: undefined,
			codexTransport: undefined,
		}),
	};
}

export function migrationHoldsTurns(state: ProviderMigrationState | undefined): boolean {
	return Boolean(
		state &&
		['deferred', 'planned', 'staging', 'staged', 'committing', 'recovery-required'].includes(
			state.state
		)
	);
}

/** A History entry retains its original native ID; resumes resolve the active migration mapping. */
export function translatedHistorySessionId(
	session: Pick<TranslatableSession, 'providerTranslationHistoryMappings'>,
	originalSessionId: string
): string {
	const mapping = session.providerTranslationHistoryMappings?.find(
		(m: HistoryTranslationMapping) => m.tabId === `history:${originalSessionId}`
	);
	if (mapping && !mapping.destinationSessionId)
		throw new Error(
			'This History entry has no native mapping for the active provider. Its original record remains available; migration did not create a resumable counterpart.'
		);
	return mapping?.destinationSessionId ?? originalSessionId;
}

/** Resolve a History identity without importing it. Pending conversations keep their native owner. */
export function resolveHistorySession(
	session: TranslatableSession,
	originalSessionId: string,
	provider?: ToolType
): {
	provider: ToolType;
	agentSessionId: string;
	providerSessions?: TranslationTab['providerSessions'];
} {
	if (provider) {
		const tab = [...session.aiTabs, ...translationSessionTabs(session).reverse()].find(
			(candidate) =>
				(resolveTabProvider(candidate, session) === provider
					? candidate.agentSessionId
					: candidate.providerSessions?.[provider]?.agentSessionId) === originalSessionId
		);
		return {
			provider,
			agentSessionId: originalSessionId,
			providerSessions: tab
				? {
						...tab.providerSessions,
						...switchTabProvider(tab, resolveTabProvider(tab, session), provider).providerSessions,
					}
				: undefined,
		};
	}
	const mapping = session.providerTranslationHistoryMappings?.find(
		(entry) => entry.tabId === `history:${originalSessionId}`
	);
	const ids = new Set([originalSessionId, mapping?.destinationSessionId].filter(Boolean));
	// Prefer a live tab over its older inventory copy or a synthetic History alias.
	const tab = [...session.aiTabs, ...translationSessionTabs(session).reverse()].find(
		(candidate) =>
			candidate.id === `history:${originalSessionId}` ||
			ids.has(candidate.agentSessionId) ||
			Object.values(candidate.providerSessions ?? {}).some((slot) => ids.has(slot?.agentSessionId))
	);
	const liveProvider = resolveTabProvider(tab, session);
	if (tab?.pendingTranslation && tab.pendingTranslation !== liveProvider) {
		const sourceId = tab.providerSessions?.[tab.pendingTranslation]?.agentSessionId;
		if (!sourceId) throw new Error('Pending History conversation has no native source identity');
		return {
			provider: tab.pendingTranslation,
			agentSessionId: sourceId,
			providerSessions: {
				...switchTabProvider(tab, liveProvider, tab.pendingTranslation).providerSessions,
				[tab.pendingTranslation]: tab.providerSessions?.[tab.pendingTranslation],
			},
		};
	}
	// With no migration alias, a parked native ID still names its own provider.
	const parked =
		!mapping &&
		Object.entries(tab?.providerSessions ?? {}).find(
			([, slot]) => slot?.agentSessionId === originalSessionId
		);
	if (tab && parked)
		return {
			provider: parked[0] as ToolType,
			agentSessionId: originalSessionId,
			providerSessions: {
				...tab.providerSessions,
				...switchTabProvider(tab, liveProvider, parked[0] as ToolType).providerSessions,
			},
		};
	if (tab?.agentSessionId)
		return {
			provider: liveProvider,
			agentSessionId: tab.agentSessionId,
			providerSessions: tab.providerSessions,
		};
	if (tab) {
		const sources = Object.entries(tab.providerSessions ?? {}).filter(
			([, slot]) => slot?.agentSessionId
		);
		const source =
			sources.find(([, slot]) => ids.has(slot?.agentSessionId)) ??
			(sources.length === 1 ? sources[0] : undefined);
		if (source)
			return {
				provider: source[0] as ToolType,
				agentSessionId: source[1]!.agentSessionId!,
				providerSessions: tab.providerSessions,
			};
		throw new Error('This History conversation has no unambiguous native source identity');
	}
	return {
		provider: session.toolType,
		agentSessionId: translatedHistorySessionId(session, originalSessionId),
	};
}
