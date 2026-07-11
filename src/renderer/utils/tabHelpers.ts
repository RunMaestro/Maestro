// Tab helper functions for AI multi-tab support
// These helpers manage AITab state within Maestro sessions

import {
	Session,
	AITab,
	ClosedTab,
	ClosedTabEntry,
	BrowserTab,
	FilePreviewTab,
	UnifiedTab,
	UnifiedTabRef,
	PanelLayoutNode,
	TabGroup,
	LogEntry,
	UsageStats,
	ToolType,
	ThinkingMode,
	QueuedItem,
} from '../types';
import { generateId } from './ids';
import { getAutoRunFolderPath } from './existingDocsDetector';
import { createTerminalTab, nextTerminalCoworkingId } from './terminalTabHelpers';
import {
	findActiveUnifiedTabIndex,
	insertAfterActiveInUnifiedTabOrder,
} from './unifiedTabOrderUtils';
import { useSettingsStore } from '../stores/settingsStore';
import { isWindowsPlatform } from './platformUtils';
import { DEFAULT_BROWSER_TAB_URL, getBrowserTabTitle } from './browserTabPersistence';
import { getLiveDraft } from './liveDraftStore';

/**
 * Whether an AI tab is hidden from the tab strip and from tab-cycling shortcuts.
 * Currently only unopened cross-agent consult tabs (see `AITab.hidden`).
 *
 * The single predicate behind both visibility surfaces: `buildUnifiedTabs` (what
 * renders) and `getNavigableTabs` (what Cmd+1..9 / cycling reaches). They must
 * agree, or a shortcut lands on a tab the strip never showed.
 */
export function isAiTabHidden(tab: AITab): boolean {
	return tab.hidden === true;
}

/**
 * Reveal a hidden AI tab, permanently. Called when the user deliberately opens a
 * consult tab (via the attribution header's deep link). Returns the session
 * unchanged when the tab is absent or already visible, so callers can apply it
 * unconditionally without churning state.
 */
export function revealAiTab(session: Session, tabId: string): Session {
	const tab = session.aiTabs?.find((t) => t.id === tabId);
	if (!tab || !isAiTabHidden(tab)) return session;
	return {
		...session,
		aiTabs: session.aiTabs.map((t) => (t.id === tabId ? { ...t, hidden: false } : t)),
	};
}

/**
 * Build the unified tab list from a session's tab data.
 * Follows unifiedTabOrder, then appends any orphaned tabs as a safety net
 * (e.g., from migration or state corruption).
 *
 * Single source of truth — used by useTabHandlers and tabStore selectors.
 */
export function buildUnifiedTabs(session: Session): UnifiedTab[] {
	if (!session) return [];
	const { aiTabs, filePreviewTabs, browserTabs, terminalTabs, unifiedTabOrder } = session;

	// Hidden AI tabs are excluded up front, so neither the ordered walk below nor
	// the orphan fallback can re-surface them (the fallback would: a hidden tab
	// keeps its unifiedTabOrder ref, but dropping the ref instead would lose its
	// position on reveal).
	const aiTabMap = new Map(
		(aiTabs || []).filter((tab) => !isAiTabHidden(tab)).map((tab) => [tab.id, tab])
	);
	const fileTabMap = new Map((filePreviewTabs || []).map((tab) => [tab.id, tab]));
	const browserTabMap = new Map((browserTabs || []).map((tab) => [tab.id, tab]));
	const terminalTabMap = new Map((terminalTabs || []).map((tab) => [tab.id, tab]));
	// Groups are the 5th unified tab type: a tiled group appears as a single chip
	// referenced by a `group` ref in the order. Resolve those refs to their TabGroup.
	const groupMap = new Map((session.tabGroups || []).map((g) => [g.id, g]));

	const result: UnifiedTab[] = [];

	// Follow unified order for tabs that have entries
	for (const ref of unifiedTabOrder || []) {
		if (ref.type === 'ai') {
			const tab = aiTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'ai', id: ref.id, data: tab });
				aiTabMap.delete(ref.id);
			}
		} else if (ref.type === 'file') {
			const tab = fileTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'file', id: ref.id, data: tab });
				fileTabMap.delete(ref.id);
			}
		} else if (ref.type === 'browser') {
			const tab = browserTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'browser', id: ref.id, data: tab });
				browserTabMap.delete(ref.id);
			}
		} else if (ref.type === 'group') {
			const group = groupMap.get(ref.id);
			if (group) {
				result.push({ type: 'group', id: ref.id, data: group });
				groupMap.delete(ref.id);
			}
		} else {
			const tab = terminalTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'terminal', id: ref.id, data: tab });
				terminalTabMap.delete(ref.id);
			}
		}
	}

	// Append any orphaned tabs not in unified order (data integrity fallback)
	for (const [id, tab] of aiTabMap) {
		result.push({ type: 'ai', id, data: tab });
	}
	for (const [id, tab] of fileTabMap) {
		result.push({ type: 'file', id, data: tab });
	}
	for (const [id, tab] of browserTabMap) {
		result.push({ type: 'browser', id, data: tab });
	}
	for (const [id, tab] of terminalTabMap) {
		result.push({ type: 'terminal', id, data: tab });
	}
	// Any group not represented by a ref in the order (e.g. created by a path that
	// didn't thread the ref, or a not-yet-normalized session): append so the group
	// chip is never lost from the strip. normalizeTabGroups backfills the ref on load.
	for (const [id, group] of groupMap) {
		result.push({ type: 'group', id, data: group });
	}

	// Hide tabs that are tiled into a group: the group's chip stands in for them in
	// the strip, so a tiled tab must not also appear as its own chip. Tiling removes
	// the ref from unifiedTabOrder, but the tab still lives in aiTabs/filePreviewTabs/
	// etc., so the orphan fallback above would otherwise re-surface it. One filter at
	// the end covers both entry paths. No groups -> no allocation, no filtering.
	const memberKeys = collectGroupMemberTabKeys(session);
	if (memberKeys.size === 0) return result;
	return result.filter((t) => !memberKeys.has(`${t.type}:${t.id}`));
}

/**
 * Collect the `type:id` keys of every tab that is a leaf in one of the session's
 * tiled groups. Walks each group's layout tree directly (kept local to avoid a
 * circular import with panelLayout, which imports from this module). Used by
 * buildUnifiedTabs to keep tiled tabs out of the standalone strip.
 */
function collectGroupMemberTabKeys(session: Session): Set<string> {
	const keys = new Set<string>();
	const groups = session.tabGroups;
	if (!groups || groups.length === 0) return keys;
	const walk = (node: PanelLayoutNode): void => {
		if (node.kind === 'leaf') {
			keys.add(`${node.tab.type}:${node.tab.id}`);
			return;
		}
		node.children.forEach(walk);
	};
	for (const group of groups) walk(group.layout);
	return keys;
}

/**
 * Resolve a group's focused pane to its AI tab id, or null when the focused pane
 * is non-AI (file/terminal/browser) or absent. Walks the layout locally to avoid a
 * circular import with panelLayout (which imports from this module). Used when
 * navigating to a group so the shared input area targets the focused pane's tab.
 */
