import type { DirectoryEntry } from '../shared/types';
import { getBasename } from '../shared/formatters';

export interface HostFolderRequest {
	invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
	resolve: (path: string | null) => void;
	saveName?: string;
	filters?: Array<{ name: string; extensions: string[] }>;
}
export interface HostFolderListing {
	path: string;
	parent: string | null;
	roots: string[];
	entries: DirectoryEntry[];
}

let request: HostFolderRequest | null = null;
const listeners = new Set<() => void>();
export const getHostFolderRequest = (): HostFolderRequest | null => request;
export function subscribeHostFolderRequest(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** One shared picker serves every existing dialog.selectFolder call. */
export function selectHostFolder(invoke: HostFolderRequest['invoke']): Promise<string | null> {
	if (request) return Promise.reject(new Error('A host directory picker is already open'));
	return new Promise((resolve) => {
		request = { invoke, resolve };
		for (const listener of listeners) listener();
	});
}

/** Remote exports choose a host destination; they never open a native host dialog. */
export function selectHostSaveFile(
	invoke: HostFolderRequest['invoke'],
	options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {}
): Promise<string | null> {
	if (request) return Promise.reject(new Error('A host directory picker is already open'));
	return new Promise((resolve) => {
		request = {
			invoke,
			resolve,
			saveName: getBasename(options.defaultPath || 'export'),
			filters: options.filters,
		};
		for (const listener of listeners) listener();
	});
}

export function finishHostFolderSelection(path: string | null): void {
	const pending = request;
	request = null;
	for (const listener of listeners) listener();
	pending?.resolve(path);
}

export async function readHostFolder(
	pending: HostFolderRequest,
	path?: string
): Promise<HostFolderListing> {
	const info = (await pending.invoke('fs:directoryInfo', path)) as Omit<
		HostFolderListing,
		'entries'
	>;
	const entries = (await pending.invoke('fs:readDir', info.path)) as DirectoryEntry[];
	return {
		...info,
		entries: entries
			.filter((entry) => entry.isDirectory)
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}
