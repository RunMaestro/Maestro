import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { execFileNoThrow } from '../../../utils/execFile';
import { execGit } from '../../../utils/remote-git';
import { logger } from '../../../utils/logger';
import { getSshRemoteById } from '../../../stores';
import { createSafeSend } from '../../../utils/safe-send';
import { createIpcHandler } from '../../../utils/ipcHandler';
import { WINDOWS_LOCKED_SYSTEM_FILES } from '../../../utils/watcher-ignore';
import { readDirRemote } from '../../../utils/remote-fs';
import { captureException } from '../../../utils/sentry';
import { markStaleForDeletedWorktreeUsingStore } from '../../../agent-run/worktree-stale';
import { LOG_CONTEXT, handlerOpts, GitHandlerDependencies } from './shared';
import { isWorktreeCreatedByMaestro } from './worktreeCreationMarks';

/**
 * Directory-scan failures that are environmental rather than bugs: the path was
 * moved or deleted out from under us (ENOENT/ENOTDIR), or we don't hold read
 * permission on it (EACCES, or EPERM for macOS TCC-protected locations like
 * Documents and Desktop). The scan skips the directory and reports `scanFailed`;
 * none of these are worth a Sentry report.
 */
const EXPECTED_SCAN_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

function isExpectedScanError(code: string | undefined): boolean {
	return code !== undefined && EXPECTED_SCAN_ERROR_CODES.has(code);
}

// Worktree directory watchers keyed by session ID
const worktreeWatchers = new Map<string, FSWatcher>();
// Debounce timers keyed by "sessionId:dirPath" so each discovered directory
// gets its own independent timer (previously keyed by sessionId alone, which
// caused only the last of multiple near-simultaneous addDir events to fire).
const worktreeWatchDebounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Register worktree filesystem-watcher Git IPC handlers: scanWorktreeDirectory,
 * watchWorktreeDirectory, unwatchWorktreeDirectory.
 */
