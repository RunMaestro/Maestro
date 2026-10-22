/**
 * Preload API for agent memory (Claude Code per project, Codex per account).
 *
 * Exposes the window.maestro.memory namespace. Backed by IPC handlers
 * registered in src/main/ipc/handlers/memory.ts.
 */

import { ipcRenderer } from 'electron';
import type { MemoryListResponse, MemorySearchMatch, MemoryTarget } from '../../shared/agentMemory';

export function createMemoryApi() {
	return {
		list: (target: MemoryTarget): Promise<MemoryListResponse> =>
			ipcRenderer.invoke('memory:list', target),

		read: (
			target: MemoryTarget,
			filename: string
		): Promise<{ success: boolean; content?: string; error?: string }> =>
			ipcRenderer.invoke('memory:read', target, filename),

		write: (
			target: MemoryTarget,
			filename: string,
			content: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:write', target, filename, content),

		create: (
			target: MemoryTarget,
			filename: string,
			content: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:create', target, filename, content),

		delete: (
			target: MemoryTarget,
			filename: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('memory:delete', target, filename),

		search: (
			target: MemoryTarget,
			query: string
		): Promise<{ success: boolean; matches?: MemorySearchMatch[]; error?: string }> =>
			ipcRenderer.invoke('memory:search', target, query),

		orphans: (
			target: MemoryTarget
		): Promise<{
			success: boolean;
			orphans?: string[];
			brokenLinks?: { source: string; target: string }[];
			error?: string;
		}> => ipcRenderer.invoke('memory:orphans', target),

		getPath: (target: MemoryTarget): Promise<{ success: boolean; path?: string; error?: string }> =>
			ipcRenderer.invoke('memory:getPath', target),
	};
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
