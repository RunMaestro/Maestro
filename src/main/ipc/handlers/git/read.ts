import { ipcMain } from 'electron';
import { execFileNoThrow, execFileBufferNoThrow } from '../../../utils/execFile';
import { execGit } from '../../../utils/remote-git';
import { logger } from '../../../utils/logger';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging, createIpcHandler } from '../../../utils/ipcHandler';
import {
	parseGitBehindAhead,
	countUncommittedChanges,
	isImageFile,
	getImageMimeType,
} from '../../../../shared/gitUtils';
import { getRepoRootRemote } from '../../../utils/remote-git';
import { LOG_CONTEXT, handlerOpts } from './shared';

/**
 * Register read-only Git IPC handlers: status, diff, isRepo, numstat, remote,
 * info, log, graph, commitCount, show, showFile, getRepoRoot.
 */
export function registerReadHandlers(): void {
	// Basic Git operations
	// All handlers accept optional sshRemoteId and remoteCwd for remote execution

	// --- FIX: Always pass cwd as remoteCwd for remote git operations ---
	ipcMain.handle(
		'git:status',
		withIpcErrorLogging(
			handlerOpts('status'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(['status', '--porcelain'], cwd, sshRemote, effectiveRemoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:diff',
		withIpcErrorLogging(
			handlerOpts('diff'),
			async (cwd: string, file?: string, sshRemoteId?: string, remoteCwd?: string) => {
				const args = file ? ['diff', file] : ['diff'];
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(args, cwd, sshRemote, effectiveRemoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:isRepo',
		withIpcErrorLogging(
			handlerOpts('isRepo'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(
					['rev-parse', '--is-inside-work-tree'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				return result.exitCode === 0;
			}
		)
	);

	ipcMain.handle(
		'git:numstat',
		withIpcErrorLogging(
			handlerOpts('numstat'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(['diff', '--numstat'], cwd, sshRemote, effectiveRemoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:remote',
		withIpcErrorLogging(
			handlerOpts('remote'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(
					['remote', 'get-url', 'origin'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				return { stdout: result.stdout.trim(), stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:info',
		withIpcErrorLogging(
			handlerOpts('info'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				// Get comprehensive git info in a single call
				const [branchResult, remoteResult, statusResult, behindAheadResult] = await Promise.all([
					execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, sshRemote, effectiveRemoteCwd),
					execGit(['remote', 'get-url', 'origin'], cwd, sshRemote, effectiveRemoteCwd),
					execGit(['status', '--porcelain'], cwd, sshRemote, effectiveRemoteCwd),
					execGit(
						['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
						cwd,
						sshRemote,
						effectiveRemoteCwd
					),
				]);

				// Use shared parsing functions for behind/ahead and uncommitted changes
				const { behind, ahead } =
					behindAheadResult.exitCode === 0
						? parseGitBehindAhead(behindAheadResult.stdout)
						: { behind: 0, ahead: 0 };
				const uncommittedChanges = countUncommittedChanges(statusResult.stdout);

				return {
					branch: branchResult.stdout.trim(),
					remote: remoteResult.stdout.trim(),
					behind,
					ahead,
					uncommittedChanges,
				};
			}
		)
	);

	ipcMain.handle(
		'git:log',
		withIpcErrorLogging(
			handlerOpts('log'),
			async (
				cwd: string,
				options?: { limit?: number; search?: string },
				sshRemoteId?: string,
				remoteCwd?: string
			) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				// Get git log with formatted output for parsing
				// Format: hash|author|date|refs|subject followed by shortstat
				// Using a unique separator to split commits
				const limit = options?.limit || 100;
				const args = [
					'log',
					`--max-count=${limit}`,
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
				];

				// Add search filter if provided
				if (options?.search) {
					args.push('--all', `--grep=${options.search}`, '-i');
				}

				const result = await execGit(args, cwd, sshRemote, effectiveRemoteCwd);

				if (result.exitCode !== 0) {
					return { entries: [], error: result.stderr };
				}

				// Split by COMMIT_START marker and parse each commit
				const commits = result.stdout.split('COMMIT_START').filter((c) => c.trim());
				const entries = commits.map((commitBlock) => {
					const lines = commitBlock.split('\n').filter((l) => l.trim());
					const mainLine = lines[0];
					const [hash, author, date, refs, ...subjectParts] = mainLine.split('|');

					// Parse shortstat line (e.g., " 3 files changed, 10 insertions(+), 5 deletions(-)")
					let additions = 0;
					let deletions = 0;
					const statLine = lines.find((l) => l.includes('changed'));
					if (statLine) {
						const addMatch = statLine.match(/(\d+) insertion/);
						const delMatch = statLine.match(/(\d+) deletion/);
						if (addMatch) additions = parseInt(addMatch[1], 10);
						if (delMatch) deletions = parseInt(delMatch[1], 10);
					}

					return {
						hash,
						shortHash: hash?.slice(0, 7),
						author,
						date,
						refs: refs ? refs.split(', ').filter((r) => r.trim()) : [],
						subject: subjectParts.join('|'), // In case subject contains |
						additions,
						deletions,
					};
				});

				return { entries, error: null };
			}
		)
	);

	// Topology data for graph view: includes parent hashes for lane rendering.
	ipcMain.handle(
		'git:graph',
		withIpcErrorLogging(
			handlerOpts('graph'),
			async (
				cwd: string,
				options?: { limit?: number },
				sshRemoteId?: string,
				remoteCwd?: string
			) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const limit = options?.limit || 200;
				// Use ASCII Unit Separator (U+001F, written as %x1f in git's pretty-format)
				// between fields. `|` was tempting but author names and subjects can legally
				// contain it, which silently corrupts every field after the offending one.
				// US is a non-printing control character that never appears in real text.
				const args = [
					'log',
					'--all',
					`--max-count=${limit}`,
					'--pretty=format:GRAPH_START%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s',
					'--date=iso-strict',
				];
				const result = await execGit(args, cwd, sshRemote, effectiveRemoteCwd);
				if (result.exitCode !== 0) {
					return { nodes: [], error: result.stderr };
				}
				const nodes = result.stdout
					.split('GRAPH_START')
					.filter((c) => c.trim())
					.map((block) => {
						const trimmed = block.trim();
						const [hash = '', parents = '', author = '', date = '', refs = '', ...subj] =
							trimmed.split('\x1f');
						return {
							hash,
							shortHash: hash.slice(0, 7),
							parents: parents ? parents.split(' ').filter(Boolean) : [],
							author,
							date,
							refs: refs ? refs.split(', ').filter((r) => r.trim()) : [],
							// Re-join with the same separator in case the subject itself contained one
							// (extremely unlikely for a control character, but cheap to be correct).
							subject: subj.join('\x1f'),
						};
					});
				return { nodes, error: null };
			}
		)
	);

	ipcMain.handle(
		'git:commitCount',
		withIpcErrorLogging(
			handlerOpts('commitCount'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				// Get total commit count using rev-list
				const result = await execGit(
					['rev-list', '--count', 'HEAD'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				if (result.exitCode !== 0) {
					return { count: 0, error: result.stderr };
				}
				return { count: parseInt(result.stdout.trim(), 10) || 0, error: null };
			}
		)
	);

	ipcMain.handle(
		'git:show',
		withIpcErrorLogging(
			handlerOpts('show'),
			async (cwd: string, hash: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				// Get the full diff for a specific commit
				const result = await execGit(
					['show', '--stat', '--patch', hash],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	// Read file content at a specific git ref (e.g., HEAD:path/to/file.png)
	// Returns base64 data URL for images, raw content for text files
	ipcMain.handle(
		'git:showFile',
		withIpcErrorLogging(
			handlerOpts('showFile'),
			async (cwd: string, ref: string, filePath: string) => {
				// Use git show to get file content at specific ref
				// We need to handle binary files differently
				const ext = filePath.split('.').pop()?.toLowerCase() || '';

				if (isImageFile(filePath)) {
					// For images we need raw binary content. Use the async,
					// binary-safe exec helper instead of spawnSync so reading the blob
					// never blocks the main-process event loop (which would freeze the
					// entire UI while a large image / cold git object is fetched).
					const result = await execFileBufferNoThrow(
						'git',
						['show', `${ref}:${filePath}`],
						cwd,
						50 * 1024 * 1024 // 50MB max
					);

					if (result.exitCode !== 0) {
						return { error: result.stderr || 'Failed to read file from git' };
					}

					const base64 = result.stdout.toString('base64');
					const mimeType = getImageMimeType(ext);
					return { content: `data:${mimeType};base64,${base64}` };
				} else {
					// For text files, use regular exec
					const result = await execFileNoThrow('git', ['show', `${ref}:${filePath}`], cwd);
					if (result.exitCode !== 0) {
						return { error: result.stderr || 'Failed to read file from git' };
					}
					return { content: result.stdout };
				}
			}
		)
	);

	// Get the root directory of the git repository
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:getRepoRoot',
		createIpcHandler(handlerOpts('getRepoRoot'), async (cwd: string, sshRemoteId?: string) => {
			// SSH remote: dispatch to remote git operations
			if (sshRemoteId) {
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				logger.debug(`${LOG_CONTEXT} getRepoRoot via SSH: ${cwd}`, LOG_CONTEXT);
				const result = await getRepoRootRemote(cwd, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Not a git repository');
				}
				return { root: result.data };
			}

			// Local execution
			const result = await execFileNoThrow('git', ['rev-parse', '--show-toplevel'], cwd);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr || 'Not a git repository');
			}
			return { root: result.stdout.trim() };
		})
	);
}
