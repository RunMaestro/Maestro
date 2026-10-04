import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import { App } from '../App';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const CTRL_K = '\u000b';
const CTRL_N = '\u000e';
const ENTER = '\r';
const ESC = '\u001B';
const BACKSPACE = '\u007f';

const SESSIONS = {
	sessions: [
		{
			id: 'a-maestro',
			name: 'Maestro',
			toolType: 'claude-code',
			groupId: 'g-core',
			activeTabId: 't1',
			aiTabs: [
				{ id: 't1', name: 'lib-audit' },
				{ id: 't2', agentSessionId: '8535e0e3-aaaa-bbbb-cccc-dddddddddddd' },
			],
		},
		{ id: 'a-cue', name: 'Cue', toolType: 'codex', groupId: 'g-core' },
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

describe('command palette and agent menu', () => {
	let dir: string;

	const renderApp = async () => {
		const instance = render(
			<App
				paths={{
					userDataDir: dir,
					sessionsFile: path.join(dir, 'maestro-sessions.json'),
					groupsFile: path.join(dir, 'maestro-groups.json'),
					settingsFile: path.join(dir, 'maestro-settings.json'),
					agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
					historyDir: path.join(dir, 'history'),
				}}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 30, configurable: true });
		stdout.emit('resize');
		await tick();
		return instance;
	};
	const type = async (stdin: { write: (data: string) => void }, text: string) => {
		for (const ch of text) {
			stdin.write(ch);
			await tick();
		}
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-palette-'));
		fs.writeFileSync(path.join(dir, 'maestro-sessions.json'), JSON.stringify(SESSIONS));
		fs.writeFileSync(path.join(dir, 'maestro-groups.json'), JSON.stringify(GROUPS));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('opens on Ctrl-K, lists actions, agents, and tabs, and closes on Esc or a second Ctrl-K', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		expect(lastFrame()).toContain('Ctrl-K palette');
		stdin.write(CTRL_K);
		await tick();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Command palette');
		expect(frame).toContain('Esc close');
		expect(frame).toContain('Next pane');
		stdin.write(ESC);
		await tick();
		expect(lastFrame()).not.toContain('Command palette');
		stdin.write(CTRL_K);
		await tick();
		stdin.write(CTRL_K);
		await tick();
		expect(lastFrame()).not.toContain('Command palette');
		unmount();
	});

	it('treats letters as typing, so j, q, and ? narrow the list instead of acting', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'q?j');
		const frame = lastFrame() ?? '';
		expect(frame).toContain('› q?j');
		expect(frame).toContain('Command palette');
		expect(frame).toContain('No match');
		await type(stdin, BACKSPACE.repeat(3));
		expect(lastFrame()).toContain('Next pane');
		unmount();
	});

	it('jumps to an agent and opens its conversation', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'scratch');
		stdin.write(ENTER);
		await tick();
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('Command palette');
		expect(frame).toContain('Scratch · Claude Code');
		unmount();
	});

	it('unfolds a folded group to reach an agent inside it', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		expect(lastFrame()).not.toContain('Pedsidian');
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'pedsid');
		stdin.write(ENTER);
		await tick();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('▾ 🌐 Web');
		expect(frame).toContain('Pedsidian · OpenCode');
		unmount();
	});

	it('switches to a tab picked by agent and tab name', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'maes853');
		stdin.write(ENTER);
		await tick();
		expect(lastFrame()).toContain('Maestro · Claude Code');
		expect(lastFrame()).toContain('tab: 8535E0E3');
		unmount();
	});

	it('runs an action entry as it would run from the main view, and moves with Ctrl-N', async () => {
		const { stdin, lastFrame, unmount } = await renderApp();
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'key help');
		stdin.write(ENTER);
		await tick();
		// The help overlay itself lists "Command palette", so look for the search box.
		expect(lastFrame()).toContain('Key help');
		expect(lastFrame()).not.toContain('› key help');
		stdin.write(ESC);
		await tick();

		// "ma" matches Maestro (agent) and its tabs; Ctrl-N moves off the first result.
		stdin.write(CTRL_K);
		await tick();
		await type(stdin, 'maestro');
		stdin.write(CTRL_N);
		await tick();
		stdin.write(ENTER);
		await tick();
		expect(lastFrame()).toContain('Maestro · Claude Code · tab: lib-audit');
		unmount();
	});

	describe('agent menu', () => {
		it('opens on m for the agent under the cursor and lists its actions with keys', async () => {
			const { stdin, lastFrame, unmount } = await renderApp();
			await type(stdin, 'jj');
			stdin.write('m');
			await tick();
			const frame = lastFrame() ?? '';
			expect(frame).toContain('Agent: Maestro');
			expect(frame).toContain('Open conversation');
			expect(frame).toContain('Switch tab');
			expect(frame).toContain('History');
			stdin.write(ESC);
			await tick();
			expect(lastFrame()).not.toContain('Agent: Maestro');
			unmount();
		});

		it('does nothing on a group header', async () => {
			const { stdin, lastFrame, unmount } = await renderApp();
			stdin.write('m');
			await tick();
			expect(lastFrame()).not.toContain('Agent:');
			unmount();
		});

		it('runs the picked action for that agent', async () => {
			const { stdin, lastFrame, unmount } = await renderApp();
			await type(stdin, 'jj');
			stdin.write('m');
			await tick();
			stdin.write('j');
			await tick();
			stdin.write(ENTER);
			await tick();
			expect(lastFrame()).toContain('Tabs: Maestro');
			expect(lastFrame()).not.toContain('Agent: Maestro');
			unmount();
		});

		it('is reachable from the palette too', async () => {
			const { stdin, lastFrame, unmount } = await renderApp();
			await type(stdin, 'jj');
			stdin.write(CTRL_K);
			await tick();
			await type(stdin, 'menu for');
			stdin.write(ENTER);
			await tick();
			expect(lastFrame()).toContain('Agent: Maestro');
			unmount();
		});
	});
});
