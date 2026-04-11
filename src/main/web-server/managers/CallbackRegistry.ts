/**
 * CallbackRegistry - Manages callback functions for the WebServer
 *
 * Centralizes all callback storage and provides typed getter/setter methods.
 * This separates callback management from the core WebServer logic.
 */

import { logger } from '../../utils/logger';
import type {
	GetSessionsCallback,
	GetSessionDetailCallback,
	WriteToSessionCallback,
	ExecuteCommandCallback,
	InterruptSessionCallback,
	SwitchModeCallback,
	SelectSessionCallback,
	SelectTabCallback,
	NewTabCallback,
	CloseTabCallback,
	RenameTabCallback,
	StarTabCallback,
	ReorderTabCallback,
	ToggleBookmarkCallback,
	OpenFileTabCallback,
	RefreshFileTreeCallback,
	RefreshAutoRunDocsCallback,
	ConfigureAutoRunCallback,
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
	GetAutoRunDocsCallback,
	GetAutoRunDocContentCallback,
	SaveAutoRunDocCallback,
	StopAutoRunCallback,
	GetSettingsCallback,
	SetSettingCallback,
	GetGroupsCallback,
	CreateGroupCallback,
	RenameGroupCallback,
	DeleteGroupCallback,
	MoveSessionToGroupCallback,
	CreateSessionCallback,
	DeleteSessionCallback,
	RenameSessionCallback,
	WebSettings,
	SettingValue,
	GroupData,
	GetGitStatusCallback,
	GetGitDiffCallback,
	GitStatusResult,
	GitDiffResult,
	GetGroupChatsCallback,
	StartGroupChatCallback,
	GetGroupChatStateCallback,
	StopGroupChatCallback,
	SendGroupChatMessageCallback,
	GroupChatState,
	MergeContextCallback,
	TransferContextCallback,
	SummarizeContextCallback,
	GetCueSubscriptionsCallback,
	ToggleCueSubscriptionCallback,
	GetCueActivityCallback,
	TriggerCueSubscriptionCallback,
	CueSubscriptionInfo,
	CueActivityEntry,
	GetUsageDashboardCallback,
	GetAchievementsCallback,
	UsageDashboardData,
	AchievementData,
} from '../types';

const LOG_CONTEXT = 'CallbackRegistry';

/**
 * All callback types supported by the WebServer
 */
export interface WebServerCallbacks {
	getSessions: GetSessionsCallback | null;
	getSessionDetail: GetSessionDetailCallback | null;
	getTheme: GetThemeCallback | null;
	getCustomCommands: GetCustomCommandsCallback | null;
	writeToSession: WriteToSessionCallback | null;
	executeCommand: ExecuteCommandCallback | null;
	interruptSession: InterruptSessionCallback | null;
	switchMode: SwitchModeCallback | null;
	selectSession: SelectSessionCallback | null;
	selectTab: SelectTabCallback | null;
	newTab: NewTabCallback | null;
	closeTab: CloseTabCallback | null;
	renameTab: RenameTabCallback | null;
	starTab: StarTabCallback | null;
	reorderTab: ReorderTabCallback | null;
	toggleBookmark: ToggleBookmarkCallback | null;
	openFileTab: OpenFileTabCallback | null;
	refreshFileTree: RefreshFileTreeCallback | null;
	refreshAutoRunDocs: RefreshAutoRunDocsCallback | null;
	configureAutoRun: ConfigureAutoRunCallback | null;
	getHistory: GetHistoryCallback | null;
	getAutoRunDocs: GetAutoRunDocsCallback | null;
	getAutoRunDocContent: GetAutoRunDocContentCallback | null;
	saveAutoRunDoc: SaveAutoRunDocCallback | null;
	stopAutoRun: StopAutoRunCallback | null;
	getSettings: GetSettingsCallback | null;
	setSetting: SetSettingCallback | null;
	getGroups: GetGroupsCallback | null;
	createGroup: CreateGroupCallback | null;
	renameGroup: RenameGroupCallback | null;
	deleteGroup: DeleteGroupCallback | null;
	moveSessionToGroup: MoveSessionToGroupCallback | null;
	createSession: CreateSessionCallback | null;
	deleteSession: DeleteSessionCallback | null;
	renameSession: RenameSessionCallback | null;
	getGitStatus: GetGitStatusCallback | null;
	getGitDiff: GetGitDiffCallback | null;
	getGroupChats: GetGroupChatsCallback | null;
	startGroupChat: StartGroupChatCallback | null;
	getGroupChatState: GetGroupChatStateCallback | null;
	stopGroupChat: StopGroupChatCallback | null;
	sendGroupChatMessage: SendGroupChatMessageCallback | null;
	mergeContext: MergeContextCallback | null;
	transferContext: TransferContextCallback | null;
	summarizeContext: SummarizeContextCallback | null;
	getCueSubscriptions: GetCueSubscriptionsCallback | null;
	toggleCueSubscription: ToggleCueSubscriptionCallback | null;
	getCueActivity: GetCueActivityCallback | null;
	triggerCueSubscription: TriggerCueSubscriptionCallback | null;
	getUsageDashboard: GetUsageDashboardCallback | null;
	getAchievements: GetAchievementsCallback | null;
}

