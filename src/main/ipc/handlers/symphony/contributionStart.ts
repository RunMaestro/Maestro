import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../utils/logger';
import { createSafeSend } from '../../../utils/safe-send';
import { createIpcHandler } from '../../../utils/ipcHandler';
import { execFileNoThrow } from '../../../utils/execFile';
import { ensureForkSetup } from '../../../utils/symphony-fork';
import { BRANCH_TEMPLATE } from '../../../../shared/symphony-constants';
import type {
	ActiveContribution,
	StartContributionResponse,
	DocumentReference,
} from '../../../../shared/symphony-types';
import {
	LOG_CONTEXT,
	handlerOpts,
	readState,
	writeState,
	broadcastSymphonyUpdate,
	getReposDir,
	getSymphonyDir,
	checkGhAuthentication,
	getDefaultBranch,
	createDraftPR,
	validateContributionId,
	toSafeDocumentFileName,
	SymphonyHandlerDependencies,
} from './shared';

/**
 * Sanitize repository name to prevent path traversal attacks.
 * Removes any characters that could be used for path traversal.
 */
function sanitizeRepoName(repoName: string): string {
	// Only allow alphanumeric, dashes, underscores, and dots (not leading)
	return repoName
		.replace(/\.\./g, '') // Remove path traversal sequences
		.replace(/[^a-zA-Z0-9_\-]/g, '-') // Replace unsafe chars with dashes
		.replace(/^\.+/, '') // Remove leading dots
		.substring(0, 100); // Limit length
}

/**
 * Validate that a URL is a GitHub repository URL.
 * Only allows HTTPS URLs to github.com.
 */
function validateGitHubUrl(url: string): { valid: boolean; error?: string } {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return { valid: false, error: 'Only HTTPS URLs are allowed' };
		}
		if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
			return { valid: false, error: 'Only GitHub repositories are allowed' };
		}
		// Check for valid repo path format (owner/repo)
		const pathParts = parsed.pathname.split('/').filter(Boolean);
		if (pathParts.length < 2) {
			return { valid: false, error: 'Invalid repository path' };
		}
		return { valid: true };
	} catch {
		return { valid: false, error: 'Invalid URL format' };
	}
}

/**
 * Validate repository slug format (owner/repo).
 */
function validateRepoSlug(slug: string): { valid: boolean; error?: string } {
	if (!slug || typeof slug !== 'string') {
		return { valid: false, error: 'Repository slug is required' };
	}
	const parts = slug.split('/');
	if (parts.length !== 2) {
		return { valid: false, error: 'Invalid repository slug format (expected owner/repo)' };
	}
	const [owner, repo] = parts;
	if (!owner || !repo) {
		return { valid: false, error: 'Owner and repository name are required' };
	}
	// GitHub username/repo name rules
	if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(owner)) {
		return { valid: false, error: 'Invalid owner name' };
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(repo)) {
		return { valid: false, error: 'Invalid repository name' };
	}
	return { valid: true };
}

/**
 * Validate contribution start parameters.
 */
