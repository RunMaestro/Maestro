/**
 * File actions that hand a file to this machine: open in the default app,
 * reveal in the file manager, open in the Maestro Browser, play, save a copy,
 * drag out.
 *
 * A local, an SSH, and a hosted agent offer the same file controls with the
 * same labels. Only the transport differs: a file on the agent's SSH remote is
 * not on this disk, so every action first fetches it here through
 * `fs:downloadRemoteFile`, then does exactly what a local file gets with the
 * fetched copy. This module is that one fetch-then-act step; menus and toolbars
 * call it instead of branching on the agent's mode.
 *
 * A remote DIRECTORY has no location on this machine at all. The nearest honest
 * thing is the Files panel at that folder, with a center flash that says so.
 */

import { isMediaFile } from '../../shared/mediaTypes';
import {
	dismissCenterFlash,
	notifyCenterFlash,
	useCenterFlashStore,
} from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { pathToFileUrl } from '../utils/openFileUrl';
import { captureException } from '../utils/sentry';
import { revealPathInFileTree } from './fileTreeReveal';

/** A path on the machine that owns it: this one, or the agent's SSH remote. */
export interface FileActionTarget {
	/** Absolute path where the file lives. */
	path: string;
	/** The SSH remote the path is on; undefined (or empty) for a path on this machine. */
	sshRemoteId?: string | null;
}

/** Remote path -> the local copy fetched for it, so a repeat action is instant. */
const localCopies = new Map<string, string>();

function copyKey(target: FileActionTarget): string {
	return `${target.sshRemoteId}\0${target.path}`;
}