function resolveFocusedAiTabId(group: TabGroup): string | null {
	if (!group.focusedPaneId) return null;
	let found: string | null = null;
	const walk = (node: PanelLayoutNode): void => {
		if (found) return;
		if (node.kind === 'leaf') {
			if (node.id === group.focusedPaneId && node.tab.type === 'ai') found = node.tab.id;
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	return found;
}

/**
 * Locate the tiled group and leaf-pane id that hold a given AI tab, or null when
 * the tab isn't tiled into any group (i.e. it's a standalone tab). Walks each
 * group's layout locally to avoid a circular import with panelLayout (which
 * imports from this module). Used by setActiveTab so selecting a group-member AI
 * tab (e.g. from the Tab Switcher) activates its group and focuses its pane
 * instead of trying to render it standalone - group members have no standalone
 * chip and are excluded from buildUnifiedTabs, so the standalone path leaves
 * focus stuck on whatever was already showing.
 */
function findGroupPaneForAiTab(
	session: Session,
	tabId: string
): { groupId: string; leafId: string } | null {
	const groups = session.tabGroups;
	if (!groups || groups.length === 0) return null;
	for (const group of groups) {
		let leafId: string | null = null;
		const walk = (node: PanelLayoutNode): void => {
			if (leafId) return;
			if (node.kind === 'leaf') {
				if (node.tab.type === 'ai' && node.tab.id === tabId) leafId = node.id;
				return;
			}
			node.children.forEach(walk);
		};
		walk(group.layout);
		if (leafId) return { groupId: group.id, leafId };
	}
	return null;
}

/**
 * Ensure a tab ID is present in unifiedTabOrder.
 * Returns the order unchanged if already present, or with the tab appended.
 */
export function ensureInUnifiedTabOrder(
	unifiedTabOrder: UnifiedTabRef[],
	type: 'ai' | 'file' | 'browser' | 'terminal',
	id: string
): UnifiedTabRef[] {
	const exists = unifiedTabOrder.some((ref) => ref.type === type && ref.id === id);
	if (exists) return unifiedTabOrder;
	return [...unifiedTabOrder, { type, id }];
}

/**
 * Get a repaired unifiedTabOrder that includes any orphaned tabs.
 * Follows the existing unifiedTabOrder, then appends tabs that exist in
 * aiTabs/filePreviewTabs but are missing from the order.
 *
 * This keeps navigation in sync with rendering (which uses buildUnifiedTabs).
 * Returns the original array unchanged if no orphans are found (no allocation).
 */
export function getRepairedUnifiedTabOrder(session: Session): UnifiedTabRef[] {
	const order = session.unifiedTabOrder || [];
	const aiTabs = session.aiTabs || [];
	const fileTabs = session.filePreviewTabs || [];
	const browserTabs = session.browserTabs || [];
	const terminalTabs = session.terminalTabs || [];

	// Build sets of IDs that actually exist (for pruning stale entries)
	const liveAiIds = new Set(aiTabs.map((t) => t.id));
	const liveFileIds = new Set(fileTabs.map((t) => t.id));
	const liveBrowserIds = new Set(browserTabs.map((t) => t.id));
	const liveTerminalIds = new Set(terminalTabs.map((t) => t.id));
	// Groups are the 5th unified type: a `group` ref is live while its TabGroup
	// exists. Tabs tiled INTO a group are represented by the group ref, so they must
	// NOT be re-appended as orphans below (that would double them in the strip and
	// desync navigation from what buildUnifiedTabs renders).
	const liveGroupIds = new Set((session.tabGroups || []).map((g) => g.id));
	const groupMemberKeys = collectGroupMemberTabKeys(session);

	// Prune stale entries and duplicates — refs whose tabs no longer exist, and
	// later duplicate refs for the same type+id (buildUnifiedTabs also skips both).
	// Without this, navigation indices diverge from the rendered tab bar.
	const seen = new Set<string>();
	const prunedOrder = order.filter((ref) => {
		const key = `${ref.type}:${ref.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		if (ref.type === 'ai') return liveAiIds.has(ref.id);
		if (ref.type === 'file') return liveFileIds.has(ref.id);
		if (ref.type === 'browser') return liveBrowserIds.has(ref.id);
		if (ref.type === 'group') return liveGroupIds.has(ref.id);
		return liveTerminalIds.has(ref.id);
	});

	// Track which live IDs are already in the pruned order
	const aiIdsInOrder = new Set<string>();
	const fileIdsInOrder = new Set<string>();
	const browserIdsInOrder = new Set<string>();
	const terminalIdsInOrder = new Set<string>();
	for (const ref of prunedOrder) {
		if (ref.type === 'ai') aiIdsInOrder.add(ref.id);
		else if (ref.type === 'file') fileIdsInOrder.add(ref.id);
		else if (ref.type === 'browser') browserIdsInOrder.add(ref.id);
		else terminalIdsInOrder.add(ref.id);
	}

	// Collect orphaned tabs (exist in data but missing from order). Tabs tiled into a
	// group are intentionally absent from the order (the group ref stands in), so skip
	// them here - re-adding them would resurrect a duplicate standalone chip.
	const orphanedRefs: UnifiedTabRef[] = [];
	for (const tab of aiTabs) {
		if (!aiIdsInOrder.has(tab.id) && !groupMemberKeys.has(`ai:${tab.id}`)) {
			orphanedRefs.push({ type: 'ai', id: tab.id });
		}
	}
	for (const tab of fileTabs) {
		if (!fileIdsInOrder.has(tab.id) && !groupMemberKeys.has(`file:${tab.id}`)) {
			orphanedRefs.push({ type: 'file', id: tab.id });
		}
	}
	for (const tab of browserTabs) {
		if (!browserIdsInOrder.has(tab.id) && !groupMemberKeys.has(`browser:${tab.id}`)) {
			orphanedRefs.push({ type: 'browser', id: tab.id });
		}
	}
	for (const tab of terminalTabs) {
		if (!terminalIdsInOrder.has(tab.id) && !groupMemberKeys.has(`terminal:${tab.id}`)) {
			orphanedRefs.push({ type: 'terminal', id: tab.id });
		}
	}

	// Return original if nothing changed (avoids allocation)
	if (prunedOrder.length === order.length && orphanedRefs.length === 0) return order;
	if (orphanedRefs.length === 0) return prunedOrder;
	return [...prunedOrder, ...orphanedRefs];
}

/**
 * Move the currently active tab to the first or last position in the unified tab
 * order. Works across ALL tab kinds (AI, file, browser, terminal) since it operates
 * on unifiedTabOrder, the single source of truth for visual tab position.
 *
 * Uses the repaired order so the move aligns with what TabBar renders and stale /
 * duplicate refs are pruned as a side effect. The active tab stays active - only its
 * position changes, so no active-tab-id fields are touched.
 *
 * Returns the original session unchanged (no allocation) when there are fewer than
 * two tabs, no active tab is present in the order, or the active tab already sits at
 * the target edge.
 *
 * @param session - The Maestro session
 * @param edge - 'start' moves the active tab to the first slot, 'end' to the last
 * @returns New session with the reordered unifiedTabOrder, or the original if it's a no-op
 */
export function moveActiveUnifiedTabToEdge(session: Session, edge: 'start' | 'end'): Session {
	const order = getRepairedUnifiedTabOrder(session);
	if (order.length < 2) return session;

	const activeIndex = findActiveUnifiedTabIndex(session, order);
	if (activeIndex === -1) return session;

	const targetIndex = edge === 'start' ? 0 : order.length - 1;
	if (activeIndex === targetIndex) return session;

	const newOrder = [...order];
	const [moved] = newOrder.splice(activeIndex, 1);
	if (edge === 'start') {
		newOrder.unshift(moved);
	} else {
		newOrder.push(moved);
	}

	return { ...session, unifiedTabOrder: newOrder };
}

/**
 * Get the initial name to show in the rename modal.
 * Returns empty string if no custom name is set (name is null),
 * or the custom name if user has set one.
 *
 * @param tab - The AI tab being renamed
 * @returns The name to pre-fill in the rename input (empty for auto-generated names)
 */
/**
 * Get the display name for a tab. Strictly per-tab — the title only reflects
 * THIS tab's own state, never another tab's id from the session level.
 *
 * Resolution order:
 *   1. `tab.name` if set (auto-rename or manual rename)
 *   2. `tab.agentSessionId` formatted (e.g. `SES_4BCD`, `THR_ABC1`, first UUID octet)
 *   3. "New Session"
 *
 * The `sessionAgentSessionId` parameter is accepted for signature compatibility
 * but intentionally ignored: borrowing it caused freshly-created sibling tabs
 * to inherit the previously-active tab's id (e.g. multiple OpenCode tabs all
 * displaying the same `SES_XXXX`).
 */
export function getTabDisplayName(tab: AITab, _sessionAgentSessionId?: string | null): string {
	if (tab.name) {
		return tab.name;
	}
	if (tab.agentSessionId) {
		return formatSessionId(tab.agentSessionId);
	}
	return 'New Session';
}

/**
 * Format a session/tab ID into a short display label.
 */
function formatSessionId(id: string): string {
	// OpenCode format: ses_XXXX... or SES_XXXX...
	if (id.toLowerCase().startsWith('ses_')) {
		return `SES_${id.slice(4, 8).toUpperCase()}`;
	}
	// Codex format: thread_XXXX...
	if (id.toLowerCase().startsWith('thread_')) {
		return `THR_${id.slice(7, 11).toUpperCase()}`;
	}
	// UUID format: has dashes, return first octet
	if (id.includes('-')) {
		return id.split('-')[0].toUpperCase();
	}
	// Generic fallback: first 8 chars uppercase
	return id.slice(0, 8).toUpperCase();
}

export function getInitialRenameValue(tab: AITab): string {
	return tab.name || '';
}

/**
 * Attempt to extract a tab name from the user's message using fast client-side
 * pattern matching. This avoids spawning an expensive ephemeral agent for messages
 * that clearly reference a GitHub PR, issue, or similar identifiable resource.
 *
 * @param message - The user's input message
 * @returns A short tab name if a pattern matched, or null to fall back to agent naming
 */
export function extractQuickTabName(message: string): string | null {
	// GitHub PR URL: https://github.com/org/repo/pull/123
	const ghPrUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
	if (ghPrUrl) {
		return `PR #${ghPrUrl[2]}`;
	}

	// GitHub issue URL: https://github.com/org/repo/issues/123
	const ghIssueUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/);
	if (ghIssueUrl) {
		return `Issue #${ghIssueUrl[2]}`;
	}

	// GitHub discussion URL: https://github.com/org/repo/discussions/123
	const ghDiscussionUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/discussions\/(\d+)/);
	if (ghDiscussionUrl) {
		return `Discussion #${ghDiscussionUrl[2]}`;
	}

	// Jira-style ticket: PROJ-1234
	const jiraTicket = message.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
	if (jiraTicket) {
		return jiraTicket[1];
	}

	// Linear-style ticket: PROJ-123 (shorter numbers)
	// Already covered by the Jira pattern above

	// Inline "PR #123" or "pull request #123" (not in a URL)
	const prRef = message.match(/\b(?:PR|pull request)\s*#(\d+)\b/i);
	if (prRef) {
		return `PR #${prRef[1]}`;
	}

	// Inline "issue #123"
	const issueRef = message.match(/\bissue\s*#(\d+)\b/i);
	if (issueRef) {
		return `Issue #${issueRef[1]}`;
	}

	return null;
}

// Maximum number of closed tabs to keep in history
const MAX_CLOSED_TAB_HISTORY = 25;

/**
 * Check if a tab has draft content (unsent input or staged images).
 * Used for determining if a tab should be shown in "unread only" filter mode.
 *
 * Prefers the live textarea value from liveDraftStore (which the active tab
 * keeps current on every keystroke) over `tab.inputValue` (only synced on
 * blur/submit). This keeps the draft indicator and close confirmation in
 * sync with what's actually on screen.
 *
 * @param tab - The AI tab to check
 * @returns True if the tab has unsent text input or staged images
 */
export function hasDraft(tab: AITab): boolean {
	const liveValue = getLiveDraft(tab.id);
	const text = liveValue !== undefined ? liveValue : (tab.inputValue ?? '');
	return text.trim() !== '' || (tab.stagedImages && tab.stagedImages.length > 0);
}

/**
 * Check if a tab has an active (unfinished) wizard session.
 * Used to determine if closing the tab should show a confirmation modal.
 *
 * @param tab - The AI tab to check
 * @returns True if the tab has an active wizard that hasn't completed
 */
export function hasActiveWizard(tab: AITab): boolean {
	return tab.wizardState?.isActive === true;
}

/**
 * Check if a tab's active wizard has any user interaction.
 * Returns true if the user has sent messages, typed input, or staged images.
 * Used to decide whether closing the wizard should show a confirmation dialog.
 *
 * @param tab - The AI tab to check
 * @returns True if the wizard has user interaction worth confirming loss of
 */
export function hasWizardInteraction(tab: AITab): boolean {
	if (!tab.wizardState?.isActive) return false;
	const hasUserMessages =
		tab.wizardState.conversationHistory?.some((m) => m.role === 'user') ?? false;
	const hasInput = (tab.inputValue ?? '').trim() !== '';
	const hasImages = tab.stagedImages?.length > 0;
	return hasUserMessages || hasInput || hasImages;
}

/**
 * Filter a unified tab order down to the refs that TabBar actually displays when the
 * "unread only" tab filter is active. Matches TabBar.tsx's displayedUnifiedTabs logic so
 * keyboard jump shortcuts (Cmd+1..9, Cmd+0) stay aligned with the rendered tab strip.
 *
 * AI tabs pass if they're unread, busy, the active AI tab (in AI mode), have a draft, or
 * are starred (when that setting is on). File tabs pass when the file-preview setting is
 * enabled OR when they're the currently active file tab (the active tab is never hidden).
 * Terminal and browser tabs always pass (no unread semantics to filter on).
 *
 * @param session - The Maestro session supplying activeTabId / inputMode / aiTabs
 * @param order   - Unified tab order to filter (typically getRepairedUnifiedTabOrder(session))
 * @returns Filtered UnifiedTabRef[] in the same relative order
 */
export function filterUnifiedTabOrderForUnread(
	session: Session,
	order: UnifiedTabRef[]
): UnifiedTabRef[] {
	const settings = useSettingsStore.getState();
	const showStarred = settings.showStarredInUnreadFilter;
	const showFilePreviews = settings.showFilePreviewsInUnreadFilter;
	const inputMode = session.inputMode ?? 'ai';
	const activeTabId = session.activeTabId ?? null;
	const activeFileTabId = session.activeFileTabId ?? null;

	return order.filter((ref) => {
		if (ref.type === 'ai') {
			const tab = session.aiTabs.find((t) => t.id === ref.id);
			if (!tab) return false;
			return aiTabPassesUnreadFilter(tab, inputMode, activeTabId, showStarred);
		}
		// Active file tab is always visible so the user never loses sight of what
		// they're looking at, even when the file-preview filter is off.
		if (ref.type === 'file') return showFilePreviews || ref.id === activeFileTabId;
		// A group is shown iff ANY of its member tabs passes the unread filter (the
		// group chip stands in for its collapsed members, so it inherits their unread
		// state). Otherwise the whole group hides, like any other filtered-out tab.
		if (ref.type === 'group') {
			const group = session.tabGroups?.find((g) => g.id === ref.id);
			return group ? groupHasUnreadTabs(session, group) : false;
		}
		return true;
	});
}

/**
 * Shared predicate: does this AI tab pass the "unread" filter? An AI tab is kept
 * when it has unread messages, is busy (thinking), is the active tab in AI mode,
 * holds an unsent draft, or (when the setting is on) is starred. Centralized so the
 * TabBar display filter, navigation filter, and group-unread rollup can never drift.
 */
export function aiTabPassesUnreadFilter(
	tab: AITab,
	inputMode: 'ai' | 'terminal' | undefined,
	activeTabId: string | null,
	showStarred: boolean
): boolean {
	return (
		tab.hasUnread ||
		tab.state === 'busy' ||
		(inputMode === 'ai' && tab.id === activeTabId) ||
		hasDraft(tab) ||
		(showStarred && !!tab.starred)
	);
}

/**
 * True when any AI tab tiled into `group` passes the unread filter. Walks the
 * group's layout leaves and applies {@link aiTabPassesUnreadFilter} to each AI
 * member (non-AI panes have no unread state and never keep the group visible). Used
 * to decide whether the group chip survives the unread filter - the chip inherits
 * the unread state of the members it collapsed.
 */
export function groupHasUnreadTabs(session: Session, group: TabGroup): boolean {
	const settings = useSettingsStore.getState();
	const showStarred = settings.showStarredInUnreadFilter;
	const inputMode = session.inputMode ?? 'ai';
	const activeTabId = session.activeTabId ?? null;
	for (const ref of collectGroupLeafRefs(group)) {
		if (ref.type !== 'ai') continue;
		const tab = session.aiTabs.find((t) => t.id === ref.id);
		if (tab && aiTabPassesUnreadFilter(tab, inputMode, activeTabId, showStarred)) return true;
	}
	return false;
}

/**
 * Build the set of group ids that survive the unread filter (any member is unread).
 * Precomputed once per render where the full session is in scope, then handed to the
 * TabBar so its display filter can gate group chips without re-walking every layout.
 */
export function computeUnreadGroupIds(session: Session): Set<string> {
	const ids = new Set<string>();
	for (const group of session.tabGroups ?? []) {
		if (groupHasUnreadTabs(session, group)) ids.add(group.id);
	}
	return ids;
}

/** Collect a group's layout leaf refs (local walk; avoids a panelLayout import cycle). */
function collectGroupLeafRefs(group: TabGroup): UnifiedTabRef[] {
	const out: UnifiedTabRef[] = [];
	const walk = (node: PanelLayoutNode): void => {
		if (node.kind === 'leaf') {
			out.push(node.tab);
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	return out;
}

/**
 * Get the list of navigable tabs based on filter settings.
 * When showUnreadOnly is true, only returns unread tabs and tabs with unsent drafts/staged images.
 * When false (default), returns all tabs.
 *
 * This helper consolidates the tab filtering logic used by navigation functions.
 *
 * @param session - The Maestro session containing tabs
 * @param showUnreadOnly - If true, filter to only unread tabs and tabs with drafts
 * @returns Array of navigable AITabs (may be empty if session has no tabs or filter excludes all)
 *
 * @example
 * // Get all tabs
 * const tabs = getNavigableTabs(session);
 *
 * @example
 * // Get only unread tabs and tabs with draft content
 * const unreadTabs = getNavigableTabs(session, true);
 */
export function getNavigableTabs(session: Session, showUnreadOnly = false): AITab[] {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return [];
	}

	// Hidden tabs aren't in the strip, so no shortcut may land on one. The common
	// case is no hidden tabs at all: keep returning `session.aiTabs` by reference
	// then, since callers memoize on its identity.
	const visible = session.aiTabs.some(isAiTabHidden)
		? session.aiTabs.filter((tab) => !isAiTabHidden(tab))
		: session.aiTabs;

	if (showUnreadOnly) {
		const showStarred = useSettingsStore.getState().showStarredInUnreadFilter;
		return visible.filter(
			(tab) =>
				tab.hasUnread || tab.state === 'busy' || hasDraft(tab) || (showStarred && tab.starred)
		);
	}

	return visible;
}

/**
 * Get the currently active AI tab for a session.
 * Returns the tab matching activeTabId, or the first tab if not found.
 * Returns undefined if the session has no tabs.
 *
 * @param session - The Maestro session
 * @returns The active AITab or undefined if no tabs exist
 */
export function getActiveTab(session: Session): AITab | undefined {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return undefined;
	}

	const activeTab = session.aiTabs.find((tab) => tab.id === session.activeTabId);

	// Fallback to first tab if activeTabId doesn't match any tab
	// (can happen after tab deletion or data corruption)
	return activeTab ?? session.aiTabs[0];
}

/**
 * Where a dequeued execution-queue item should run.
 *
 * - `'aiTab'`  - the tab it was queued against is still open (normal foreground send).
 * - `'orphan'` - the user closed that tab while the message was still queued, so it now
 *   lives in `orphanedThinkingTabs` and the send is fire-and-forget. Busy state and the
 *   user log MUST route there, never onto whatever tab happens to be active.
 * - `'active'` - the item has no resolvable tabId (legacy item, or the tab was
 *   hard-deleted) so we fall back to the active tab.
 */
export interface QueuedItemTarget {
	tabId: string;
	location: 'aiTab' | 'orphan' | 'active';
}

/**
 * Resolve which tab a dequeued {@link QueuedItem} runs on.
 *
 * Every dispatch path (onExit, interrupt, kill, queue recovery, debug release) shares
 * this resolver so a message queued on a since-closed tab can never leak into the
 * foreground conversation. The item carries the tabId it was queued against; we look in
 * `aiTabs` first, then `orphanedThinkingTabs` (closed-but-still-draining tabs), and only
 * fall back to the active tab when the item truly has nowhere else to go.
 *
 * Returns `null` only when the session has no aiTabs at all (caller decides what to do).
 */
export function resolveQueuedItemTarget(
	session: Session,
	item: Pick<QueuedItem, 'tabId'>
): QueuedItemTarget | null {
	if (item.tabId) {
		if (session.aiTabs?.some((tab) => tab.id === item.tabId)) {
			return { tabId: item.tabId, location: 'aiTab' };
		}
		const orphan = session.orphanedThinkingTabs?.find((tab) => tab.id === item.tabId);
		if (orphan) {
			return { tabId: orphan.id, location: 'orphan' };
		}
	}
	const active = getActiveTab(session);
	return active ? { tabId: active.id, location: 'active' } : null;
}

/**
 * Mark a tab as running a dequeued queue item: set it busy/thinking and, for message
 * items, append the user-visible log entry. Shared by every dispatch path so the
 * busy-state + log construction stays identical (and lands on the resolved target tab,
 * which may be an orphan - see {@link resolveQueuedItemTarget}).
 */
export function markTabRunningQueuedItem(tab: AITab, item: QueuedItem): AITab {
	const now = Date.now();
	const next: AITab = { ...tab, state: 'busy', thinkingStartTime: now };
	if (item.type === 'message' && item.text) {
		const logEntry: LogEntry = {
			id: generateId(),
			timestamp: now,
			source: 'user',
			text: item.text,
			images: item.images,
			...(item.forceParallel && { forceParallel: true }),
			...(item.readOnlyMode && { readOnly: true }),
		};
		next.logs = [...tab.logs, logEntry];
	}
	return next;
}

/**
 * Options for creating a new AI tab.
 */
export interface CreateTabOptions {
	agentSessionId?: string | null; // Claude Code session UUID (null for new tabs)
	logs?: LogEntry[]; // Initial conversation history
	name?: string | null; // User-defined name (null = show UUID octet)
	starred?: boolean; // Whether session is starred
	usageStats?: UsageStats; // Token usage stats
	saveToHistory?: boolean; // Whether to save synopsis to history after completions
	showThinking?: ThinkingMode; // Thinking display mode: 'off' | 'on' (temporary) | 'sticky' (persistent)
}

/**
 * Result of creating a new tab - contains both the new tab and updated session.
 */
export interface CreateTabResult {
	tab: AITab; // The newly created tab
	session: Session; // Updated session with the new tab added and set as active
}

/**
 * Create a new AI tab for a session.
 * The new tab is appended to the session's aiTabs array and set as the active tab.
 *
 * @param session - The Maestro session to add the tab to
 * @param options - Optional tab configuration (agentSessionId, logs, name, starred)
 * @returns Object containing the new tab and updated session
 *
 * @example
 * // Create a new empty tab
 * const { tab, session: updatedSession } = createTab(session);
 *
 * @example
 * // Create a tab for an existing Claude session
 * const { tab, session: updatedSession } = createTab(session, {
 *   agentSessionId: 'abc123',
 *   name: 'My Feature',
 *   starred: true,
 *   logs: existingLogs
 * });
 */
export function createTab(
	session: Session,
	options: CreateTabOptions = {}
): CreateTabResult | null {
	if (!session) {
		return null;
	}

	const {
		agentSessionId = null,
		logs = [],
		name = null,
		starred = false,
		usageStats,
		saveToHistory = true,
		showThinking = 'off',
	} = options;

	// Create the new tab with default values
	const newTab: AITab = {
		id: generateId(),
		agentSessionId,
		name,
		starred,
		logs,
		inputValue: '',
		stagedImages: [],
		usageStats,
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory,
		showThinking,
	};

	// Update the session with the new tab added and set as active.
	// Clear activeFileTabId and activeTerminalTabId so the new AI tab is shown in the
	// main panel, and set inputMode to 'ai' so callers don't need to patch it manually.
	// activeGroupId is cleared too: a new tab is a fresh standalone view, so it must
	// leave any active tiled group - otherwise the group keeps taking over the panel
	// and the new tab opens in the background (never gets focus). Insert the new tab
	// into unifiedTabOrder directly to the right of the currently active tab so "new
	// tab" actions feel positional regardless of which tab type is currently focused.
	const newTabRef = { type: 'ai' as const, id: newTab.id };
	const updatedSession: Session = {
		...session,
		aiTabs: [...(session.aiTabs || []), newTab],
		activeTabId: newTab.id,
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		activeGroupId: null,
		inputMode: 'ai' as const,
		unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(session, newTabRef),
	};

	return {
		tab: newTab,
		session: updatedSession,
	};
}

/**
 * Options for closing a tab.
 */
export interface CloseTabOptions {
	/** If true, skip adding to closed tab history (e.g., for wizard tabs) */
	skipHistory?: boolean;
}

/**
 * Result of closing a tab - contains the closed tab info and updated session.
 */
export interface CloseTabResult {
	closedTab: ClosedTab; // The closed tab data with original index
	session: Session; // Updated session with tab removed
}

/**
 * Close an AI tab and optionally add it to the closed tab history.
 * The closed tab is stored in closedTabHistory for potential restoration via Cmd+Shift+T,
 * unless skipHistory is true (e.g., for wizard tabs which should not be restorable).
 * If the closed tab was active, the next tab (or previous if at end) becomes active.
 * When showUnreadOnly is true, prioritizes switching to the next unread tab.
 * If closing the last tab, a fresh new tab is created to replace it.
 *
 * @param session - The Maestro session containing the tab
 * @param tabId - The ID of the tab to close
 * @param showUnreadOnly - If true, prioritize switching to the next unread tab
 * @param options - Optional close options (e.g., skipHistory for wizard tabs)
 * @returns Object containing the closed tab info and updated session, or null if tab not found
 *
 * @example
 * const result = closeTab(session, 'tab-123');
 * if (result) {
 *   const { closedTab, session: updatedSession } = result;
 *   logger.info(`Closed tab at index ${closedTab.index}`);
 * }
 *
 * @example
 * // Close wizard tab without adding to history
 * const result = closeTab(session, 'wizard-tab-id', false, { skipHistory: true });
 */
export function closeTab(
	session: Session,
	tabId: string,
	showUnreadOnly = false,
	options: CloseTabOptions = {}
): CloseTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	// Find the tab to close
	const tabIndex = session.aiTabs.findIndex((tab) => tab.id === tabId);
	if (tabIndex === -1) {
		return null;
	}

	const tabToClose = session.aiTabs[tabIndex];

	// Create closed tab entry with original index
	const closedTab: ClosedTab = {
		tab: { ...tabToClose },
		index: tabIndex,
		closedAt: Date.now(),
	};

	// Remove tab from aiTabs
	let updatedTabs = session.aiTabs.filter((tab) => tab.id !== tabId);

	// If we just closed the last tab, create a fresh new tab to replace it
	let newActiveTabId = session.activeTabId;
	// Fallback unified tab ref when the closed tab was active — may be terminal or file
	let fallbackRef: UnifiedTabRef | null = null;
	if (updatedTabs.length === 0) {
		const freshTab: AITab = {
			id: generateId(),
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: Date.now(),
			state: 'idle',
		};
		updatedTabs = [freshTab];
		newActiveTabId = freshTab.id;
	} else if (session.activeTabId === tabId) {
		// If we closed the active tab, select the tab to the left (previous tab)
		// If closing the first tab, select the new first tab (was previously to the right)

		if (showUnreadOnly) {
			// When filtering unread tabs, find the previous unread tab to switch to
			// Build a temporary session with the updated tabs to use getNavigableTabs
			const tempSession = { ...session, aiTabs: updatedTabs };
			const navigableTabs = getNavigableTabs(tempSession, true);

			if (navigableTabs.length > 0) {
				// Find the position of the closed tab within the navigable tabs (before removal)
				// Then pick the tab to the left, or the first tab if we were at position 0
				const closedTabNavIndex = getNavigableTabs(session, true).findIndex((t) => t.id === tabId);
				const newNavIndex = Math.max(0, closedTabNavIndex - 1);
				newActiveTabId = navigableTabs[Math.min(newNavIndex, navigableTabs.length - 1)].id;
			} else {
				// No more unread tabs - fall back to selecting by position in full list
				// Select the tab to the left, or first tab if we were at position 0
				const newIndex = Math.max(0, tabIndex - 1);
				newActiveTabId = updatedTabs[newIndex].id;
			}
		} else {
			// Normal mode: use repaired unifiedTabOrder to find the correct left neighbor.
			// This respects the visual tab order which includes terminal and file tabs —
			// without this, closing an AI tab that sits to the right of a terminal tab
			// would fall back to a random AI tab instead of the adjacent terminal tab.
			// We use getRepairedUnifiedTabOrder to skip stale/duplicate refs (same as rendering).
			const unifiedOrder = getRepairedUnifiedTabOrder(session);
			const closedUnifiedIndex = unifiedOrder.findIndex(
				(ref) => ref.type === 'ai' && ref.id === tabId
			);
			const remainingUnified = unifiedOrder.filter(
				(ref) => !(ref.type === 'ai' && ref.id === tabId)
			);
			if (closedUnifiedIndex !== -1 && remainingUnified.length > 0) {
				const fallbackIndex = Math.max(0, closedUnifiedIndex - 1);
				fallbackRef = remainingUnified[Math.min(fallbackIndex, remainingUnified.length - 1)];
			} else {
				// unifiedTabOrder out of sync — fall back to aiTabs position
				const newIndex = Math.max(0, tabIndex - 1);
				newActiveTabId = updatedTabs[newIndex].id;
			}
		}
	}

	// Add to closed tab history unless skipHistory is set (e.g., for wizard tabs)
	// Wizard tabs should not be restorable via Cmd+Shift+T
	const updatedHistory = options.skipHistory
		? session.closedTabHistory || []
		: [closedTab, ...(session.closedTabHistory || [])].slice(0, MAX_CLOSED_TAB_HISTORY);

	// Also remove from unifiedTabOrder to keep AI and file tabs in sync
	const updatedUnifiedTabOrder = (session.unifiedTabOrder || []).filter(
		(ref) => !(ref.type === 'ai' && ref.id === tabId)
	);

	// If we created a fresh tab, add it to unifiedTabOrder at the end
	let finalUnifiedTabOrder = updatedUnifiedTabOrder;
	if (session.aiTabs.length === 1 && updatedTabs.length === 1 && updatedTabs[0].id !== tabId) {
		// A fresh tab was created to replace the closed one
		const freshTabRef: UnifiedTabRef = { type: 'ai', id: updatedTabs[0].id };
		finalUnifiedTabOrder = [...updatedUnifiedTabOrder, freshTabRef];
	}

	// Create updated session.
	// When the fallback is a non-AI tab (terminal or file), we must update the corresponding
	// active ID and inputMode so the UI switches to the correct view.
	const updatedSession: Session =
		fallbackRef?.type === 'terminal'
			? {
					...session,
					aiTabs: updatedTabs,
					// Keep activeTabId as-is; the terminal tab is now active
					activeTerminalTabId: fallbackRef.id,
					activeFileTabId: null,
					inputMode: 'terminal',
					closedTabHistory: updatedHistory,
					unifiedTabOrder: finalUnifiedTabOrder,
				}
			: fallbackRef?.type === 'file'
				? {
						...session,
						aiTabs: updatedTabs,
						activeFileTabId: fallbackRef.id,
						activeBrowserTabId: null,
						activeTerminalTabId: null,
						inputMode: 'ai',
						closedTabHistory: updatedHistory,
						unifiedTabOrder: finalUnifiedTabOrder,
					}
				: fallbackRef?.type === 'browser'
					? {
							...session,
							aiTabs: updatedTabs,
							activeFileTabId: null,
							activeBrowserTabId: fallbackRef.id,
							activeTerminalTabId: null,
							inputMode: 'ai',
							closedTabHistory: updatedHistory,
							unifiedTabOrder: finalUnifiedTabOrder,
						}
					: fallbackRef?.type === 'ai'
						? {
								...session,
								aiTabs: updatedTabs,
								activeTabId: fallbackRef.id,
								activeFileTabId: null,
								activeBrowserTabId: null,
								activeTerminalTabId: null,
								inputMode: 'ai',
								closedTabHistory: updatedHistory,
								unifiedTabOrder: finalUnifiedTabOrder,
							}
						: {
								...session,
								aiTabs: updatedTabs,
								activeTabId: newActiveTabId,
								closedTabHistory: updatedHistory,
								unifiedTabOrder: finalUnifiedTabOrder,
							};

	// Keep tracking the closed tab in orphanedThinkingTabs when it still has work
	// in flight, so the thinking pill stays visible and the tab survives as a
	// dispatch target until that work finishes. Two cases qualify:
	//   1. It was busy (an agent turn is mid-flight).
	//   2. It has queued items waiting (a message the user already sent that should
	//      still fire in the background - fire-and-forget).
	// The pill picks orphans up alongside busy aiTabs. The agent exit/error
	// listeners drop the orphan once its process is gone and its queue is drained.
	const closedTabWasBusy = tabToClose.state === 'busy';
	const closedTabHasQueuedItems = (session.executionQueue ?? []).some(
		(item) => item.tabId === tabId
	);
	const shouldOrphanClosedTab = closedTabWasBusy || closedTabHasQueuedItems;
	const anyRemainingTabBusy = updatedTabs.some((tab) => tab.state === 'busy');
	const updatedOrphans: AITab[] | undefined = shouldOrphanClosedTab
		? [...(session.orphanedThinkingTabs ?? []), tabToClose]
		: session.orphanedThinkingTabs;
	const hasOrphans = (updatedOrphans?.length ?? 0) > 0;
	const sessionWithOrphans: Session =
		updatedOrphans === session.orphanedThinkingTabs
			? updatedSession
			: { ...updatedSession, orphanedThinkingTabs: updatedOrphans };
	// Only clear session-level busy state when nothing is thinking anywhere —
	// neither a remaining aiTab nor an orphaned-but-still-running tab.
	const finalSession =
		closedTabWasBusy &&
		!anyRemainingTabBusy &&
		!hasOrphans &&
		sessionWithOrphans.busySource === 'ai'
			? {
					...sessionWithOrphans,
					state: 'idle' as const,
					busySource: undefined,
					thinkingStartTime: undefined,
				}
			: sessionWithOrphans;

	// Queued items targeting the just-closed tab are intentionally preserved. A
	// message the user already sent fires in the background against the now-orphaned
	// tab (see the orphan-drain path in useAgentExitListener), so closing the tab is
	// fire-and-forget rather than a discard. The tab survives in orphanedThinkingTabs
	// to carry its agent session id for continuity and to be a valid dispatch target.
	return {
		closedTab,
		session: finalSession,
	};
}

/**
 * Result of restoring an orphaned (still-thinking) tab back into aiTabs.
 */
export interface RestoreOrphanedTabResult {
	tab: AITab;
	session: Session;
}

/**
 * Restore a tab from `orphanedThinkingTabs` back to `aiTabs` and make it active.
 * Used when the user clicks the thinking pill's tab link for a tab they closed
 * while its agent was still running — restoring brings it back into the tab bar
 * so streaming output resumes routing to the visible tab. The tab keeps its
 * original ID, so the still-running process re-attaches automatically.
 */
export function restoreOrphanedTab(
	session: Session,
	tabId: string
): RestoreOrphanedTabResult | null {
	const orphan = session.orphanedThinkingTabs?.find((tab) => tab.id === tabId);
	if (!orphan) return null;
	const remainingOrphans = (session.orphanedThinkingTabs ?? []).filter((tab) => tab.id !== tabId);
	return {
		tab: orphan,
		session: {
			...session,
			aiTabs: [...session.aiTabs, orphan],
			activeTabId: orphan.id,
			activeFileTabId: null,
			activeBrowserTabId: null,
			activeTerminalTabId: null,
			inputMode: 'ai',
			unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder || [], 'ai', orphan.id),
			orphanedThinkingTabs: remainingOrphans.length > 0 ? remainingOrphans : undefined,
		},
	};
}

/**
 * Result of reopening a closed tab.
 */
export interface ReopenTabResult {
	tab: AITab; // The reopened tab (either restored or existing duplicate)
	session: Session; // Updated session with tab restored/selected
	wasDuplicate: boolean; // True if we switched to an existing tab instead of restoring
}

/**
 * Reopen the most recently closed tab from the closed tab history.
 * Includes duplicate detection: if a tab with the same agentSessionId already exists,
 * switch to that existing tab instead of creating a duplicate.
 *
 * The tab is restored at its original index position if possible, otherwise appended to the end.
 * The reopened tab becomes the active tab.
 *
 * @param session - The Maestro session
 * @returns Object containing the reopened tab and updated session, or null if no closed tabs exist
 *
 * @example
 * const result = reopenClosedTab(session);
 * if (result) {
 *   const { tab, session: updatedSession, wasDuplicate } = result;
 *   if (wasDuplicate) {
 *     logger.info(`Switched to existing tab ${tab.id}`);
 *   } else {
 *     logger.info(`Restored tab ${tab.id} from history`);
 *   }
 * }
 */
export function reopenClosedTab(session: Session): ReopenTabResult | null {
	// Check if there's anything in the history
	if (!session.closedTabHistory || session.closedTabHistory.length === 0) {
		return null;
	}

	// Pop the most recently closed tab from history
	const [closedTabEntry, ...remainingHistory] = session.closedTabHistory;
	const tabToRestore = closedTabEntry.tab;

	// If this closed tab is still tracked as an orphan (i.e., it was busy when
	// closed and its agent is still streaming), pull it back from orphans
	// instead of creating a duplicate tab with a fresh ID. Reusing the original
	// ID lets the still-running process re-attach to the visible tab.
	const matchingOrphan = session.orphanedThinkingTabs?.find(
		(t) =>
			t.id === tabToRestore.id ||
			(t.agentSessionId !== null && t.agentSessionId === tabToRestore.agentSessionId)
	);
	if (matchingOrphan) {
		const restored = restoreOrphanedTab(session, matchingOrphan.id);
		if (restored) {
			return {
				tab: restored.tab,
				session: { ...restored.session, closedTabHistory: remainingHistory },
				wasDuplicate: false,
			};
		}
	}

	// Check for duplicate: does a tab with the same agentSessionId already exist?
	// Note: null agentSessionId (new/empty tabs) are never considered duplicates
	if (tabToRestore.agentSessionId !== null) {
		const existingTab = session.aiTabs.find(
			(tab) => tab.agentSessionId === tabToRestore.agentSessionId
		);

		if (existingTab) {
			// Duplicate found - switch to existing tab instead of restoring
			// Still remove from history since user "used" their undo
			return {
				tab: existingTab,
				session: {
					...session,
					activeTabId: existingTab.id,
					closedTabHistory: remainingHistory,
					unifiedTabOrder: ensureInUnifiedTabOrder(
						session.unifiedTabOrder || [],
						'ai',
						existingTab.id
					),
				},
				wasDuplicate: true,
			};
		}
	}

	// No duplicate - restore the tab
	// Generate a new ID to avoid any ID conflicts
	const restoredTab: AITab = {
		...tabToRestore,
		id: generateId(),
	};

	// Insert at original index if possible, otherwise append
	const insertIndex = Math.min(closedTabEntry.index, session.aiTabs.length);
	const updatedTabs = [
		...session.aiTabs.slice(0, insertIndex),
		restoredTab,
		...session.aiTabs.slice(insertIndex),
	];

	return {
		tab: restoredTab,
		session: {
			...session,
			aiTabs: updatedTabs,
			activeTabId: restoredTab.id,
			closedTabHistory: remainingHistory,
			unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder || [], 'ai', restoredTab.id),
		},
		wasDuplicate: false,
	};
}

