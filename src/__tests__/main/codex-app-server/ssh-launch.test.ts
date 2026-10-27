/**
 * Tests for src/main/codex-app-server/ssh-launch.ts
 *
 * The launch must run `codex app-server` with the SAME config args the exec
 * turn would have, from the same remote, binary, cwd and env, and must refuse
 * (null, so the exec wrapper runs) any turn app-server cannot carry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBuildSshCommandWithStdin = vi.fn();
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommandWithStdin: (...args: unknown[]) => mockBuildSshCommandWithStdin(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildCodexAppServerSshLaunch } from '../../../main/codex-app-server/ssh-launch';
import type { SshRemoteConfig } from '../../../shared/types';

const REMOTE = { id: 'remote-1', name: 'Box', host: 'box', port: 22 } as SshRemoteConfig;
const EXEC_ARGS = [
	'exec',
	'--json',
	'--dangerously-bypass-approvals-and-sandbox',
	'-c',
	'model_reasoning_effort="high"',
];
const OPTIONS = {
	remoteCommand: 'codex',
	execArgs: EXEC_ARGS,
	cwd: '/home/me/proj',
	env: { MAESTRO_QUERY_SOURCE: 'user' },
	prompt: 'fix the bug',
};

describe('buildCodexAppServerSshLaunch', () => {
	beforeEach(() => {
		mockBuildSshCommandWithStdin.mockReset();
		mockBuildSshCommandWithStdin.mockResolvedValue({
			command: '/usr/bin/ssh',
			args: ['box', '/bin/bash', '--norc', '--noprofile', '-s'],
			stdinScript: 'exec codex app-server\n',
			remoteCommandLine: 'codex app-server',
		});
	});

	it('runs app-server with the exec turn config args, on the same remote, cwd and env', async () => {
		const launch = await buildCodexAppServerSshLaunch(REMOTE, OPTIONS);

		expect(mockBuildSshCommandWithStdin).toHaveBeenCalledWith(REMOTE, {
			command: 'codex',
			args: ['app-server', '-c', 'model_reasoning_effort="high"'],
			cwd: '/home/me/proj',
			env: { MAESTRO_QUERY_SOURCE: 'user' },
		});
		expect(launch).toEqual({
			command: '/usr/bin/ssh',
			args: ['box', '/bin/bash', '--norc', '--noprofile', '-s'],
			stdinScript: 'exec codex app-server\n',
			remoteCommandLine: 'codex app-server',
			execArgs: EXEC_ARGS,
			cwd: '/home/me/proj',
			prompt: 'fix the bug',
		});
	});

	it.each([
		['no prompt', { prompt: undefined }],
		['an image', { images: ['data:image/png;base64,AAAA'] }],
		['an arg app-server cannot carry', { execArgs: [...EXEC_ARGS, '--oss'] }],
	])('leaves a turn with %s to the exec wrapper', async (_label, overrides) => {
		expect(await buildCodexAppServerSshLaunch(REMOTE, { ...OPTIONS, ...overrides })).toBeNull();
		expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
	});

	it('leaves a named profile and ordered config overrides to the exec wrapper', async () => {
		const execArgs = [
			...EXEC_ARGS,
			'--profile',
			'synthetic-manager',
			'--config=model_reasoning_effort="low"',
		];
		const options = { ...OPTIONS, execArgs: [...execArgs] };

		expect(await buildCodexAppServerSshLaunch(REMOTE, options)).toBeNull();

		expect(options.execArgs).toEqual(execArgs);
		expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
	});

	it('returns null when the builder produced no script', async () => {
		mockBuildSshCommandWithStdin.mockResolvedValue({ command: 'ssh', args: [] });
		expect(await buildCodexAppServerSshLaunch(REMOTE, OPTIONS)).toBeNull();
	});
});
