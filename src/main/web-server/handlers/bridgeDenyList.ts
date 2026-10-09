/**
 * Owner-operator remote surface, shared by existing web-desktop and Lite.
 * Exact inventory: new IPC registrations are NOT automatically remote APIs.
 * Host lifecycle, security administration, native client UI, trusted renderer
 * request/reply channels and credential management are deliberately absent.
 */
const METHODS: Record<string, string> = {
	agent: 'clearError retryAfterError',
	agentRun: 'cancel event events list merge record resolveFinding retry show',
	agentSessions:
		'deleteMessagePair getAllNamedSessions getAvailableStorages getGlobalStats getOrigins getPath hasStorage list listPaginated read releaseSnoozedTranscript search setSessionName setSessionStarred snapshotStarredTranscript',
	agents:
		'consumeCodexResetCredit detect discoverSlashCommands get getAllCapabilities getAllCustomArgs getAllCustomEnvVars getAllCustomPaths getAllSnapshots getCapabilities getClaudeUsageAccountKeys getClaudeUsageSnapshots getCodexResetCredits getCodexUsageAccountKeys getCodexUsageSnapshots getConfig getConfigOptions getConfigValue getCustomArgs getCustomEnvVars getCustomPath getKnownAuthDirs getKnownEnvVarKeys getLimitResetAt getMaestroPDetectedPath getModels getRemoteMaestroPAvailable getSnapshot refresh reprobe setConfig setConfigValue setCustomArgs setCustomPath',
	aiCommand: 'suggest',
	attachments: 'delete getPath list load save',
	autorun:
		'createBackup createWorkingCopy deleteBackups deleteFolder deleteImage hasDocuments listDocs listImages readDoc replaceImage restoreBackup saveImage unwatchFolder unwatchStatus watchFolder watchStatus writeDoc',
	bmad: 'getCommand getMetadata getPrompts refresh resetPrompt savePrompt',
	browser: 'clearSessionData createTab relayAction relayClose relayFrame relayInput relayOpen',
	campaign: 'list record show',
	claude:
		'deleteMessagePair getAllNamedSessions getCommands getGlobalStats getProjectStats getSessionOrigins getSessionTimestamps getSkills listSessions listSessionsPaginated readSessionMessages registerSessionOrigin searchSessions updateSessionContextUsage updateSessionName updateSessionStarred usage:refresh-all',
	cli: 'getActivity',
	codex: 'usage:refresh-all',
	'concerto-html': 'release restore',
	context:
		'cancelGrooming cleanupGroomingSession createGroomingSession getStoredSession groomContext sendGroomingPrompt',
	contextTimeline: 'clearCaptures getCaptures',
	coworking: 'getInstallStatus removeSession',
	'cross-agent': 'cancel send',
	'cue-stats': 'get-aggregation get-historical-conductor-credit',
	cue: 'cancelScheduledTask createScheduledTask deleteYaml disable enable getActiveRuns getActivityLog getEventCount getFanInHealth getGraphData getMetrics getQueueStatus getRunLiveOutput getSettings getStatus listScheduledTasks loadPipelineLayout readYaml refreshSession removeSession renamePipeline savePipelineLayout saveSettings setActive stopAll stopRun triggerSubscription updateScheduledTask validateYaml writeYaml',
	cueBackup: 'create delete getDiffStatus inspect list readFile readLive restoreAll restoreFile',
	'director-notes':
		'generateSynopsis getGraphData getOffsetForTimestamp getRichOverviewStats getUnifiedHistory',
	documentGraph: 'unwatchFolder watchFolder',
	feedback:
		'check-gh-auth compose-prompt drafts:delete drafts:list drafts:save get-conversation-prompt issues:delete issues:list issues:refresh-states search-issues submit submit-conversation subscribe-issue',
	fonts: 'detect',
	fs: 'cancelReadFile compressFolder copyPath countItems delete deleteMany directoryInfo directorySize downloadRemoteFile fetchImageAsBase64 homeDir listTreeRemote mkdir readDir readDirTree readFile rename stat writeFile writeImageFile',
	git: 'branch branches cancelCommand checkGhCli checkoutBranch commitAll commitCount createGist createPR diff getDefaultBranch getRepoRoot graph info init isRepo listWorktrees log numstat remote removeWorktree runCommand scanWorktreeDirectory show showFile status switch tags unwatchWorktreeDirectory watchWorktreeDirectory worktreeCheckout worktreeInfo worktreeRunSetup worktreeSetup',
	groupChat:
		'addHistoryEntry addParticipant appendMessage archive clearHistory create delete deleteHistoryEntry getHistory getHistoryFilePath getImages getMessages getModeratorSessionId getQueue list load queueAdd queueRemove queueReorder queueResume removeParticipant rename reportAutoRunComplete resetParticipantContext saveImage sendToModerator sendToParticipant startModerator stopAll stopModerator submitMessage update',
	groups: 'getAll setAll',
	history:
		'add clear delete getAll getAllPaginated getCueGroupRuns getFilePath getGraphData getOffsetForTimestamp listSessions reload update updateSessionName',
	images: 'resolve',
	leaderboard: 'get getInstallationId getLongestRuns',
	live: 'getLiveSessions getStatus',
	logger: 'getLogLevel log',
	marketplace: 'getDocument getManifest getReadme importPlaybook refreshManifest',
	memory: 'create delete getPath list orphans read search write',
	openspec: 'getCommand getMetadata getPrompts refresh resetPrompt savePrompt',
	parquet: 'close export open query',
	permission: 'respond',
	pianola:
		'apply-suggestion get-decisions get-rules get-suggestions save-rules supervisor-add supervisor-list supervisor-remove supervisor-set-enabled',
	playbooks: 'create delete deleteAll export import list update',
	plugins: 'contributions get-activity get-grants get-groupings invoke-command invoke-tool list',
	process:
		'broadcast-user-input cancelCommand getActiveProcesses interrupt isTerminalBusy kill resize runCommand spawn spawnTerminalTab write',
	prompts: 'get getAll getAllIds getBundledDefault getPath listFiles reset save',
	sessions:
		'getActiveSessionId getAll getBootstrap getDeferredContent setActiveSessionId setAll setMany',
	settings: 'get getAll set',
	shell: 'trashItem',
	shells: 'detect',
	speckit: 'getCommand getMetadata getPrompts refresh resetPrompt savePrompt',
	'ssh-remote':
		'deleteConfig getConfigs getDefaultId getSshConfigHosts saveConfig setDefaultId test',
	stats:
		'clear-initialization-result clear-old-data end-autorun export get-aggregation get-autorun-sessions get-autorun-tasks get-database-size get-delegation-by-day get-delegation-totals get-earliest-timestamp get-initialization-result get-resilience get-session-lifecycle get-shortcut-usage-by-day get-shortcut-usage-total get-stats get-token-usage get-wizard-runs record-image-annotation record-query record-resilience record-session-closed record-session-created record-shortcut-usage record-task record-wizard-run start-autorun',
	symphony:
		'cancel checkPRStatuses clearCache cloneRepo complete createDraftPR fetchDocumentContent getActive getCompleted getIssueCounts getIssues getRegistry getState getStats manualCredit registerActive start startContribution syncContribution updateStatus',
	tabNaming: 'generateTabName',
	tabs: 'aiTabClosed',
	tempfile: 'delete read write',
	web: 'broadcastSessionState broadcastTabsChange broadcastUserInput requestNewTab startAutoRun controlAutoRun',
	windows: 'getForSession getState list',
};
const EVENTS: Record<string, string> = {
	agent: 'authExpired error',
	agentRun: 'eventAppended updated',
	agentSessions: 'globalStatsUpdate',
	agents: 'snapshot-updated',
	app: 'systemResume',
	autorun: 'fileChanged statusChanged',
	claude: 'globalStatsUpdate projectStatsUpdate',
	cli: 'activityChange',
	'cross-agent': 'chunk',
	cue: 'activityUpdate',
	'director-notes': 'synopsisProgress',
	documentGraph: 'filesChanged',
	git: 'commandOutput',
	groupChat:
		'autoRunBatchComplete autoRunTriggered historyEntry message moderatorSessionIdChanged moderatorUsage participantLiveOutput participantState participantsChanged queueState stateChange',
	history: 'entryAdded externalChange',
	marketplace: 'manifestChanged',
	notification: 'commandCompleted',
	parquet: 'fetchProgress',
	plugins: 'changed groupings-changed',
	process:
		'claude-mode-resolved command-exit data exit permission-request session-id slash-commands ssh-remote stderr thinking-chunk tool-execution usage user-input',
	// Display-only remote pushes, not owner command/reply listeners. Movement
	// is mirrored intentionally so host-created Concerto panels remain visible.
	remote:
		'movement cadenza cadenzaFlash cadenzaHidden notifyToast notifyCenterFlash autoRunStateMirror',
	sessions: 'lifecycleSync transcriptSync',
	settings: 'externalChange',
	stats: 'updated',
	symphony: 'contributionStarted prCreated updated',
	worktree: 'discovered removed',
};

