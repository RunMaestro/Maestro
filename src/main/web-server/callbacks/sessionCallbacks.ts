import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import type { Group } from '../../../shared/types';
import { asThinkingMode } from '../../../shared/types';
import { getSessionIdsBusyWithCli } from '../../../shared/cli-activity';
import { isAiTabProcessActive } from '../../utils/agent-busy';
import { isImageRef, resolveToDataUrlSync } from '../../storage/session-image-store';

export function registerSessionCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'sessionsStore' | 'groupsStore' | 'getProcessManager'>
): void {
	const { sessionsStore, groupsStore, getProcessManager } = deps;

	// Set up callback for web server to fetch sessions list
	server.setGetSessionsCallback(() => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const groups = groupsStore.get<Group[]>('groups', []);
		return sessions.map((s) => {
			// Find the group for this session
			const group = s.groupId ? groups.find((g) => g.id === s.groupId) : null;

			// Extract last AI response for mobile preview (first 3 lines, max 500 chars)
			// Use active tab's logs as the source of truth
			let lastResponse = null;
			const activeTab = s.aiTabs?.find((t: any) => t.id === s.activeTabId) || s.aiTabs?.[0];
			const tabLogs = activeTab?.logs || [];
			if (tabLogs.length > 0) {
				// Find the last stdout/stderr entry from the AI (not user messages)
				// Note: 'thinking' logs are already excluded since they have a distinct source type
				const lastAiLog = [...tabLogs]
					.reverse()
					.find((log: any) => log.source === 'stdout' || log.source === 'stderr');
				if (lastAiLog && lastAiLog.text) {
					const fullText = lastAiLog.text;
					// Get first 3 lines or 500 chars, whichever is shorter
					const lines = fullText.split('\n').slice(0, 3);
					let previewText = lines.join('\n');
					if (previewText.length > 500) {
						previewText = previewText.slice(0, 497) + '...';
					} else if (fullText.length > previewText.length) {
						previewText = previewText + '...';
					}
					lastResponse = {
						text: previewText,
						timestamp: lastAiLog.timestamp,
						source: lastAiLog.source,
						fullLength: fullText.length,
					};
				}
			}

			// Map aiTabs to web-safe format (strip logs to reduce payload)
			const aiTabs =
				s.aiTabs?.map((tab: any) => ({
					id: tab.id,
					agentSessionId: tab.agentSessionId || null,
					name: tab.name || null,
					starred: tab.starred || false,
					inputValue: tab.inputValue || '',
					usageStats: tab.usageStats || null,
					createdAt: tab.createdAt,
					state: tab.state || 'idle',
					thinkingStartTime: tab.thinkingStartTime || null,
					hasUnread: tab.hasUnread ?? false,
				})) || [];

			return {
				id: s.id,
				name: s.name,
				toolType: s.toolType,
				state: s.state,
				inputMode: s.inputMode,
				cwd: s.cwd,
				// Claude token-source selection, so web-initiated group chat
				// participants honor the maestro-p TUI / API / dynamic choice.
				enableMaestroP: s.enableMaestroP,
				maestroPMode: s.maestroPMode,
				maestroPPath: s.maestroPPath,
				groupId: s.groupId || null,
				groupName: group?.name || null,
				groupEmoji: group?.emoji || null,
				usageStats: s.usageStats || null,
				lastResponse,
				agentSessionId: s.agentSessionId || null,
				thinkingStartTime: s.thinkingStartTime || null,
				aiTabs,
				activeTabId: s.activeTabId || (aiTabs.length > 0 ? aiTabs[0].id : undefined),
				bookmarked: s.bookmarked || false,
				// Worktree subagent support
				parentSessionId: s.parentSessionId || null,
				worktreeBranch: s.worktreeBranch || null,
				isGitRepo: s.isGitRepo ?? false,
				worktreeBasePath: s.worktreeConfig?.basePath || null,
				// Auto Run folder - exposes the session's configured `.maestro/`
				// playbook folder to web clients so the folder picker can show
				// the current selection.
				autoRunFolderPath: s.autoRunFolderPath || null,
			};
		});
	});

	// `maestro-cli session list` - flatten all open AI tabs into addressable
	// entries. The CLI does not need group/cwd metadata; the structurally
	// smaller payload keeps polling cheap. Reads straight from the persisted
	// session store (same source the renderer pushes to via `sessions:save`),
	// then reconciles it with live managed-process and CLI-activity evidence.
	server.setListDesktopSessionsCallback(() => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const processManager = getProcessManager();
		// Resolved once: this used to be a per-agent call that re-read and
		// re-parsed the CLI activity file on every iteration.
		const cliBusySessionIds = getSessionIdsBusyWithCli();
		const entries = [];
		for (const s of sessions) {
			const aiTabs = (s.aiTabs as Array<Record<string, any>> | undefined) ?? [];
			const cliBusy = cliBusySessionIds.has(s.id);
			for (const tab of aiTabs) {
				if (!tab || typeof tab.id !== 'string') continue;
				const isActiveTab = tab.id === s.activeTabId;
				const managedProcessActive = isAiTabProcessActive(
					processManager,
					s.id,
					tab.id,
					isActiveTab
				);
				const processActive = managedProcessActive || (isActiveTab && cliBusy);
				const state =
					tab.state === 'busy' || processActive
						? ('busy' as const)
						: tab.state === 'idle'
							? ('idle' as const)
							: ('unknown' as const);
				entries.push({
					tabId: tab.id,
					sessionId: tab.id,
					agentId: s.id,
					agentName: s.name,
					toolType: s.toolType,
					name: typeof tab.name === 'string' ? tab.name : null,
					agentSessionId: typeof tab.agentSessionId === 'string' ? tab.agentSessionId : null,
					state,
					createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : 0,
					starred: tab.starred === true,
					active: isActiveTab,
					hasUnread: tab.hasUnread === true,
					saveToHistory: tab.saveToHistory === true,
					readOnly: tab.readOnlyMode === true,
					thinking: asThinkingMode(tab.showThinking) ?? 'off',
					// `null` (not `false`) is the honest answer for the three
					// inheriting fields: the tab has no override and follows the
					// agent's model/effort or the global enter-to-send setting.
					model: typeof tab.customModel === 'string' ? tab.customModel : null,
					effort: typeof tab.customEffort === 'string' ? tab.customEffort : null,
					enterToSend: typeof tab.enterToSend === 'boolean' ? tab.enterToSend : null,
				});
			}
		}
		return entries;
	});

	// `maestro-cli session show <tabId>` - return the tab's conversation
	// history with optional `--since` (poll cursor) and `--tail` (cap)
	// filters applied here so the CLI never receives more than it asked for.
	// `LogEntry.source` values map to a coarse `role` for conversational
	// consumers (Discord bots); the raw `source` is preserved alongside so
	// callers that want finer detail (tool vs assistant text) can still
	// discriminate. `stdout` is treated as `assistant` because legacy /
	// non-AI agent flows store assistant replies under that source.
	server.setGetSessionHistoryCallback((tabId, options) => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		for (const s of sessions) {
			const aiTabs = (s.aiTabs as Array<Record<string, any>> | undefined) ?? [];
			const tab = aiTabs.find((t) => t && t.id === tabId);
			if (!tab) continue;
			const rawLogs = (tab.logs as Array<Record<string, any>> | undefined) ?? [];
			let logs = rawLogs;
			if (options?.sinceMs !== undefined) {
				const cutoff = options.sinceMs;
				logs = logs.filter((l) => typeof l.timestamp === 'number' && l.timestamp > cutoff);
			}
			if (options?.tail !== undefined && options.tail >= 0) {
				// `slice(-0)` is identical to `slice(0)` (because `-0 === 0`),
				// which would silently return the full transcript when the
				// caller asked for zero messages. Compute the start index
				// explicitly so `tail: 0` yields `[]`.
				logs = logs.slice(Math.max(logs.length - options.tail, 0));
			}
			const messages = logs.map((l) => {
				const source = typeof l.source === 'string' ? l.source : 'unknown';
				const tsMs = typeof l.timestamp === 'number' ? l.timestamp : 0;
				let role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'error' | 'unknown';
				switch (source) {
					case 'user':
						role = 'user';
						break;
					case 'ai':
					case 'stdout':
						role = 'assistant';
						break;
					case 'thinking':
						role = 'thinking';
						break;
					case 'tool':
						role = 'tool';
						break;
					case 'system':
						role = 'system';
						break;
					case 'error':
					case 'stderr':
						role = 'error';
						break;
					default:
						role = 'unknown';
				}
				return {
					id: typeof l.id === 'string' ? l.id : `${tab.id}-${tsMs}`,
					role,
					source,
					content: typeof l.text === 'string' ? l.text : '',
					timestamp: new Date(tsMs).toISOString(),
				};
			});
			return {
				tabId,
				sessionId: tabId,
				agentId: s.id,
				agentSessionId: typeof tab.agentSessionId === 'string' ? tab.agentSessionId : null,
				projectPath: typeof s.cwd === 'string' ? s.cwd : undefined,
				messages,
			};
		}
		return null;
	});

	// Set up callback for web server to fetch single session details
	// Optional tabId param allows fetching logs for a specific tab (avoids race conditions)
	server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) return null;

		// Get the requested tab's logs (or active tab if no tabId provided)
		// Tabs are the source of truth for AI conversation history
		// AI logs include thinking and tool entries for UX parity with desktop
		let aiLogs: any[] = [];
		const targetTabId = tabId || session.activeTabId;
		if (session.aiTabs && session.aiTabs.length > 0) {
			const targetTab = session.aiTabs.find((t: any) => t.id === targetTabId);
			// If a specific tabId was requested but not found, return empty logs
			// (avoids showing stale history from another tab during new tab creation race)
			if (!targetTab && tabId) {
				aiLogs = [];
			} else {
				const rawLogs = (targetTab || session.aiTabs[0])?.logs || [];
				// Include thinking and tool logs for UX parity with desktop.
				// Web/mobile clients run in a plain browser and can't load the
				// maestro-image protocol, so resolve any relocated image refs back
				// to inline data URLs for transport (desktop keeps the lean ref).
				aiLogs = rawLogs.map((log: any) => {
					if (!Array.isArray(log?.images) || log.images.length === 0) return log;
					const hasRef = log.images.some((img: unknown) => isImageRef(img as string));
					if (!hasRef) return log;
					return {
						...log,
						images: log.images
							.map((img: string) => resolveToDataUrlSync(img))
							.filter((img: string | null): img is string => img !== null),
					};
				});
			}
		}

		return {
			id: session.id,
			name: session.name,
			toolType: session.toolType,
			state: session.state,
			inputMode: session.inputMode,
			cwd: session.cwd,
			aiLogs,
			shellLogs: session.shellLogs || [],
			usageStats: session.usageStats,
			agentSessionId: session.agentSessionId,
			isGitRepo: session.isGitRepo,
			activeTabId: targetTabId,
		};
	});
}
