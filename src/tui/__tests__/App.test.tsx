import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import { App } from '../App';
import { TUI_STATE_FILE_NAME } from '../store/view-state';
import { KEYMAP, formatBindingKeys } from '../keymap';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const CTRL_B = '\u0002';
const ENTER = '\r';
const TAB = '\t';
const SHIFT_TAB = '\u001B[Z';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const UP = '\u001B[A';

const SESSIONS = {
	sessions: [
		{
			id: 'a-maestro',
			name: 'Maestro',
			toolType: 'claude-code',
			groupId: 'g-core',
			state: 'busy',
			customModel: 'opus',
			activeTabId: 't1',
			aiTabs: [
				{ id: 't1', name: 'lib-audit', hasUnread: true },
				{ id: 't2', agentSessionId: '8535e0e3-aaaa-bbbb-cccc-dddddddddddd' },
			],
		},
		{ id: 'a-cue', name: 'Cue', toolType: 'codex', groupId: 'g-core', state: 'error' },
		{ id: 'a-web', name: 'Pedsidian', toolType: 'opencode', groupId: 'g-web' },
		{ id: 'a-loose', name: 'Scratch', toolType: 'claude-code' },
	],
};
const GROUPS = {
	groups: [
		{ id: 'g-core', name: 'Core', emoji: '🎼', collapsed: false },
		{ id: 'g-web', name: 'Web', emoji: '🌐', collapsed: true },
	],
};

/**
 * Draws the App on a fake terminal of the given size. ink-testing-library's
 * stdout is fixed at 100 columns with no rows, so the size is patched in and
 * announced with a `resize`, the way a real terminal does it.
 */
function resizeStdout(
	stdout: object & { emit: (event: string) => boolean },
	columns: number,
	rows: number
) {
	Object.defineProperty(stdout, 'columns', { value: columns, configurable: true });
	Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
	stdout.emit('resize');
}