function inventory(groups: Record<string, string>): Readonly<Record<string, true>> {
	return Object.fromEntries(
		Object.entries(groups).flatMap(([namespace, names]) =>
			names.split(' ').map((name) => [`${namespace}:${name}`, true])
		)
	);
}

const allowedMethods = inventory(METHODS);
const allowedEvents = inventory(EVENTS);

export function isRemoteMethodAllowed(channel: string): boolean {
	return Object.prototype.hasOwnProperty.call(allowedMethods, channel);
}

export function isRemoteEventAllowed(channel: string): boolean {
	return Object.prototype.hasOwnProperty.call(allowedEvents, channel);
}

export function remoteDeniedChannelError(channel: string): string {
	return `Channel "${channel}" is not available over the web interface`;
}

// Configuration containers can include credentials even when a key is innocuous.
// Do not apply this to transcripts, file content or process output: this is an
// owner-operator workload API, not an attempt at content-based data-loss prevention.
export function isRemoteSecretField(key: string): boolean {
	return /^(?:.*(?:auth|access|refresh|client|session|webAuth|id)Token|token|.*secret.*|.*password.*|.*api.?key.*|.*credential.*|private.?key(?:Pem|Content)?|(?:custom|remote|shell)Env.*|env(?:Vars|Disabled)?)$/i.test(
		key
	);
}

