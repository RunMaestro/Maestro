import type {
	MemoryCommandSelection,
	MemoryCommandDraft,
	MemoryCommandDraftStatus,
	MemoryCommandSaveResult,
	MemoryCommandEditorPreview,
} from '../../shared/memoryCommandDraft';
/**
 * Preload API for agent memory (Claude Code per project, Codex per account).
 *
 * Exposes the window.maestro.memory namespace. Backed by IPC handlers
 * registered in src/main/ipc/handlers/memory.ts.
 */

import type { CodexMemorySourceRef } from '../../shared/codexMemory';
import { ipcRenderer } from 'electron';
import type { MemoryListResponse, MemorySearchMatch, MemoryTarget } from '../../shared/agentMemory';

export function createMemoryApi() {
	return {
		commandAvailability: (
			generatorId: string
		): Promise<{ status: 'available' | 'plugin-unavailable' | 'permission-denied' }> =>
			ipcRenderer.invoke('memory:command:availability', generatorId),
		generateCommand: (
			viewerId: string,
			selection: MemoryCommandSelection
		): Promise<MemoryCommandDraftStatus> =>
			ipcRenderer.invoke('memory:command:generate', viewerId, selection),
		commandStatus: (viewerId: string, requestId: string): Promise<MemoryCommandDraftStatus> =>
			ipcRenderer.invoke('memory:command:status', viewerId, requestId),
		cancelCommand: (viewerId: string, requestId: string): Promise<boolean> =>
			ipcRenderer.invoke('memory:command:cancel', viewerId, requestId),
		saveCommand: (
			viewerId: string,
			requestId: string,
			draft: MemoryCommandDraft
		): Promise<MemoryCommandSaveResult> =>
			ipcRenderer.invoke('memory:command:save', viewerId, requestId, draft),
		closeCommandViewer: (viewerId: string): Promise<void> =>
			ipcRenderer.invoke('memory:command:close', viewerId),
		onCommandDraft: (
			callback: (value: { viewerId: string; requestId: string; draft: MemoryCommandDraft }) => void
		): (() => void) => {
			const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) =>
				callback(value);
			ipcRenderer.on('memory:command:draft', listener);
			return () => ipcRenderer.removeListener('memory:command:draft', listener);
		},

		onCommandEditor: (callback: (value: MemoryCommandEditorPreview) => void): (() => void) => {
			const listener = (_event: Electron.IpcRendererEvent, value: MemoryCommandEditorPreview) =>
				callback(value);
			ipcRenderer.on('memory:command:editor', listener);
			return () => ipcRenderer.removeListener('memory:command:editor', listener);
		},

		list: (target: MemoryTarget): Promise<MemoryListResponse> =>
			ipcRenderer.invoke('memory:list', target),

		read: (
			target: MemoryTarget,
			filename: string
		): Promise<{
			success: boolean;
			content?: string;
			sourceRef?: CodexMemorySourceRef;
			error?: string;
		}> => ipcRenderer.invoke('memory:read', target, filename),

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