/**
 * Result of closing a file tab - contains the closed tab entry and updated session.
 */
export interface CloseFileTabResult {
	closedTabEntry: ClosedTabEntry; // The closed tab data with unified index
	session: Session; // Updated session with tab removed
}

/**
 * Close a file preview tab and add it to the unified closed tab history.
 * When the closed tab was active, selects the next tab in unifiedTabOrder.
 *
 * @param session - The Maestro session containing the file tab
 * @param tabId - The ID of the file tab to close
 * @returns Object containing the closed tab entry and updated session, or null if tab not found
 *
 * @example
 * const result = closeFileTab(session, 'file-tab-123');
 * if (result) {
 *   const { closedTabEntry, session: updatedSession } = result;
 *   logger.info(`Closed file tab at unified index ${closedTabEntry.unifiedIndex}`);
 * }
 */
export function closeFileTab(session: Session, tabId: string): CloseFileTabResult | null {
	if (!session || !session.filePreviewTabs || session.filePreviewTabs.length === 0) {
		return null;
	}

	// Find the tab to close
	const tabToClose = session.filePreviewTabs.find((tab) => tab.id === tabId);
	if (!tabToClose) {
		return null;
	}

	// Use repaired order to skip stale/duplicate refs (same as rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);

	// Find the position in the repaired unifiedTabOrder
	const unifiedIndex = repairedOrder.findIndex((ref) => ref.type === 'file' && ref.id === tabId);

	// Create closed tab entry
	const closedTabEntry: ClosedTabEntry = {
		type: 'file',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : repairedOrder.length,
		closedAt: Date.now(),
	};

	// Remove from filePreviewTabs
	const updatedFilePreviewTabs = session.filePreviewTabs.filter((tab) => tab.id !== tabId);

	// Remove from unifiedTabOrder (filter from repaired order to persist the fix)
	const updatedUnifiedTabOrder = repairedOrder.filter(
		(ref) => !(ref.type === 'file' && ref.id === tabId)
	);

	// Determine new active tab if we closed the active file tab
	let newActiveFileTabId = session.activeFileTabId;
	let newActiveBrowserTabId = session.activeBrowserTabId;
	let newActiveTerminalTabId = session.activeTerminalTabId;
	let newActiveTabId = session.activeTabId;
	let newInputMode = session.inputMode;

	if (session.activeFileTabId === tabId) {
		// This was the active tab - select the tab to the left in unifiedTabOrder
		// If closing the first tab, select the new first tab
		if (updatedUnifiedTabOrder.length > 0 && unifiedIndex !== -1) {
			// Select the tab to the left (previous tab), or first tab if we were at position 0
			const newIndex = Math.max(0, unifiedIndex - 1);
			const nextTabRef = updatedUnifiedTabOrder[newIndex];

			if (nextTabRef.type === 'file') {
				// Previous tab is a file tab
				newActiveFileTabId = nextTabRef.id;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (nextTabRef.type === 'browser') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = nextTabRef.id;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (nextTabRef.type === 'terminal') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = nextTabRef.id;
				newInputMode = 'terminal';
			} else {
				// Previous tab is an AI tab - switch to it
				newActiveTabId = nextTabRef.id;
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			}
		} else if (updatedUnifiedTabOrder.length > 0) {
			// Fallback: just select the first available tab
			const firstTabRef = updatedUnifiedTabOrder[0];
			if (firstTabRef.type === 'file') {
				newActiveFileTabId = firstTabRef.id;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (firstTabRef.type === 'browser') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = firstTabRef.id;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (firstTabRef.type === 'terminal') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = firstTabRef.id;
				newInputMode = 'terminal';
			} else {
				newActiveTabId = firstTabRef.id;
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			}
		} else {
			// No tabs left - shouldn't happen as AI tabs should always exist
			newActiveFileTabId = null;
			newActiveBrowserTabId = null;
			newActiveTerminalTabId = null;
			newInputMode = 'ai';
		}
	}

	// Add to unified closed tab history
	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		closedTabEntry,
		session: {
			...session,
			filePreviewTabs: updatedFilePreviewTabs,
			unifiedTabOrder: updatedUnifiedTabOrder,
			activeFileTabId: newActiveFileTabId,
			activeBrowserTabId: newActiveBrowserTabId,
			activeTerminalTabId: newActiveTerminalTabId,
			activeTabId: newActiveTabId,
			inputMode: newInputMode,
			unifiedClosedTabHistory: updatedUnifiedHistory,
		},
	};
}