function validateContributionParams(params: {
	repoSlug: string;
	repoUrl: string;
	repoName: string;
	issueNumber: number;
	documentPaths: DocumentReference[];
}): { valid: boolean; error?: string } {
	// Validate repo slug
	const slugValidation = validateRepoSlug(params.repoSlug);
	if (!slugValidation.valid) {
		return slugValidation;
	}

	// Validate URL
	const urlValidation = validateGitHubUrl(params.repoUrl);
	if (!urlValidation.valid) {
		return urlValidation;
	}

	// Validate repo name
	if (!params.repoName || typeof params.repoName !== 'string') {
		return { valid: false, error: 'Repository name is required' };
	}

	// Validate issue number
	if (!Number.isInteger(params.issueNumber) || params.issueNumber <= 0) {
		return { valid: false, error: 'Invalid issue number' };
	}

	// Validate document paths (check for path traversal in repo-relative paths)
	for (const doc of params.documentPaths) {
		if (doc.isExternal) {
			// Validate external URLs are from trusted domains (GitHub)
			try {
				const parsed = new URL(doc.path);
				if (parsed.protocol !== 'https:') {
					return { valid: false, error: `External document URL must use HTTPS: ${doc.path}` };
				}
				// Allow GitHub domains for external documents (attachments, raw content, etc.)
				const allowedHosts = [
					'github.com',
					'www.github.com',
					'raw.githubusercontent.com',
					'user-images.githubusercontent.com',
					'camo.githubusercontent.com',
				];
				if (!allowedHosts.includes(parsed.hostname)) {
					return { valid: false, error: `External document URL must be from GitHub: ${doc.path}` };
				}
			} catch {
				return { valid: false, error: `Invalid external document URL: ${doc.path}` };
			}
		} else {
			// Check repo-relative paths for path traversal
			if (doc.path.includes('..') || doc.path.startsWith('/')) {
				return { valid: false, error: `Invalid document path: ${doc.path}` };
			}
		}
	}

	return { valid: true };
}

/**
 * Generate a unique contribution ID.
 */
function generateContributionId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `contrib_${timestamp}_${random}`;
}

/**
 * Generate branch name from template.
 */
function generateBranchName(issueNumber: number): string {
	const timestamp = Date.now().toString(36);
	return BRANCH_TEMPLATE.replace('{issue}', String(issueNumber)).replace('{timestamp}', timestamp);
}

/**
 * Clone a repository to a local path.
 */
async function cloneRepository(
	repoUrl: string,
	targetPath: string
): Promise<{ success: boolean; error?: string }> {
	logger.info('Cloning repository', LOG_CONTEXT, { repoUrl, targetPath });

	const result = await execFileNoThrow('git', ['clone', '--depth=1', repoUrl, targetPath]);

	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr };
	}

	return { success: true };
}

/**
 * Create a new branch for contribution work.
 */
async function createBranch(
	repoPath: string,
	branchName: string
): Promise<{ success: boolean; error?: string }> {
	const result = await execFileNoThrow('git', ['checkout', '-b', branchName], repoPath);

	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr };
	}

	return { success: true };
}

/**
 * Register contribution-kickoff Symphony IPC handlers: start, cloneRepo,
 * startContribution. Handlers that begin a new contribution, as opposed to
 * contributionFinish.ts which handles wrapping one up.
 */