export class CallbackRegistry {
	private callbacks: WebServerCallbacks = {
		getSessions: null,
		getSessionDetail: null,
		getTheme: null,
		getCustomCommands: null,
		writeToSession: null,
		executeCommand: null,
		interruptSession: null,
		switchMode: null,
		selectSession: null,
		selectTab: null,
		newTab: null,
		closeTab: null,
		renameTab: null,
		starTab: null,
		reorderTab: null,
		toggleBookmark: null,
		openFileTab: null,
		refreshFileTree: null,
		refreshAutoRunDocs: null,
		configureAutoRun: null,
		getHistory: null,
		getAutoRunDocs: null,
		getAutoRunDocContent: null,
		saveAutoRunDoc: null,
		stopAutoRun: null,
		getSettings: null,
		setSetting: null,
		getGroups: null,
		createGroup: null,
		renameGroup: null,
		deleteGroup: null,
		moveSessionToGroup: null,
		createSession: null,
		deleteSession: null,
		renameSession: null,
		getGitStatus: null,
		getGitDiff: null,
		getGroupChats: null,
		startGroupChat: null,
		getGroupChatState: null,
		stopGroupChat: null,
		sendGroupChatMessage: null,
		mergeContext: null,
		transferContext: null,
		summarizeContext: null,
		getCueSubscriptions: null,
		toggleCueSubscription: null,
		getCueActivity: null,
		triggerCueSubscription: null,
		getUsageDashboard: null,
		getAchievements: null,
	};

	// ============ Getter Methods ============

	getSessions(): ReturnType<GetSessionsCallback> | [] {
		return this.callbacks.getSessions?.() ?? [];
	}

	getSessionDetail(sessionId: string, tabId?: string): ReturnType<GetSessionDetailCallback> | null {
		return this.callbacks.getSessionDetail?.(sessionId, tabId) ?? null;
	}

	getTheme(): ReturnType<GetThemeCallback> | null {
		return this.callbacks.getTheme?.() ?? null;
	}

	getCustomCommands(): ReturnType<GetCustomCommandsCallback> | [] {
		return this.callbacks.getCustomCommands?.() ?? [];
	}

	writeToSession(sessionId: string, data: string): boolean {
		return this.callbacks.writeToSession?.(sessionId, data) ?? false;
	}

	async executeCommand(
		sessionId: string,
		command: string,
		inputMode?: 'ai' | 'terminal'
	): Promise<boolean> {
		if (!this.callbacks.executeCommand) return false;
		return this.callbacks.executeCommand(sessionId, command, inputMode);
	}

	async interruptSession(sessionId: string): Promise<boolean> {
		return this.callbacks.interruptSession?.(sessionId) ?? false;
	}

	async switchMode(sessionId: string, mode: 'ai' | 'terminal'): Promise<boolean> {
		if (!this.callbacks.switchMode) return false;
		return this.callbacks.switchMode(sessionId, mode);
	}

	async selectSession(sessionId: string, tabId?: string, focus?: boolean): Promise<boolean> {
		if (!this.callbacks.selectSession) return false;
		return this.callbacks.selectSession(sessionId, tabId, focus);
	}