export interface CloseBrowserTabResult {
	closedTabEntry: ClosedTabEntry;
	session: Session;
}

export function closeBrowserTab(session: Session, tabId: string): CloseBrowserTabResult | null {
	if (!session || !session.browserTabs || session.browserTabs.length === 0) {
		return null;
	}

	const tabToClose = session.browserTabs.find((tab) => tab.id === tabId);
	if (!tabToClose) {
		return null;
	}

	const repairedOrder = getRepairedUnifiedTabOrder(session);
	const unifiedIndex = repairedOrder.findIndex((ref) => ref.type === 'browser' && ref.id === tabId);
	const closedTabEntry: ClosedTabEntry = {
		type: 'browser',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : repairedOrder.length,
		closedAt: Date.now(),
	};

	const updatedBrowserTabs = session.browserTabs.filter((tab) => tab.id !== tabId);
	const updatedUnifiedTabOrder = repairedOrder.filter(
		(ref) => !(ref.type === 'browser' && ref.id === tabId)
	);

	let nextActiveTabId = session.activeTabId;
	let nextActiveFileTabId = session.activeFileTabId;
	let nextActiveBrowserTabId = session.activeBrowserTabId;
	let nextActiveTerminalTabId = session.activeTerminalTabId;
	let nextInputMode = session.inputMode;

	if (session.activeBrowserTabId === tabId) {
		const fallbackRef =
			updatedUnifiedTabOrder.length > 0 && unifiedIndex !== -1
				? updatedUnifiedTabOrder[Math.max(0, unifiedIndex - 1)]
				: (updatedUnifiedTabOrder[0] ?? null);

		nextActiveBrowserTabId = null;
		if (fallbackRef?.type === 'ai') {
			nextActiveTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'file') {
			nextActiveFileTabId = fallbackRef.id;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'browser') {
			nextActiveBrowserTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'terminal') {
			nextActiveTerminalTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextInputMode = 'terminal';
		}
	}

	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		closedTabEntry,
		session: {
			...session,
			browserTabs: updatedBrowserTabs,
			unifiedTabOrder: updatedUnifiedTabOrder,
			activeTabId: nextActiveTabId,
			activeFileTabId: nextActiveFileTabId,
			activeBrowserTabId: nextActiveBrowserTabId,
			activeTerminalTabId: nextActiveTerminalTabId,
			inputMode: nextInputMode,
			unifiedClosedTabHistory: updatedUnifiedHistory,
		},
	};
}

