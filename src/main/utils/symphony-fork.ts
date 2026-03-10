import { execFileNoThrow } from './execFile';
import { logger } from './logger';
import { getExpandedEnv } from '../agents/path-prober';

const LOG_CONTEXT = '[SymphonyFork]';

export interface ForkSetupResult {
	isFork: boolean;
	forkSlug?: string;
	error?: string;
}

/**
 * Ensures the user has push access to the repo, forking if necessary.
 * Reconfigures git remotes so `origin` points to the user's fork
 * and `upstream` points to the original repo.
 */
export async function ensureForkSetup(
	repoPath: string,
	repoSlug: string
): Promise<ForkSetupResult> {
	const env = getExpandedEnv();

	// 1. Get authenticated GitHub user
	logger.info('Checking GitHub authentication', LOG_CONTEXT);
	const userResult = await execFileNoThrow('gh', ['api', 'user', '--jq', '.login'], undefined, env);
	if (userResult.exitCode !== 0) {
		logger.error('GitHub CLI not authenticated', LOG_CONTEXT, { stderr: userResult.stderr });
		return { isFork: false, error: 'GitHub CLI not authenticated' };
	}
	const ghUser = userResult.stdout.trim();

	// 2. Check if user owns the repo
	const [owner, repoName] = repoSlug.split('/');
	if (owner === ghUser) {
		logger.info('User owns the repo, no fork needed', LOG_CONTEXT);
		return { isFork: false };
	}

	// 3. Check push access
	logger.info(`Checking push access to ${repoSlug}`, LOG_CONTEXT);
	const accessResult = await execFileNoThrow(
		'gh',
		['api', `repos/${repoSlug}`, '--jq', '.permissions.push'],
		undefined,
		env
	);
	if (accessResult.exitCode === 0 && accessResult.stdout.trim() === 'true') {
		logger.info('User has push access, no fork needed', LOG_CONTEXT);
		return { isFork: false };
	}

	// 4. Fork the repo (idempotent)
	logger.info(`Forking ${repoSlug}`, LOG_CONTEXT);
	const forkResult = await execFileNoThrow(
		'gh',
		['repo', 'fork', repoSlug, '--clone=false'],
		undefined,
		env
	);
	if (forkResult.exitCode !== 0) {
		// gh repo fork returns non-zero if fork already exists but prints to stderr — check for that
		const alreadyExists = forkResult.stderr.includes('already exists');
		if (!alreadyExists) {
			logger.error('Failed to fork repo', LOG_CONTEXT, { stderr: forkResult.stderr });
			return { isFork: false, error: `Failed to fork repo: ${forkResult.stderr}` };
		}
		logger.info('Fork already exists', LOG_CONTEXT);
	}

	// 5. Get fork clone URL
	const forkSlug = `${ghUser}/${repoName}`;
	logger.info(`Getting clone URL for ${forkSlug}`, LOG_CONTEXT);
	const urlResult = await execFileNoThrow(
		'gh',
		['api', `repos/${forkSlug}`, '--jq', '.clone_url'],
		undefined,
		env
	);
	if (urlResult.exitCode !== 0) {
		logger.error('Failed to get fork clone URL', LOG_CONTEXT, { stderr: urlResult.stderr });
		return { isFork: false, error: `Failed to get fork clone URL: ${urlResult.stderr}` };
	}
	const forkCloneUrl = urlResult.stdout.trim();

	// 6. Reconfigure remotes
	logger.info('Reconfiguring git remotes', LOG_CONTEXT);
	const renameResult = await execFileNoThrow(
		'git',
		['remote', 'rename', 'origin', 'upstream'],
		repoPath
	);
	if (renameResult.exitCode !== 0) {
		// Fallback: upstream already exists, just set origin URL
		logger.warn('Could not rename origin to upstream, trying set-url fallback', LOG_CONTEXT, {
			stderr: renameResult.stderr,
		});
		const setUrlResult = await execFileNoThrow(
			'git',
			['remote', 'set-url', 'origin', forkCloneUrl],
			repoPath
		);
		if (setUrlResult.exitCode !== 0) {
			logger.error('Failed to set origin URL', LOG_CONTEXT, { stderr: setUrlResult.stderr });
			return { isFork: false, error: `Failed to reconfigure remotes: ${setUrlResult.stderr}` };
		}
	} else {
		const addResult = await execFileNoThrow(
			'git',
			['remote', 'add', 'origin', forkCloneUrl],
			repoPath
		);
		if (addResult.exitCode !== 0) {
			logger.error('Failed to add origin remote', LOG_CONTEXT, { stderr: addResult.stderr });
			return { isFork: false, error: `Failed to add origin remote: ${addResult.stderr}` };
		}
	}

	// Set HEAD for origin so getDefaultBranch() works correctly with fork remotes
	await execFileNoThrow('git', ['remote', 'set-head', 'origin', '-a'], repoPath);

	logger.info(`Fork setup complete: ${forkSlug}`, LOG_CONTEXT);
	return { isFork: true, forkSlug };
}
