#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

function run(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			encoding: 'utf8',
			stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		if (options.allowFailure) {
			return error.stdout?.toString() ?? '';
		}
		throw error;
	}
}

function readPm2Processes() {
	const output = run('pm2', ['jlist'], { allowFailure: true });
	if (!output.trim()) {
		return [];
	}

	try {
		return JSON.parse(output);
	} catch {
		return [];
	}
}

function readProcessTable() {
	const output = run('ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
	return output
		.split('\n')
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
			if (!match) {
				return null;
			}

			return {
				pid: Number(match[1]),
				ppid: Number(match[2]),
				pgid: Number(match[3]),
				command: match[4],
			};
		})
		.filter(Boolean);
}

function currentProcessGroupId() {
	const output = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFailure: true });
	return Number(output.trim());
}

function isE2ePm2Process(processInfo) {
	return /^maestro-e2e(?:-|$)/.test(processInfo.name ?? '');
}

function isKnownE2eChild(processInfo) {
	const command = processInfo.command;
	if (processInfo.pid === process.pid) {
		return false;
	}

	if (/\.bin\/playwright test .*e2e\//.test(command) && /e2e-results\/shard-/.test(command)) {
		return true;
	}

	if (!command.includes(repoRoot)) {
		return false;
	}

	return (
		command.includes('/node_modules/playwright/lib/common/process.js') ||
		command.includes('/node_modules/electron/dist/Electron.app') ||
		command.includes('/node_modules/electron/dist/Electron Helper') ||
		command.includes('/node_modules/electron/dist/Electron Framework') ||
		/maestro-e2e-run-/.test(command)
	);
}

function descendantsOf(processTable, rootPids) {
	const byParent = new Map();
	for (const processInfo of processTable) {
		const children = byParent.get(processInfo.ppid) ?? [];
		children.push(processInfo);
		byParent.set(processInfo.ppid, children);
	}

	const seen = new Set();
	const queue = [...rootPids];
	const descendants = [];
	while (queue.length > 0) {
		const parentPid = queue.shift();
		for (const child of byParent.get(parentPid) ?? []) {
			if (seen.has(child.pid)) {
				continue;
			}
			seen.add(child.pid);
			descendants.push(child);
			queue.push(child.pid);
		}
	}

	return descendants;
}

function stopPm2Processes(pm2Processes) {
	if (pm2Processes.length === 0) {
		return;
	}

	const ids = pm2Processes.map((processInfo) => String(processInfo.pm_id));
	console.log(
		`Stopping PM2 E2E processes: ${pm2Processes.map((processInfo) => processInfo.name).join(', ')}`
	);
	if (dryRun) {
		return;
	}

	run('pm2', ['stop', ...ids], { allowFailure: true, stdio: 'inherit' });
	run('pm2', ['delete', ...ids], { allowFailure: true, stdio: 'inherit' });
}

function killProcesses(processes, signal) {
	const ownPgid = currentProcessGroupId();
	const groups = new Set();
	const pids = new Set();

	for (const processInfo of processes) {
		if (processInfo.pid === process.pid) {
			continue;
		}
		if (processInfo.pgid > 1 && processInfo.pgid !== ownPgid) {
			groups.add(processInfo.pgid);
		} else {
			pids.add(processInfo.pid);
		}
	}

	for (const pgid of groups) {
		if (dryRun) {
			console.log(`[dry-run] would send ${signal} to process group ${pgid}`);
			continue;
		}
		try {
			process.kill(-pgid, signal);
		} catch {}
	}

	for (const pid of pids) {
		if (dryRun) {
			console.log(`[dry-run] would send ${signal} to process ${pid}`);
			continue;
		}
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

function wait(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const pm2E2eProcesses = readPm2Processes().filter(isE2ePm2Process);
const initialProcessTable = readProcessTable();
const pm2RootPids = pm2E2eProcesses.map((processInfo) => processInfo.pid).filter(Boolean);
const initialTargets = [
	...descendantsOf(initialProcessTable, pm2RootPids),
	...initialProcessTable.filter(isKnownE2eChild),
];

if (dryRun) {
	console.log(`PM2 E2E processes: ${pm2E2eProcesses.length}`);
	console.log(`Candidate child processes: ${initialTargets.length}`);
	for (const processInfo of initialTargets) {
		console.log(
			`${processInfo.pid}\t${processInfo.ppid}\t${processInfo.pgid}\t${processInfo.command}`
		);
	}
	process.exit(0);
}

stopPm2Processes(pm2E2eProcesses);

let remainingTargets = [
	...readProcessTable().filter((processInfo) =>
		initialTargets.some(
			(target) => target.pid === processInfo.pid || target.pgid === processInfo.pgid
		)
	),
	...readProcessTable().filter(isKnownE2eChild),
];

remainingTargets = [
	...new Map(remainingTargets.map((processInfo) => [processInfo.pid, processInfo])).values(),
];
if (remainingTargets.length > 0) {
	console.log(`Terminating ${remainingTargets.length} E2E child processes/process groups`);
	killProcesses(remainingTargets, 'SIGTERM');
	wait(1500);
}

remainingTargets = readProcessTable().filter((processInfo) => isKnownE2eChild(processInfo));
if (remainingTargets.length > 0) {
	console.log(
		`Force-killing ${remainingTargets.length} remaining E2E child processes/process groups`
	);
	killProcesses(remainingTargets, 'SIGKILL');
	wait(500);
}

const survivors = readProcessTable().filter(isKnownE2eChild);
if (survivors.length > 0) {
	console.error('Some Maestro E2E processes are still running:');
	for (const processInfo of survivors) {
		console.error(
			`${processInfo.pid}\t${processInfo.ppid}\t${processInfo.pgid}\t${processInfo.command}`
		);
	}
	process.exit(1);
}

console.log('No Maestro E2E Playwright/Electron processes found.');