/**
 * Add an AI tab to the unified closed tab history.
 * This should be called when closing an AI tab to enable Cmd+Shift+T for all tab types.
 * Note: This only adds to the unified history - the existing closeTab function already
 * handles the legacy closedTabHistory for backwards compatibility.
 *
 * @param session - The Maestro session
 * @param aiTab - The AI tab being closed
 * @param unifiedIndex - The tab's position in unifiedTabOrder
 * @returns Updated session with the tab added to unified history
 */
export function addAiTabToUnifiedHistory(
	session: Session,
	aiTab: AITab,
	unifiedIndex: number
): Session {
	const closedTabEntry: ClosedTabEntry = {
		type: 'ai',
		tab: { ...aiTab },
		unifiedIndex,
		closedAt: Date.now(),
	};

	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		...session,
		unifiedClosedTabHistory: updatedUnifiedHistory,
	};
}

/**
 * Result of reopening a tab from unified closed tab history.
 */
export interface ReopenUnifiedClosedTabResult {
	tabType: 'ai' | 'file' | 'browser' | 'terminal'; // Type of tab that was reopened
	tabId: string; // ID of the restored or existing tab
	session: Session; // Updated session with tab restored/selected
	wasDuplicate: boolean; // True if we switched to an existing tab instead of restoring
}

/**
 * Restore a closed AI tab into a session, handling orphan re-attach and
 * duplicate detection. Does NOT mutate either closed-tab history list - the
 * caller is responsible for popping/removing the entry it pulled this tab from
 * and patching the appropriate history field on the returned session. This is
 * the shared core behind both `reopenUnifiedClosedTab` (most-recent) and
 * `reopenClosedAiTabById` (targeted, e.g. clicking a notification toast whose
 * tab was since closed).
 *
 * @param session - The Maestro session
 * @param tabToRestore - The closed AI tab to restore
 * @param unifiedIndex - Original position in the unified tab order
 */
function restoreClosedAiTab(
	session: Session,
	tabToRestore: AITab,
	unifiedIndex: number
): ReopenUnifiedClosedTabResult {
	// If this closed tab is still tracked as an orphan, restore the orphan
	// (preserving its original ID so the still-running agent re-attaches)
	// instead of creating a duplicate tab with a fresh ID.
	const matchingOrphan = session.orphanedThinkingTabs?.find(
		(t) =>
			t.id === tabToRestore.id ||
			(t.agentSessionId !== null && t.agentSessionId === tabToRestore.agentSessionId)
	);
	if (matchingOrphan) {
		const restored = restoreOrphanedTab(session, matchingOrphan.id);
		if (restored) {
			return {
				tabType: 'ai',
				tabId: restored.tab.id,
				session: restored.session,
				wasDuplicate: false,
			};
		}
	}

	// Check for duplicate: does a tab with the same agentSessionId already exist?
	if (tabToRestore.agentSessionId !== null) {
		const existingTab = session.aiTabs.find(
			(tab) => tab.agentSessionId === tabToRestore.agentSessionId
		);

		if (existingTab) {
			// Duplicate found - switch to existing tab instead of restoring
			return {
				tabType: 'ai',
				tabId: existingTab.id,
				session: {
					...session,
					activeTabId: existingTab.id,
					activeFileTabId: null,
					unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder, 'ai', existingTab.id),
				},
				wasDuplicate: true,
			};
		}
	}

	// No duplicate - restore the tab
	const restoredTab: AITab = {
		...tabToRestore,
		id: generateId(),
	};

	// Calculate insert position in aiTabs based on unified index
	// Find where this tab should go in unifiedTabOrder
	const targetUnifiedIndex = Math.min(unifiedIndex, session.unifiedTabOrder.length);

	// Count how many AI tabs come before this position
	let aiTabsBeforeIndex = 0;
	for (let i = 0; i < targetUnifiedIndex && i < session.unifiedTabOrder.length; i++) {
		if (session.unifiedTabOrder[i].type === 'ai') {
			aiTabsBeforeIndex++;
		}
	}
	const insertIndex = Math.min(aiTabsBeforeIndex, session.aiTabs.length);

	const updatedAiTabs = [
		...session.aiTabs.slice(0, insertIndex),
		restoredTab,
		...session.aiTabs.slice(insertIndex),
	];

	// Insert into unifiedTabOrder at the original position
	const newTabRef: UnifiedTabRef = { type: 'ai', id: restoredTab.id };
	const updatedUnifiedTabOrder = [
		...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
		newTabRef,
		...session.unifiedTabOrder.slice(targetUnifiedIndex),
	];

	return {
		tabType: 'ai',
		tabId: restoredTab.id,
		session: {
			...session,
			aiTabs: updatedAiTabs,
			activeTabId: restoredTab.id,
			activeFileTabId: null,
			unifiedTabOrder: updatedUnifiedTabOrder,
		},
		wasDuplicate: false,
	};
}

/**
 * Reopen a specific closed AI tab by its original tab ID, restoring it from
 * whichever closed-tab history list it lives in (unified first, legacy as a
 * fallback). Returns null when no closed AI tab with that ID is on record (it
 * was never closed, or has aged out of both histories).
 *
 * Used by the notification toast click path: a toast can carry the AI tab it
 * fired from, and if the user closed that tab before clicking the toast we
 * reopen it rather than silently landing on whatever tab happens to be active.
 *
 * @param session - The Maestro session that owned the tab
 * @param tabId - The original AITab.id recorded on the toast
 */
export function reopenClosedAiTabById(
	session: Session,
	tabId: string
): ReopenUnifiedClosedTabResult | null {
	// Prefer the unified history (the current closed-tab store).
	const unifiedHistory = session.unifiedClosedTabHistory || [];
	const unifiedIdx = unifiedHistory.findIndex((e) => e.type === 'ai' && e.tab.id === tabId);
	if (unifiedIdx !== -1) {
		const entry = unifiedHistory[unifiedIdx] as Extract<ClosedTabEntry, { type: 'ai' }>;
		const remainingHistory = [
			...unifiedHistory.slice(0, unifiedIdx),
			...unifiedHistory.slice(unifiedIdx + 1),
		];
		const result = restoreClosedAiTab(session, entry.tab, entry.unifiedIndex);
		return {
			...result,
			session: { ...result.session, unifiedClosedTabHistory: remainingHistory },
		};
	}

	// Fall back to the legacy AI-only history for older sessions. Legacy entries
	// predate unified ordering, so restore at the end of the unified order.
	const legacyHistory = session.closedTabHistory || [];
	const legacyIdx = legacyHistory.findIndex((e) => e.tab.id === tabId);
	if (legacyIdx !== -1) {
		const entry = legacyHistory[legacyIdx];
		const remainingLegacy = [
			...legacyHistory.slice(0, legacyIdx),
			...legacyHistory.slice(legacyIdx + 1),
		];
		const result = restoreClosedAiTab(session, entry.tab, session.unifiedTabOrder.length);
		return {
			...result,
			session: { ...result.session, closedTabHistory: remainingLegacy },
		};
	}

	return null;
}

/**
 * Reopen the most recently closed tab from the unified closed tab history.
 * Handles both AI tabs and file preview tabs with appropriate duplicate detection:
 * - For AI tabs: checks if a tab with the same agentSessionId already exists
 * - For file tabs: checks if a tab with the same path already exists
 *
 * The tab is restored at its original unified index position if possible.
 * The reopened tab becomes the active tab.
 *
 * @param session - The Maestro session
 * @returns Object containing the reopened tab info and updated session, or null if no closed tabs exist
 *
 * @example
 * const result = reopenUnifiedClosedTab(session);
 * if (result) {
 *   const { tabType, tabId, session: updatedSession, wasDuplicate } = result;
 *   if (wasDuplicate) {
 *     logger.info(`Switched to existing ${tabType} tab ${tabId}`);
 *   } else {
 *     logger.info(`Restored ${tabType} tab ${tabId} from history`);
 *   }
 * }
 */
