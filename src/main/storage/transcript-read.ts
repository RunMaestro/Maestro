/**
 * Reading a provider transcript file for a conversation, with one answer in every mode.
 *
 * A transcript that does not exist (deleted, or not written yet) is an EMPTY conversation: the tab
 * shows "Beginning of conversation". A transcript that exists and cannot be read (permission, a
 * dropped SSH connection, a directory where the file should be) is an ERROR: the read rejects, and
 * the tab shows "Could not load earlier messages" with Retry. A local agent, an SSH agent, and a
 * hosted agent (whose host reads its own disk) give the same answer for the same file, because
 * the local and the remote reader both go through here (docs/parity/agent-ux-parity.md).
 */

import fs from 'fs/promises';
import type { SshRemoteConfig } from '../../shared/types';
import { forEachJsonlLine } from '../utils/jsonl-stream';
import { readFileRemote } from '../utils/remote-fs';

/** True when a local read failed because the file, or a folder above it, does not exist. */
export function isMissingFileError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** True when a remote read failed because the file does not exist (`readFileRemote`'s wording). */
export function isMissingRemoteFile(error: string | undefined): boolean {
	if (!error) return false;
	const lower = error.toLowerCase();
	return (
		lower.startsWith('file not found') ||
		lower.includes('no such file') ||
		// A folder on the path is a file: the transcript cannot exist, as ENOTDIR reads locally.
		lower.includes('not a directory') ||
		lower.includes('does not exist')
	);
}

/**
 * Stream a local transcript's lines into `onLine`. Resolves `false` when the file does not exist
 * (an empty conversation) and `true` when it was read. Any other failure rejects.
 */
export async function forEachLocalTranscriptLine(
	filePath: string,
	onLine: (line: string) => void
): Promise<boolean> {
	try {
		await forEachJsonlLine(filePath, onLine);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

/**
 * A local transcript's whole text, or `null` when the file does not exist (an empty conversation).
 * Any other failure rejects. For a provider whose transcripts stay small; a JSONL transcript that
 * can grow large is streamed with `forEachLocalTranscriptLine` instead (#1862).
 */
export async function readLocalTranscript(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
}

/**
 * A remote transcript's text, or `null` when the file does not exist (an empty conversation).
 * Any other failure rejects with the remote's own words, so the tab offers Retry.
 */
export async function readRemoteTranscript(
	filePath: string,
	sshConfig: SshRemoteConfig
): Promise<string | null> {
	const result = await readFileRemote(filePath, sshConfig);
	if (result.success) return result.data ?? '';
	if (isMissingRemoteFile(result.error)) return null;
	throw new Error(result.error || `Failed to read transcript: ${filePath}`);
}