	async selectTab(sessionId: string, tabId: string): Promise<boolean> {
		if (!this.callbacks.selectTab) return false;
		return this.callbacks.selectTab(sessionId, tabId);
	}

	async newTab(sessionId: string): Promise<{ tabId: string } | null> {
		if (!this.callbacks.newTab) return null;
		return this.callbacks.newTab(sessionId);
	}

	async closeTab(sessionId: string, tabId: string): Promise<boolean> {
		if (!this.callbacks.closeTab) return false;
		return this.callbacks.closeTab(sessionId, tabId);
	}

	async renameTab(sessionId: string, tabId: string, newName: string): Promise<boolean> {
		if (!this.callbacks.renameTab) return false;
		return this.callbacks.renameTab(sessionId, tabId, newName);
	}

	async starTab(sessionId: string, tabId: string, starred: boolean): Promise<boolean> {
		if (!this.callbacks.starTab) return false;
		return this.callbacks.starTab(sessionId, tabId, starred);
	}

	async reorderTab(sessionId: string, fromIndex: number, toIndex: number): Promise<boolean> {
		if (!this.callbacks.reorderTab) return false;
		return this.callbacks.reorderTab(sessionId, fromIndex, toIndex);
	}

	async toggleBookmark(sessionId: string): Promise<boolean> {
		if (!this.callbacks.toggleBookmark) return false;
		return this.callbacks.toggleBookmark(sessionId);
	}

	async openFileTab(sessionId: string, filePath: string): Promise<boolean> {
		if (!this.callbacks.openFileTab) return false;
		return this.callbacks.openFileTab(sessionId, filePath);
	}

	async refreshFileTree(sessionId: string): Promise<boolean> {
		if (!this.callbacks.refreshFileTree) return false;
		return this.callbacks.refreshFileTree(sessionId);
	}

	async refreshAutoRunDocs(sessionId: string): Promise<boolean> {
		if (!this.callbacks.refreshAutoRunDocs) return false;
		return this.callbacks.refreshAutoRunDocs(sessionId);
	}

	async configureAutoRun(
		sessionId: string,
		config: {
			documents: Array<{ filename: string; resetOnCompletion?: boolean }>;
			prompt?: string;
			loopEnabled?: boolean;
			maxLoops?: number;
			saveAsPlaybook?: string;
			launch?: boolean;
		}
	): Promise<{ success: boolean; playbookId?: string; error?: string }> {
		if (!this.callbacks.configureAutoRun) return { success: false, error: 'Not configured' };
		return this.callbacks.configureAutoRun(sessionId, config);
	}

	getHistory(projectPath?: string, sessionId?: string): ReturnType<GetHistoryCallback> | [] {
		return this.callbacks.getHistory?.(projectPath, sessionId) ?? [];
	}

	async getAutoRunDocs(sessionId: string): Promise<import('../types').AutoRunDocument[]> {
		if (!this.callbacks.getAutoRunDocs) return [];
		return this.callbacks.getAutoRunDocs(sessionId);
	}

	async getAutoRunDocContent(sessionId: string, filename: string): Promise<string> {
		if (!this.callbacks.getAutoRunDocContent) return '';
		return this.callbacks.getAutoRunDocContent(sessionId, filename);
	}

	async saveAutoRunDoc(sessionId: string, filename: string, content: string): Promise<boolean> {
		if (!this.callbacks.saveAutoRunDoc) return false;
		return this.callbacks.saveAutoRunDoc(sessionId, filename, content);
	}

	async stopAutoRun(sessionId: string): Promise<boolean> {
		if (!this.callbacks.stopAutoRun) return false;
		return this.callbacks.stopAutoRun(sessionId);
	}

	getSettings(): WebSettings {
		if (this.callbacks.getSettings) {
			return this.callbacks.getSettings();
		}
		return {
			theme: 'dracula',
			fontSize: 14,
			enterToSendAI: false,
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			autoScroll: true,
			notificationsEnabled: true,
			audioFeedbackEnabled: false,
			colorBlindMode: 'false',
			conductorProfile: '',
		};
	}

	async setSetting(key: string, value: SettingValue): Promise<boolean> {
		if (!this.callbacks.setSetting) return false;
		return this.callbacks.setSetting(key, value);
	}