export function registerContributionStartHandlers({
	app,
	getMainWindow,
}: SymphonyHandlerDependencies): void {
	const safeSend = createSafeSend(getMainWindow);

	/**
	 * Start a new contribution.
	 */
	ipcMain.handle(
		'symphony:start',
		createIpcHandler(
			handlerOpts('start'),
			async (params: {
				repoSlug: string;
				repoUrl: string;
				repoName: string;
				issueNumber: number;
				issueTitle: string;
				documentPaths: DocumentReference[];
				agentType: string;
				sessionId: string;
				baseBranch?: string;
			}): Promise<Omit<StartContributionResponse, 'success'>> => {
				// Validate input parameters
				const validation = validateContributionParams({
					repoSlug: params.repoSlug,
					repoUrl: params.repoUrl,
					repoName: params.repoName,
					issueNumber: params.issueNumber,
					documentPaths: params.documentPaths,
				});
				if (!validation.valid) {
					return { error: validation.error };
				}

				// Check gh CLI authentication before starting
				const authCheck = await checkGhAuthentication();
				if (!authCheck.authenticated) {
					return { error: authCheck.error };
				}

				const {
					repoSlug,
					repoUrl,
					repoName,
					issueNumber,
					issueTitle,
					documentPaths,
					agentType,
					sessionId,
				} = params;

				const contributionId = generateContributionId();
				const state = await readState(app);

				// Check if already working on this issue
				const existing = state.active.find(
					(c) => c.repoSlug === repoSlug && c.issueNumber === issueNumber
				);
				if (existing) {
					return {
						error: `Already working on this issue (contribution: ${existing.id})`,
					};
				}

				// Sanitize repo name for local path
				const sanitizedRepoName = sanitizeRepoName(repoName);

				// Determine local path
				const reposDir = getReposDir(app);
				await fs.mkdir(reposDir, { recursive: true });
				const localPath = path.join(reposDir, `${sanitizedRepoName}-${contributionId}`);

				// Generate branch name
				const branchName = generateBranchName(issueNumber);

				// Clone repository
				const cloneResult = await cloneRepository(repoUrl, localPath);
				if (!cloneResult.success) {
					return { error: `Clone failed: ${cloneResult.error}` };
				}

				// Detect default branch (don't rely on hardcoded 'main')
				const baseBranch = params.baseBranch || (await getDefaultBranch(localPath));

				// Create branch
				const branchResult = await createBranch(localPath, branchName);
				if (!branchResult.success) {
					// Cleanup
					await fs
						.rm(localPath, { recursive: true, force: true })
						.catch((err) =>
							logger.warn(`Failed to clean up directory ${localPath}: ${err}`, LOG_CONTEXT)
						);
					return { error: `Branch creation failed: ${branchResult.error}` };
				}

				// Set up fork if user doesn't have push access
				logger.info('Checking fork requirements', LOG_CONTEXT, { repoSlug });
				const forkResult = await ensureForkSetup(localPath, repoSlug);
				if (forkResult.error) {
					await fs
						.rm(localPath, { recursive: true, force: true })
						.catch((err) =>
							logger.warn(`Failed to clean up directory ${localPath}: ${err}`, LOG_CONTEXT)
						);
					return { error: `Fork setup failed: ${forkResult.error}` };
				}
				if (forkResult.isFork) {
					logger.info('Using fork for contribution', LOG_CONTEXT, {
						forkSlug: forkResult.forkSlug,
						upstreamSlug: repoSlug,
					});
				} else {
					logger.info('User has push access, no fork needed', LOG_CONTEXT, { repoSlug });
				}

				// Create draft PR to claim the issue
				const prTitle = `[WIP] Symphony: ${issueTitle} (#${issueNumber})`;
				const prBody = `## Maestro Symphony Contribution

Closes #${issueNumber}

Contributed via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** ${new Date().toISOString()}

---

This PR will be updated automatically when the Auto Run completes.`;

				const forkOwner = forkResult.isFork ? forkResult.forkSlug?.split('/')[0] : undefined;
				if (forkResult.isFork) {
					logger.info('Creating cross-fork draft PR', LOG_CONTEXT, {
						upstreamSlug: repoSlug,
						forkSlug: forkResult.forkSlug,
						branchName,
					});
				}
				const prResult = await createDraftPR(
					localPath,
					baseBranch,
					prTitle,
					prBody,
					forkResult.isFork ? repoSlug : undefined,
					forkOwner
				);
				if (!prResult.success) {
					// Cleanup
					await fs
						.rm(localPath, { recursive: true, force: true })
						.catch((err) =>
							logger.warn(`Failed to clean up directory ${localPath}: ${err}`, LOG_CONTEXT)
						);
					return { error: `PR creation failed: ${prResult.error}` };
				}

				// Create active contribution entry
				const contribution: ActiveContribution = {
					id: contributionId,
					repoSlug,
					repoName,
					issueNumber,
					issueTitle,
					localPath,
					branchName,
					draftPrNumber: prResult.prNumber!,
					draftPrUrl: prResult.prUrl!,
					startedAt: new Date().toISOString(),
					status: 'running',
					progress: {
						totalDocuments: documentPaths.length,
						completedDocuments: 0,
						totalTasks: 0,
						completedTasks: 0,
					},
					tokenUsage: {
						inputTokens: 0,
						outputTokens: 0,
						estimatedCost: 0,
					},
					timeSpent: 0,
					sessionId,
					agentType,
					isFork: forkResult.isFork,
					...(forkResult.isFork && {
						forkSlug: forkResult.forkSlug,
						upstreamSlug: repoSlug,
					}),
				};

				// Save state
				state.active.push(contribution);
				await writeState(app, state);

				logger.info('Contribution started', LOG_CONTEXT, {
					contributionId,
					repoSlug,
					issueNumber,
					prNumber: prResult.prNumber,
				});

				broadcastSymphonyUpdate(safeSend);

				return {
					contributionId,
					draftPrUrl: prResult.prUrl,
					draftPrNumber: prResult.prNumber,
				};
			}
		)
	);

	/**
	 * Clone a repository for a new Symphony session.
	 * This is a simpler version of the start handler for the session creation flow.
	 */
	ipcMain.handle(
		'symphony:cloneRepo',
		createIpcHandler(
			handlerOpts('cloneRepo'),
			async (params: {
				repoUrl: string;
				localPath: string;
			}): Promise<{ success: boolean; error?: string }> => {
				const { repoUrl, localPath } = params;

				// Validate GitHub URL
				const urlValidation = validateGitHubUrl(repoUrl);
				if (!urlValidation.valid) {
					return { success: false, error: urlValidation.error };
				}

				// Ensure parent directory exists
				const parentDir = path.dirname(localPath);
				await fs.mkdir(parentDir, { recursive: true });

				// Clone with depth=1 for speed
				const result = await cloneRepository(repoUrl, localPath);
				if (!result.success) {
					return { success: false, error: `Clone failed: ${result.error}` };
				}

				logger.info('Repository cloned for Symphony session', LOG_CONTEXT, { localPath });
				return { success: true };
			}
		)
	);

	/**
	 * Start the contribution workflow after session is created.
	 * Creates branch and sets up Auto Run documents.
	 * Draft PR will be created on first real commit (deferred to avoid "no commits" error).
	 */
	ipcMain.handle(
		'symphony:startContribution',
		createIpcHandler(
			handlerOpts('startContribution'),
			async (params: {
				contributionId: string;
				sessionId: string;
				repoSlug: string;
				issueNumber: number;
				issueTitle: string;
				localPath: string;
				documentPaths: DocumentReference[];
			}): Promise<{
				success: boolean;
				branchName?: string;
				draftPrNumber?: number;
				draftPrUrl?: string;
				autoRunPath?: string;
				error?: string;
			}> => {
				const {
					contributionId,
					sessionId,
					repoSlug,
					issueNumber,
					issueTitle,
					localPath,
					documentPaths,
				} = params;

				// Validate inputs
				const idValidation = validateContributionId(contributionId);
				if (!idValidation.valid) {
					return { success: false, error: idValidation.error };
				}

				const slugValidation = validateRepoSlug(repoSlug);
				if (!slugValidation.valid) {
					return { success: false, error: slugValidation.error };
				}

				if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
					return { success: false, error: 'Invalid issue number' };
				}

				// Validate document paths
				for (const doc of documentPaths) {
					if (doc.isExternal) {
						// Validate external URLs are from trusted domains (GitHub)
						try {
							const parsed = new URL(doc.path);
							if (parsed.protocol !== 'https:') {
								return {
									success: false,
									error: `External document URL must use HTTPS: ${doc.path}`,
								};
							}
							// Allow GitHub domains for external documents (attachments, raw content, etc.)
							const allowedHosts = [
								'github.com',
								'www.github.com',
								'raw.githubusercontent.com',
								'user-images.githubusercontent.com',
								'camo.githubusercontent.com',
							];
							if (!allowedHosts.includes(parsed.hostname)) {
								return {
									success: false,
									error: `External document URL must be from GitHub: ${doc.path}`,
								};
							}
						} catch {
							return { success: false, error: `Invalid external document URL: ${doc.path}` };
						}
					} else {
						// Check repo-relative paths for path traversal
						if (doc.path.includes('..') || doc.path.startsWith('/')) {
							return { success: false, error: `Invalid document path: ${doc.path}` };
						}
					}
				}

				// Check gh CLI authentication (needed later for PR creation)
				const authCheck = await checkGhAuthentication();
				if (!authCheck.authenticated) {
					return { success: false, error: authCheck.error };
				}

				try {
					// 1. Create branch and checkout
					const branchName = generateBranchName(issueNumber);
					const branchResult = await createBranch(localPath, branchName);
					if (!branchResult.success) {
						logger.error('Failed to create branch', LOG_CONTEXT, {
							localPath,
							branchName,
							error: branchResult.error,
						});
						return { success: false, error: `Failed to create branch: ${branchResult.error}` };
					}

					// 1b. Capture upstream default branch before fork setup rewrites origin
					const upstreamDefaultBranch = await getDefaultBranch(localPath);

					// 1c. Set up fork if user doesn't have push access
					logger.info('Checking fork requirements', LOG_CONTEXT, { repoSlug });
					const forkResult = await ensureForkSetup(localPath, repoSlug);
					if (forkResult.error) {
						return { success: false, error: `Fork setup failed: ${forkResult.error}` };
					}
					if (forkResult.isFork) {
						logger.info('Using fork for contribution', LOG_CONTEXT, {
							forkSlug: forkResult.forkSlug,
							upstreamSlug: repoSlug,
						});
					} else {
						logger.info('User has push access, no fork needed', LOG_CONTEXT, { repoSlug });
					}

					// 2. Set up Auto Run documents directory
					// External docs (GitHub attachments) go to cache dir to avoid polluting the repo
					// Repo-internal docs are referenced in place
					const symphonyDocsDir = path.join(
						getSymphonyDir(app),
						'contributions',
						contributionId,
						'docs'
					);
					await fs.mkdir(symphonyDocsDir, { recursive: true });

					// Track resolved document paths for Auto Run
					const resolvedDocs: { name: string; path: string; isExternal: boolean }[] = [];

					for (const doc of documentPaths) {
						if (doc.isExternal) {
							// Download external file (GitHub attachment) to cache directory.
							// The name is link text from the issue body, so reduce it to a
							// bare file name before joining it onto the cache directory.
							const safeFileName = toSafeDocumentFileName(doc.name);
							if (!safeFileName) {
								logger.warn('Skipping document with unusable name', LOG_CONTEXT, {
									name: doc.name,
								});
								continue;
							}
							const destPath = path.join(symphonyDocsDir, safeFileName);
							try {
								logger.info('Downloading external document', LOG_CONTEXT, {
									name: doc.name,
									url: doc.path,
								});
								const response = await fetch(doc.path);
								if (!response.ok) {
									logger.warn('Failed to download document', LOG_CONTEXT, {
										name: doc.name,
										status: response.status,
									});
									continue;
								}
								const buffer = await response.arrayBuffer();
								await fs.writeFile(destPath, Buffer.from(buffer));
								logger.info('Downloaded document to cache', LOG_CONTEXT, {
									name: doc.name,
									to: destPath,
								});
								resolvedDocs.push({ name: doc.name, path: destPath, isExternal: true });
							} catch (e) {
								logger.warn('Failed to download document', LOG_CONTEXT, {
									name: doc.name,
									error: e instanceof Error ? e.message : String(e),
								});
							}
						} else {
							// Repo-internal doc - verify it exists and reference in place
							const resolvedSource = path.resolve(localPath, doc.path);
							if (!resolvedSource.startsWith(localPath)) {
								logger.error('Attempted path traversal in document path', LOG_CONTEXT, {
									docPath: doc.path,
								});
								continue;
							}
							try {
								await fs.access(resolvedSource);
								logger.info('Using repo document', LOG_CONTEXT, {
									name: doc.name,
									path: resolvedSource,
								});
								resolvedDocs.push({ name: doc.name, path: resolvedSource, isExternal: false });
							} catch (e) {
								logger.warn('Document not found in repo', LOG_CONTEXT, {
									docPath: doc.path,
									error: e instanceof Error ? e.message : String(e),
								});
							}
						}
					}

					// 3. Write contribution metadata for later PR creation
					const metadataPath = path.join(symphonyDocsDir, '..', 'metadata.json');
					await fs.writeFile(
						metadataPath,
						JSON.stringify(
							{
								contributionId,
								sessionId,
								repoSlug,
								issueNumber,
								issueTitle,
								branchName,
								localPath,
								resolvedDocs,
								startedAt: new Date().toISOString(),
								prCreated: false,
								upstreamDefaultBranch,
								isFork: forkResult.isFork,
								...(forkResult.isFork && {
									forkSlug: forkResult.forkSlug,
									upstreamSlug: repoSlug,
								}),
							},
							null,
							2
						)
					);

					// 4. Determine Auto Run path (use cache dir if we have external docs, otherwise repo path)
					const hasExternalDocs = resolvedDocs.some((d) => d.isExternal);
					const autoRunPath = hasExternalDocs
						? symphonyDocsDir
						: resolvedDocs[0]?.path
							? path.dirname(resolvedDocs[0].path)
							: localPath;

					// 5. Create empty commit, push branch, and open draft PR to claim the issue
					let draftPrNumber: number | undefined;
					let draftPrUrl: string | undefined;

					const baseBranch = upstreamDefaultBranch;
					const commitMsg = `[Symphony] Start contribution for #${issueNumber}`;
					const emptyCommitResult = await execFileNoThrow(
						'git',
						['commit', '--allow-empty', '-m', commitMsg],
						localPath
					);

					if (emptyCommitResult.exitCode === 0) {
						const prTitle = `[WIP] Symphony: ${issueTitle} (#${issueNumber})`;
						const prBody = `## Maestro Symphony Contribution

Closes #${issueNumber}

Contributed via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** ${new Date().toISOString()}

---

This PR will be updated automatically when the Auto Run completes.`;

						const forkOwner = forkResult.isFork ? forkResult.forkSlug?.split('/')[0] : undefined;
						if (forkResult.isFork) {
							logger.info('Creating cross-fork draft PR', LOG_CONTEXT, {
								upstreamSlug: repoSlug,
								forkSlug: forkResult.forkSlug,
								branchName,
							});
						}
						const prResult = await createDraftPR(
							localPath,
							baseBranch,
							prTitle,
							prBody,
							forkResult.isFork ? repoSlug : undefined,
							forkOwner
						);
						if (prResult.success) {
							draftPrNumber = prResult.prNumber;
							draftPrUrl = prResult.prUrl;

							// Update metadata with PR info
							const metaContent = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
							metaContent.prCreated = true;
							metaContent.draftPrNumber = draftPrNumber;
							metaContent.draftPrUrl = draftPrUrl;
							await fs.writeFile(metadataPath, JSON.stringify(metaContent, null, 2));
						} else {
							logger.warn('Failed to create draft PR, continuing without claim', LOG_CONTEXT, {
								contributionId,
								error: prResult.error,
							});
						}
					} else {
						logger.warn('Empty commit failed, continuing without draft PR', LOG_CONTEXT, {
							contributionId,
							error: emptyCommitResult.stderr,
						});
					}

					// 6. Broadcast status update
					safeSend('symphony:contributionStarted', {
						contributionId,
						sessionId,
						branchName,
						autoRunPath,
						draftPrNumber,
						draftPrUrl,
					});

					logger.info('Symphony contribution started', LOG_CONTEXT, {
						contributionId,
						sessionId,
						branchName,
						documentCount: resolvedDocs.length,
						hasExternalDocs,
						draftPrNumber,
					});

					return {
						success: true,
						branchName,
						autoRunPath,
						draftPrNumber,
						draftPrUrl,
					};
				} catch (error) {
					logger.error('Symphony contribution failed', LOG_CONTEXT, { error });
					return {
						success: false,
						error: error instanceof Error ? error.message : 'Unknown error',
					};
				}
			}
		)
	);
}
