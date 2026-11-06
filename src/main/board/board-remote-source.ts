/** Board's explicit adapter to the existing SSH config, file and Git transports.
 * No local path resolution is permitted on this side of the boundary. */
import * as path from 'node:path';
import type { SshRemoteConfig } from '../../shared/types';
import { canonicalJson } from '../../shared/canonicalJson';
import { isPathAtOrUnderRoot } from '../../shared/worktreePaths';
import { getSshRemoteById } from '../stores/getters';
import { readBinaryFileRemoteAsBase64 } from '../utils/remote-fs';
import { execGitReadOnly, execShellRemote } from '../utils/remote-git';
import { BoardStorageError } from './board-storage';

export interface BoardRemoteTransport {
	config: (remoteId: string) => SshRemoteConfig | undefined;
	read: typeof readBinaryFileRemoteAsBase64;
	git: typeof execGitReadOnly;
	shell: typeof execShellRemote;
}
export const boardRemoteTransport: BoardRemoteTransport = {
	config: (remoteId) => getSshRemoteById(remoteId),
	read: readBinaryFileRemoteAsBase64,
	git: execGitReadOnly,
	shell: execShellRemote,
};

export function resolveBoardRemote(remoteId: string, transport = boardRemoteTransport) {
	if (!remoteId)
		throw new BoardStorageError('legacy-mapping-missing', 'SSH source has no remote identity');
	const config = transport.config(remoteId);
	if (!remoteId || !config || config.id !== remoteId || !config.enabled)
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'SSH source requires its configured remote'
		);
	return config;
}

export async function probeBoardRemoteRepository(
	remoteId: string,
	root: string,
	cwd = root,
	transport = boardRemoteTransport
): Promise<string> {
	const config = resolveBoardRemote(remoteId, transport);
	if (
		!path.posix.isAbsolute(root) ||
		!path.posix.isAbsolute(cwd) ||
		path.posix.normalize(root) !== root ||
		path.posix.normalize(cwd) !== cwd ||
		!isPathAtOrUnderRoot(cwd, root)
	)
		throw new BoardStorageError(
			'identity-mismatch',
			'Explicit remote repository directory required'
		);
	const configIdentity = canonicalJson(config);
	const physical = await transport.shell('pwd -P', config, { cwd, timeoutMs: 10000 }).catch(() => {
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'Remote path transport unavailable; revalidate source'
		);
	});
	const git = await transport
		.git(['rev-parse', '--show-toplevel', '--absolute-git-dir'], '', config, cwd)
		.catch(() => {
			throw new BoardStorageError(
				'legacy-mapping-missing',
				'Remote Git transport unavailable; revalidate source'
			);
		});
	if (canonicalJson(resolveBoardRemote(remoteId, transport)) !== configIdentity)
		throw new BoardStorageError(
			'identity-mismatch',
			'SSH configuration changed during repository validation'
		);
	const real = physical.stdout.trim();
	if (physical.exitCode !== 0 || git.exitCode !== 0 || !path.posix.isAbsolute(real))
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'Remote repository remains unresolved; revalidate source'
		);
	if (real !== cwd || git.stdout.trim().split('\n')[0] !== root)
		throw new BoardStorageError('identity-mismatch', 'Remote physical repository identity changed');
	return canonicalJson({ remoteId, root, cwd, physical: real, git: git.stdout.trim() });
}

export async function readBoardRemoteInput(
	remoteId: string,
	root: string,
	relative: string,
	transport = boardRemoteTransport
): Promise<Buffer | null> {
	const config = resolveBoardRemote(remoteId, transport);
	const result = await transport.read(path.posix.join(root, relative), config).catch(() => {
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'Remote source transport unavailable; revalidate source'
		);
	});
	if (result.success && typeof result.data === 'string') return Buffer.from(result.data, 'base64');
	if (result.error === `File not found: ${path.posix.join(root, relative)}`) return null;
	throw new BoardStorageError(
		'legacy-mapping-missing',
		'Remote source input unavailable; revalidate source'
	);
}
