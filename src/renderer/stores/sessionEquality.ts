import type { AITab, Session } from '../types';

// Fields on Session that the sidebar (SessionList, useSessionCategories) actually
// reads to render. Streaming-heavy fields (aiLogs, shellLogs, workLog, usageStats,
// contextUsage, currentCycleBytes, currentCycleTokens, fileTree, etc.) are
// excluded so that log streaming does not bust the equality check and force a
// sidebar re-render every 200 ms batched flush.
function aiTabEqual(a: AITab, b: AITab): boolean {
	if (a === b) return true;
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.state === b.state &&
		a.starred === b.starred &&
		a.hasUnread === b.hasUnread &&
		a.readOnlyMode === b.readOnlyMode &&
		a.agentSessionId === b.agentSessionId
	);
}

/**
 * Equality function for `useStoreWithEqualityFn(useSessionStore, s => s.sessions, ...)`.
 *
 * Returns true when the two arrays are sidebar-equivalent - i.e. nothing the
 * left-bar / categorization layer cares about has changed. This lets the
 * batched session-update flush rebuild the array reference every 200 ms without
 * forcing the sidebar tree to re-render unless a user-visible field actually
 * changed (name, state, bookmark, group membership, worktree expansion, AI tab
 * busy/unread state, etc.).
 */
export function sidebarSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.name !== y.name ||
			x.state !== y.state ||
			x.toolType !== y.toolType ||
			x.bookmarked !== y.bookmarked ||
			x.groupId !== y.groupId ||
			x.parentSessionId !== y.parentSessionId ||
			x.worktreesExpanded !== y.worktreesExpanded ||
			x.worktreeBranch !== y.worktreeBranch ||
			x.isGitRepo !== y.isGitRepo ||
			x.isLive !== y.isLive ||
			x.inputMode !== y.inputMode ||
			x.activeTabId !== y.activeTabId
		) {
			return false;
		}

		const ax = x.aiTabs;
		const bx = y.aiTabs;
		if (ax !== bx) {
			if (!ax || !bx) return false;
			if (ax.length !== bx.length) return false;
			for (let j = 0; j < ax.length; j++) {
				if (!aiTabEqual(ax[j], bx[j])) return false;
			}
		}
	}

	return true;
}

/**
 * Fields useGitStatusPolling reads for poll cwd / SSH / isGitRepo gating.
 * Ignores logs, tokens, and other streaming-heavy fields.
 */
export function gitPollSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.isGitRepo !== y.isGitRepo ||
			x.inputMode !== y.inputMode ||
			x.cwd !== y.cwd ||
			x.shellCwd !== y.shellCwd ||
			x.sshRemoteId !== y.sshRemoteId ||
			x.sessionSshRemoteConfig?.remoteId !== y.sessionSshRemoteConfig?.remoteId
		) {
			return false;
		}
	}

	return true;
}

/**
 * Fields GroupChat @mention autocomplete needs (id, name, toolType, groupId).
 */
export function mentionSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.name !== y.name ||
			x.toolType !== y.toolType ||
			x.groupId !== y.groupId
		) {
			return false;
		}
	}

	return true;
}

/**
 * Fields that need a live id → projectRoot map (e.g. GroupChat participant paths).
 * Ignores logs, tokens, and other streaming-heavy fields. Unlike
 * `sidebarSessionEquality`, this *does* compare `projectRoot`.
 */
export function projectRootSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (x.id !== y.id || x.projectRoot !== y.projectRoot) {
			return false;
		}
	}

	return true;
}

/**
 * Compact signature of session id + projectRoot for Cue auto-discovery.
 * Changes only when agents are added/removed or their project root moves.
 */
export function selectCueDiscoverySignature(state: { sessions: Session[] }): string {
	return state.sessions.map((s) => `${s.id}\0${s.projectRoot ?? ''}`).join('\n');
}

/**
 * AI-tab fields needed for App shell chrome when a host still holds a chrome Session.
 * Deliberately omits `logs` / thinking chunks so streaming does not bust equality.
 * Also omits tab `state` / `isGeneratingName` / session `state` - those belong to
 * paint leaves (MainPanel / SessionList sidebar equality), not MaestroConsoleInner.
 */
function aiTabChromeEqual(a: AITab, b: AITab): boolean {
	if (a === b) return true;
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.starred === b.starred &&
		a.hasUnread === b.hasUnread &&
		a.readOnlyMode === b.readOnlyMode &&
		a.saveToHistory === b.saveToHistory &&
		a.showThinking === b.showThinking &&
		a.enterToSend === b.enterToSend &&
		a.agentSessionId === b.agentSessionId &&
		a.autoSendOnActivate === b.autoSendOnActivate &&
		a.customModel === b.customModel &&
		a.customEffort === b.customEffort &&
		!!a.pendingMergedContext === !!b.pendingMergedContext &&
		a.agentError?.timestamp === b.agentError?.timestamp &&
		a.agentError?.message === b.agentError?.message
	);
}

