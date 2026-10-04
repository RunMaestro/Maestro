import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import { App } from '../App';
import { TUI_STATE_FILE_NAME } from '../store/view-state';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const CTRL_B = '\u0002';
const ENTER = '\r';

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
});
