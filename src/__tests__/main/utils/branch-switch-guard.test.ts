import { describe, it, expect, vi, beforeEach } from 'vitest';

// Work trees on the fake disk. `rev-parse --show-toplevel` answers with the
// deepest root that contains the directory, as git does.
const ROOTS = ['/repo', '/repo/.wt/nested', '/worktrees/feature'];

vi.mock('../../../main/utils/remote-git', () => ({
	execGit: vi.fn(async (_args: string[], localCwd: string, _ssh?: unknown, remoteCwd?: string) => {
		const dir = remoteCwd || localCwd;
		const root = ROOTS.filter((r) => dir === r || dir.startsWith(`${r}/`)).sort(
			(a, b) => b.length - a.length
		)[0];
		return root
			? { exitCode: 0, stdout: `${root}\n`, stderr: '' }
			: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
	}),
}));

import {
	beginRemoteSync,
	branchSwitchBlocker,
	__resetBranchSwitchGuardForTests,
	type WorkTreeProcess,
} from '../../../main/utils/branch-switch-guard';

const AGENT = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-7777-8888-9999-000000000000';
const NAMES: Record<string, string> = { [AGENT]: 'Maestro', [OTHER]: 'Docs' };

function deps(processes: WorkTreeProcess[]) {
	return {
		getProcessManager: () => ({ getAll: () => processes }),
		getAgentName: (id: string) => NAMES[id],
	};
}

function proc(
	sessionId: string,
	cwd: string,
	extra: Partial<WorkTreeProcess> = {}
): WorkTreeProcess {
	return { sessionId, cwd, isTerminal: false, ...extra };
}

describe('branchSwitchBlocker', () => {
	beforeEach(() => __resetBranchSwitchGuardForTests());

	it('allows a switch when nothing runs in the work tree', async () => {
		expect(await branchSwitchBlocker(deps([]), '/repo')).toBeNull();
	});

	it('refuses while a push runs in the same work tree, and allows it after', async () => {
		const release = await beginRemoteSync('push', '/repo/src');
		expect(await branchSwitchBlocker(deps([]), '/repo')).toMatch(/git push is running/);
		release();
		expect(await branchSwitchBlocker(deps([]), '/repo')).toBeNull();
	});

	it('keeps refusing until every overlapping push/pull has released', async () => {
		const a = await beginRemoteSync('push', '/repo');
		const b = await beginRemoteSync('pull', '/repo');
		a();
		a(); // a double release must not drop the other run's hold
		expect(await branchSwitchBlocker(deps([]), '/repo')).not.toBeNull();
		b();
		expect(await branchSwitchBlocker(deps([]), '/repo')).toBeNull();
	});

	it('does not let a push in a worktree block the main checkout', async () => {
		await beginRemoteSync('push', '/worktrees/feature');
		expect(await branchSwitchBlocker(deps([]), '/repo')).toBeNull();
	});

	it('refuses while an agent runs a turn anywhere in the work tree, and names it', async () => {
		const result = await branchSwitchBlocker(
			deps([proc(`${AGENT}-ai-tab1`, '/repo/packages/app')]),
			'/repo'
		);
		expect(result).toBe(
			'Maestro has a turn running in this working tree. Wait for it to finish before you change branch.'
		);
	});

	it('counts Auto Run and Cue processes, and names each agent once', async () => {
		const result = await branchSwitchBlocker(
			deps([
				proc(`${AGENT}-batch-123`, '/repo'),
				proc(`${AGENT}-ai-tab2`, '/repo'),
				proc(`${OTHER}-cue-run9`, '/repo'),
			]),
			'/repo'
		);
		expect(result).toMatch(/^Maestro and Docs have turns running/);
	});

	it('ignores shell tabs, other work trees, and other hosts', async () => {
		const result = await branchSwitchBlocker(
			deps([
				proc(`${AGENT}-terminal`, '/repo', { isTerminal: true }),
				proc(`${AGENT}-ai-tab1`, '/worktrees/feature'),
				proc(`${AGENT}-ai-tab2`, '/repo/.wt/nested'),
				proc(`${OTHER}-ai-tab1`, '/repo', { sshRemoteId: 'remote-1' }),
				proc(`${OTHER}-ai-tab2`, '/elsewhere'),
			]),
			'/repo'
		);
		expect(result).toBeNull();
	});

	it('prefers projectPath over cwd (SSH spawns run locally from home)', async () => {
		const result = await branchSwitchBlocker(
			deps([proc(`${AGENT}-ai-tab1`, '/Users/me', { projectPath: '/repo' })]),
			'/repo'
		);
		expect(result).toMatch(/^Maestro/);
	});

	it('says "An agent" when the process id does not map to a known agent', async () => {
		const result = await branchSwitchBlocker(deps([proc('group-chat-xyz', '/repo')]), '/repo');
		expect(result).toMatch(/^An agent has a turn running/);
	});

	it('defers to git when the directory is not a repository', async () => {
		await beginRemoteSync('push', '/nowhere');
		expect(
			await branchSwitchBlocker(deps([proc(`${AGENT}-ai-t`, '/nowhere')]), '/nowhere')
		).toBeNull();
	});
});
