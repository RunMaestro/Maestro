import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { agentMenuEntries } from '../palette/agentMenu';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const BACKSPACE = '\u007f';
const CTRL_K = '\u000b';

const AGENTS = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'codex',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [
			{ id: 't1', name: 'first' },
			{ id: 't2', name: 'second' },
			{ id: 't3', name: 'third' },
		],
	},
	{
		id: 'a2',
		name: 'Beta',
		toolType: 'codex',
		state: 'idle',
		aiTabs: [{ id: 'b1', name: 'only' }],
	},
];

describe('AI tab management in the App (CH-1)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({ agents: AGENTS(), ...options });
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
				client={withClient ? fake.client : undefined}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 36, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		const methods = () => fake.requests.map((request) => request.method);
		return { ...instance, fake, press, methods, frame: () => instance.lastFrame() ?? '' };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-tabs-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// Rows from the top: Ungrouped, Alpha, Beta. The cursor starts on the Ungrouped header.
	const TO_ALPHA = ['j'];

	it('opens a new tab with the exact call and shows it', async () => {
		const { press, frame, fake, methods, unmount } = await mount();
		await press(...TO_ALPHA, 't');
		expect(fake.requests).toEqual([{ method: 'tabs.create', args: ['a1'] }]);
		expect(frame()).toContain('Opened a new tab in Alpha.');
		await press('T');
		expect(frame()).toContain('Tabs: Alpha');
		// Four tabs now; the new one is open (marked) and last.
		expect(frame()).toMatch(/● .*\n?/);
		expect(methods()).toEqual(['tabs.create']);
		unmount();
	});

	it('renames the open tab, and an empty name clears it', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'r');
		expect(frame()).toContain('Rename tab: first');
		await press(...Array(5).fill(BACKSPACE), 'uno', ENTER);
		expect(fake.requests).toEqual([{ method: 'tabs.rename', args: ['a1', 't1', 'uno'] }]);
		expect(frame()).toContain('Renamed the tab to uno.');
		expect(frame()).toContain('tab: uno');

		await press('r');
		expect(frame()).toContain('An empty name clears it.');
		await press(...Array(3).fill(BACKSPACE), ENTER);
		expect(fake.requests[1]).toEqual({ method: 'tabs.rename', args: ['a1', 't1', ''] });
		expect(frame()).toContain('Cleared the tab name.');
		unmount();
	});

	it('closes the open tab: the call is made, the tab leaves the strip, the view moves to its neighbor', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'T', 'j', ENTER);
		expect(frame()).toContain('tab: second');

		await press('x');
		expect(fake.requests).toEqual([{ method: 'tabs.close', args: ['a1', 't2'] }]);
		expect(frame()).toContain('Closed second.');
		expect(frame()).toContain('closed-tab history');
		// Left neighbor.
		expect(frame()).toContain('tab: first');

		await press('T');
		expect(frame()).toContain('first');
		expect(frame()).toContain('third');
		expect(frame()).not.toContain('second');
		unmount();
	});

	it('closes the highlighted tab from the switcher and keeps the switcher open', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'T', 'j', 'j', 'x');
		expect(fake.requests).toEqual([{ method: 'tabs.close', args: ['a1', 't3'] }]);
		expect(frame()).toContain('Tabs: Alpha');
		// The notice names the closed tab; the rows must not.
		expect(frame().replace('Closed third.', '')).not.toContain('third');
		// The open tab was not the one closed, so the view stays on it.
		await press(ESC);
		expect(frame()).toContain('tab: first');
		unmount();
	});

	it('never destroys a transcript: it stays readable after the close (CH-1)', async () => {
		const entry = { id: 'e1', timestamp: 1, source: 'user' as const, text: 'remember this' };
		const { press, frame, fake, unmount } = await mount({ transcripts: { 'a1:t2': [entry] } });
		await press(...TO_ALPHA, 'T', 'j', 'x');
		expect(fake.closedTabs.map((closed) => closed.tab.id)).toEqual(['t2']);

		const read = await fake.client.tabs.transcript('a1', 't2');
		expect(read).toEqual({ ok: true, value: [entry] });

		// The summaries stay in History, which the same agent still opens.
		fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'history', 'a1.jsonl'),
			JSON.stringify({
				id: 'h1',
				type: 'USER',
				timestamp: 1_700_000_000_000,
				summary: 'Kept note',
				projectPath: '/p',
			})
		);
		await press(ESC, 'H');
		expect(frame()).toContain('Kept note');
		unmount();
	});

	it('closing the last tab shows the fresh empty tab the host leaves', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('j', 'j', 'x');
		expect(fake.requests).toEqual([{ method: 'tabs.close', args: ['a2', 'b1'] }]);
		await press('T');
		expect(frame()).toContain('Tabs: Beta');
		expect(frame()).not.toContain('only');
		unmount();
	});

	it("shows the host's refusal and keeps the tab", async () => {
		const { press, frame, unmount } = await mount({ failures: { 'tabs.close': 'rejected' } });
		await press(...TO_ALPHA, 'x');
		expect(frame()).toContain('fake rejected');
		await press('T');
		expect(frame()).toContain('first');
		unmount();
	});

	it('is read-only without a desktop', async () => {
		const { press, frame, unmount } = await mount({}, false);
		for (const key of ['t', 'r', 'x']) {
			await press(key);
			expect(frame()).toContain('No desktop attached');
			expect(frame()).not.toContain('Rename tab');
		}
		unmount();
	});

	it('has three ways in: a key, the agent menu, and the palette', async () => {
		const labels = agentMenuEntries().map((entry) => entry.label);
		expect(labels).toEqual(expect.arrayContaining(['New tab', 'Rename tab', 'Close tab']));

		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'm');
		expect(frame()).toContain('Close tab');
		for (const [index, entry] of agentMenuEntries().entries()) {
			if (entry.label === 'New tab') {
				await press(...Array(index).fill('j'), ENTER);
				break;
			}
		}
		expect(fake.requests[0]).toEqual({ method: 'tabs.create', args: ['a1'] });

		await press(CTRL_K, ...'Close tab'.split(''));
		expect(frame()).toContain('Close tab');
		await press(ENTER);
		expect(fake.requests[1]).toEqual({ method: 'tabs.close', args: ['a1', 'new-tab-1'] });
		unmount();
	});
});