export function reopenUnifiedClosedTab(session: Session): ReopenUnifiedClosedTabResult | null {
	// Check if there's anything in the unified history
	if (!session.unifiedClosedTabHistory || session.unifiedClosedTabHistory.length === 0) {
		// Fall back to legacy closedTabHistory for backwards compatibility
		const legacyResult = reopenClosedTab(session);
		if (legacyResult) {
			return {
				tabType: 'ai',
				tabId: legacyResult.tab.id,
				session: legacyResult.session,
				wasDuplicate: legacyResult.wasDuplicate,
			};
		}
		return null;
	}

	// Pop the most recently closed tab from unified history
	const [closedEntry, ...remainingHistory] = session.unifiedClosedTabHistory;

	if (closedEntry.type === 'ai') {
		// Restoring an AI tab. The shared helper handles orphan re-attach and
		// duplicate detection; we layer on the popped history afterward.
		const result = restoreClosedAiTab(session, closedEntry.tab, closedEntry.unifiedIndex);
		return {
			...result,
			session: { ...result.session, unifiedClosedTabHistory: remainingHistory },
		};
	} else if (closedEntry.type === 'file') {
		// Restoring a file tab
		const tabToRestore = closedEntry.tab;

		// Check for duplicate: does a tab with the same path already exist?
		const existingTab = session.filePreviewTabs.find((tab) => tab.path === tabToRestore.path);

		if (existingTab) {
			// Duplicate found - switch to existing tab instead of restoring
			return {
				tabType: 'file',
				tabId: existingTab.id,
				session: {
					...session,
					activeFileTabId: existingTab.id,
					activeBrowserTabId: null,
					unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder, 'file', existingTab.id),
					unifiedClosedTabHistory: remainingHistory,
				},
				wasDuplicate: true,
			};
		}

		// No duplicate - restore the tab
		// Reset navigation history to just the current file to avoid stale/corrupted breadcrumbs
		const restoredTab: FilePreviewTab = {
			...tabToRestore,
			id: generateId(),
			// Clear any unsaved edit content since we're restoring from history
			editContent: undefined,
			editMode: false,
			// Reset breadcrumb history - start fresh with just the current file
			navigationHistory: [
				{ path: tabToRestore.path, name: tabToRestore.name, scrollTop: tabToRestore.scrollTop },
			],
			navigationIndex: 0,
		};

		// Add to filePreviewTabs
		const updatedFilePreviewTabs = [...session.filePreviewTabs, restoredTab];

		// Insert into unifiedTabOrder at the original position
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'file', id: restoredTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'file',
			tabId: restoredTab.id,
			session: {
				...session,
				filePreviewTabs: updatedFilePreviewTabs,
				activeFileTabId: restoredTab.id,
				activeBrowserTabId: null,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	} else if (closedEntry.type === 'browser') {
		const closedBrowserTab = closedEntry.tab as BrowserTab;
		const restoredTab: BrowserTab = {
			...closedBrowserTab,
			id: generateId(),
			url: closedBrowserTab.url || DEFAULT_BROWSER_TAB_URL,
			title: getBrowserTabTitle(
				closedBrowserTab.url || DEFAULT_BROWSER_TAB_URL,
				closedBrowserTab.title
			),
			webContentsId: undefined,
		};

		const updatedBrowserTabs = [...(session.browserTabs || []), restoredTab];
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'browser', id: restoredTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'browser',
			tabId: restoredTab.id,
			session: {
				...session,
				browserTabs: updatedBrowserTabs,
				activeBrowserTabId: restoredTab.id,
				activeFileTabId: null,
				activeTabId: session.activeTabId,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	} else {
		// Terminal tab restore: create a fresh terminal tab (old PTY is gone, can't restore).
		// Mint a coworkingId from the same session counter new terminal tabs use so the
		// restored tab keeps its term:N pill and stays visible to list_terminals (coworking
		// MCP); without it the tab would restore id-less and be filtered out of the registry.
		const closedTerminalTab = closedEntry.tab;
		const { coworkingId, nextCoworkingId } = nextTerminalCoworkingId(session);
		const freshTab = {
			...createTerminalTab(
				closedTerminalTab.shellType,
				closedTerminalTab.cwd,
				closedTerminalTab.name
			),
			coworkingId,
		};

		// Insert into unifiedTabOrder at the original position
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'terminal', id: freshTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'terminal',
			tabId: freshTab.id,
			session: {
				...session,
				terminalTabs: [...(session.terminalTabs || []), freshTab],
				activeTerminalTabId: freshTab.id,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
				inputMode: 'terminal',
				nextCoworkingId,
			},
			wasDuplicate: false,
		};
	}
}

/**
 * Result of setting the active tab.
 */
/**
 * The session-state patch that focuses an agent's AI tab area.
 *
 * The main window renders exactly one tab type using this precedence:
 *   terminal (inputMode==='terminal') > file (activeFileTabId) > browser
 *   (activeBrowserTabId, while inputMode==='ai') > ai (activeTabId).
 * See findActiveUnifiedTabIndex in unifiedTabOrderUtils.ts. Because browser, file,
 * and terminal all outrank the AI tab, ANY code that wants to land the user on an
 * AI tab must clear all three active-tab ids as well as set inputMode:'ai'. Leaving
 * even one dangling keeps the previous view on screen (e.g. clicking a toast while a
 * browser tab is active silently leaves the user on the browser tab).
 *
 * Spread this into a session update instead of hand-rolling the literal, so the
 * invariant lives in one place:
 *   updateSession(id, (s) => ({ ...s, ...aiTabFocusFields(tabId) }))
 *
 * @param tabId - The AI tab to activate. Omit to clear the non-AI views and force
 *                AI mode without changing which AI tab is active.
 */
export function aiTabFocusFields(tabId?: string): Partial<Session> {
	return {
		...(tabId ? { activeTabId: tabId } : {}),
		activeFileTabId: null,
		activeTerminalTabId: null,
		activeBrowserTabId: null,
		inputMode: 'ai',
		// Landing on a standalone AI tab always leaves any active tiled group so the
		// group's layout stops taking over the panel. A no-op when no group is active.
		activeGroupId: null,
	};
}

/**
 * Field patch for flipping a tab's read-only state.
 *
 * Keeps the legacy `readOnlyMode` boolean and the 3-way `permissionMode` in
 * lockstep, so the toolbar pill (resolved via resolveTabPermissionMode) and the
 * spawn path can never drift: toggling read-only ON means `readonly`, OFF means
 * full access. This mirrors what the toolbar's permission cycle already writes.
 * Every read-only toggle entry point (keyboard shortcut, quick action, prompt
 * composer, tab menu, tab store) spreads this instead of writing `readOnlyMode`
 * alone - the old inline `readOnlyMode: !tab.readOnlyMode` left `permissionMode`
 * stale, so a Full Access tab kept its pill after being switched to read-only.
 * `standard` is reachable only through the toolbar cycle, so toggling read-only
 * off lands on `full` (the non-readonly default).
 */
export function toggleReadOnlyModeFields(tab: Pick<AITab, 'readOnlyMode'>): {
	readOnlyMode: boolean;
	permissionMode: 'full' | 'readonly';
} {
	const nextReadOnly = !tab.readOnlyMode;
	return { readOnlyMode: nextReadOnly, permissionMode: nextReadOnly ? 'readonly' : 'full' };
}

/**
 * Detects the "closed the last tab" transition produced by closeTab(): when the
 * sole remaining AI tab is closed, closeTab() replaces it with a brand-new empty
 * tab, so the session still has exactly one AI tab but its id changed. Callers use
 * this to land the caret in the chat input on that fresh tab (same as a manual new
 * tab), without stealing focus on unrelated single-tab states like agent switches.
 *
 * @param prevSessionId - The active session id from the previous render.
 * @param prevAiTabIds  - The active session's AI tab ids from the previous render.
 * @param session       - The current active session.
 */
export function isSoleAiTabReplacement(
	prevSessionId: string | undefined,
	prevAiTabIds: readonly string[],
	session: Session | null | undefined
): boolean {
	return (
		!!session &&
		session.inputMode === 'ai' &&
		prevSessionId === session.id &&
		prevAiTabIds.length === 1 &&
		session.aiTabs.length === 1 &&
		session.aiTabs[0].id !== prevAiTabIds[0]
	);
}

export interface SetActiveTabResult {
	tab: AITab; // The newly active tab
	session: Session; // Updated session with activeTabId changed
}

/**
 * Set the active AI tab for a session.
 * Changes which tab is currently displayed and receives input.
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the tab to make active
 * @returns Object containing the active tab and updated session, or null if tab not found
 *
 * @example
 * const result = setActiveTab(session, 'tab-456');
 * if (result) {
 *   const { tab, session: updatedSession } = result;
 *   logger.info(`Now viewing tab: ${tab.name || tab.agentSessionId}`);
 * }
 */
export function setActiveTab(session: Session, tabId: string): SetActiveTabResult | null {
	// Validate that the session and tab exists
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	const targetTab = session.aiTabs.find((tab) => tab.id === tabId);
	if (!targetTab) {
		return null;
	}

	// When the target AI tab is tiled inside a group, activate that group and focus
	// its pane rather than falling through to the standalone path. A group member has
	// no standalone chip and is excluded from buildUnifiedTabs, so the old behavior
	// (clear activeGroupId + set activeTabId via aiTabFocusFields) left the panel stuck
	// on whatever was showing. This mirrors the group branch in
	// navigateToUnifiedTabByIndex: set activeGroupId, sync focusedPaneId to the leaf and
	// activeTabId to the tab (so the shared input targets it), clear standalone ids.
	const groupPane = findGroupPaneForAiTab(session, tabId);
	if (groupPane) {
		return {
			tab: targetTab,
			session: {
				...session,
				tabGroups: session.tabGroups.map((g) =>
					g.id === groupPane.groupId ? { ...g, focusedPaneId: groupPane.leafId } : g
				),
				activeGroupId: groupPane.groupId,
				activeTabId: tabId,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
			},
		};
	}

	// If already active, no file/terminal tab and no group is active, and already in
	// AI mode, return current state. The activeGroupId guard mirrors
	// navigateToUnifiedTabByIndex: without it, a stale active group could satisfy this
	// no-op and leave the tiled view rendered instead of switching to the standalone tab.
	if (
		session.activeTabId === tabId &&
		session.activeFileTabId === null &&
		session.activeBrowserTabId === null &&
		session.activeTerminalTabId === null &&
		session.activeGroupId == null &&
		session.inputMode === 'ai'
	) {
		return {
			tab: targetTab,
			session,
		};
	}

	// When selecting an AI tab, deselect any active file/terminal tab and switch to AI mode.
	// This ensures only one tab type (AI, file, or terminal) is active at a time, and
	// switching from terminal mode back to AI mode works by clicking any AI tab.
	// Clearing activeTerminalTabId is critical — getCurrentUnifiedTabIndex checks it first,
	// so a stale value causes next/prev tab navigation to start from the wrong position.
	return {
		tab: targetTab,
		session: {
			...session,
			...aiTabFocusFields(tabId),
		},
	};
}

/**
 * Get the tab that is currently in write mode (busy state) for a session.
 * In write-mode locking, only one tab can be busy at a time per Maestro session
 * to prevent file clobbering when multiple Claude sessions write to the same project.
 *
 * @param session - The Maestro session
 * @returns The busy AITab or undefined if no tab is in write mode
 *
 * @example
 * const busyTab = getWriteModeTab(session);
 * if (busyTab) {
 *   logger.info(`Tab ${busyTab.name || busyTab.agentSessionId} is currently writing`);
 *   // Disable input for other tabs
 * }
 */
export function getWriteModeTab(session: Session): AITab | undefined {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return undefined;
	}

	return session.aiTabs.find((tab) => tab.state === 'busy');
}

/**
 * Get all tabs that are currently busy (in write mode) for a session.
 * While the system enforces single write-mode, multiple busy tabs can exist
 * temporarily when resuming already-running sessions.
 *
 * This is useful for the busy tab indicator which needs to show ALL busy tabs,
 * not just the first one found.
 *
 * Pass `{ includeOrphans: true }` to also count closed-but-still-thinking tabs
 * (those parked in `orphanedThinkingTabs`). Those tabs keep writing in the
 * background after the user closes them, so any single-writer gate must treat
 * them as live writers - excluding them lets a new write spawn concurrently with
 * an orphan, violating single-writer-per-agent.
 *
 * @param session - The Maestro session
 * @param options.includeOrphans - Also include busy orphaned (closed) tabs
 * @returns Array of busy AITabs (empty if none are busy)
 *
 * @example
 * const busyTabs = getBusyTabs(session);
 * if (busyTabs.length > 0) {
 *   // Show busy indicator with pills for each busy tab
 *   busyTabs.forEach(tab => {
 *     logger.info(`Tab ${tab.name || tab.agentSessionId} is busy`);
 *   });
 * }
 */
export function getBusyTabs(session: Session, options: { includeOrphans?: boolean } = {}): AITab[] {
	if (!session) {
		return [];
	}

	const tabs = options.includeOrphans
		? [...(session.aiTabs ?? []), ...(session.orphanedThinkingTabs ?? [])]
		: (session.aiTabs ?? []);

	return tabs.filter((tab) => tab.state === 'busy');
}

