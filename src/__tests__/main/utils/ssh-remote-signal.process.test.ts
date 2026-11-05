/** Local counterexamples to treating legacy SSH stop results as remote death proof. */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildRemoteSignalScript } from '../../../main/utils/ssh-remote-signal';
import {
	killSurvivors,
	snapshotProcessTree,
	type ProcessTreeSnapshot,
} from '../../../shared/maestro-lib/control/process-tree';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';
import { createScratchDir } from '../../shared/maestro-lib/run/fakeAgent';

const posix = describe.skipIf(process.platform === 'win32' || !fs.existsSync('/bin/bash'));

posix('legacy SSH signal evidence against owned local processes', () => {
	let scratch: ReturnType<typeof createScratchDir> | undefined;
	let child: ChildProcess | undefined;
	let tree: ProcessTreeSnapshot | undefined;
	let workerPid: number | undefined;

	afterEach(async () => {
		try {
			if (child) {
				stopProcess({ child }, { from: 'kill', graceMs: 0, immediate: true }).dispose();
				// The escaped worker is deliberately no longer in the leader's group/tree.
				// Reuse captured PID/start identities so cleanup cannot signal a recycled PID.
				if (tree?.owned) killSurvivors(tree.descendants, { label: 'SSH evidence fixture' });
				await vi.waitFor(() => {
					expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
					if (workerPid) expect(() => process.kill(workerPid!, 0)).toThrow();
				});
			}
		} finally {
			scratch?.cleanup();
			scratch = undefined;
			child = undefined;
			tree = undefined;
			workerPid = undefined;
		}
	});

	async function launch(detached: boolean) {
		scratch = createScratchDir('maestro-ssh-evidence');
		const ready = path.join(scratch.dir, 'worker.pid');
		const pidFile = path.join(scratch.dir, 'agent.pid');
		child = spawn(
			process.execPath,
			[
				'-e',
				`const worker = require('child_process').spawn(process.execPath,
					['-e', 'setInterval(() => {}, 1000)'],
					{ detached: process.argv[2] === 'detached', stdio: 'ignore' });
				worker.on('spawn', () => require('fs').writeFileSync(process.argv[1], String(worker.pid)));
				setInterval(() => {}, 1000);`,
				ready,
				detached ? 'detached' : 'inherited',
			],
			{ detached: true, stdio: 'ignore' }
		);
		await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
		workerPid = Number(fs.readFileSync(ready, 'utf8'));
		tree = snapshotProcessTree(child.pid!);
		expect(tree.owned).toBe(true);
		expect(tree.descendants.map((entry) => entry.pid)).toContain(workerPid);
		const start = await execFileNoThrow(
			'ps',
			['-o', 'lstart=', '-p', String(child.pid)],
			scratch.dir,
			{
				timeout: 1000,
			}
		);
		expect(start.exitCode).toBe(0);
		expect(start.stdout.trim()).not.toBe('');
		// Same record format as withRemotePidRecord, without its global /tmp sweep.
		fs.writeFileSync(pidFile, `${child.pid} ${start.stdout.trim()}\n`);
		return pidFile;
	}

	function terminate(pidFile: string) {
		return execFileNoThrow('/bin/bash', ['--norc', '--noprofile', '-s'], scratch!.dir, {
			input: buildRemoteSignalScript(pidFile, 'terminate'),
			timeout: 5000,
		});
	}

	it('terminates the cooperative fixture group, without establishing containment', async () => {
		const pidFile = await launch(false);
		expect((await terminate(pidFile)).exitCode).toBe(0);
		await vi.waitFor(() => {
			expect(child!.signalCode).toBe('SIGTERM');
			expect(() => process.kill(workerPid!, 0)).toThrow();
		});
		expect(fs.existsSync(pidFile)).toBe(false);
	});

	it('returns success and deletes the record while a detached descendant survives the entire group', async () => {
		const pidFile = await launch(true);
		const leaderPid = child!.pid!;
		const group = await execFileNoThrow(
			'ps',
			['-o', 'pgid=', '-p', String(workerPid)],
			scratch!.dir,
			{
				timeout: 1000,
			}
		);
		expect(group.exitCode).toBe(0);
		expect(Number(group.stdout.trim())).toBe(workerPid);
		expect(workerPid).not.toBe(leaderPid);
		const result = await terminate(pidFile);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('');
		await vi.waitFor(() => expect(child!.signalCode).toBe('SIGTERM'));
		expect(fs.existsSync(pidFile)).toBe(false);
		expect(() => process.kill(-leaderPid, 0)).toThrow();
		expect(() => process.kill(workerPid!, 0)).not.toThrow();
		// Retrying with the now-missing record also exits 0 and proves nothing further.
		expect((await terminate(pidFile)).exitCode).toBe(0);
		expect(() => process.kill(workerPid!, 0)).not.toThrow();
	});

	it('returns success for a missing record while the original processes are still running', async () => {
		const pidFile = await launch(true);
		fs.unlinkSync(pidFile);
		expect((await terminate(pidFile)).exitCode).toBe(0);
		expect(child!.signalCode).toBeNull();
		expect(child!.exitCode).toBeNull();
		expect(() => process.kill(workerPid!, 0)).not.toThrow();
	});

	it('refuses a mismatching start identity without proving that any work terminated', async () => {
		const pidFile = await launch(true);
		fs.writeFileSync(pidFile, `${child!.pid} different-original-start\n`);
		expect((await terminate(pidFile)).exitCode).toBe(0);
		expect(fs.existsSync(pidFile)).toBe(false);
		expect(child!.signalCode).toBeNull();
		expect(child!.exitCode).toBeNull();
		expect(() => process.kill(workerPid!, 0)).not.toThrow();
	});
});