export function registerWorktreeWatchHandlers(deps: GitHandlerDependencies): void {
	const safeSend = createSafeSend(deps.getMainWindow);

	// Scan a directory for subdirectories that are git repositories or worktrees
	// This is used for auto-discovering worktrees in a parent directory
	// PERFORMANCE: Parallelized git operations to avoid blocking UI (was sequential before)
	// Supports SSH remote execution via optional sshRemoteId parameter
	//
	// Recurses one level into non-git subdirectories so worktrees created from
	// branch names with slashes (e.g. "fix/worktree-removal" → /worktrees/fix/worktree-removal)
	// are still discovered. Without recursion, those nested worktrees are absent
	// from the result and the renderer's stale-detection wrongly removes them.
	ipcMain.handle(
		'git:scanWorktreeDirectory',
		createIpcHandler(
			handlerOpts('scanWorktreeDirectory'),
			async (parentPath: string, sshRemoteId?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;

				// Maximum recursion depth below the configured basePath. 1 covers the
				// common case `<basePath>/<group>/<branch>` from slash-named branches.
				// Going deeper would multiply git invocations without a real-world need
				// (git itself rejects nested worktrees inside the main repo).
				const MAX_DEPTH = 1;

				type SubdirEntry = { name: string; isDirectory: boolean };
				type ScanEntry = {
					path: string;
					name: string;
					isWorktree: boolean;
					branch: string | null;
					repoRoot: string | null;
				};

				const joinPath = (parent: string, child: string): string =>
					sshRemote
						? parent.endsWith('/')
							? `${parent}${child}`
							: `${parent}/${child}`
						: path.join(parent, child);

				// Throws on read failure (matching local `fs.readdir` behavior) so the
				// outer try/catch can surface scanFailed: true at the top level. Nested
				// recursion wraps this in its own try/catch and swallows the throw.
				// Without this, an SSH `readDirRemote` failure would silently return []
				// and the renderer would bulk-remove every child session.
				const readSubdirs = async (dir: string): Promise<SubdirEntry[]> => {
					if (sshRemote) {
						const result = await readDirRemote(dir, sshRemote);
						if (!result.success || !result.data) {
							const err = new Error(
								`Failed to read remote directory ${dir}: ${result.error || 'unknown error'}`
							) as NodeJS.ErrnoException;
							// Tag as ENOENT so the outer catch's Sentry-quieting branch applies -
							// remote read failures are typically "path no longer exists / not reachable",
							// not bugs worth paging on.
							err.code = 'ENOENT';
							throw err;
						}
						return result.data.filter((e) => e.isDirectory && !e.name.startsWith('.'));
					}
					const entries = await fs.readdir(dir, { withFileTypes: true });
					return entries
						.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
						.map((e) => ({ name: e.name, isDirectory: true }));
				};

				// Inspect a single directory: returns the worktree entry if it IS a
				// git repo/worktree root, or null otherwise. Caller decides whether
				// to recurse into a null result.
				const inspectSubdir = async (
					subdirPath: string,
					name: string
				): Promise<ScanEntry | null> => {
					const isInsideWorkTree = await execGit(
						['rev-parse', '--is-inside-work-tree'],
						subdirPath,
						sshRemote
					);
					if (isInsideWorkTree.exitCode !== 0) {
						return null; // Not a git repo
					}

					// Verify this directory IS a worktree/repo root, not just a subdirectory inside one.
					// Without this check, subdirectories like "build/" or "src/" inside a worktree
					// would pass --is-inside-work-tree and be incorrectly treated as separate worktrees.
					const toplevelResult = await execGit(
						['rev-parse', '--show-toplevel'],
						subdirPath,
						sshRemote
					);
					if (toplevelResult.exitCode !== 0) {
						return null; // Git command failed - treat as invalid
					}
					const toplevel = toplevelResult.stdout.trim();
					// For local paths, canonicalize via realpath so that symlinked base
					// paths (common on Linux: /home → /data/home; Windows junctions) match
					// what git rev-parse --show-toplevel returns. path.resolve alone does
					// NOT follow symlinks, which previously caused every subdir to be
					// rejected and the entire worktree set to be marked stale.
					const normalizedSubdir = sshRemote
						? subdirPath
						: await fs.realpath(subdirPath).catch(() => path.resolve(subdirPath));
					const normalizedToplevel = sshRemote
						? toplevel
						: await fs.realpath(toplevel).catch(() => path.resolve(toplevel));
					if (normalizedSubdir !== normalizedToplevel) {
						return null; // Subdirectory inside a repo, not a repo/worktree root
					}

					// Run remaining git commands in parallel for each subdirectory (SSH-aware via execGit)
					const [gitDirResult, gitCommonDirResult, branchResult] = await Promise.all([
						execGit(['rev-parse', '--git-dir'], subdirPath, sshRemote),
						execGit(['rev-parse', '--git-common-dir'], subdirPath, sshRemote),
						execGit(['rev-parse', '--abbrev-ref', 'HEAD'], subdirPath, sshRemote),
					]);

					const gitDir = gitDirResult.exitCode === 0 ? gitDirResult.stdout.trim() : '';
					const gitCommonDir =
						gitCommonDirResult.exitCode === 0 ? gitCommonDirResult.stdout.trim() : gitDir;
					const isWorktree = gitDir !== gitCommonDir;
					const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

					// Get repo root
					let repoRoot: string | null = null;
					if (isWorktree && gitCommonDir) {
						// For SSH, use POSIX path operations
						if (sshRemote) {
							const commonDirAbs = gitCommonDir.startsWith('/')
								? gitCommonDir
								: `${subdirPath}/${gitCommonDir}`.replace(/\/+/g, '/');
							// Get parent directory (remove last path component)
							repoRoot = commonDirAbs.split('/').slice(0, -1).join('/') || '/';
						} else {
							const commonDirAbs = path.isAbsolute(gitCommonDir)
								? gitCommonDir
								: path.resolve(subdirPath, gitCommonDir);
							repoRoot = path.dirname(commonDirAbs);
						}
					} else {
						// For non-worktree git repos, the toplevel IS the repo root -
						// reuse the value we already fetched above instead of re-running
						// `git rev-parse --show-toplevel`.
						repoRoot = toplevel;
					}

					return {
						path: subdirPath,
						name,
						isWorktree,
						branch,
						repoRoot,
					};
				};

				// Walk a directory level: inspect each subdir, then recurse into any
				// non-git subdirs (up to MAX_DEPTH below the original parentPath).
				// Failures while reading a nested directory are swallowed by the
				// inner try/catch - a missing or unreadable group dir shouldn't fail
				// the entire scan. Top-level failure propagates up to the outer
				// try/catch so scanFailed is surfaced and the renderer skips removal.
				const scanLevel = async (dir: string, depthRemaining: number): Promise<ScanEntry[]> => {
					const subdirs = await readSubdirs(dir);

					const results = await Promise.all(
						subdirs.map(async (subdir) => {
							const subdirPath = joinPath(dir, subdir.name);
							const entry = await inspectSubdir(subdirPath, subdir.name);
							if (entry) {
								return [entry];
							}
							if (depthRemaining > 0) {
								try {
									return await scanLevel(subdirPath, depthRemaining - 1);
								} catch (err) {
									const code = (err as NodeJS.ErrnoException | undefined)?.code;
									if (!isExpectedScanError(code)) {
										logger.warn(`${LOG_CONTEXT} Failed to recurse into ${subdirPath}: ${err}`);
									}
									return [];
								}
							}
							return [];
						})
					);

					return results.flat();
				};

				try {
					const gitSubdirs = await scanLevel(parentPath, MAX_DEPTH);
					return { gitSubdirs };
				} catch (err) {
					// The configured parent path is user-supplied, so failing to read it is
					// an environment condition rather than a bug: ENOENT when it's been moved
					// or deleted, and EPERM/EACCES when it sits behind macOS TCC (Documents,
					// Desktop) or has permissions we simply don't hold. Both surface to logs
					// and to `scanFailed` below; neither should pollute Sentry. (MAESTRO-VQ)
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					if (!isExpectedScanError(code)) {
						void captureException(err);
					}
					logger.error(`Failed to scan directory ${parentPath}: ${err}`, LOG_CONTEXT);
					// Distinguish a failed scan from a successful "no subdirs" result so
					// the renderer doesn't bulk-flag every existing child session as removed.
					return { gitSubdirs: [], scanFailed: true };
				}
			}
		)
	);

	// Watch a worktree directory for new worktrees
	// Note: File watching is not supported for SSH remote sessions.
	// Remote sessions will get success: true but isRemote: true flag indicating
	// watching is not active. The UI should periodically poll listWorktrees instead.
	ipcMain.handle(
		'git:watchWorktreeDirectory',
		createIpcHandler(
			handlerOpts('watchWorktreeDirectory'),
			async (sessionId: string, worktreePath: string, sshRemoteId?: string) => {
				// TODO: Remove debug logging after worktree detection is confirmed working
				logger.warn(
					`[WT-DEBUG] watchWorktreeDirectory called: session=${sessionId} path=${worktreePath} ssh=${sshRemoteId}`
				);

				// SSH remote: file watching is not supported
				// Return success with isRemote flag so UI knows to poll instead
				if (sshRemoteId) {
					logger.debug(
						`${LOG_CONTEXT} Worktree watching not supported for SSH remote sessions. Session ${sessionId} should poll instead.`,
						LOG_CONTEXT
					);
					return {
						success: true,
						isRemote: true,
						message: 'File watching not available for remote sessions. Use polling instead.',
					};
				}

				// Stop existing watcher if any - delete from map BEFORE awaiting close
				// to prevent race conditions with concurrent unwatch/watch IPC calls
				const existingWatcher = worktreeWatchers.get(sessionId);
				if (existingWatcher) {
					worktreeWatchers.delete(sessionId);
					await existingWatcher.close();
				}

				// Clear any pending debounce timers for this session
				for (const [key, timer] of worktreeWatchDebounceTimers) {
					if (key.startsWith(`${sessionId}:`)) {
						clearTimeout(timer);
						worktreeWatchDebounceTimers.delete(key);
					}
				}

				try {
					// Verify directory exists
					await fs.access(worktreePath);

					// Watch one level deep so worktrees from slash-named branches
					// (e.g. "fix/worktree-removal" → <basePath>/fix/worktree-removal)
					// also fire addDir/unlinkDir events. The addDir handler validates
					// every candidate via `is-inside-work-tree` + `show-toplevel`, so
					// the intermediate group directory (e.g. "fix") is rejected and
					// only the actual worktree is reported as discovered.
					const watcher = chokidar.watch(worktreePath, {
						ignored: [
							/(^|[/\\])\../, // Ignore dotfiles
							WINDOWS_LOCKED_SYSTEM_FILES,
						],
						persistent: true,
						ignoreInitial: true,
						depth: 1,
					});

					// Handler for directory additions
					watcher.on('addDir', async (dirPath: string) => {
						// TODO: Remove debug logging after worktree detection is confirmed working
						logger.warn(`[WT-DEBUG] addDir event: ${dirPath}`);
						// Skip the root directory itself
						if (dirPath === worktreePath) return;

						// Per-directory debounce so multiple near-simultaneous worktree
						// additions each get their own validation pipeline
						const debounceKey = `${sessionId}:${dirPath}`;
						const existingTimer = worktreeWatchDebounceTimers.get(debounceKey);
						if (existingTimer) {
							clearTimeout(existingTimer);
						}

						const timer = setTimeout(async () => {
							worktreeWatchDebounceTimers.delete(debounceKey);

							// Maestro just created this worktree itself (`git:worktreeSetup`),
							// and the renderer that asked for it is already building the child
							// session. This event is broadcast to every renderer - each
							// Electron window and every web-desktop bridge client - so letting
							// it through has each of the others mint a rival child at the same
							// path under the same parent (issue #1506). Suppress it here, at
							// the one place all of them share.
							if (isWorktreeCreatedByMaestro(dirPath)) {
								logger.warn(`[WT-DEBUG] SKIPPED ${dirPath}: created by Maestro`);
								return;
							}

							// Check if this new directory is a git worktree
							const isInsideWorkTree = await execFileNoThrow(
								'git',
								['rev-parse', '--is-inside-work-tree'],
								dirPath
							);
							if (isInsideWorkTree.exitCode !== 0) {
								logger.warn(
									`[WT-DEBUG] REJECTED ${dirPath}: not inside work tree (exit=${isInsideWorkTree.exitCode} stderr=${isInsideWorkTree.stderr})`
								);
								return;
							}

							// Verify this IS a worktree/repo root, not a subdirectory inside one
							const toplevelResult = await execFileNoThrow(
								'git',
								['rev-parse', '--show-toplevel'],
								dirPath
							);
							if (toplevelResult.exitCode !== 0) {
								logger.warn(
									`[WT-DEBUG] REJECTED ${dirPath}: show-toplevel failed (exit=${toplevelResult.exitCode})`
								);
								return;
							}
							// Use realpath so symlinked base paths (e.g. /home/user/work →
							// /data/work on Linux, NTFS junctions on Windows) match git's
							// canonical toplevel output.
							const resolvedDir = await fs.realpath(dirPath).catch(() => path.resolve(dirPath));
							const resolvedToplevel = await fs
								.realpath(toplevelResult.stdout.trim())
								.catch(() => path.resolve(toplevelResult.stdout.trim()));
							if (resolvedDir !== resolvedToplevel) {
								logger.warn(
									`[WT-DEBUG] REJECTED ${dirPath}: not repo root (resolved=${resolvedDir} toplevel=${resolvedToplevel})`
								);
								return;
							}

							// Re-check against the realpath: a symlinked basePath (or an
							// NTFS junction) means the watcher's `dirPath` and the path the
							// renderer asked `worktreeSetup` for can be spellings of the same
							// directory, and only one of them is marked.
							if (isWorktreeCreatedByMaestro(resolvedDir)) {
								logger.warn(`[WT-DEBUG] SKIPPED ${dirPath}: created by Maestro (realpath)`);
								return;
							}

							// Get branch name
							const branchResult = await execFileNoThrow(
								'git',
								['rev-parse', '--abbrev-ref', 'HEAD'],
								dirPath
							);
							const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

							// Skip main/master/HEAD branches
							if (branch === 'main' || branch === 'master' || branch === 'HEAD') {
								logger.warn(`[WT-DEBUG] REJECTED ${dirPath}: skippable branch ${branch}`);
								return;
							}

							logger.warn(
								`[WT-DEBUG] ACCEPTED ${dirPath}: branch=${branch}, emitting worktree:discovered`
							);

							// Emit event to the renderer and web-desktop bridge clients
							safeSend('worktree:discovered', {
								sessionId,
								worktree: {
									path: dirPath,
									name: path.basename(dirPath),
									branch,
								},
							});

							logger.info(`${LOG_CONTEXT} New worktree discovered: ${dirPath} (branch: ${branch})`);
						}, 500); // 500ms debounce

						worktreeWatchDebounceTimers.set(debounceKey, timer);
					});

					// Handler for directory removals (e.g., `git worktree remove` from CLI).
					//
					// With depth: 1 this can fire spuriously for an intermediate group
					// directory (e.g. <basePath>/fix) when its last nested worktree is
					// removed and the empty parent is cleaned up. We forward the event
					// regardless because (a) the dir is gone so we can't run git checks
					// to validate, and (b) the renderer's onWorktreeRemoved handler
					// already filters by registered child cwds - an unknown path is a
					// no-op, not a session removal. See useWorktreeHandlers.ts.
					watcher.on('unlinkDir', (dirPath: string) => {
						if (dirPath === worktreePath) return;

						logger.warn(`[WT-DEBUG] unlinkDir event: ${dirPath}`);
						logger.info(`${LOG_CONTEXT} Worktree directory removed: ${dirPath}`);

						// A deleted worktree is no longer a valid jump/diff target; flag
						// any non-terminal agent runs bound to it as stale (ISC-6.7/D12).
						markStaleForDeletedWorktreeUsingStore(dirPath);

						safeSend('worktree:removed', {
							sessionId,
							worktreePath: dirPath,
						});
					});

					watcher.on('error', (error) => {
						logger.error(
							`${LOG_CONTEXT} Worktree watcher error for session ${sessionId}: ${error}`
						);
					});

					worktreeWatchers.set(sessionId, watcher);
					logger.info(
						`${LOG_CONTEXT} Started watching worktree directory: ${worktreePath} for session ${sessionId}`
					);

					return { success: true };
				} catch (err) {
					// ENOENT is expected when the worktree parent path has been moved
					// or deleted; the renderer surfaces this as "stale" - no need to
					// page Sentry on user filesystem state.
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					if (code !== 'ENOENT') {
						void captureException(err);
					}
					logger.error(`${LOG_CONTEXT} Failed to watch worktree directory ${worktreePath}: ${err}`);
					return { success: false, error: String(err) };
				}
			}
		)
	);

	// Stop watching a worktree directory
	ipcMain.handle(
		'git:unwatchWorktreeDirectory',
		createIpcHandler(handlerOpts('unwatchWorktreeDirectory'), async (sessionId: string) => {
			// TODO: Remove debug logging after worktree detection is confirmed working
			logger.warn(
				`[WT-DEBUG] unwatchWorktreeDirectory called: session=${sessionId} hasWatcher=${worktreeWatchers.has(sessionId)}`
			);
			const watcher = worktreeWatchers.get(sessionId);
			if (watcher) {
				// Delete from map BEFORE awaiting close to prevent a race condition:
				// React StrictMode double-fires effects, so unwatchWorktreeDirectory and
				// watchWorktreeDirectory can interleave. If we delete after await, the
				// unwatch can remove a NEW watcher that watchWorktreeDirectory just created.
				worktreeWatchers.delete(sessionId);
				await watcher.close();
				logger.info(`${LOG_CONTEXT} Stopped watching worktree directory for session ${sessionId}`);
			}

			// Clear any pending debounce timers for this session
			for (const [key, timer] of worktreeWatchDebounceTimers) {
				if (key.startsWith(`${sessionId}:`)) {
					clearTimeout(timer);
					worktreeWatchDebounceTimers.delete(key);
				}
			}

			return { success: true };
		})
	);
}