	getGroups(): GroupData[] {
		return this.callbacks.getGroups?.() ?? [];
	}

	async createGroup(name: string, emoji?: string): Promise<{ id: string } | null> {
		if (!this.callbacks.createGroup) return null;
		return this.callbacks.createGroup(name, emoji);
	}

	async renameGroup(groupId: string, name: string): Promise<boolean> {
		if (!this.callbacks.renameGroup) return false;
		return this.callbacks.renameGroup(groupId, name);
	}

	async deleteGroup(groupId: string): Promise<boolean> {
		if (!this.callbacks.deleteGroup) return false;
		return this.callbacks.deleteGroup(groupId);
	}

	async moveSessionToGroup(sessionId: string, groupId: string | null): Promise<boolean> {
		if (!this.callbacks.moveSessionToGroup) return false;
		return this.callbacks.moveSessionToGroup(sessionId, groupId);
	}

	async createSession(
		name: string,
		toolType: string,
		cwd: string,
		groupId?: string
	): Promise<{ sessionId: string } | null> {
		if (!this.callbacks.createSession) return null;
		return this.callbacks.createSession(name, toolType, cwd, groupId);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		if (!this.callbacks.deleteSession) return false;
		return this.callbacks.deleteSession(sessionId);
	}

	async renameSession(sessionId: string, newName: string): Promise<boolean> {
		if (!this.callbacks.renameSession) return false;
		return this.callbacks.renameSession(sessionId, newName);
	}

	async getGitStatus(sessionId: string): Promise<GitStatusResult> {
		if (!this.callbacks.getGitStatus) return { branch: '', files: [], ahead: 0, behind: 0 };
		return this.callbacks.getGitStatus(sessionId);
	}

	async getGitDiff(sessionId: string, filePath?: string): Promise<GitDiffResult> {
		if (!this.callbacks.getGitDiff) return { diff: '', files: [] };
		return this.callbacks.getGitDiff(sessionId, filePath);
	}

	async getGroupChats(): Promise<GroupChatState[]> {
		if (!this.callbacks.getGroupChats) return [];
		return this.callbacks.getGroupChats();
	}

	async startGroupChat(
		topic: string,
		participantIds: string[]
	): Promise<{ chatId: string } | null> {
		if (!this.callbacks.startGroupChat) return null;
		return this.callbacks.startGroupChat(topic, participantIds);
	}

	async getGroupChatState(chatId: string): Promise<GroupChatState | null> {
		if (!this.callbacks.getGroupChatState) return null;
		return this.callbacks.getGroupChatState(chatId);
	}

	async stopGroupChat(chatId: string): Promise<boolean> {
		if (!this.callbacks.stopGroupChat) return false;
		return this.callbacks.stopGroupChat(chatId);
	}

	async sendGroupChatMessage(chatId: string, message: string): Promise<boolean> {
		if (!this.callbacks.sendGroupChatMessage) return false;
		return this.callbacks.sendGroupChatMessage(chatId, message);
	}

	async mergeContext(sourceSessionId: string, targetSessionId: string): Promise<boolean> {
		if (!this.callbacks.mergeContext) return false;
		return this.callbacks.mergeContext(sourceSessionId, targetSessionId);
	}

	async transferContext(sourceSessionId: string, targetSessionId: string): Promise<boolean> {
		if (!this.callbacks.transferContext) return false;
		return this.callbacks.transferContext(sourceSessionId, targetSessionId);
	}

	async summarizeContext(sessionId: string): Promise<boolean> {
		if (!this.callbacks.summarizeContext) return false;
		return this.callbacks.summarizeContext(sessionId);
	}

	async getCueSubscriptions(sessionId?: string): Promise<CueSubscriptionInfo[]> {
		if (!this.callbacks.getCueSubscriptions) return [];
		return this.callbacks.getCueSubscriptions(sessionId);
	}

	async toggleCueSubscription(subscriptionId: string, enabled: boolean): Promise<boolean> {
		if (!this.callbacks.toggleCueSubscription) return false;
		return this.callbacks.toggleCueSubscription(subscriptionId, enabled);
	}

