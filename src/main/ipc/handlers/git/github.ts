import { ipcMain } from 'electron';
import { execFileNoThrow } from '../../../utils/execFile';
import { logger } from '../../../utils/logger';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { resolveGhPath, getCachedGhStatus, setCachedGhStatus } from '../../../utils/cliDetection';
import { getShellPath } from '../../../runtime/getShellPath';
import { captureMessage } from '../../../utils/sentry';
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
				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI at: ${ghCommand}`, LOG_CONTEXT);

				// Build env with the user's full shell PATH so git hooks
				// (e.g. Husky pre-push running npm) can find Node/npm binaries
				let shellEnv: NodeJS.ProcessEnv | undefined;
				try {
					const shellPath = await getShellPath();
					if (shellPath) {
						shellEnv = { ...process.env, PATH: shellPath };
					}
				} catch (error) {
					captureMessage(
						`git:createPR falling back to default PATH: ${error instanceof Error ? error.message : String(error)}`,
						'warning'
					);
				}

				// First, push the current branch to origin
				const pushResult = await execFileNoThrow(
					'git',
					['push', '-u', 'origin', 'HEAD'],
					worktreePath,
					shellEnv
				);
				if (pushResult.exitCode !== 0) {
					return { success: false, error: `Failed to push branch: ${pushResult.stderr}` };
				}

				// Create the PR using gh CLI
				const prResult = await execFileNoThrow(
					ghCommand,
					['pr', 'create', '--base', baseBranch, '--title', title, '--body', body],
					worktreePath,
					shellEnv
				);

				if (prResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						prResult.stderr.includes('command not found') ||
						prResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
						};
					}
					return { success: false, error: prResult.stderr || 'Failed to create PR' };
				}

				// The PR URL is typically in stdout
				const prUrl = prResult.stdout.trim();
				return { success: true, prUrl };
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