export function isRemoteSettingReadable(key: unknown): key is string {
	return (
		typeof key === 'string' &&
		!/[.\[\]]/.test(key) &&
		!isRemoteSecretField(key) &&
		!['maestroRemoteInstanceId'].includes(key)
	);
}

export function isRemoteSettingWritable(key: unknown): key is string {
	return (
		isRemoteSettingReadable(key) &&
		!/^(?:webAuth|webInterface|persistentWebLink|encoreFeatures|installationId|globalShowHotkey|customSyncPath|iCloudSyncEnabled|sshRemotes|leaderboardRegistration)/.test(
			key
		)
	);
}

export function sanitizeRemoteConfiguration(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeRemoteConfiguration);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !isRemoteSecretField(key))
			.map(([key, child]) => [key, sanitizeRemoteConfiguration(child)])
	);
}

export function sanitizeRemoteResult(channel: string, result: unknown): unknown {
	if (channel === 'agents:getCustomEnvVars') return null;
	if (channel === 'agents:getAllCustomEnvVars') return {};
	if (channel === 'settings:getAll' && result && typeof result === 'object') {
		return Object.fromEntries(
			Object.entries(result)
				.filter(([key]) => isRemoteSettingReadable(key))
				.map(([key, value]) => [key, sanitizeRemoteConfiguration(value)])
		);
	}
	if (
		channel.startsWith('agents:') ||
		channel.startsWith('sessions:') ||
		channel === 'context:getStoredSession' ||
		channel === 'ssh-remote:getConfigs' ||
		channel === 'settings:get'
	) {
		return sanitizeRemoteConfiguration(result);
	}
	return result;
}