/**
 * Equality for the active agent when held by MaestroConsoleInner / remaining App shell.
 *
 * Returns true when nothing the shell needs for layout, title bar, or modal flags has
 * changed. Streaming fields (logs, tokens, contextUsage, fileTree, workLog, etc.) and
 * busy/thinking chrome (`state`, tab `state`, `isGeneratingName`) are ignored so
 * send/reply and log flushes do not re-render the whole console. Tab-strip busy /
 * naming spinners live in MainPanel (full session) and the Left Bar (sidebar equality).
 *
 * Invariant: any consumer of this chrome-gated slice must not read fields absent
 * from this comparator (or those fields go silently stale). Paint/data leaves that
 * need omitted fields (MainPanel logs, useFileTreeManagement.fileTree, summarize
 * eligibility via contextUsage/logs) must self-subscribe with their own selector
 * or read getState() at event time - same pattern as MainPanel.
 */
export function activeSessionChromeEquality(a: Session | null, b: Session | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;

	if (
		a.id !== b.id ||
		a.name !== b.name ||
		a.groupId !== b.groupId ||
		a.toolType !== b.toolType ||
		a.inputMode !== b.inputMode ||
		a.cwd !== b.cwd ||
		a.shellCwd !== b.shellCwd ||
		a.parentSessionId !== b.parentSessionId ||
		a.isGitRepo !== b.isGitRepo ||
		a.isPianola !== b.isPianola ||
		a.activeTabId !== b.activeTabId ||
		a.activeFileTabId !== b.activeFileTabId ||
		a.activeBrowserTabId !== b.activeBrowserTabId ||
		a.activeTerminalTabId !== b.activeTerminalTabId ||
		a.activeGroupId !== b.activeGroupId ||
		a.autoRunFolderPath !== b.autoRunFolderPath ||
		a.autoRunSelectedFile !== b.autoRunSelectedFile ||
		a.fileExplorerExpanded !== b.fileExplorerExpanded ||
		a.customModel !== b.customModel ||
		a.customEffort !== b.customEffort ||
		a.projectRoot !== b.projectRoot ||
		a.fullPath !== b.fullPath ||
		a.sshRemoteId !== b.sshRemoteId ||
		a.sessionSshRemoteConfig?.remoteId !== b.sessionSshRemoteConfig?.remoteId ||
		a.sessionSshRemoteConfig?.enabled !== b.sessionSshRemoteConfig?.enabled
	) {
		return false;
	}

	const aiA = a.aiTabs;
	const aiB = b.aiTabs;
	if (aiA !== aiB) {
		if (!aiA || !aiB || aiA.length !== aiB.length) return false;
		for (let i = 0; i < aiA.length; i++) {
			if (!aiTabChromeEqual(aiA[i], aiB[i])) return false;
		}
	}

	if (a.filePreviewTabs !== b.filePreviewTabs) {
		const fa = a.filePreviewTabs;
		const fb = b.filePreviewTabs;
		if (!fa || !fb || fa.length !== fb.length) return false;
		for (let i = 0; i < fa.length; i++) {
			const x = fa[i];
			const y = fb[i];
			if (
				x.id !== y.id ||
				x.name !== y.name ||
				x.path !== y.path ||
				x.editMode !== y.editMode ||
				x.navigationIndex !== y.navigationIndex ||
				(x.navigationHistory?.length ?? 0) !== (y.navigationHistory?.length ?? 0)
			) {
				return false;
			}
		}
	}

	if (a.browserTabs !== b.browserTabs) {
		const ba = a.browserTabs;
		const bb = b.browserTabs;
		if ((ba?.length ?? 0) !== (bb?.length ?? 0)) return false;
		if (ba && bb) {
			for (let i = 0; i < ba.length; i++) {
				if (
					ba[i].id !== bb[i].id ||
					ba[i].title !== bb[i].title ||
					ba[i].url !== bb[i].url ||
					ba[i].customTitle !== bb[i].customTitle
				) {
					return false;
				}
			}
		}
	}

	if (a.terminalTabs !== b.terminalTabs) {
		const ta = a.terminalTabs;
		const tb = b.terminalTabs;
		if ((ta?.length ?? 0) !== (tb?.length ?? 0)) return false;
		if (ta && tb) {
			for (let i = 0; i < ta.length; i++) {
				if (ta[i].id !== tb[i].id || ta[i].name !== tb[i].name) return false;
			}
		}
	}

	if (a.unifiedTabOrder !== b.unifiedTabOrder) {
		const ua = a.unifiedTabOrder;
		const ub = b.unifiedTabOrder;
		if ((ua?.length ?? 0) !== (ub?.length ?? 0)) return false;
		if (ua && ub) {
			for (let i = 0; i < ua.length; i++) {
				if (ua[i].type !== ub[i].type || ua[i].id !== ub[i].id) return false;
			}
		}
	}

	if (a.tabGroups !== b.tabGroups) {
		const ga = a.tabGroups;
		const gb = b.tabGroups;
		if ((ga?.length ?? 0) !== (gb?.length ?? 0)) return false;
		if (ga && gb) {
			for (let i = 0; i < ga.length; i++) {
				if (ga[i].id !== gb[i].id || ga[i].name !== gb[i].name) return false;
			}
		}
	}

	if (a.agentCommands !== b.agentCommands) {
		const ca = a.agentCommands;
		const cb = b.agentCommands;
		if ((ca?.length ?? 0) !== (cb?.length ?? 0)) return false;
		if (ca && cb) {
			for (let i = 0; i < ca.length; i++) {
				if (ca[i].command !== cb[i].command || ca[i].description !== cb[i].description) {
					return false;
				}
			}
		}
	}

	return true;
}
