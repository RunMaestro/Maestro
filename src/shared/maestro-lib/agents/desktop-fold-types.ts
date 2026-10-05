/**
 * The desktop fold's wire shapes (4.5), shared by the library's applier, the main-process binding,
 * and the renderer's fold builder.
 *
 * The fold is `sessions:setMany` with rules: desktop-owned keys always land, a domain change lands only
 * at the revision the sender last applied, and an agent or tab the runtime never had is adopted. It
 * never removes an agent or a tab because a fold leaves it out.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.5.
 */

import type { ClientResult, GroupPatch } from '../client/types';
import type {
	AgentRecord,
	GroupRecord,
	GroupsDocument,
	SessionsDocument,
	TabRefRecord,
} from '../store/records';

export interface DesktopFoldAgent {
	id: string;
	/** The revision of the runtime state this client last applied. Absent: its domain parts are dropped as drift. */
	baseRev?: number;
	/** The provider this snapshot was computed under (provider epoch, DM9). */
	provider: string;
	/** Desktop-owned agent keys: view and workspace, plus turn state when this client owns the agent's stream. */
	fields: Record<string, unknown>;
	/** Desktop-owned keys per AI tab id. */
	tabs: Record<string, Record<string, unknown>>;
	/** `unifiedTabOrder` as this client holds it. Lands only at the current revision. */
	order?: TabRefRecord[];
	/** Agent domain keys that differ from the last authoritative record: a site not migrated yet. Lands only at the current revision. */
	domain?: Record<string, unknown>;
	/** Tab domain keys that differ from the last authoritative record, per tab id. Lands only at the current revision. */
	tabDomain?: Record<string, Record<string, unknown>>;
	/** AI tabs this client holds that the runtime never had: created without a command. */
	adoptTabs?: Record<string, unknown>[];
	/** AI tabs this client closed without a command. Lands only at the current revision; archived before removed. */
	closeTabs?: string[];
}

export interface DesktopFoldGroups {
	/** The groups revision this client last applied. */
	baseRev?: number;
	/** Always lands: `collapsed` is the renderer's (CO-4). */
	collapsed: Record<string, boolean>;
	/** The groups as this client holds them, for a site not migrated yet. Lands only at the current revision. */
	domain?: GroupRecord[];
	/** Groups this client removed without a command. */
	removeGroups?: string[];
}

export interface DesktopFold {
	agents: DesktopFoldAgent[];
	/** Agents created without a command. Adopted unless their id is tombstoned. */
	adoptAgents?: Record<string, unknown>[];
	/** Agents removed without a command. Always lands and tombstones the id. */
	removeAgents?: string[];
	activeSessionId?: string;
	groups?: DesktopFoldGroups;
}

export type DriftKind =
	| 'domain-dropped'
	| 'tab-domain-dropped'
	| 'close-tabs-dropped'
	| 'order-dropped'
	| 'adopted-agent'
	| 'adopted-tab'
	| 'tombstoned-agent'
	| 'tombstoned-tab'
	| 'unknown-agent'
	| 'groups-domain-dropped'
	| 'adopted-group';

/** One way a fold differed from what a fully migrated client would have sent. Logged once per site and kind. */
export interface DriftReport {
	kind: DriftKind;
	agentId?: string;
	tabId?: string;
	groupId?: string;
	keys?: string[];
}

export interface DesktopFoldResult {
	/** The revision of every agent the fold touched or the runtime holds (after the fold). */
	revs: Record<string, number>;
	groupsRev: number;
	drift: DriftReport[];
}

/** The stored state a mirror loads from: records WITH transcripts, and the revisions to guard later events with. */
export interface DesktopSnapshot {
	agents: AgentRecord[];
	groups: GroupRecord[];
	activeSessionId: string;
	revs: Record<string, number>;
	groupsRev: number;
}

/** What a desktop tab create may say (DG10). The client API's `tabs.create(agentId)` takes neither. */
export interface DesktopCreateTabOptions {
	/**
	 * A client-chosen id, so the window's optimistic tab and the runtime's are one tab. Refused when empty
	 * or unsafe as a file name. A tab the agent already shows under that id answers success and changes
	 * nothing: a fold that adopted the tab first, or a command sent twice, must not fail the second time.
	 */
	tabId?: string;
	/** Where the window put the tab in its own strip: directly after this ref, or first when `null`. */
	placeAfter?: TabRefRecord | null;
}

/** What a desktop tab close may say (DG3, DG10). */
export interface DesktopCloseTabOptions {
	/**
	 * `refuse` (the default, and what every other client gets): a tab with a turn running cannot be closed.
	 * `orphan` (DM18, what Cmd+W does on the desktop today): the tab is archived now and the process is left
	 * to finish, since stopping it is a separate act the person did not ask for.
	 */
	busy?: 'refuse' | 'orphan';
	/** A client-chosen id for the replacement tab created when no tab of any kind survives. */
	freshTabId?: string;
}

/**
 * What the desktop adds on top of the client API: the fold, the snapshot, the revisions, and the group
 * update. Present on a runtime started in mode `desktop`; the TUI and the detached host have none.
 */
export interface DesktopRuntimeApi {
	/** The stored records with transcripts, read now. Synchronous: it is the in-memory document. */
	snapshot(): DesktopSnapshot;
	/** Land a fold (4.5). Runs in the repository's queue; the write is coalesced, and `flush()` makes it durable. */
	fold(fold: DesktopFold): Promise<DesktopFoldResult>;
	/** The agent's revision, 0 for an agent the runtime has never changed. Bumped by every committed domain change. */
	revisionOf(agentId: string): number;
	groupsRevision(): number;
	/**
	 * The documents as the runtime holds them, for the main-process store facade. Read only: a caller
	 * must never mutate what it gets, and must not hold it across an await.
	 */
	documents(): { sessions: SessionsDocument; groups: GroupsDocument };
	/** DG8. A group's name, emoji, or parent, checked with `canSetGroupParent`. Write-through, like every command. */
	updateGroup(groupId: string, patch: GroupPatch): Promise<ClientResult<void>>;
	/** DG10. `tabs.create` with a client-chosen id and the window's own placement. */
	createTab(
		agentId: string,
		options?: DesktopCreateTabOptions
	): Promise<ClientResult<{ tabId: string }>>;
	/** DG3, DG10. `tabs.close` that may orphan a running turn instead of refusing. */
	closeTab(
		agentId: string,
		tabId: string,
		options?: DesktopCloseTabOptions
	): Promise<ClientResult<void>>;
	/** DG7. Move one ref of `unifiedTabOrder`, any kind, so it sits at `toIndex` of the result. */
	reorderTab(agentId: string, ref: TabRefRecord, toIndex: number): Promise<ClientResult<void>>;
	/** Resolve once every accepted command and fold is on disk. */
	flush(): Promise<void>;
}
