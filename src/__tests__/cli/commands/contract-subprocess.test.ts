import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const cliEntry = resolve(process.cwd(), 'src/cli/index.ts');
const dataDirectories: string[] = [];

function runCli(...args: string[]) {
	const dataDirectory = mkdtempSync(resolve(tmpdir(), 'maestro-cli-contract-'));
	dataDirectories.push(dataDirectory);
	return spawnSync('bun', [cliEntry, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, MAESTRO_USER_DATA: dataDirectory },
		encoding: 'utf8',
	});
}

function runErrorWriter(isTTY: boolean, json: boolean) {
	// Dynamic import is intentional: formatter color support is captured when the module loads.
	const writer = resolve(process.cwd(), 'src/cli/output/command-error.ts').replace(/\\/g, '\\\\');
	return spawnSync(
		'bun',
		[
			'--eval',
			`Object.defineProperty(process.stdout, 'isTTY', { value: ${isTTY} }); const { writeCommandError } = await import('${writer}'); writeCommandError(${json}, 'daemon down');`,
		],
		{ cwd: process.cwd(), encoding: 'utf8' }
	);
}

function cliStderr(stderr: string): string {
	return stderr.replace(/^\[Logger\].*\r?\n/gm, '');
}

afterEach(() => {
	for (const dataDirectory of dataDirectories.splice(0)) {
		rmSync(dataDirectory, { recursive: true, force: true });
	}
});

describe('CLI error-output subprocess contracts', () => {
	it.each([
		['create-group', ['create-group', 'Group']],
		['create-agent', ['create-agent', 'Agent', '--cwd', '.']],
	])('%s preserves the human daemon-down contract', (_name, args) => {
		const result = runCli(...args);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(cliStderr(result.stderr)).toBe('✗ Error: Maestro desktop app is not running\n');
	});

	it.each([
		['create-group', ['create-group', 'Group', '--json']],
		['create-agent', ['create-agent', 'Agent', '--cwd', '.', '--json']],
	])('%s preserves the machine daemon-down envelope', (_name, args) => {
		const result = runCli(...args);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe('{"success":false,"error":"Maestro desktop app is not running"}\n');
		expect(cliStderr(result.stderr)).toBe('');
	});

	it('keeps Unicode-dash quoted values byte-exact in JSON errors', () => {
		const result = runCli(
			'create-agent',
			'Agent',
			'--cwd',
			'.',
			'--sync-history-to-remote',
			'“—quoted”',
			'--json'
		);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe(
			'{"success":false,"error":"--sync-history-to-remote expects true or false, got \\"“—quoted”\\""}\n'
		);
		expect(cliStderr(result.stderr)).toBe('');
	});

	it('keeps writer bytes distinct only by TTY color support', () => {
		const nonTty = runErrorWriter(false, false);
		const tty = runErrorWriter(true, false);
		const json = runErrorWriter(true, true);

		expect(nonTty.status).toBe(0);
		expect(nonTty.stdout).toBe('');
		expect(nonTty.stderr).toBe('✗ Error: daemon down\n');

		expect(tty.status).toBe(0);
		expect(tty.stdout).toBe('');
		expect(tty.stderr).toBe('\u001b[31m✗\u001b[0m \u001b[31mError:\u001b[0m daemon down\n');

		expect(json.status).toBe(0);
		expect(json.stdout).toBe('{"success":false,"error":"daemon down"}\n');
		expect(json.stderr).toBe('');
	});

	it('keeps the JSON timeout envelope when an available daemon does not answer', async () => {
		const dataDirectory = mkdtempSync(resolve(tmpdir(), 'maestro-cli-timeout-'));
		dataDirectories.push(dataDirectory);
		const server = createServer();
		const sockets: Array<{ terminate: () => void }> = [];
		const websocketServer = new WebSocketServer({ server });
		websocketServer.on('connection', (socket) => sockets.push(socket));
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');

		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
		writeFileSync(
			resolve(dataDirectory, 'cli-server.json'),
			JSON.stringify({
				port: address.port,
				token: 'test-token',
				pid: process.pid,
				startedAt: Date.now(),
			})
		);

		try {
			const child = spawn('bun', [cliEntry, 'create-group', 'Group', '--json'], {
				cwd: process.cwd(),
				env: { ...process.env, MAESTRO_USER_DATA: dataDirectory },
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => (stdout += chunk));
			child.stderr.on('data', (chunk) => (stderr += chunk));
			const [status] = await once(child, 'close');

			expect(status).toBe(1);
			expect(stdout).toBe(
				`{"success":false,"error":"Timed out waiting for the Maestro app to respond (expected 'create_group_result'). The app is reachable but its renderer did not reply - it may be busy or unresponsive."}\n`
			);
			expect(cliStderr(stderr)).toBe('');
		} finally {
			for (const socket of sockets) socket.terminate();
			websocketServer.close();
			server.close();
			await once(server, 'close');
		}
	}, 15_000);
	it('keeps the -- terminator usage error on stderr', () => {
		const result = runCli('create-agent', '--', '--literal');

		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(cliStderr(result.stderr)).toBe(
			"error: required option '-d, --cwd <path>' not specified\n"
		);
	});
});
