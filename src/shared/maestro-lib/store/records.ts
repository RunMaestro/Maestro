/**
 * The persisted shapes of Maestro's store files, as a library client sees them.
 *
 * These are the ON-DISK records, not the renderer's in-memory types. The
 * renderer's `Session`, `AITab`, and `Group` (`src/renderer/types/index.ts`,
 * `src/shared/types.ts`) describe what the desktop holds after hydration; a
 * file on disk may predate a field, come from a newer build (rc carries fields
 * main does not), or come from another machine through a sync folder. So:
 *
 *   - only the fields a client actually reads are named, and only the ones the
 *     readers validate are required;
 *   - every record keeps EVERY other key through an index signature, and the
 *     readers never copy, normalize, or strip a record. A client that later
 *     writes a record back must write the object it read, so a field it has
 *     never heard of survives the round trip (requirement DD-5);
 *   - provider ids stay `string`, not `ToolType`: a provider this build does
 *     not know is still the user's agent, and must still be listed.
 */

/** Keys a record carries that this build does not name. Kept, never dropped. */
export interface UnknownFields {
	[key: string]: unknown;
}

/** An agent's lifecycle state, as the desktop color-codes it. */
export type AgentRecordState = 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error';

/** One entry of an agent's unified tab order: which strip a tab lives in, and its id. */
export interface TabRefRecord extends UnknownFields {
	type: string;
	id: string;
}

/** One AI tab, mirroring the persisted fields of the renderer's `AITab`. */
export interface AITabRecord extends UnknownFields {
	id: string;
	/** Provider session id; null for a tab that has not sent a turn yet. */
	agentSessionId?: string | null;
	/** User-assigned name; null or absent means "show the session id octet". */
	name?: string | null;
	starred?: boolean;
	/** The tab's transcript. Entry shape is defined by the transcript accessor. */
	logs?: unknown[];
	createdAt?: number;
	state?: 'idle' | 'busy';
	hasUnread?: boolean;
	/** A consult tab not drawn in the tab strip (see `isAiTabHidden`). */
	hidden?: boolean;
	customModel?: string;
	customEffort?: string;
}

/** One agent, mirroring the persisted fields of the renderer's `Session`. */
export interface AgentRecord extends UnknownFields {
	id: string;
	name: string;
	/** Provider id (`claude-code`, `codex`, ...). Kept as a string on purpose. */
	toolType: string;
	groupId?: string;
	state?: AgentRecordState;
	cwd?: string;
	projectRoot?: string;
	createdAt?: number;
	bookmarked?: boolean;
	/** Set on a worktree agent: the agent it was created from. */
	parentSessionId?: string;
	worktreeBranch?: string;
	aiTabs?: AITabRecord[];
	activeTabId?: string;
	unifiedTabOrder?: TabRefRecord[];
	customModel?: string;
	customEffort?: string;
}

/** One Left Bar group, mirroring `Group` in `src/shared/types.ts`. */
export interface GroupRecord extends UnknownFields {
	id: string;
	name: string;
	emoji?: string;
	kind?: 'user' | 'worktree';
	parentGroupId?: string;
	collapsed?: boolean;
}

/** `maestro-sessions.json`. */
export interface SessionsDocument extends UnknownFields {
	sessions?: unknown[];
	activeSessionId?: string;
}

/** `maestro-groups.json`. */
export interface GroupsDocument extends UnknownFields {
	groups?: unknown[];
}

/** `maestro-settings.json`: a flat key-value store with hundreds of keys. */
export type SettingsDocument = UnknownFields;

/** `maestro-agent-configs.json`: provider id to that provider's config. */
export interface AgentConfigsDocument extends UnknownFields {
	configs?: Record<string, UnknownFields>;
}
