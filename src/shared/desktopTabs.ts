/**
 * Wire shape for one open AI tab as reported by the desktop app's
 * `list_desktop_sessions` message (`maestro-cli session list`).
 *
 * It lives in `shared/` because both ends of that message need it: the main
 * process builds the entries in `web-server-factory.ts`, and the CLI consumes
 * them in `session list`, `tab show`, and every tab verb that resolves a tab's
 * owning agent. It used to be declared three times (main wire type, CLI display
 * type, CLI resolver type), which is how the resolver ended up knowing only
 * about `tabId` and `agentId`.
 *
 * The per-tab settings below mirror the composer chips. `null` means "not set
 * on this tab", so the tab inherits the agent's value (model / effort) or the
 * global setting (enter-to-send) - it is NOT the same as `false`.
 */
import {
	projectTabProvider,
	type ProviderSwitchAgent,
	type ProviderSwitchTab,
} from './maestro-lib/agents/providerSwap';
import type { TranslationReport } from './maestro-lib/translation/types';
import { isValidAgentId } from './agentIds';
import type { RunOnTarget } from './local-models/run-on';
import type { StripTabType, TabStripVisibility } from './tabStripMembership';

/** Safe inspection fields. Never expose environment values or parked native slots. */
export interface TabProviderInspection {
	provider?: string;
	agentProvider?: string;
	tabProvider?: string | null;
	turnProvider?: string | null;
	pendingTranslation?: string | null;
	effectiveModel?: string | null;
	effectiveEffort?: string | null;
	runOn?: RunOnTarget;
}

export function inspectTabProvider(
	tab: ProviderSwitchTab,
	agent: Omit<ProviderSwitchAgent, 'toolType' | 'aiTabs'> & { toolType: string }
): TabProviderInspection {
	const projected = isValidAgentId(agent.toolType)
		? projectTabProvider({ ...agent, toolType: agent.toolType, aiTabs: undefined }, tab).agent
		: undefined;
	return {
		provider: projected?.toolType ?? tab.tabProvider ?? agent.toolType,
		agentProvider: agent.toolType,
		tabProvider: tab.tabProvider ?? null,
		turnProvider: tab.turnProvider ?? null,
		pendingTranslation: tab.pendingTranslation ?? null,
		effectiveModel: tab.customModel ?? projected?.customModel ?? null,
		effectiveEffort: tab.customEffort ?? projected?.customEffort ?? null,
		runOn: projected?.runOn ?? { type: 'provider' },
	};
}

export type TabConfigResult = TranslationReport & { tab?: TabProviderInspection };

export interface DesktopTabEntry extends TabProviderInspection {
	tabId: string;
	sessionId: string;
	/** Maestro agent (Left Bar entity) ID this tab belongs to. */
	agentId: string;
	agentName: string;
	/** Legacy agent default. `provider` is this tab's effective harness. */
	toolType: string;
	/** User-defined tab name; null when the user hasn't named the tab. */
	name: string | null;
	/** Provider session id (e.g. Claude `session_id`) bound to this tab. */
	agentSessionId: string | null;
	state: 'idle' | 'busy' | 'unknown';
	createdAt: number;
	starred: boolean;
	/** True for the tab its agent currently has selected (the `active` keyword). */
	active: boolean;
	/** Unread marker in the tab bar. */
	hasUnread: boolean;
	/**
	 * True when the tab bar draws no chip for this tab (`isAiTabHidden`): a
	 * consult tab, or any tab marked hidden. `session list` drops these unless
	 * `--include-hidden` is passed; tab verbs still resolve them by ID.
	 */
	hidden: boolean;
	/**
	 * True when the agent's `unifiedTabOrder` holds an `ai` ref for this tab.
	 * Raw data, not a visibility verdict: a tab tiled into a group has no ref of
	 * its own but is still on screen inside the group chip.
	 */
	inTabOrder: boolean;
	/**
	 * Where the tab stands relative to the strip (`tabStripVisibility`):
	 * `visible` draws a chip (standalone or inside a tiled group), `hidden` is
	 * held out on purpose, `orphaned` has no slot at all (a close that did not
	 * apply, #2008). Optional: absent means an older desktop.
	 */
	visibility?: TabStripVisibility;
	/** Synopsize this tab's completions into History after each completion. */
	saveToHistory: boolean;
	/** Read-only / plan mode: the agent may not modify files. */
	readOnly: boolean;
	/** Thinking display: 'off' | 'on' (temporary) | 'sticky' (pinned). */
	thinking: 'off' | 'on' | 'sticky';
	/** Per-tab model override, or null to inherit the agent's model. */
	model: string | null;
	/** Per-tab effort/reasoning override, or null to inherit the agent's effort. */
	effort: string | null;
	/** Per-tab send-key override, or null to inherit the `enterToSendAI` setting. */
	enterToSend: boolean | null;
	/** Metadata for consumers that need to resolve project ownership and a baseline.
	 * Optional so clients can detect an older desktop and fail closed. */
	supervision?: {
		cwd: string;
		parentSessionId: string | null;
		groupId?: string | null;
		/** Parent chain from the same snapshot, including parents without open tabs. */
		ancestors: Array<{
			id: string;
			cwd: string;
			parentSessionId: string | null;
			groupId?: string | null;
			isPianola: boolean;
			remote: boolean;
		}>;
		/** False for a missing, cyclic, or excessively deep parent chain. */
		lineageComplete: boolean;
		isPianola: boolean;
		remote: boolean;
		/** One pause signal only; other forms of parked work need separate checks. */
		errorPaused: boolean;
		/** Scope-only safety state. Absent on desktops predating scoped watches. */
		paused?: boolean;
		/** Live process/CLI evidence, independent of the persisted display state. */
		busy?: boolean;
		nativeQuestion?: import('./currentTurn').NativeQuestionRequest;
		consult: boolean;
		ephemeral: boolean;
		/** False when the persisted tab has no available transcript snapshot. */
		currentTurn?: Omit<import('./currentTurn').CurrentTurnRead, 'messages'>;
		cursorAvailable: boolean;
		cursor: { id: string; count: number; textLength: number } | null;
	};
}

/** Complete local owner census, including owners with no open AI tabs. */
export interface DesktopAgentEntry {
	id: string;
	cwd: string;
	parentSessionId: string | null;
	groupId?: string | null;
	isPianola: boolean;
	remote: boolean;
}

/** Versioned supervision contract; legacy tab-list callers still consume sessions. */
export interface DesktopSessionsSnapshot {
	supervisionVersion: 1;
	complete: boolean;
	capturedAt: number;
	owners: DesktopAgentEntry[];
	sessions: DesktopTabEntry[];
	/** File, browser, and terminal tabs (`session list --type`). Absent from a desktop that predates it. */
	tabs?: DesktopStripTabEntry[];
}

/**
 * One open file, browser, or terminal tab, for `session list --type`. Kept apart
 * from `DesktopTabEntry` (which `sessions` carries): those entries are AI
 * conversations, and pollers that read `sessions` must never meet a terminal.
 */
export interface DesktopStripTabEntry {
	tabId: string;
	tabType: Exclude<StripTabType, 'ai'>;
	agentId: string;
	agentName: string;
	/** Display name: the file name, the page title, or the terminal's name. */
	name: string | null;
	/** What the tab shows: the file path, the page URL, or the shell's directory. */
	target: string | null;
	/** True for the tab its agent has selected in that kind. */
	active: boolean;
	visibility: TabStripVisibility;
}
