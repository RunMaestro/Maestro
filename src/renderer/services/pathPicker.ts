/**
 * pathPicker - the one Browse entry point for every folder or file field.
 *
 * A local agent's path lives on this disk, so the native OS dialog picks it, as it always has. An
 * SSH or hosted agent's path lives on its remote, which the native dialog cannot browse, so the
 * Maestro-drawn `<PathPickerModal>` lists the remote's folders through the same `fs.readDir` IPC
 * the Files panel reads with. The caller never branches: it asks for a path with the agent's SSH
 * remote (`pathPickerRemoteId(session)`) and gets one back, or `null` when the user cancels. The
 * Browse button, its label, its tooltip, and its shortcut are therefore the same in every mode
 * (docs/parity/agent-ux-parity.md); only the transport behind the button differs.
 *
 * A path is a flag on the CLI (`--cwd`, `--folder`), so this has no `maestro-cli` verb of its own.
 */

import { create } from 'zustand';
import { getSessionSshRemoteId, isSessionRemote } from '../utils/sessionHelpers';
import { notifyToast } from '../stores/notificationStore';
import type { SessionSshInfo } from '../utils/sessionHelpers';

/** A file-type filter, the same shape the native file dialog takes. */
export interface PathPickerFilter {
	name: string;
	extensions: string[];
}

export interface PickPathOptions {
	/**
	 * The SSH remote the path lives on. Omit (or pass `undefined`) for this machine. Pass `null`
	 * for a path on a remote that is not resolved yet (an SSH draft with no remote picked): the
	 * picker then says so instead of browsing this machine's disk, which would be the wrong one.
	 */
	sshRemoteId?: string | null;
	/** Dialog title, e.g. "Select Auto Run Folder". */
	title?: string;
	/** Folder the picker opens in. The remote picker falls back to the remote's home (`~`). */
	startPath?: string;
}

export interface PickFileOptions extends PickPathOptions {
	/** Only files with one of these extensions can be picked. Omit to allow any file. */
	filters?: PathPickerFilter[];
}

/** One open request for the Maestro-drawn picker. */
export interface PathPickerRequest {
	kind: 'directory' | 'file';
	sshRemoteId: string;
	title: string;
	startPath: string;
	filters?: PathPickerFilter[];
	resolve: (path: string | null) => void;
}

interface PathPickerState {
	request: PathPickerRequest | null;
	open: (request: PathPickerRequest) => void;
	/** Settle the open request with a path, or `null` for cancel, and close the picker. */
	settle: (path: string | null) => void;
}

export const usePathPickerStore = create<PathPickerState>((set, get) => ({
	request: null,
	open: (request) => {
		// One picker at a time: a second Browse cancels the first rather than leaving its
		// caller waiting on a promise that never settles.
		get().request?.resolve(null);
		set({ request });
	},
	settle: (path) => {
		const current = get().request;
		set({ request: null });
		current?.resolve(path);
	},
}));

/**
 * The remote a session's paths live on (SSH and hosted alike), or `undefined` for a local agent.
 * An SSH agent whose remote is not resolved yet gets `null`, never `undefined`: the pickers read
 * `undefined` as this machine, which is the wrong disk for that agent. A remote id stored on an
 * agent with SSH switched off is ignored, so this is the one place that decides where Browse looks.
 */
export function pathPickerRemoteId(
	session: SessionSshInfo | null | undefined
): string | null | undefined {
	if (!isSessionRemote(session)) return undefined;
	return getSessionSshRemoteId(session) ?? null;
}

/** The folder the remote picker opens in when the caller has none: the remote user's home. */
export const REMOTE_PICKER_HOME = '~';

function openRemotePicker(
	kind: PathPickerRequest['kind'],
	sshRemoteId: string | null,
	options: PickFileOptions,
	fallbackTitle: string
): Promise<string | null> {
	if (!sshRemoteId) {
		notifyToast({
			color: 'orange',
			title: 'Nothing to browse yet',
			message: 'Choose where this agent runs, then browse its folders.',
		});
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		usePathPickerStore.getState().open({
			kind,
			sshRemoteId,
			title: options.title || fallbackTitle,
			startPath: options.startPath?.trim() || REMOTE_PICKER_HOME,
			filters: options.filters,
			resolve,
		});
	});
}

/** Pick a folder on the machine the agent's paths live on. Resolves `null` on cancel. */
export async function pickDirectory(options: PickPathOptions = {}): Promise<string | null> {
	if (options.sshRemoteId === undefined) {
		return (await window.maestro.dialog.selectFolder()) || null;
	}
	return openRemotePicker('directory', options.sshRemoteId, options, 'Select Folder');
}

/** Pick a file on the machine the agent's paths live on. Resolves `null` on cancel. */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
	if (options.sshRemoteId === undefined) {
		return (
			(await window.maestro.dialog.selectFile({
				...(options.filters ? { filters: options.filters } : {}),
				...(options.title ? { title: options.title } : {}),
			})) || null
		);
	}
	return openRemotePicker('file', options.sshRemoteId, options, 'Select File');
}
