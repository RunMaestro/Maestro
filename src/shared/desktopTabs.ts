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
export interface DesktopTabEntry {
	tabId: string;
	sessionId: string;
	/** Maestro agent (Left Bar entity) ID this tab belongs to. */
	agentId: string;
	agentName: string;
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
}
