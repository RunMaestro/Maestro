import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, ProviderInfo } from '../../shared/maestro-lib';
import { App } from '../App';
import { agentMenuEntries } from '../palette/agentMenu';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const CTRL_K = '\u000b';

const PROVIDERS: ProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', available: true },
	{ id: 'codex', name: 'Codex', available: true, version: '0.42.0' },
	{ id: 'opencode', name: 'OpenCode', available: false },
];

const AGENTS = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'codex',
		state: 'idle',
		aiTabs: [{ id: 't1', name: 'one' }],
	},
];

// One section holds the agent: the section header, then Alpha.
const TO_ALPHA = ['j'];

describe('changing an agent provider from the TUI (PS-1, PS-4)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({ agents: AGENTS(), providers: PROVIDERS, ...options });
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
		const updates = () => fake.requests.filter((request) => request.method === 'agents.update');
		return { ...instance, fake, press, updates, frame: () => instance.lastFrame() ?? '' };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-provider-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('lists installed providers only, on the current one, and swaps with one exact call', async () => {
		const { press, frame, fake, updates, unmount } = await mount();
		await press(...TO_ALPHA, 'p');
		expect(frame()).toContain('Change provider: Alpha');
		expect(frame()).toContain('Claude Code');
		expect(frame()).toContain('Codex 0.42.0');
		expect(frame()).toContain('current');
		expect(frame()).not.toContain('OpenCode');
		// The picker opens on Codex, the agent's own provider; Up lands on Claude Code.
		await press('k', ENTER);
		expect(updates()).toEqual([
			{ method: 'agents.update', args: ['a1', { provider: 'claude-code' }] },
		]);
		expect(frame()).toContain('Switched Alpha to Claude Code. Every tab was kept.');
		expect(frame()).not.toContain('Not kept');
		expect(fake.requests.map((request) => request.method)).toEqual([
			'providers.list',
			'agents.update',
		]);
		unmount();
	});

	it('shows what the host could not park until the person closes it', async () => {
		const { press, frame, updates, unmount } = await mount({
			updateNotices: ['A queued message was set to run with model "opus" on Claude Code.'],
		});
		await press(...TO_ALPHA, 'p', 'k', ENTER);
		expect(frame()).toContain('Not kept');
		expect(frame()).toContain('A queued message was set to run with model "opus"');
		// A second Enter closes the result and sends nothing more.
		await press(ENTER);
		expect(frame()).not.toContain('Not kept');
		expect(updates()).toHaveLength(1);
		unmount();
	});

	it('sends nothing when the agent is already on the chosen provider', async () => {
		const { press, frame, updates, unmount } = await mount();
		await press(...TO_ALPHA, 'p', ENTER);
		expect(frame()).toContain('Alpha is already on Codex.');
		expect(updates()).toEqual([]);
		unmount();
	});

	it('keeps the picker open with the host reason when the swap is refused', async () => {
		const { press, frame, unmount } = await mount({ failures: { 'agents.update': 'rejected' } });
		await press(...TO_ALPHA, 'p', 'k', ENTER);
		expect(frame()).toContain('Change provider: Alpha');
		expect(frame()).toContain('fake rejected');
		await press(ESC);
		expect(frame()).not.toContain('Change provider:');
		unmount();
	});

	it('says so when the provider probe fails, without opening anything', async () => {
		const { press, frame, unmount } = await mount({ failures: { 'providers.list': 'failed' } });
		await press(...TO_ALPHA, 'p');
		expect(frame()).not.toContain('Change provider:');
		unmount();
	});

	it('refuses on a group header and without a desktop attached', async () => {
		const header = await mount();
		await header.press('p');
		expect(header.frame()).toContain('Select an agent to change its provider.');
		expect(header.frame()).not.toContain('Change provider:');
		header.unmount();

		const readOnly = await mount({}, false);
		await readOnly.press(...TO_ALPHA, 'p');
		expect(readOnly.frame()).toContain('No desktop attached');
		expect(readOnly.frame()).not.toContain('Change provider:');
		readOnly.unmount();
	});

	it('reaches the picker through the agent menu and the command palette (three ways in)', async () => {
		const entries = agentMenuEntries();
		const at = entries.findIndex((entry) => entry.label === 'Change provider');
		expect(at).toBeGreaterThan(-1);

		const menu = await mount();
		await menu.press(...TO_ALPHA, 'm', ...Array(at).fill('j'), ENTER);
		expect(menu.frame()).toContain('Change provider: Alpha');
		menu.unmount();

		const palette = await mount();
		await palette.press(...TO_ALPHA, CTRL_K, "Change the selected agent's provider", ENTER);
		expect(palette.frame()).toContain('Change provider: Alpha');
		palette.unmount();
	});
});
