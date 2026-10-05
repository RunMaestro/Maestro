import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { KEYMAP, type Binding } from '../keymap';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ESC = '\u001B';
const CTRL_K = '\u000b';

const AGENTS: AgentRecord[] = [
	{ id: 'a1', name: 'Alpha', toolType: 'claude-code', state: 'idle', aiTabs: [{ id: 't1' }] },
];

/** No shipped binding sits behind a flag yet, so these tests gate group chats on Cue. */
const GATED: readonly Binding[] = KEYMAP.map((binding) =>
	binding.action === 'groupChats' ? { ...binding, encore: 'maestroCue' } : binding
);

describe('the settings view and the Encore gate (ST-1, ST-2)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, keymap?: readonly Binding[]) => {
		const fake = createFakeClient({ agents: AGENTS, ...options });
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
				client={fake.client}
				keymap={keymap}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 120, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 50, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		return { ...instance, fake, press, frame: () => instance.lastFrame() ?? '' };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-settings-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('shows what the host holds, masks secrets, and closes on Esc', async () => {
		const { press, frame, fake, unmount } = await mount({
			settings: {
				defaultShell: 'fish',
				conductorProfile: 'Direct, no fluff.',
				shellEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-supersecret-1234' },
				encoreFeatures: { maestroCue: false },
			},
			sshRemotes: [
				{
					id: 'r1',
					name: 'Build box',
					host: 'build.example.com',
					port: 22,
					username: 'ci',
					privateKeyPath: '',
					enabled: true,
				},
			],
		});
		await press('S');
		const out = frame();
		expect(out).toContain('Settings (read-only)');
		expect(out).toContain('Source: the desktop (live)');
		expect(out).toContain('fish');
		expect(out).toContain('ANTHROPIC_API_KEY=••••••••1234');
		expect(out).not.toContain('supersecret');
		expect(out).toContain('Build box');
		expect(out).toContain('ci@build.example.com');
		expect(out).toContain('Direct, no fluff.');
		expect(out).toContain('Maestro Cue');
		// The view reads and never writes.
		expect(fake.requests.filter((request) => request.method === 'agents.update')).toEqual([]);
		await press(ESC);
		expect(frame()).not.toContain('Settings (read-only)');
		unmount();
	});

	it('re-reads on r and when the desktop says a setting changed', async () => {
		const { press, frame, fake, unmount } = await mount({ settings: { defaultShell: 'fish' } });
		await press('S');
		expect(frame()).toContain('fish');
		fake.changeSettings({ defaultShell: 'nushell' });
		await tick(60);
		expect(frame()).toContain('nushell');
		const reads = fake.settingsReads.length;
		await press('r');
		await tick(60);
		expect(fake.settingsReads.length).toBeGreaterThan(reads);
		unmount();
	});

	it('is reachable from the palette and the help lists its key', async () => {
		const { press, frame, unmount } = await mount();
		await press(CTRL_K);
		for (const key of 'settings') await press(key);
		expect(frame()).toContain('Settings the desktop holds');
		await press('\r');
		expect(frame()).toContain('Settings (read-only)');
		unmount();
	});

	it('hides a feature whose Encore flag is off in the desktop: the key is dead and the palette lacks it', async () => {
		const { press, frame, unmount } = await mount(
			{ settings: { encoreFeatures: { maestroCue: false } } },
			GATED
		);
		await tick(60);
		await press('c');
		expect(frame()).not.toContain('Group chats');
		await press(CTRL_K);
		for (const key of 'group') await press(key);
		expect(frame()).not.toContain('Group chats');
		unmount();
	});

	it('keeps the feature when its flag is on, and follows the flag when the desktop flips it', async () => {
		const { press, frame, fake, unmount } = await mount(
			{ settings: { encoreFeatures: { maestroCue: true } } },
			GATED
		);
		await tick(60);
		await press('c');
		expect(frame()).toContain('Group chats');
		await press(ESC);
		fake.changeSettings({ encoreFeatures: { maestroCue: false } });
		await tick(80);
		await press('c');
		expect(frame()).not.toContain('No group chats yet');
		unmount();
	});
});
