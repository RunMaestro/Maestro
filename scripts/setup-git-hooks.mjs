import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function runGit(args) {
	const result = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
	}
	return result.stdout.trim();
}

function getGitConfig(key) {
	const result = spawnSync('git', ['config', '--get', key], { stdio: 'pipe', encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) return '';
	return result.stdout.trim();
}

if (!existsSync('.git')) {
	console.log('[setup-git-hooks] Skipping hook installation because .git is not present.');
	process.exit(0);
}

const desiredHooksPath = '.husky';
const currentHooksPath = getGitConfig('core.hooksPath');

if (currentHooksPath !== desiredHooksPath) {
	runGit(['config', 'core.hooksPath', desiredHooksPath]);
	console.log(`[setup-git-hooks] Set core.hooksPath=${desiredHooksPath}`);
} else {
	console.log(`[setup-git-hooks] core.hooksPath already set to ${desiredHooksPath}`);
}
