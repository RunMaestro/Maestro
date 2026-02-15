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
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
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
	getHistory: GetHistoryCallback | null;
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
		getHistory: null,
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

	async selectSession(sessionId: string, tabId?: string): Promise<boolean> {
		if (!this.callbacks.selectSession) return false;
		return this.callbacks.selectSession(sessionId, tabId);
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

	async getHistory(projectPath?: string, sessionId?: string): Promise<import('../../../shared/types').HistoryEntry[]> {
		return (await this.callbacks.getHistory?.(projectPath, sessionId)) ?? [];
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

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbacks.getHistory = callback;
	}

	// ============ Check Methods ============

	hasCallback(name: keyof WebServerCallbacks): boolean {
		return this.callbacks[name] !== null;
	}
}
