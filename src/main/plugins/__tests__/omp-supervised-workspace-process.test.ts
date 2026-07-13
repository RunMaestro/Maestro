import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
	createConfiguredOmpSupervisedWorkspaceProcess,
	createOmpSupervisedWorkspaceProcess,
	type WorkspaceProcessChild,
} from '../omp-supervised-workspace-process';

class FakeChild extends EventEmitter implements WorkspaceProcessChild {
	pid = 71;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();

	kill = vi.fn(() => true);

	close(code = 0): void {
		this.exitCode = code;
		this.emit('close', code, null);
	}
}

function configured(
	options: Partial<Parameters<typeof createConfiguredOmpSupervisedWorkspaceProcess>[0]> = {}
) {
	return createConfiguredOmpSupervisedWorkspaceProcess({
		selectedShell: 'C:/Program Files/Git/bin/bash.exe',
		resolveShellPath: (shell) => shell,
		inspectShell: async () => ({
			isRegularFile: true,
			isReparsePoint: false,
			canonicalPath: 'C:/Program Files/Git/bin/bash.exe',
		}),
		privateHome: 'C:/private/omp-home',
		spawn: vi.fn(() => new FakeChild()),
		killTree: vi.fn(async () => undefined),
		environment: { PATH: 'C:/Windows/System32', SystemRoot: 'C:/Windows' },
		...options,
	});
}

describe('OMP supervised workspace process', () => {
	it('does not expose an adapter for absent, relative, non-regular, or reparse shell paths', async () => {
		await expect(configured({ selectedShell: '' })).resolves.toBeNull();
		await expect(
			configured({ selectedShell: 'powershell', resolveShellPath: () => 'powershell.exe' })
		).resolves.toBeNull();
		await expect(
			configured({
				inspectShell: async () => ({
					isRegularFile: false,
					isReparsePoint: false,
					canonicalPath: 'C:/Program Files/Git/bin/bash.exe',
				}),
			})
		).resolves.toBeNull();
		await expect(
			configured({
				inspectShell: async () => ({
					isRegularFile: true,
					isReparsePoint: true,
					canonicalPath: 'C:/Program Files/Git/bin/bash.exe',
				}),
			})
		).resolves.toBeNull();
	});

	it('uses configured Git Bash with fixed arguments, root cwd, no shell, and private allowlisted environment', async () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child);
		const process = await configured({ spawn });
		expect(process).not.toBeNull();
		const promise = process!.run({
			command: 'git status',
			cwd: 'C:/workspace',
			timeoutMs: 1_000,
			signal: new AbortController().signal,
		});
		expect(spawn).toHaveBeenCalledWith(
			'C:/Program Files/Git/bin/bash.exe',
			['--noprofile', '--norc', '-c', 'git status'],
			expect.objectContaining({
				cwd: 'C:/workspace',
				shell: false,
				env: {
					HOME: 'C:/private/omp-home',
					USERPROFILE: 'C:/private/omp-home',
					PATH: 'C:/Windows/System32',
					SystemRoot: 'C:/Windows',
				},
			})
		);
		child.close();
		await expect(promise).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
	});

	it('uses fixed PowerShell noninteractive arguments', async () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child);
		const process = await configured({
			selectedShell: 'C:/Program Files/PowerShell/7/pwsh.exe',
			inspectShell: async () => ({
				isRegularFile: true,
				isReparsePoint: false,
				canonicalPath: 'C:/Program Files/PowerShell/7/pwsh.exe',
			}),
			spawn,
		});
		const promise = process!.run({
			command: 'Get-ChildItem',
			cwd: 'C:/workspace',
			timeoutMs: 1_000,
			signal: new AbortController().signal,
		});
		expect(spawn).toHaveBeenCalledWith(
			'C:/Program Files/PowerShell/7/pwsh.exe',
			['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem'],
			expect.objectContaining({ shell: false })
		);
		child.close();
		await promise;
	});

	it('enforces one active run, timeout bounds, combined 1 MiB output, cancellation, and revocation process-tree cleanup', async () => {
		const child = new FakeChild();
		const killTree = vi.fn(async () => undefined);
		const process = createOmpSupervisedWorkspaceProcess({
			shellPath: 'C:/Program Files/Git/bin/bash.exe',
			fixedArgs: ['--noprofile', '--norc', '-c'],
			privateHome: 'C:/private/omp-home',
			spawn: vi.fn(() => child),
			killTree,
			environment: { PATH: 'C:/Windows/System32' },
		});
		const active = process.run({
			command: 'sleep',
			cwd: 'C:/workspace',
			timeoutMs: 1_000,
			signal: new AbortController().signal,
			env: { LEAK: 'no' },
		} as never);
		await expect(
			process.run({
				command: 'second',
				cwd: 'C:/workspace',
				timeoutMs: 1_000,
				signal: new AbortController().signal,
			})
		).rejects.toThrow('unavailable');
		process.cancel();
		expect(killTree).toHaveBeenCalledWith(71, true);
		await expect(active).rejects.toThrow('cancelled');
		await expect(
			process.run({
				command: 'too-short',
				cwd: 'C:/workspace',
				timeoutMs: 999,
				signal: new AbortController().signal,
			})
		).rejects.toThrow('unavailable');
		const outputChild = new FakeChild();
		const outputProcess = createOmpSupervisedWorkspaceProcess({
			shellPath: 'C:/Program Files/Git/bin/bash.exe',
			fixedArgs: ['-c'],
			privateHome: 'C:/private/omp-home',
			spawn: vi.fn(() => outputChild),
			killTree,
			environment: { PATH: 'safe' },
		});
		const oversized = outputProcess.run({
			command: 'flood',
			cwd: 'C:/workspace',
			timeoutMs: 1_000,
			signal: new AbortController().signal,
		});
		outputChild.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
		await expect(oversized).rejects.toThrow('output exceeds limit');
		expect(killTree).toHaveBeenLastCalledWith(71, true);
		const revokeChild = new FakeChild();
		revokeChild.pid = 72;
		const revokeProcess = createOmpSupervisedWorkspaceProcess({
			shellPath: 'C:/Program Files/Git/bin/bash.exe',
			fixedArgs: ['-c'],
			privateHome: 'C:/private/omp-home',
			spawn: vi.fn(() => revokeChild),
			killTree,
			environment: { PATH: 'safe' },
		});
		const revoking = revokeProcess.run({
			command: 'wait',
			cwd: 'C:/workspace',
			timeoutMs: 1_000,
			signal: new AbortController().signal,
		});
		revokeProcess.revoke();
		await expect(revoking).rejects.toThrow('revoked');
		expect(killTree).toHaveBeenLastCalledWith(72, true);
	});
});