	async getCueActivity(sessionId?: string, limit?: number): Promise<CueActivityEntry[]> {
		if (!this.callbacks.getCueActivity) return [];
		return this.callbacks.getCueActivity(sessionId, limit);
	}

	async triggerCueSubscription(subscriptionName: string, prompt?: string): Promise<boolean> {
		if (!this.callbacks.triggerCueSubscription) return false;
		return this.callbacks.triggerCueSubscription(subscriptionName, prompt);
	}

	async getUsageDashboard(
		timeRange: 'day' | 'week' | 'month' | 'all'
	): Promise<UsageDashboardData> {
		if (!this.callbacks.getUsageDashboard) {
			return {
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCost: 0,
				sessionBreakdown: [],
				dailyUsage: [],
			};
		}
		return this.callbacks.getUsageDashboard(timeRange);
	}

	async getAchievements(): Promise<AchievementData[]> {
		if (!this.callbacks.getAchievements) return [];
		return this.callbacks.getAchievements();
	}

	// ============ Setter Methods ============

	setGetSessionsCallback(callback: GetSessionsCallback): void {
		this.callbacks.getSessions = callback;
	}

	setGetSessionDetailCallback(callback: GetSessionDetailCallback): void {
		this.callbacks.getSessionDetail = callback;
	}

	setGetThemeCallback(callback: GetThemeCallback): void {
		this.callbacks.getTheme = callback;
	}

	setGetCustomCommandsCallback(callback: GetCustomCommandsCallback): void {
		this.callbacks.getCustomCommands = callback;
	}

	setWriteToSessionCallback(callback: WriteToSessionCallback): void {
		this.callbacks.writeToSession = callback;
	}

	setExecuteCommandCallback(callback: ExecuteCommandCallback): void {
		this.callbacks.executeCommand = callback;
	}

	setInterruptSessionCallback(callback: InterruptSessionCallback): void {
		this.callbacks.interruptSession = callback;
	}

	setSwitchModeCallback(callback: SwitchModeCallback): void {
		logger.info('[CallbackRegistry] setSwitchModeCallback called', LOG_CONTEXT);
		this.callbacks.switchMode = callback;
	}

	setSelectSessionCallback(callback: SelectSessionCallback): void {
		logger.info('[CallbackRegistry] setSelectSessionCallback called', LOG_CONTEXT);
		this.callbacks.selectSession = callback;
	}

	setSelectTabCallback(callback: SelectTabCallback): void {
		logger.info('[CallbackRegistry] setSelectTabCallback called', LOG_CONTEXT);
		this.callbacks.selectTab = callback;
	}

	setNewTabCallback(callback: NewTabCallback): void {
		logger.info('[CallbackRegistry] setNewTabCallback called', LOG_CONTEXT);
		this.callbacks.newTab = callback;
	}

	setCloseTabCallback(callback: CloseTabCallback): void {
		logger.info('[CallbackRegistry] setCloseTabCallback called', LOG_CONTEXT);
		this.callbacks.closeTab = callback;
	}

	setRenameTabCallback(callback: RenameTabCallback): void {
		logger.info('[CallbackRegistry] setRenameTabCallback called', LOG_CONTEXT);
		this.callbacks.renameTab = callback;
	}

	setStarTabCallback(callback: StarTabCallback): void {
		this.callbacks.starTab = callback;
	}

	setReorderTabCallback(callback: ReorderTabCallback): void {
		this.callbacks.reorderTab = callback;
	}

	setToggleBookmarkCallback(callback: ToggleBookmarkCallback): void {
		this.callbacks.toggleBookmark = callback;
	}

	setOpenFileTabCallback(callback: OpenFileTabCallback): void {
		this.callbacks.openFileTab = callback;
	}

	setRefreshFileTreeCallback(callback: RefreshFileTreeCallback): void {
		this.callbacks.refreshFileTree = callback;
	}

	setRefreshAutoRunDocsCallback(callback: RefreshAutoRunDocsCallback): void {
		this.callbacks.refreshAutoRunDocs = callback;
	}