/**
 * Navigate to the next tab in the session's tab list.
 * Wraps around to the first tab if currently on the last tab.
 * When showUnreadOnly is true, only cycles through unread tabs and tabs with drafts.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, only navigate through unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if less than 2 tabs
 *
 * @example
 * const result = navigateToNextTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToNextTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length < 2) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	// Find current position in navigable tabs
	const currentIndex = navigableTabs.findIndex((tab) => tab.id === session.activeTabId);

	// If current tab is not in navigable list, go to first navigable tab
	if (currentIndex === -1) {
		const firstTab = navigableTabs[0];
		return {
			tab: firstTab,
			session: {
				...session,
				activeTabId: firstTab.id,
			},
		};
	}

	// If only one navigable tab, stay on it
	if (navigableTabs.length < 2) {
		return null;
	}

	// Wrap around to first tab if at the end
	const nextIndex = (currentIndex + 1) % navigableTabs.length;
	const nextTab = navigableTabs[nextIndex];

	return {
		tab: nextTab,
		session: {
			...session,
			activeTabId: nextTab.id,
		},
	};
}

/**
 * Navigate to the previous tab in the session's tab list.
 * Wraps around to the last tab if currently on the first tab.
 * When showUnreadOnly is true, only cycles through unread tabs and tabs with drafts.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, only navigate through unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if less than 2 tabs
 *
 * @example
 * const result = navigateToPrevTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToPrevTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length < 2) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	// Find current position in navigable tabs
	const currentIndex = navigableTabs.findIndex((tab) => tab.id === session.activeTabId);

	// If current tab is not in navigable list, go to last navigable tab
	if (currentIndex === -1) {
		const lastTab = navigableTabs[navigableTabs.length - 1];
		return {
			tab: lastTab,
			session: {
				...session,
				activeTabId: lastTab.id,
			},
		};
	}

	// If only one navigable tab, stay on it
	if (navigableTabs.length < 2) {
		return null;
	}

	// Wrap around to last tab if at the beginning
	const prevIndex = (currentIndex - 1 + navigableTabs.length) % navigableTabs.length;
	const prevTab = navigableTabs[prevIndex];

	return {
		tab: prevTab,
		session: {
			...session,
			activeTabId: prevTab.id,
		},
	};
}

/**
 * Navigate to a specific tab by its index (0-based).
 * Used for Cmd+1 through Cmd+8 shortcuts.
 * When showUnreadOnly is true, navigates within the filtered list (unread + drafts).
 *
 * @param session - The Maestro session
 * @param index - The 0-based index of the tab to navigate to
 * @param showUnreadOnly - If true, navigate within unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if index out of bounds
 *
 * @example
 * // Navigate to the first tab (Cmd+1)
 * const result = navigateToTabByIndex(session, 0);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToTabByIndex(
	session: Session,
	index: number,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	// Check if index is within bounds
	if (index < 0 || index >= navigableTabs.length) {
		return null;
	}

	const targetTab = navigableTabs[index];

	// If already on this tab, return current state (no change needed)
	if (session.activeTabId === targetTab.id) {
		return {
			tab: targetTab,
			session,
		};
	}

	return {
		tab: targetTab,
		session: {
			...session,
			activeTabId: targetTab.id,
		},
	};
}

/**
 * Navigate to the last tab in the session's tab list.
 * Used for Cmd+0 shortcut.
 * When showUnreadOnly is true, navigates to the last tab in the filtered list (unread + drafts).
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, navigate to last unread/draft tab
 * @returns Object containing the new active tab and updated session, or null if no tabs
 *
 * @example
 * const result = navigateToLastTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToLastTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	const lastIndex = navigableTabs.length - 1;
	return navigateToTabByIndex(session, lastIndex, showUnreadOnly);
}

/**
 * Result of navigating to a unified tab (can be AI or file tab).
 */
export interface NavigateToUnifiedTabResult {
	type: 'ai' | 'file' | 'browser' | 'terminal' | 'group';
	id: string;
	session: Session;
}

/**
 * Navigate to a tab by its index in the unified tab order.
 * Used for Cmd+1 through Cmd+9 shortcuts to jump to tabs by position.
 * Works with both AI tabs and file preview tabs in the unified tab system.
 *
 * @param session - The Maestro session
 * @param index - The 0-based index in unifiedTabOrder
 * @returns Object with the tab type, id, and updated session, or null if index out of bounds
 *
 * @example
 * // Navigate to the first tab (Cmd+1)
 * const result = navigateToUnifiedTabByIndex(session, 0);
 * if (result) {
 *   if (result.type === 'ai') {
 *     // AI tab - activeTabId is updated, activeFileTabId is cleared
 *   } else {
 *     // File tab - activeFileTabId is updated, activeTabId preserved
 *   }
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToUnifiedTabByIndex(
	session: Session,
	index: number,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order that includes any orphaned tabs (keeps navigation
	// consistent with what buildUnifiedTabs renders in the tab bar)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length === 0) {
		return null;
	}

	// When the unread filter is active, index into the filtered order so Cmd+N matches
	// the Nth tab the user actually sees in the tab bar.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;

	// Check if index is within bounds
	if (index < 0 || index >= effectiveOrder.length) {
		return null;
	}

	const targetTabRef = effectiveOrder[index];
	// If orphans were repaired, persist the fix in the returned session
	const repairedSession =
		repairedOrder !== session.unifiedTabOrder
			? { ...session, unifiedTabOrder: repairedOrder }
			: session;

	if (targetTabRef.type === 'ai') {
		// Navigate to AI tab - verify it exists
		const aiTab = session.aiTabs.find((tab) => tab.id === targetTabRef.id);
		if (!aiTab) return null;

		// If already active, no file/terminal/browser tab selected, and in AI mode, return current state.
		// The other-ID checks are critical: without them, a stale browser/file/terminal selection
		// causes the early return to fire and skip the clearing update below, leaving
		// findActiveUnifiedTabIndex pointing at the wrong tab — the higher-priority ID wins
		// visually and the user-perceived "current tab" never changes (Cmd+Shift+[ no-ops).
		if (
			session.activeTabId === targetTabRef.id &&
			session.activeFileTabId === null &&
			session.activeBrowserTabId === null &&
			session.activeTerminalTabId === null &&
			session.activeGroupId == null &&
			session.inputMode === 'ai'
		) {
			return {
				type: 'ai',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		// Set the AI tab as active, clear terminal/file selection, and ensure inputMode is 'ai'.
		// inputMode must be explicitly set because navigating from a terminal tab leaves inputMode
		// as 'terminal' in the spread — without this, MainPanel would continue rendering the
		// terminal view even though an AI tab is now active. activeGroupId is cleared so an
		// active tiled group stops taking over the panel when navigating to a standalone tab.
		return {
			type: 'ai',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeTabId: targetTabRef.id,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				activeGroupId: null,
				inputMode: 'ai',
			},
		};
	} else if (targetTabRef.type === 'file') {
		// Navigate to file tab - verify it exists
		const fileTab = session.filePreviewTabs.find((tab) => tab.id === targetTabRef.id);
		if (!fileTab) return null;

		// If already active, no browser/terminal tab selected, and in AI mode, return current state.
		// The other-ID checks prevent a stale browser/terminal selection from masking this no-op:
		// without them, findActiveUnifiedTabIndex would prioritize the stale higher-priority ID
		// and the user-perceived "current tab" would never change.
		if (
			session.activeFileTabId === targetTabRef.id &&
			session.activeBrowserTabId === null &&
			session.activeTerminalTabId === null &&
			session.activeGroupId == null &&
			session.inputMode === 'ai'
		) {
			return {
				type: 'file',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		// Set the file tab as active and ensure inputMode is 'ai' (file preview is shown in
		// non-terminal mode; without this, navigating from a terminal tab would leave the
		// terminal visible instead of showing the file preview). activeGroupId is cleared so
		// an active tiled group stops taking over the panel.
		return {
			type: 'file',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeFileTabId: targetTabRef.id,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				activeGroupId: null,
				inputMode: 'ai',
			},
		};
	} else if (targetTabRef.type === 'browser') {
		const browserTab = (session.browserTabs || []).find((tab) => tab.id === targetTabRef.id);
		if (!browserTab) return null;

		// If already active, no file/terminal tab selected, and in AI mode, return current state.
		// The other-ID checks prevent a stale file/terminal selection from masking this no-op:
		// without them, findActiveUnifiedTabIndex would prioritize the stale higher-priority ID
		// and the user-perceived "current tab" would never change.
		if (
			session.activeBrowserTabId === targetTabRef.id &&
			session.activeFileTabId === null &&
			session.activeTerminalTabId === null &&
			session.activeGroupId == null &&
			session.inputMode === 'ai'
		) {
			return {
				type: 'browser',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		return {
			type: 'browser',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeFileTabId: null,
				activeBrowserTabId: targetTabRef.id,
				activeTerminalTabId: null,
				activeGroupId: null,
				inputMode: 'ai',
			},
		};
	} else if (targetTabRef.type === 'group') {
		// Navigate to a tiled group - it is a single unified tab. Verify it exists,
		// then set activeGroupId so the group takes over the panel, clear the standalone
		// active ids, and sync activeTabId to the group's focused AI pane (if any) so the
		// shared input targets it. inputMode 'ai' so the group (not a terminal) renders.
		const group = (session.tabGroups || []).find((g) => g.id === targetTabRef.id);
		if (!group) return null;

		if (
			session.activeGroupId === targetTabRef.id &&
			session.activeFileTabId === null &&
			session.activeBrowserTabId === null &&
			session.activeTerminalTabId === null &&
			session.inputMode === 'ai'
		) {
			return {
				type: 'group',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		const focusedAiId = resolveFocusedAiTabId(group);
		return {
			type: 'group',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeGroupId: targetTabRef.id,
				...(focusedAiId ? { activeTabId: focusedAiId } : {}),
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
			},
		};
	} else {
		// Terminal tab — verify it exists and activate it
		const terminalTab = (session.terminalTabs || []).find((tab) => tab.id === targetTabRef.id);
		if (!terminalTab) return null;

		// If already active, return current state (with repair if needed)
		if (session.activeTerminalTabId === targetTabRef.id && session.activeGroupId == null) {
			return {
				type: 'terminal',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		// activeGroupId is cleared so an active tiled group stops taking over the panel.
		return {
			type: 'terminal',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeTerminalTabId: targetTabRef.id,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeGroupId: null,
				inputMode: 'terminal',
			},
		};
	}
}

/**
 * Activate a specific tab by its kind and id, reusing the per-kind field logic
 * in navigateToUnifiedTabByIndex. Returns null when the tab no longer exists.
 *
 * Used by breadcrumb navigation (back/forward) to restore a previously-visited
 * tab of any kind (ai, file, browser, terminal).
 *
 * @param session - The Maestro session
 * @param tabKind - The kind of tab to activate
 * @param tabId - The id of the tab to activate
 */
export function navigateToUnifiedTabById(
	session: Session,
	tabKind: UnifiedTabRef['type'],
	tabId: string
): NavigateToUnifiedTabResult | null {
	const order = getRepairedUnifiedTabOrder(session);
	const index = order.findIndex((ref) => ref.type === tabKind && ref.id === tabId);
	if (index === -1) return null;
	// Pass showUnreadOnly=false: breadcrumb restore must reach the exact tab
	// regardless of the unread filter, and index is taken from the same
	// repaired order navigateToUnifiedTabByIndex uses in that mode.
	return navigateToUnifiedTabByIndex(session, index, false);
}

/**
 * Navigate to the last tab in the unified tab order.
 * Used for Cmd+0 shortcut.
 *
 * @param session - The Maestro session
 * @returns Object with the tab type, id, and updated session, or null if no tabs
 */