describe('App shell', () => {
	let dir: string;

	const paths = () => ({
		userDataDir: dir,
		sessionsFile: path.join(dir, 'maestro-sessions.json'),
		groupsFile: path.join(dir, 'maestro-groups.json'),
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
	});
	const writeStore = (name: string, value: unknown) =>
		fs.writeFileSync(path.join(dir, name), JSON.stringify(value, undefined, '\t'));
	const renderAt = async (columns: number, rows: number) => {
		const instance = render(<App paths={paths()} />);
		// Let the effect that listens for resizes attach before announcing one.
		await tick();
		resizeStdout(instance.stdout, columns, rows);
		await tick();
		return instance;
	};
	const stateFile = () => path.join(dir, TUI_STATE_FILE_NAME);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-app-'));
		writeStore('maestro-sessions.json', SESSIONS);
		writeStore('maestro-groups.json', GROUPS);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('draws the Agents pane, the Conversation pane, and the status bar at 140 columns', async () => {
		const { lastFrame, unmount } = await renderAt(140, 30);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Agents');
		expect(frame).toContain('▾ 🎼 Core');
		expect(frame).toContain('Maestro');
		expect(frame).toContain('Cue');
		// The Web group is saved folded on the desktop, so its agent is hidden and the count shows.
		expect(frame).toContain('▸ 🌐 Web (1)');
		expect(frame).not.toContain('Pedsidian');
		expect(frame).toContain('Ungrouped');
		expect(frame).toContain('Scratch');
		// Provider badge and unread marker.
		expect(frame).toContain('CC');
		expect(frame).toContain('◆');
		// The cursor starts on the first row, a group header, so no agent is open yet.
		expect(frame).toContain('Select an agent');
		expect(frame).toContain('host: read-only');
		expect(frame).toContain('data:');
		unmount();
	});

	it('titles the Conversation pane with the agent, provider, model, and tab', async () => {
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		// Rows sort by name: Core, Cue, Maestro.
		stdin.write('j');
		await tick();
		stdin.write('j');
		await tick();
		expect(lastFrame()).toContain('Maestro · Claude Code · opus · tab: lib-audit');
		expect(lastFrame()).toContain('2 tabs');
		unmount();
	});

	it('does not drop keys that arrive faster than the screen redraws', async () => {
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		for (const key of ['j', 'j', 'j']) {
			stdin.write(key);
		}
		await tick();
		// Core, Cue, Maestro, Web: three moves land on the Web header.
		expect(lastFrame()).toMatch(/›▸ 🌐 Web/);
		unmount();
	});

	it('hides the Agents pane at 80 columns and brings it back with Ctrl-B', async () => {
		const { stdin, lastFrame, unmount } = await renderAt(80, 24);
		expect(lastFrame()).not.toContain('Agents');
		expect(lastFrame()).toContain('host: read-only');

		stdin.write(CTRL_B);
		await tick();
		expect(lastFrame()).toContain('Agents');
		expect(lastFrame()).toContain('Maestro');

		stdin.write(CTRL_B);
		await tick();
		expect(lastFrame()).not.toContain('Agents');
		unmount();
	});

	it('lets Ctrl-B hide the pane on a wide terminal too', async () => {
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		stdin.write(CTRL_B);
		await tick();
		expect(lastFrame()).not.toContain('Agents');
		unmount();
	});

	it('asks for a bigger terminal below 80x24', async () => {
		const { lastFrame, unmount } = await renderAt(70, 20);
		expect(lastFrame()).toContain('Terminal too small: 70x20');
		expect(lastFrame()).toContain('80x24');
		unmount();
	});

	it('folds and unfolds a group with Enter and remembers it in maestro-tui.json only', async () => {
		const before = fs.readFileSync(path.join(dir, 'maestro-settings.json'), { flag: 'a+' });
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		// The cursor starts on the Core header.
		stdin.write(ENTER);
		await tick();
		expect(lastFrame()).toContain('▸ 🎼 Core (2)');

		const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
		expect(saved.view.collapsedSections).toEqual({ 'group:g-core': true });
		// The desktop's stores are untouched, and no settings file was created.
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8'))).toEqual(
			SESSIONS
		);
		expect(before.length).toBe(0);
		unmount();
	});

	it('restores the remembered selection and keeps unrelated keys in the state file', async () => {
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({ keymap: { quit: 'q' }, view: { selectedAgentId: 'a-cue' } })
		);
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		expect(lastFrame()).toContain('Cue · Codex');

		stdin.write('j');
		await tick();
		const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
		expect(saved.keymap).toEqual({ quit: 'q' });
		expect(saved.view.selectedAgentId).toBe('a-maestro');
		unmount();
	});

	it('reports a corrupt sessions file instead of crashing, and still lists the groups', async () => {
		fs.writeFileSync(path.join(dir, 'maestro-sessions.json'), '{ "sessions": [');
		const { lastFrame, unmount } = await renderAt(140, 30);
		expect(lastFrame()).toContain('Sessions file is corrupt');
		expect(lastFrame()).toContain('Core');
		unmount();
		// Never rewritten.
		expect(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8')).toBe(
			'{ "sessions": ['
		);
	});

	it('does not touch a corrupt TUI state file', async () => {
		fs.writeFileSync(stateFile(), '{ not json');
		const { stdin, unmount } = await renderAt(140, 30);
		stdin.write('j');
		await tick();
		expect(fs.readFileSync(stateFile(), 'utf-8')).toBe('{ not json');
		unmount();
	});

	it('works with no data directory contents at all', async () => {
		fs.rmSync(path.join(dir, 'maestro-sessions.json'));
		fs.rmSync(path.join(dir, 'maestro-groups.json'));
		const { lastFrame, unmount } = await renderAt(140, 30);
		expect(lastFrame()).toContain('No agents found');
		unmount();
	});

	it('exits on q', async () => {
		const { stdin, lastFrame, unmount } = await renderAt(140, 30);
		const before = lastFrame();
		stdin.write('q');
		await tick();
		// Ink leaves the last frame on screen after exit.
		expect(lastFrame()).toBe(before);
		unmount();
	});

	describe('keyboard', () => {
		it('moves the selection with j, k, and the arrow keys', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			// Core, Cue, Maestro, Web, Ungrouped, Scratch.
			stdin.write(DOWN);
			await tick();
			expect(lastFrame()).toMatch(/›\s+● Cue/);
			stdin.write('j');
			await tick();
			expect(lastFrame()).toMatch(/›\s+● Maestro/);
			stdin.write(UP);
			await tick();
			expect(lastFrame()).toMatch(/›\s+● Cue/);
			stdin.write('k');
			await tick();
			expect(lastFrame()).toMatch(/›▾ 🎼 Core/);
			unmount();
		});

		it('cycles pane focus with Tab and Shift-Tab, and only the focused pane moves', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write(TAB);
			await tick();
			// Focus is in the Conversation pane now: j no longer walks the agent list.
			stdin.write('j');
			await tick();
			expect(lastFrame()).toMatch(/›▾ 🎼 Core/);

			stdin.write(SHIFT_TAB);
			await tick();
			stdin.write('j');
			await tick();
			expect(lastFrame()).toMatch(/›\s+● Cue/);
			unmount();
		});

		it('moves focus into the Conversation pane when Enter opens an agent', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('j');
			await tick();
			stdin.write('j');
			await tick();
			stdin.write(ENTER);
			await tick();
			expect(lastFrame()).toContain('Maestro · Claude Code · opus');
			// Enter did not fold anything, and focus left the list.
			stdin.write('j');
			await tick();
			expect(lastFrame()).toMatch(/›\s+● Maestro/);
			unmount();
		});

		it('opens a tab switcher on T, picks a tab with Enter, and remembers it in the TUI file only', async () => {
			const before = fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8');
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('j');
			await tick();
			stdin.write('j');
			await tick();

			stdin.write('T');
			await tick();
			let frame = lastFrame() ?? '';
			expect(frame).toContain('Tabs: Maestro');
			expect(frame).toContain('Esc close');
			expect(frame).toContain('lib-audit');
			expect(frame).toContain('8535E0E3');
			// The open tab is marked and the cursor starts on it.
			expect(frame).toMatch(/›● lib-audit/);

			stdin.write('j');
			await tick();
			stdin.write(ENTER);
			await tick();
			frame = lastFrame() ?? '';
			expect(frame).not.toContain('Tabs: Maestro');
			expect(frame).toContain('tab: 8535E0E3');

			const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
			expect(saved.view.activeTabByAgent).toEqual({ 'a-maestro': 't2' });
			expect(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8')).toBe(before);
			unmount();
		});

		it('closes the tab switcher with Esc without changing the tab', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('j');
			await tick();
			stdin.write('j');
			await tick();
			stdin.write('T');
			await tick();
			stdin.write('j');
			await tick();
			stdin.write(ESC);
			await tick();
			expect(lastFrame()).not.toContain('Tabs: Maestro');
			expect(lastFrame()).toContain('tab: lib-audit');
			expect(fs.existsSync(stateFile())).toBe(true);
			expect(JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).view.activeTabByAgent).toEqual({});
			unmount();
		});

		it('ignores T on a group header or an agent with no tabs', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('T');
			await tick();
			expect(lastFrame()).not.toContain('Tabs:');
			// Cue has no tabs.
			stdin.write('j');
			await tick();
			stdin.write('T');
			await tick();
			expect(lastFrame()).not.toContain('Tabs:');
			unmount();
		});

		it('lists every binding in the help overlay and closes it with Esc', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('?');
			await tick();
			const frame = lastFrame() ?? '';
			expect(frame).toContain('Key help');
			expect(frame).toContain('Esc close');
			for (const binding of KEYMAP) {
				expect(frame, binding.action).toContain(formatBindingKeys(binding));
				expect(frame, binding.action).toContain(binding.description);
			}

			stdin.write(ESC);
			await tick();
			expect(lastFrame()).not.toContain('Key help');
			expect(lastFrame()).toContain('Select an agent');
			unmount();
		});

		it('toggles help off with ? and keeps q from quitting under an overlay', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(140, 30);
			stdin.write('?');
			await tick();
			stdin.write('q');
			await tick();
			expect(lastFrame()).toContain('Key help');
			stdin.write('?');
			await tick();
			expect(lastFrame()).not.toContain('Key help');
			unmount();
		});

		it('fits the help overlay in the smallest terminal', async () => {
			const { stdin, lastFrame, unmount } = await renderAt(80, 24);
			stdin.write('?');
			await tick();
			const frame = lastFrame() ?? '';
			for (const binding of KEYMAP) {
				expect(frame, binding.action).toContain(binding.description);
			}
			expect(frame.split('\n').length).toBeLessThanOrEqual(24);
			unmount();
		});

		it('advertises help in the status bar', async () => {
			const { lastFrame, unmount } = await renderAt(140, 30);
			expect(lastFrame()).toContain('? help');
			unmount();
		});

		describe('history', () => {
			const entry = (id: string, type: string, timestamp: number, summary: string) =>
				JSON.stringify({ id, type, timestamp, summary, projectPath: '/p' });
			const writeHistory = (agentId: string, lines: string[]) => {
				fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
				fs.writeFileSync(path.join(dir, 'history', `${agentId}.jsonl`), lines.join('\n'));
			};
			const openMaestro = async (columns = 140, rows = 30) => {
				const instance = await renderAt(columns, rows);
				// Rows sort by name: Core, Cue, Maestro.
				instance.stdin.write('j');
				await tick();
				instance.stdin.write('j');
				await tick();
				return instance;
			};

			it('lists type, time, and summary newest first, and closes with Esc', async () => {
				writeHistory('a-maestro', [
					entry('h1', 'USER', 1_700_000_000_000, 'Fixed the build'),
					entry('h2', 'AUTO', 1_700_000_100_000, 'Ran the playbook\nsecond line'),
					entry('h3', 'CUE', 1_700_000_200_000, 'Nightly sweep'),
					'{"id":"h4","type":"USER","timest',
				]);
				const { stdin, lastFrame, unmount } = await openMaestro();
				stdin.write('H');
				await tick();
				const frame = lastFrame() ?? '';
				expect(frame).toContain('History: Maestro');
				expect(frame).toContain('Esc close');
				expect(frame).toMatch(/›CUE\s+.*Nightly sweep/);
				expect(frame).toMatch(/AUTO\s+.*Ran the playbook second line/);
				expect(frame).toMatch(/USER\s+.*Fixed the build/);
				expect(frame.indexOf('Nightly sweep')).toBeLessThan(frame.indexOf('Fixed the build'));
				expect(frame).toContain('1 of 3');

				stdin.write('j');
				await tick();
				expect(lastFrame()).toMatch(/›AUTO/);

				stdin.write(ESC);
				await tick();
				expect(lastFrame()).not.toContain('History: Maestro');
				unmount();
			});

			it('reads older pages as the cursor reaches the last loaded row', async () => {
				const lines = Array.from({ length: 250 }, (_, i) =>
					entry(`h${i}`, 'USER', 1_700_000_000_000 + i * 1000, `Entry number ${i}`)
				);
				writeHistory('a-maestro', lines);
				const { stdin, lastFrame, unmount } = await openMaestro(140, 30);
				stdin.write('H');
				await tick();
				expect(lastFrame()).toContain('1 of 250');
				expect(lastFrame()).toContain('Entry number 249');
				expect(lastFrame()).toContain('older load as you scroll');

				for (let i = 0; i < 205; i++) stdin.write('j');
				await tick();
				// Past the first page of 200, so the second page was read and appended.
				expect(lastFrame()).toContain('206 of 250');
				expect(lastFrame()).toContain('Entry number 44');
				expect(lastFrame()).not.toContain('older load as you scroll');
				unmount();
			});

			it('says so when the agent has no history, and does not create the file', async () => {
				const { stdin, lastFrame, unmount } = await openMaestro();
				stdin.write('H');
				await tick();
				expect(lastFrame()).toContain('No history yet for this agent.');
				expect(fs.existsSync(path.join(dir, 'history'))).toBe(false);
				unmount();
			});

			it('does nothing on a group header, and lists the key in help', async () => {
				const { stdin, lastFrame, unmount } = await renderAt(140, 30);
				stdin.write('H');
				await tick();
				expect(lastFrame()).not.toContain('History:');
				stdin.write('?');
				await tick();
				expect(lastFrame()).toContain('History of the selected agent');
				unmount();
			});
		});

		describe('transcript', () => {
			const withLogs = () => {
				const sessions = JSON.parse(JSON.stringify(SESSIONS));
				sessions.sessions[0].aiTabs[0].logs = [
					{
						id: 'l1',
						timestamp: 1_700_000_000_000,
						source: 'user',
						text: 'Please **fix** the build',
					},
					{
						id: 'l2',
						timestamp: 1_700_000_001_000,
						source: 'tool',
						text: 'Bash',
						metadata: {
							toolState: {
								status: 'completed',
								input: { command: 'npm run build' },
								output: 'BUILDOUTPUT',
							},
						},
					},
					{ id: 'l3', timestamp: 1_700_000_002_000, source: 'ai', text: '# Fixed\n\n- one\n- two' },
				];
				writeStore('maestro-sessions.json', sessions);
			};

			it('draws the selected tab as markdown, with tool calls collapsed to one line', async () => {
				withLogs();
				const { stdin, lastFrame, unmount } = await renderAt(140, 30);
				stdin.write('j');
				await tick();
				stdin.write('j');
				await tick();
				const frame = lastFrame() ?? '';
				expect(frame).toContain('Please fix the build');
				expect(frame).not.toContain('**fix**');
				expect(frame).toContain('# Fixed');
				expect(frame).toContain('• one');
				expect(frame).toContain('▸ ✓ Ran npm run build');
				expect(frame).not.toContain('BUILDOUTPUT');
				unmount();
			});

			it('expands and collapses tool calls with e', async () => {
				withLogs();
				const { stdin, lastFrame, unmount } = await renderAt(140, 40);
				stdin.write('j');
				await tick();
				stdin.write('j');
				await tick();
				stdin.write('e');
				await tick();
				expect(lastFrame()).toContain('▾ ✓ Ran npm run build');
				expect(lastFrame()).toContain('BUILDOUTPUT');
				stdin.write('e');
				await tick();
				expect(lastFrame()).not.toContain('BUILDOUTPUT');
				unmount();
			});

			it('keeps the newest entries on screen in a short pane', async () => {
				withLogs();
				const { stdin, lastFrame, unmount } = await renderAt(100, 24);
				stdin.write('j');
				await tick();
				stdin.write('j');
				await tick();
				stdin.write('e');
				await tick();
				const frame = lastFrame() ?? '';
				expect(frame).toContain('# Fixed');
				expect(frame.split('\n').length).toBeLessThanOrEqual(24);
				unmount();
			});
		});
	});
});
