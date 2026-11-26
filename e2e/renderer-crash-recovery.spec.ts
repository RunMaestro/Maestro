import fs from 'node:fs';
import path from 'node:path';
import { createMockSession } from '../src/__tests__/helpers/mockSession';
import { expect, test as base } from './fixtures/electron-app';

const AGENT_ID = 'renderer-recovery-agent';
const TAB_ID = 'renderer-recovery-tab';
const PROCESS_ID = `${AGENT_ID}-ai-${TAB_ID}`;
const RESPONSE = 'Codex finished after the renderer recovered.';

const test = base.extend({
	electronLaunchEnv: async ({ testDataDir }, use) => {
		const session = createMockSession({
			id: AGENT_ID,
			name: 'Renderer Recovery',
			toolType: 'codex',
			codexTransport: 'app-server',
			cwd: testDataDir,
			fullPath: testDataDir,
			projectRoot: testDataDir,
			activeTabId: TAB_ID,
			aiTabs: [
				{
					id: TAB_ID,
					agentSessionId: null,
					name: 'Recovery',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
					state: 'idle',
				},
			],
			unifiedTabOrder: [{ type: 'ai', id: TAB_ID }],
		});
		fs.writeFileSync(
			path.join(testDataDir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [session], activeSessionId: AGENT_ID })
		);
		// A local app-server fixture keeps an acknowledged turn open until released.
		fs.writeFileSync(
			path.join(testDataDir, 'codex'),
			`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) {
	console.log('codex-cli 0.150.0');
	process.exit(0);
}
if (!process.argv.includes('app-server')) process.exit(1);
const threadId = 'c75cf10a-23db-42aa-9f76-e7a6ee46dd25';
const turnId = 'fixture-turn';
const send = (message) => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const { id, method } = JSON.parse(line);
	if (method === 'initialize') send({ id, result: {} });
	if (method === 'thread/start') send({ id, result: { thread: { id: threadId } } });
	if (method !== 'turn/start') return;
	send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
	send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
	fs.writeFileSync('codex-turn-started', '');
	const timer = setInterval(() => {
		if (!fs.existsSync('finish-codex')) return;
		clearInterval(timer);
		send({ method: 'item/completed', params: {
			threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: ${JSON.stringify(RESPONSE)} }
		} });
		send({ method: 'turn/completed', params: {
			threadId, turn: { id: turnId, status: 'completed' }
		} });
	}, 25);
});
`,
			{ mode: 0o755 }
		);
		await use({
			MAESTRO_USER_DATA: testDataDir,
			MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1',
			CODEX_HOME: path.join(testDataDir, 'codex-home'),
		});
	},
});

test('keeps the same live Codex turn through a primary renderer crash', async ({
	electronApp,
	window,
	testDataDir,
}) => {
	test.skip(process.platform === 'win32', 'The local Codex fixture uses a POSIX shebang.');

	const cwd = testDataDir;
	const command = path.join(cwd, 'codex');
	const spawn = await window.evaluate(
		({ cwd, command, tabId, sessionId }) =>
			window.maestro.process.spawn({
				sessionId,
				tabId,
				toolType: 'codex',
				cwd,
				command,
				args: [],
				sessionCustomPath: command,
				permissionMode: 'full',
				prompt: 'Finish when the test releases the turn.',
			}),
		{ cwd, command, tabId: TAB_ID, sessionId: PROCESS_ID }
	);
	expect(spawn.success).toBe(true);
	expect(spawn.pid).toBeGreaterThan(0);
	await expect.poll(() => fs.existsSync(path.join(cwd, 'codex-turn-started'))).toBe(true);
	const mainPid = await electronApp.evaluate(() => process.pid);

	await electronApp.evaluate(async ({ BrowserWindow }) => {
		const contents = BrowserWindow.getAllWindows()[0].webContents;
		const crashed = new Promise<void>((resolve) => {
			contents.once('render-process-gone', () => resolve());
		});
		const reloaded = new Promise<void>((resolve) => {
			contents.once('did-finish-load', () => resolve());
		});
		contents.forcefullyCrashRenderer();
		await crashed;
		await reloaded;
	});

	// The Playwright page is marked crashed permanently. Read the recovered
	// document through its Electron WebContents, which survived the crash.
	const rendererRead = <T>(source: string): Promise<T> =>
		electronApp.evaluate(
			({ BrowserWindow }, code) =>
				BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code),
			source
		);
	expect(await electronApp.evaluate(() => process.pid)).toBe(mainPid);
	const survivingPid = await rendererRead<number | undefined>(`(async () => {
		const processes = await window.maestro.process.getActiveProcesses({ includeChildProcesses: false });
		return processes.find((process) => process.sessionId === ${JSON.stringify(PROCESS_ID)})?.pid;
	})()`);
	expect(survivingPid).toBe(spawn.pid);
	const stopIsVisible = () =>
		rendererRead<boolean>(
			"Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Stop' && button.offsetWidth > 0)"
		);
	await expect.poll(stopIsVisible).toBe(true);

	fs.writeFileSync(path.join(cwd, 'finish-codex'), '');
	await expect
		.poll(() =>
			rendererRead<boolean>(`document.body.innerText.includes(${JSON.stringify(RESPONSE)})`)
		)
		.toBe(true);
	await expect.poll(stopIsVisible).toBe(false);
});