function isRemote<T extends FileActionTarget>(target: T): target is T & { sshRemoteId: string } {
	return !!target.sshRemoteId;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * The local copy a previous fetch left for this file, read synchronously.
 *
 * For callers that cannot await, such as an OS drag that must name its files in
 * the same event. A local file is its own copy.
 */
export function cachedLocalCopy(target: FileActionTarget): string | undefined {
	if (!isRemote(target)) return target.path;
	return localCopies.get(copyKey(target));
}

/**
 * A path on THIS machine holding the file's current bytes.
 *
 * Local: the path itself, no I/O. Remote: a fresh fetch to the temp folder,
 * showing the "Downloading..." flash only while the fetch runs. Always fetches
 * again for a remote file, because the copy is what the user is about to see and
 * the remote file may have changed. Rejects when the fetch fails.
 */
export async function fetchLocalCopy(
	target: FileActionTarget,
	options: { quiet?: boolean } = {}
): Promise<string> {
	if (!isRemote(target)) return target.path;
	const flashId = options.quiet
		? null
		: notifyCenterFlash({ message: 'Downloading…', color: 'theme', duration: 0 });
	try {
		const { path } = await window.maestro.fs.downloadRemoteFile(target.path, target.sshRemoteId);
		localCopies.set(copyKey(target), path);
		return path;
	} finally {
		// Clear our own flash only: a newer flash raised mid-fetch stays up.
		if (flashId !== null && useCenterFlashStore.getState().active?.id === flashId) {
			dismissCenterFlash();
		}
	}
}

/**
 * Where to read a file from to open it in Maestro.
 *
 * Media plays in the one floating player, which streams from this disk only, so
 * a remote media file is fetched first and opened from its local copy. Every
 * other file is read where it lives (remote previews read over SSH).
 */
export async function resolveOpenSource(
	target: FileActionTarget,
	fileName: string
): Promise<{ path: string; sshRemoteId?: string }> {
	if (isRemote(target) && isMediaFile(fileName)) {
		return { path: await fetchLocalCopy(target) };
	}
	return { path: target.path, sshRemoteId: target.sshRemoteId || undefined };
}

async function runFileAction(
	title: string,
	target: FileActionTarget,
	action: (localPath: string) => Promise<unknown> | unknown
): Promise<boolean> {
	try {
		await action(await fetchLocalCopy(target));
		return true;
	} catch (error) {
		captureException(error, {
			extra: { action: title, path: target.path, sshRemoteId: target.sshRemoteId },
		});
		notifyToast({
			color: 'red',
			title,
			message: errorMessage(error, 'Could not fetch the remote file'),
		});
		return false;
	}
}

/** Open a file in this machine's default app (a remote file opens its fetched copy). */
export function openFileInDefaultApp(target: FileActionTarget): Promise<boolean> {
	return runFileAction('Open failed', target, (localPath) =>
		window.maestro.shell.openPath(localPath)
	);
}

/** Open several files in their default apps, one fetch at a time. */
export async function openFilesInDefaultApp(targets: FileActionTarget[]): Promise<number> {
	let opened = 0;
	for (const target of targets) {
		if (await openFileInDefaultApp(target)) opened++;
	}
	return opened;
}

/** Open a file in a Maestro Browser tab (a remote file opens its fetched copy). */
export function openFileInMaestroBrowser(
	target: FileActionTarget,
	openBrowserTabAt: (url: string, options?: { title?: string }) => void,
	title?: string
): Promise<boolean> {
	return runFileAction('Open failed', target, (localPath) =>
		openBrowserTabAt(pathToFileUrl(localPath), title ? { title } : undefined)
	);
}

/**
 * Show a remote folder where Maestro can: the Files panel. Flashes what
 * happened, since the user asked for the file manager.
 */
function showRemoteFolderInFilesPanel(sessionId: string | undefined, path: string): void {
	const shown = sessionId ? revealPathInFileTree(sessionId, path, { focus: true }) : false;
	notifyCenterFlash({
		message: shown ? 'Showing the folder in the Files panel' : 'This folder is on the remote host',
		detail: shown
			? 'A folder on the remote host has no location on this computer.'
			: 'A folder on the remote host has no location on this computer, and it is outside the Files panel.',
		color: 'theme',
		duration: 3000,
	});
}

/**
 * Reveal a file or folder in this machine's file manager.
 *
 * A remote file is fetched and its local copy revealed. A remote folder has no
 * location here, so it is shown in the Files panel instead.
 */
export async function revealInFileManager(
	target: FileActionTarget & { isDirectory?: boolean },
	options: { sessionId?: string } = {}
): Promise<boolean> {
	if (isRemote(target) && target.isDirectory) {
		showRemoteFolderInFilesPanel(options.sessionId, target.path);
		return true;
	}
	return runFileAction('Reveal failed', target, (localPath) =>
		window.maestro.shell.showItemInFolder(localPath)
	);
}

/**
 * Open a folder in this machine's file manager (the Files panel "Open" button,
 * Quick Actions "Open in Finder: Working Directory").
 */
export async function openFolderInFileManager(
	target: FileActionTarget,
	options: { sessionId?: string } = {}
): Promise<void> {
	if (isRemote(target)) {
		showRemoteFolderInFilesPanel(options.sessionId, target.path);
		return;
	}
	await window.maestro.shell.openPath(target.path);
}

/**
 * Save a copy of a file to a place the user picks. The same action in every
 * mode: a local file is copied, a remote file is downloaded to the chosen path.
 * Resolves the destination, or null when the user cancelled the dialog.
 */
export async function saveCopyOfFile(
	target: FileActionTarget,
	fileName: string
): Promise<string | null> {
	const destPath = await window.maestro.dialog.saveFile({
		defaultPath: fileName,
		title: 'Save a Copy',
	});
	if (!destPath) return null;
	if (isRemote(target)) {
		await window.maestro.fs.downloadRemoteFile(target.path, target.sshRemoteId, destPath);
	} else {
		// The save dialog already asked about replacing an existing file.
		await window.maestro.fs.copyPath(target.path, destPath, { overwrite: true });
	}
	return destPath;
}

/** Test-only: forget every fetched copy. */
export function __resetFileActionsForTests(): void {
	localCopies.clear();
}