	setConfigureAutoRunCallback(callback: ConfigureAutoRunCallback): void {
		this.callbacks.configureAutoRun = callback;
	}

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbacks.getHistory = callback;
	}

	setGetAutoRunDocsCallback(callback: GetAutoRunDocsCallback): void {
		this.callbacks.getAutoRunDocs = callback;
	}

	setGetAutoRunDocContentCallback(callback: GetAutoRunDocContentCallback): void {
		this.callbacks.getAutoRunDocContent = callback;
	}

	setSaveAutoRunDocCallback(callback: SaveAutoRunDocCallback): void {
		this.callbacks.saveAutoRunDoc = callback;
	}

	setStopAutoRunCallback(callback: StopAutoRunCallback): void {
		this.callbacks.stopAutoRun = callback;
	}

	setGetSettingsCallback(callback: GetSettingsCallback): void {
		this.callbacks.getSettings = callback;
	}

	setSetSettingCallback(callback: SetSettingCallback): void {
		this.callbacks.setSetting = callback;
	}

	setGetGroupsCallback(callback: GetGroupsCallback): void {
		this.callbacks.getGroups = callback;
	}

	setCreateGroupCallback(callback: CreateGroupCallback): void {
		this.callbacks.createGroup = callback;
	}

	setRenameGroupCallback(callback: RenameGroupCallback): void {
		this.callbacks.renameGroup = callback;
	}

	setDeleteGroupCallback(callback: DeleteGroupCallback): void {
		this.callbacks.deleteGroup = callback;
	}

	setMoveSessionToGroupCallback(callback: MoveSessionToGroupCallback): void {
		this.callbacks.moveSessionToGroup = callback;
	}

	setCreateSessionCallback(callback: CreateSessionCallback): void {
		this.callbacks.createSession = callback;
	}

	setDeleteSessionCallback(callback: DeleteSessionCallback): void {
		this.callbacks.deleteSession = callback;
	}

	setRenameSessionCallback(callback: RenameSessionCallback): void {
		this.callbacks.renameSession = callback;
	}

	setGetGitStatusCallback(callback: GetGitStatusCallback): void {
		this.callbacks.getGitStatus = callback;
	}

	setGetGitDiffCallback(callback: GetGitDiffCallback): void {
		this.callbacks.getGitDiff = callback;
	}

	setGetGroupChatsCallback(callback: GetGroupChatsCallback): void {
		this.callbacks.getGroupChats = callback;
	}

	setStartGroupChatCallback(callback: StartGroupChatCallback): void {
		this.callbacks.startGroupChat = callback;
	}

	setGetGroupChatStateCallback(callback: GetGroupChatStateCallback): void {
		this.callbacks.getGroupChatState = callback;
	}

	setStopGroupChatCallback(callback: StopGroupChatCallback): void {
		this.callbacks.stopGroupChat = callback;
	}

	setSendGroupChatMessageCallback(callback: SendGroupChatMessageCallback): void {
		this.callbacks.sendGroupChatMessage = callback;
	}

	setMergeContextCallback(callback: MergeContextCallback): void {
		this.callbacks.mergeContext = callback;
	}

	setTransferContextCallback(callback: TransferContextCallback): void {
		this.callbacks.transferContext = callback;
	}

	setSummarizeContextCallback(callback: SummarizeContextCallback): void {
		this.callbacks.summarizeContext = callback;
	}

	setGetCueSubscriptionsCallback(callback: GetCueSubscriptionsCallback): void {
		this.callbacks.getCueSubscriptions = callback;
	}

	setToggleCueSubscriptionCallback(callback: ToggleCueSubscriptionCallback): void {
		this.callbacks.toggleCueSubscription = callback;
	}

	setGetCueActivityCallback(callback: GetCueActivityCallback): void {
		this.callbacks.getCueActivity = callback;
	}

	setTriggerCueSubscriptionCallback(callback: TriggerCueSubscriptionCallback): void {
		this.callbacks.triggerCueSubscription = callback;
	}

	setGetUsageDashboardCallback(callback: GetUsageDashboardCallback): void {
		this.callbacks.getUsageDashboard = callback;
	}

	setGetAchievementsCallback(callback: GetAchievementsCallback): void {
		this.callbacks.getAchievements = callback;
	}

	// ============ Check Methods ============

	hasCallback(name: keyof WebServerCallbacks): boolean {
		return this.callbacks[name] !== null;
	}
}
