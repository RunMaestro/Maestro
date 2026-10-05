const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Explicit isolated run: owned loopback HTTP/WebSocket only; no external network, agents, SSH or full host startup.
// MAESTRO_LITE_TEST_PACKAGE may point at release/win-unpacked/resources/app.asar.
test(
	'native direct Tailscale discovery and code pairing open protected host access',
	{ timeout: 120000 },
	async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-native-lite-'));
		const env = { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '' };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(
			process.env.MAESTRO_LITE_TEST_EXECUTABLE || require('electron'),
			[
				path.join(__dirname, 'fixtures/lite-native-entry.cjs'),
				directory,
				path.resolve(process.env.MAESTRO_LITE_TEST_PACKAGE || '.'),
				'--disable-background-networking',
				'--disable-component-update',
				'--user-data-dir=' + path.join(directory, 'chromium'),
			],
			{ env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
			if (
				process.env.MAESTRO_LITE_NATIVE_PROMPT === '1' &&
				chunk.toString().includes('NATIVE_PAIRING_PROMPT_READY')
			)
				console.log(chunk.toString().trim());
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill(), 110000);
		try {
			const exit = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', (code, signal) => resolve({ code, signal }));
			});
			assert.equal(exit.code, 0, `${JSON.stringify(exit)}\n${stdout}\n${stderr}`);
			const record = stdout.split('\n').find((line) => line.startsWith('LITE_NATIVE_RESULT '));
			assert.ok(record, 'Native runner did not produce its assertion report');
			console.log(record);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill();
			await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}
);
