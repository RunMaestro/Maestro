import { ipcMain } from 'electron';
import { execFileNoThrow } from '../../../utils/execFile';
import { logger } from '../../../utils/logger';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { resolveGhPath, getCachedGhStatus, setCachedGhStatus } from '../../../utils/cliDetection';
import { captureMessage } from '../../../utils/sentry';
import { createPullRequest } from '../../../utils/pr-creator';
import { LOG_CONTEXT, handlerOpts } from './shared';

/**
 * Register GitHub CLI integration Git IPC handlers: createPR, checkGhCli, createGist.
 */
export function registerGithubHandlers(): void {
	// Create a PR from the worktree branch to a base branch
	// ghPath parameter allows specifying custom path to gh binary
	ipcMain.handle(
		'git:createPR',
		withIpcErrorLogging(
			handlerOpts('createPR'),
			async (
				worktreePath: string,
				baseBranch: string,
				title: string,
				body: string,
				ghPath?: string
			) => {
				// The shared helper owns the push + `gh pr create` chain; the base
				// branch stays a required argument here (the renderer resolves it).
				// Delegated so the Board's per-card PR-on-done and this handler cannot
				// drift apart.
				const result = await createPullRequest({
					worktreePath,
					targetBranch: baseBranch,
					title,
					body,
					ghPath,
					log: (msg) => logger.debug(msg, LOG_CONTEXT),
					warn: (msg) => captureMessage(msg, 'warning'),
				});
				// Reply shape is unchanged for renderer callers: the helper's
				// resolved `targetBranch` is redundant here (it is `baseBranch`).
				return result.success
					? { success: true, prUrl: result.prUrl }
					: { success: false, error: result.error };
			}
		)
	);

	// Check if GitHub CLI (gh) is installed and authenticated
	// ghPath parameter allows specifying custom path to gh binary (e.g., /opt/homebrew/bin/gh)
	// Results are cached for 1 minute to avoid repeated subprocess calls
	ipcMain.handle(
		'git:checkGhCli',
		withIpcErrorLogging(handlerOpts('checkGhCli'), async (ghPath?: string) => {
			// Check cache first (skip if custom path provided)
			if (!ghPath) {
				const cached = getCachedGhStatus();
				if (cached !== null) {
					logger.debug(
						`Using cached gh CLI status: installed=${cached.installed}, authenticated=${cached.authenticated}`,
						LOG_CONTEXT
					);
					return cached;
				}
			}

			// Resolve gh CLI path (uses cached detection or custom path)
			const ghCommand = await resolveGhPath(ghPath);
			logger.debug(`Checking gh CLI at: ${ghCommand}`, LOG_CONTEXT);

			// Check if gh is installed by running gh --version
			const versionResult = await execFileNoThrow(ghCommand, ['--version']);
			if (versionResult.exitCode !== 0) {
				logger.warn(
					`gh CLI not found at ${ghCommand}: exit=${versionResult.exitCode}, stderr=${versionResult.stderr}`,
					LOG_CONTEXT
				);
				const result = { installed: false, authenticated: false };
				if (!ghPath) setCachedGhStatus(false, false);
				return result;
			}
			logger.debug(`gh CLI found: ${versionResult.stdout.trim().split('\n')[0]}`, LOG_CONTEXT);

			// Check if gh is authenticated by running gh auth status
			const authResult = await execFileNoThrow(ghCommand, ['auth', 'status']);
			const authenticated = authResult.exitCode === 0;
			logger.debug(
				`gh auth status: ${authenticated ? 'authenticated' : 'not authenticated'}`,
				LOG_CONTEXT
			);

			// Cache the result (only if not using custom path)
			if (!ghPath) {
				setCachedGhStatus(true, authenticated);
			}

			return { installed: true, authenticated };
		})
	);

	// Create a GitHub Gist from file content
	// Returns the gist URL on success
	ipcMain.handle(
		'git:createGist',
		withIpcErrorLogging(
			handlerOpts('createGist'),
			async (
				filename: string,
				content: string,
				description: string,
				isPublic: boolean,
				ghPath?: string
			) => {
				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI for gist creation at: ${ghCommand}`, LOG_CONTEXT);

				// Create gist using gh CLI with stdin for content
				// gh gist create --filename <name> --desc <desc> [--public] -
				const args = ['gist', 'create', '--filename', filename];
				if (description) {
					args.push('--desc', description);
				}
				if (isPublic) {
					args.push('--public');
				}
				args.push('-'); // Read from stdin

				const gistResult = await execFileNoThrow(ghCommand, args, undefined, { input: content });

				if (gistResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						gistResult.stderr.includes('command not found') ||
						gistResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create gists.',
						};
					}
					// Check for authentication issues
					if (
						gistResult.stderr.includes('not logged') ||
						gistResult.stderr.includes('authentication')
					) {
						return {
							success: false,
							error: 'GitHub CLI is not authenticated. Please run "gh auth login" first.',
						};
					}
					return { success: false, error: gistResult.stderr || 'Failed to create gist' };
				}

				// The gist URL is typically in stdout
				const gistUrl = gistResult.stdout.trim();
				logger.info(`${LOG_CONTEXT} Created gist: ${gistUrl}`);
				return { success: true, gistUrl };
			}
		)
	);
}
