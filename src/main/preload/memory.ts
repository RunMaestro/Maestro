/**
 * Preload API for per-project memory (Claude Code).
 *
 * Exposes the window.maestro.memory namespace. Backed by IPC handlers
 * registered in src/main/ipc/handlers/memory.ts.
 */

import { ipcRenderer } from 'electron';

export interface MemoryEntry {
	name: string;
	size: number;
	createdAt: string;
	modifiedAt: string;
}

export interface MemoryStats {
	fileCount: number;
	firstCreatedAt: string | null;
	lastModifiedAt: string | null;
	totalBytes: number;
}

export interface MemoryListResponse {
	success: boolean;
	directoryPath?: string;
	exists?: boolean;
	entries?: MemoryEntry[];
	stats?: MemoryStats;
	error?: string;
}

export function createMemoryApi() {
	return {
		list: (projectPath: string, agentId: string = 'claude-code'): Promise<MemoryListResponse> =>
			ipcRenderer.invoke('memory:list', projectPath, agentId),

		read: (
			projectPath: string,
			filename: string,
			agentId: string = 'claude-code'
		): Promise<{ success: boolean; content?: string; error?: string }> =>
			ipcRenderer.invoke('memory:read', projectPath, filename, agentId),

		write: (
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:write', projectPath, filename, content, agentId),

		create: (
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:create', projectPath, filename, content, agentId),

		delete: (
			projectPath: string,
			filename: string,
			agentId: string = 'claude-code'
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:delete', projectPath, filename, agentId),

		getPath: (
			projectPath: string,
			agentId: string = 'claude-code'
		): Promise<{ success: boolean; path?: string; error?: string }> =>
			ipcRenderer.invoke('memory:getPath', projectPath, agentId),
	};
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