export function navigateToLastUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are reachable via Cmd+0
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length === 0) {
		return null;
	}

	// When unread filter is active, "last" means the last tab currently shown in the tab bar.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;

	// Find the last valid tab, skipping orphaned entries
	for (let i = effectiveOrder.length - 1; i >= 0; i--) {
		const result = navigateToUnifiedTabByIndex(session, i, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Get the current index in the unified tab order.
 * Returns the index of the currently active tab (file tab if active, otherwise AI tab).
 *
 * @param session - The Maestro session
 * @returns The index in unifiedTabOrder, or -1 if not found
 */
function getCurrentUnifiedTabIndex(session: Session, effectiveOrder?: UnifiedTabRef[]): number {
	const order = effectiveOrder || getRepairedUnifiedTabOrder(session);
	return findActiveUnifiedTabIndex(session, order);
}

/**
 * Navigate to the next tab in the unified tab order.
 * Cycles through AI, file, terminal, and browser tabs in their visual order with wrap-around.
 *
 * When showUnreadOnly is true, walks within the same filtered list TabBar renders
 * (via filterUnifiedTabOrderForUnread) so keyboard navigation and display never diverge.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, cycle only through tabs visible under the unread filter
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 */
export function navigateToNextUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are included (consistent with tab bar rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length < 2) {
		return null;
	}

	// When the unread filter is on, walk within the exact list TabBar renders — the shared
	// filter is the single source of truth so navigation and display can never drift.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;
	if (effectiveOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	const length = effectiveOrder.length;

	// If current tab isn't in the visible list, land on the first visible tab
	if (currentIndex === -1) {
		return navigateToUnifiedTabByIndex(session, 0, showUnreadOnly);
	}

	for (let offset = 1; offset < length; offset++) {
		const nextIndex = (currentIndex + offset) % length;
		const result = navigateToUnifiedTabByIndex(session, nextIndex, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Navigate to the previous tab in the unified tab order.
 * Cycles through AI, file, terminal, and browser tabs in their visual order with wrap-around.
 *
 * When showUnreadOnly is true, walks within the same filtered list TabBar renders
 * (via filterUnifiedTabOrderForUnread) so keyboard navigation and display never diverge.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, cycle only through tabs visible under the unread filter
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 */
export function navigateToPrevUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are included (consistent with tab bar rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length < 2) {
		return null;
	}

	// When the unread filter is on, walk within the exact list TabBar renders — the shared
	// filter is the single source of truth so navigation and display can never drift.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;
	if (effectiveOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	const length = effectiveOrder.length;

	// If current tab isn't in the visible list, land on the last visible tab
	if (currentIndex === -1) {
		return navigateToUnifiedTabByIndex(session, length - 1, showUnreadOnly);
	}

	for (let offset = 1; offset < length; offset++) {
		const prevIndex = (currentIndex - offset + length) % length;
		const result = navigateToUnifiedTabByIndex(session, prevIndex, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Navigate to the closest terminal tab in the unified tab order.
 * Searches outward from the current position, alternating right then left.
 * If no current tab is found, returns the first terminal tab.
 *
 * @param session - The Maestro session
 * @returns Object with the tab type, id, and updated session, or null if no terminal tabs exist
 */
export function navigateToClosestTerminalTab(session: Session): NavigateToUnifiedTabResult | null {
	const effectiveOrder = getRepairedUnifiedTabOrder(session);
	if (!session || effectiveOrder.length === 0) return null;

	// Find all terminal tab indices
	const terminalIndices: number[] = [];
	for (let i = 0; i < effectiveOrder.length; i++) {
		if (effectiveOrder[i].type === 'terminal') {
			terminalIndices.push(i);
		}
	}
	if (terminalIndices.length === 0) return null;

	// If already on a terminal tab, cycle to the next terminal tab (wrapping around)
	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	if (currentIndex >= 0 && effectiveOrder[currentIndex]?.type === 'terminal') {
		if (terminalIndices.length === 1) {
			return navigateToUnifiedTabByIndex(session, currentIndex);
		}
		const currentPos = terminalIndices.indexOf(currentIndex);
		const nextPos = (currentPos + 1) % terminalIndices.length;
		return navigateToUnifiedTabByIndex(session, terminalIndices[nextPos]);
	}

	// Find closest terminal tab by distance from current position
	if (currentIndex >= 0) {
		let closest = terminalIndices[0];
		let minDist = Math.abs(currentIndex - closest);
		for (let i = 1; i < terminalIndices.length; i++) {
			const dist = Math.abs(currentIndex - terminalIndices[i]);
			if (dist < minDist) {
				minDist = dist;
				closest = terminalIndices[i];
			}
		}
		return navigateToUnifiedTabByIndex(session, closest);
	}

	// Fallback: navigate to first terminal tab
	return navigateToUnifiedTabByIndex(session, terminalIndices[0]);
}

/**
 * Options for creating a new AI tab at a specific position.
 */
export interface CreateTabAtPositionOptions extends CreateTabOptions {
	/** Insert the new tab after this tab ID */
	afterTabId: string;
}

/**
 * Create a new AI tab at a specific position in the session's tab list.
 * The new tab is inserted immediately after the specified tab.
 *
 * @param session - The Maestro session to add the tab to
 * @param options - Tab configuration including position (afterTabId)
 * @returns Object containing the new tab and updated session, or null on error
 *
 * @example
 * // Create a compacted tab right after the source tab
 * const result = createTabAtPosition(session, {
 *   afterTabId: sourceTab.id,
 *   name: 'Session Compacted 2024-01-15',
 *   logs: summarizedLogs,
 * });
 */
export function createTabAtPosition(
	session: Session,
	options: CreateTabAtPositionOptions
): CreateTabResult | null {
	const result = createTab(session, options);
	if (!result) return null;

	// Find the index of the afterTabId
	const afterIndex = result.session.aiTabs.findIndex((t) => t.id === options.afterTabId);
	if (afterIndex === -1) return result;

	// Move the new tab to be right after afterTabId
	const tabs = [...result.session.aiTabs];
	const newTabIndex = tabs.findIndex((t) => t.id === result.tab.id);

	// Only move if the new tab isn't already in the right position
	if (newTabIndex !== afterIndex + 1) {
		const [newTab] = tabs.splice(newTabIndex, 1);
		tabs.splice(afterIndex + 1, 0, newTab);
	}

	return {
		tab: result.tab,
		session: { ...result.session, aiTabs: tabs },
	};
}

/**
 * Options for creating a merged session from multiple context sources.
 */
export interface CreateMergedSessionOptions {
	/** Name for the new merged session */
	name: string;
	/** Project root directory for the new session */
	projectRoot: string;
	/** Agent type for the new session */
	toolType: ToolType;
	/** Pre-merged conversation logs to initialize the tab with */
	mergedLogs: LogEntry[];
	/** Aggregated usage stats from merged contexts (optional) */
	usageStats?: UsageStats;
	/** Group ID to assign the session to (optional) */
	groupId?: string;
	/** Whether to save completions to history (default: true) */
	saveToHistory?: boolean;
	/** Thinking display mode: 'off' | 'on' (temporary) | 'sticky' (persistent) */
	showThinking?: ThinkingMode;
}

/**
 * Result of creating a merged session.
 */
export interface CreateMergedSessionResult {
	/** The newly created session with merged context */
	session: Session;
	/** The ID of the active tab in the new session */
	tabId: string;
}

/**
 * Create a new Maestro session pre-populated with merged context logs.
 * This is used when merging multiple sessions/tabs into a unified context
 * or when transferring context to a different agent type.
 *
 * The merged session is created with:
 * - A single tab containing the merged logs
 * - State set to 'idle' (ready to receive new input)
 * - Standard session structure matching App.tsx createNewSession pattern
 *
 * @param options - Configuration for the merged session
 * @returns Object containing the new session and its active tab ID
 *
 * @example
 * const { session, tabId } = createMergedSession({
 *   name: 'Merged Context',
 *   projectRoot: '/path/to/project',
 *   toolType: 'claude-code',
 *   mergedLogs: groomedLogs,
 *   usageStats: combinedStats
 * });
 * // Add session to app state and initialize agent
 */
export function createMergedSession(
	options: CreateMergedSessionOptions
): CreateMergedSessionResult {
	const {
		name,
		projectRoot,
		toolType,
		mergedLogs,
		usageStats,
		groupId,
		saveToHistory = true,
		showThinking = 'off',
	} = options;

	const sessionId = generateId();
	const tabId = generateId();

	// Create the initial tab with merged logs
	const mergedTab: AITab = {
		id: tabId,
		agentSessionId: null, // Will be assigned when agent spawns
		name: null, // Auto-generated name based on session UUID octet
		starred: false,
		logs: mergedLogs,
		inputValue: '',
		stagedImages: [],
		usageStats,
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory,
		showThinking,
	};

	// Create the merged session with standard structure
	// Matches the pattern from App.tsx createNewSession
	const initialMergeTerminalTab = createTerminalTab(
		useSettingsStore.getState().defaultShell || (isWindowsPlatform() ? 'powershell' : 'zsh'),
		projectRoot,
		null
	);
	const session: Session = {
		id: sessionId,
		name,
		groupId,
		toolType,
		state: 'idle',
		cwd: projectRoot,
		fullPath: projectRoot,
		projectRoot, // Never changes, used for session storage
		createdAt: Date.now(),
		isGitRepo: false, // Will be updated by caller if needed
		aiLogs: [], // Deprecated - logs are in aiTabs
		shellLogs: [
			{
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: 'Merged Context Session Ready.',
			},
		],
		workLog: [],
		contextUsage: 0,
		inputMode: toolType === 'terminal' ? 'terminal' : 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(Math.random() * 100),
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180, // Default: auto-refresh every 3 minutes
		shellCwd: projectRoot,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [mergedTab],
		activeTabId: tabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [initialMergeTerminalTab],
		activeTerminalTabId: null,
		unifiedTabOrder: [
			{ type: 'ai' as const, id: tabId },
			{ type: 'terminal' as const, id: initialMergeTerminalTab.id },
		],
		unifiedClosedTabHistory: [],
		tabGroups: [],
		activeGroupId: null,
		// Default Auto Run folder path (user can change later)
		autoRunFolderPath: getAutoRunFolderPath(projectRoot),
		claudeInteractive: toolType === 'claude-code' ? { mode: 'api', modeReason: 'auto' } : undefined,
	};

	return { session, tabId };
}

/**
 * Result of goToNextUnreadTab navigation.
 * - `jumped`: true if we switched to a different session
 * - `clearedCurrent`: true if we cleared the current session's unread tabs
 * - `targetSessionId`: the session ID we jumped to (if jumped)
 * - `targetTabId`: the tab ID to activate in the target session (if jumped)
 */
export interface GoToNextUnreadResult {
	jumped: boolean;
	clearedCurrent: boolean;
	targetSessionId?: string;
	targetTabId?: string;
}

/**
 * Compute the next unread/draft tab to jump to. Prefers a non-active actionable
 * tab in the current session (tab-level jump, no session change); otherwise
 * searches forward through other sessions in the ordered list, wrapping around.
 *
 * A tab with an active inline wizard counts as actionable: an unfinished wizard
 * is effectively a draft (it's meant to be completed into an Auto Run doc), so
 * the navigation should stop on it. Pass `isWizardActive` to opt into that.
 *
 * Does NOT mutate state — the caller applies the result via setSessions/setActiveSessionId.
 */
export function findNextUnreadSession(
	orderedSessions: Session[],
	activeSessionId: string,
	isWizardActive?: (tabId: string) => boolean
): GoToNextUnreadResult {
	const currentIndex = orderedSessions.findIndex((s) => s.id === activeSessionId);
	const currentSession = orderedSessions.find((s) => s.id === activeSessionId);
	const isActionable = (tab: AITab) =>
		tab.hasUnread || hasDraft(tab) || (isWizardActive?.(tab.id) ?? false);

	// 1) Tab-level jump within the current session: if there's an unread/draft
	//    tab here that isn't already active, switch to it without changing
	//    sessions. The shortcut is called "Next Unread / Draft *Tab*" — staying
	//    in the same session is the closest "next" when one exists.
	if (currentSession) {
		const inSessionTarget = currentSession.aiTabs?.find(
			(t) => t.id !== currentSession.activeTabId && isActionable(t)
		);
		if (inSessionTarget) {
			return {
				jumped: true,
				clearedCurrent: false,
				targetSessionId: currentSession.id,
				targetTabId: inSessionTarget.id,
			};
		}
	}

	const currentHasUnread = currentSession?.aiTabs?.some(isActionable) ?? false;

	// 2) Search forward through other sessions, wrapping around.
	for (let i = 1; i <= orderedSessions.length; i++) {
		const candidate = orderedSessions[(currentIndex + i) % orderedSessions.length];
		if (candidate.id !== activeSessionId && candidate.aiTabs?.some(isActionable)) {
			const firstUnreadTab = candidate.aiTabs.find(isActionable);
			return {
				jumped: true,
				clearedCurrent: currentHasUnread,
				targetSessionId: candidate.id,
				targetTabId: firstUnreadTab?.id !== candidate.activeTabId ? firstUnreadTab?.id : undefined,
			};
		}
	}

	// Nothing actionable elsewhere. Don't silently clear the current session's
	// unread flags — if the user can see an unread badge here, they should be
	// able to find it (it would have been handled by step 1 above when present).
	return {
		jumped: false,
		clearedCurrent: false,
	};
}
