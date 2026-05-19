// Small git helpers shared by the CLI. Mirrors the read-only subset of
// `src/main/ipc/handlers/git.ts` and `src/renderer/services/git.ts` that the
// CLI needs without pulling in Electron/IPC machinery.

import { execFileSync } from 'child_process';

export function getGitBranch(cwd: string): string | undefined {
	try {
		const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
		return branch || undefined;
	} catch {
		return undefined;
	}
}

export function isGitRepo(cwd: string): boolean {
	try {
		execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}
