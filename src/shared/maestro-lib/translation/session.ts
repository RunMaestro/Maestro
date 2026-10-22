import type { ToolType } from '../../types';
import type {
	ProviderMigrationState,
	TranslationTabMapping,
	HistoryTranslationMapping,
} from './types';

export interface TranslationTab {
	id: string;
	agentSessionId: string | null;
	usageStats?: unknown;
	customModel?: string;
	customEffort?: string;
	awaitingSessionId?: boolean;
	providerSessions?: Partial<
		Record<
			ToolType,
			{
				agentSessionId: string | null;
				usageStats?: any;
				customModel?: string;
				customEffort?: string;
			}
		>
	>;
}

/** Shared parking invariant: live ID belongs to the active provider; its slot is removed. */
export function switchTabProvider<T extends Omit<TranslationTab, 'id'>>(
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
	};
	const restored = parked[toProvider];
	delete parked[toProvider];
	return {
		...tab,
		agentSessionId: restored?.agentSessionId ?? null,
		usageStats: restored?.usageStats,
		customModel: restored?.customModel,
		customEffort: restored?.customEffort,
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

export function translationSessionTabs(session: TranslatableSession): TranslationTab[] {
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

	return [...new Map(tabs.filter(Boolean).map((t) => [t.id, t])).values()];
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

export function commitTranslationSession<T extends TranslatableSession>(
	session: T,
	destination: ToolType,
	operationId: string,
	mappings: TranslationTabMapping[],
	knowledgeDirectory?: string,
	sourceProvider: ToolType = session.toolType
): T {
	const map = new Map(mappings.map((m) => [m.tabId, m]));
	const translate = (tab: TranslationTab): TranslationTab => {
		const mapping = map.get(tab.id);
		if (!mapping) throw new Error(`Missing native translation mapping for tab ${tab.id}`);
		if (
			session.toolType === destination &&
			tab.agentSessionId === mapping.destinationSessionId &&
			tab.providerSessions?.[sourceProvider]?.agentSessionId === mapping.sourceSessionId
		)
			return tab;
		if (tab.agentSessionId !== mapping.sourceSessionId)
			throw new Error(`Native source identity changed before translation commit for tab ${tab.id}`);
		const switched = switchTabProvider(tab, sourceProvider, destination);
		return { ...switched, agentSessionId: mapping.destinationSessionId };
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
		...session,
		toolType: destination,
		providerTranslationQueuedOrigins: Object.fromEntries(
			(session.executionQueue ?? []).map((item: { id: string }) => [
				item.id,
				session.providerTranslationQueuedOrigins?.[item.id] ?? sourceProvider,
			])
		),
		...mapAgentAiTabs(session, translate),
		providerMigration: { operationId, destination, state: 'committed', verification: 'unverified' },
		providerTranslationKnowledgeDirectory: knowledgeDirectory,
		providerTranslationHistoryMappings: [...historyMappings.values()],
		providerTranslationTabInventory: translationSessionTabs(session)
			.map(translate)
			.map((tab) => ({
				id: tab.id,
				agentSessionId: tab.agentSessionId,
				providerSessions: tab.providerSessions,
			})),
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
