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
 * Open in Default App and Reveal hand the copy of a remote file to another app,
 * so main watches that copy and writes a change saved there back to the remote
 * file (never over a remote change: `fs:watchRemoteCopy`). A center flash says
 * the user has a copy that saves back.
 *
 * A remote DIRECTORY has no location on this machine at all. The nearest honest
 * thing is the Files panel at that folder, with a center flash that says so.
 */

import { joinPath } from '../../shared/formatters';
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

/**
 * Remote path -> the fetch running for it. Overlapping actions on one file or folder (two drags,
 * an open during a drag) share one fetch, so two downloads never rebuild the same copy at once.
 */
const inFlightCopies = new Map<string, Promise<string>>();

function copyKey(target: FileActionTarget): string {
	return `${target.sshRemoteId}\0${target.path}`;
}

function flightKeyOf(kind: 'file' | 'folder', key: string): string {
	return `${kind}\0${key}`;
}

function isRemote<T extends FileActionTarget>(target: T): target is T & { sshRemoteId: string } {
	return !!target.sshRemoteId;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * The local copy a previous fetch left for this file or folder, read
 * synchronously.
 *
 * For callers that cannot await, such as an OS drag that must name its files in
 * the same event. A local path is its own copy.
 */
export function cachedLocalCopy(target: FileActionTarget): string | undefined {
	if (!isRemote(target)) return target.path;
	const key = copyKey(target);
	// A fetch running for it is rebuilding the copy: the caller fetches (and joins that fetch)
	// rather than hand out a path that is being replaced.
	if (
		inFlightCopies.has(flightKeyOf('file', key)) ||
		inFlightCopies.has(flightKeyOf('folder', key))
	)
		return undefined;
	return localCopies.get(key);
}

/**
 * A path on THIS machine holding the file's current bytes.
 *
 * Local: the path itself, no I/O. Remote: a fresh fetch to the temp folder,
 * showing the "Downloading..." flash only while the fetch runs. Always fetches
 * again for a remote file, because the copy is what the user is about to see and
 * the remote file may have changed. Rejects when the fetch fails.
 */
export function fetchLocalCopy(
	target: FileActionTarget,
	options: { quiet?: boolean } = {}
): Promise<string> {
	return fetchCopy(target, options, 'file', (remote) =>
		window.maestro.fs.downloadRemoteFile(remote.path, remote.sshRemoteId)
	);
}

/**
 * A folder on THIS machine holding a copy of the folder's whole tree.
 *
 * Local: the path itself. Remote: the tree is fetched to the temp folder (same
 * flash and cache as {@link fetchLocalCopy}, so {@link cachedLocalCopy} finds
 * it). Rejects when the fetch fails or the folder is too large to copy whole.
 */
export function fetchLocalFolderCopy(
	target: FileActionTarget,
	options: { quiet?: boolean } = {}
): Promise<string> {
	return fetchCopy(target, options, 'folder', (remote) =>
		window.maestro.fs.downloadRemoteFolder(remote.path, remote.sshRemoteId)
	);
}

/**
 * The one fetch of a remote file or folder: joins a fetch already running for it, records the
 * copy when it lands, and forgets the copy when it fails (the copy on disk may be gone or stale,
 * so the next action fetches again instead of handing out that path).
 */
function sharedFetch(
	target: FileActionTarget & { sshRemoteId: string },
	kind: 'file' | 'folder',
	download: (remote: FileActionTarget & { sshRemoteId: string }) => Promise<{ path: string }>
): Promise<string> {
	const key = copyKey(target);
	const flightKey = flightKeyOf(kind, key);
	const running = inFlightCopies.get(flightKey);
	if (running) return running;
	// The download starts on the next tick, so the entry is in the map before it can settle.
	const flight = Promise.resolve()
		.then(() => download(target))
		.then(
			({ path }) => {
				localCopies.set(key, path);
				return path;
			},
			(error: unknown) => {
				localCopies.delete(key);
				throw error;
			}
		)
		.finally(() => inFlightCopies.delete(flightKey));
	inFlightCopies.set(flightKey, flight);
	return flight;
}

async function fetchCopy(
	target: FileActionTarget,
	options: { quiet?: boolean },
	kind: 'file' | 'folder',
	download: (remote: FileActionTarget & { sshRemoteId: string }) => Promise<{ path: string }>
): Promise<string> {
	if (!isRemote(target)) return target.path;
	const flashId = options.quiet
		? null
		: notifyCenterFlash({ message: 'Downloading…', color: 'theme', duration: 0 });
	try {
		return await sharedFetch(target, kind, download);
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

/**
 * Whether an HTML page points at a file beside it (`app.js`, `./site.css`,
 * `img/logo.png`). A URL with a scheme, a `//host` URL, a `/rooted` path, and a
 * bare `#fragment` or `?query` do not count: none is read from the page's own
 * folder.
 */
function pageReferencesNearbyFiles(html: string): boolean {
	const page = new DOMParser().parseFromString(html, 'text/html');
	for (const element of Array.from(page.querySelectorAll('[src], link[href]'))) {
		const reference = (element.getAttribute('src') ?? element.getAttribute('href') ?? '').trim();
		if (reference && !/^([a-z][a-z0-9+.-]*:|[/#?])/i.test(reference)) return true;
	}
	return false;
}

/**
 * A path on THIS machine to open a page from in the Maestro Browser.
 *
 * A remote HTML page that points at files beside it needs them beside its copy
 * too, or it renders without its styles, scripts, and images. So that page's
 * whole folder is fetched and the page opens from inside the folder's copy. A
 * page that stands alone opens from its own copy, and so does one whose folder
 * is too large to copy whole or fails to fetch: this step never fails an open
 * that the page's own copy can serve. Every other file is
 * {@link fetchLocalCopy}.
 */
async function fetchLocalPageCopy(target: FileActionTarget): Promise<string> {
	const pageCopy = await fetchLocalCopy(target);
	if (!isRemote(target) || !/\.html?$/i.test(target.path)) return pageCopy;
	// A remote path is POSIX: only `/` separates the page from its folder.
	const cut = target.path.lastIndexOf('/');
	const name = target.path.slice(cut + 1);
	// A page in `/` has the whole host as its folder. `joinPath()` reads `\` as
	// a separator, so a page with one in its name keeps its own copy.
	if (cut <= 0 || name.includes('\\')) return pageCopy;
	let html: unknown;
	try {
		html = await window.maestro.fs.readFile(pageCopy);
	} catch (error) {
		// Unexpected, since the copy was just written. The page opened from its
		// own copy before this read existed, and it still does.
		captureException(error, {
			extra: { action: 'open-page.read-copy', path: target.path, sshRemoteId: target.sshRemoteId },
		});
		return pageCopy;
	}
	if (typeof html !== 'string' || !pageReferencesNearbyFiles(html)) return pageCopy;
	try {
		const folderCopy = await fetchLocalFolderCopy({
			path: target.path.slice(0, cut),
			sshRemoteId: target.sshRemoteId,
		});
		return joinPath(folderCopy, name);
	} catch {
		// Expected: the folder is too large to copy whole, or the fetch failed.
		// The page still opens, from its own copy.
		return pageCopy;
	}
}

async function runFileAction(
	title: string,
	target: FileActionTarget,
	action: (localPath: string) => Promise<unknown> | unknown,
	fetchCopyOf: (target: FileActionTarget) => Promise<string> = fetchLocalCopy
): Promise<boolean> {
	try {
		await action(await fetchCopyOf(target));
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

/**
 * Have main write a change saved in the fetched copy back to the remote file.
 * Resolves whether it will: a watch that cannot start leaves a copy that does
 * not save back, and the flash must say that instead.
 */
async function watchCopyForWriteBack(
	target: FileActionTarget & { sshRemoteId: string }
): Promise<boolean> {
	try {
		await window.maestro.fs.watchRemoteCopy(target.path, target.sshRemoteId);
		return true;
	} catch (error) {
		captureException(error, {
			extra: { action: 'watch-remote-copy', path: target.path, sshRemoteId: target.sshRemoteId },
		});
		return false;
	}
}

/** Say once, after the copy is handed over, what the user is holding. */
function flashRemoteCopy(savesBack: boolean): void {
	notifyCenterFlash({
		message: 'This is a copy of the remote file',
		detail: savesBack
			? 'Changes you save go back to the remote host.'
			: 'Changes you save stay on this computer.',
		color: savesBack ? 'theme' : 'yellow',
		duration: 4000,
	});
}

/**
 * Hand a file to another app on this machine (the default app, the file
 * manager). A local file goes as it is. A remote file goes as its fetched copy,
 * which main watches and saves back, and a flash says so.
 */
async function handOverFile(
	title: string,
	target: FileActionTarget,
	action: (localPath: string) => Promise<unknown> | unknown
): Promise<boolean> {
	let savesBack: boolean | null = null;
	const done = await runFileAction(title, target, action, async (fileTarget) => {
		const localPath = await fetchLocalCopy(fileTarget);
		if (isRemote(fileTarget)) savesBack = await watchCopyForWriteBack(fileTarget);
		return localPath;
	});
	if (done && savesBack !== null) flashRemoteCopy(savesBack);
	return done;
}

/**
 * Open a file in this machine's default app. A remote file opens its fetched
 * copy, and a change saved there goes back to the remote file.
 */
export function openFileInDefaultApp(target: FileActionTarget): Promise<boolean> {
	return handOverFile('Open failed', target, (localPath) =>
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

/**
 * Open a file in a Maestro Browser tab (a remote file opens its fetched copy; a
 * remote page that points at files beside it opens from a copy of its folder).
 */
export function openFileInMaestroBrowser(
	target: FileActionTarget,
	openBrowserTabAt: (url: string, options?: { title?: string }) => void,
	title?: string
): Promise<boolean> {
	return runFileAction(
		'Open failed',
		target,
		(localPath) => openBrowserTabAt(pathToFileUrl(localPath), title ? { title } : undefined),
		fetchLocalPageCopy
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
 * A remote file is fetched and its local copy revealed (it saves back, as for
 * Open). A remote folder has no location here, so it is shown in the Files
 * panel instead.
 */
export async function revealInFileManager(
	target: FileActionTarget & { isDirectory?: boolean },
	options: { sessionId?: string } = {}
): Promise<boolean> {
	if (isRemote(target) && target.isDirectory) {
		showRemoteFolderInFilesPanel(options.sessionId, target.path);
		return true;
	}
	return handOverFile('Reveal failed', target, (localPath) =>
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
	inFlightCopies.clear();
}
