import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, GroupRecord, ProviderInfo } from '../../shared/maestro-lib';
import { App } from '../App';
import { agentMenuEntries } from '../palette/agentMenu';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const SHIFT_TAB = '\u001B[Z';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';
const BACKSPACE = '\u007f';
const CTRL_K = '\u000b';
const CTRL_S = '\u0013';

const PROVIDERS: ProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', available: false },
	{ id: 'codex', name: 'Codex', available: true, version: '0.42.0' },
	{ id: 'opencode', name: 'OpenCode', available: true },
];

const GROUPS: GroupRecord[] = [{ id: 'g1', name: 'Core', emoji: '🎼' }];

describe('the agent form in the App', () => {
	let dir: string;
	let project: string;

	const agents = (): AgentRecord[] => [
		{
			id: 'd1',
			name: 'Deskbound',
			toolType: 'codex',
			groupId: 'g1',
			state: 'idle',
			cwd: project,
			activeTabId: 't1',
			aiTabs: [{ id: 't1', name: 'live-tab' }],
		},
		{ id: 'd2', name: 'Busy One', toolType: 'codex', state: 'busy', cwd: project },
	];

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({
			agents: agents(),
			groups: GROUPS,
			providers: PROVIDERS,
			...options,
		});
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
		return { ...instance, fake, press, frame: () => instance.lastFrame() ?? '' };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-form-'));
		project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pedsidian-')));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	it('creates an agent: installed providers only, name from the folder, exact client call (AG-2)', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('n');
		expect(frame()).toContain('New agent');
		expect(frame()).toContain('Codex 0.42.0');
		expect(frame()).not.toContain('Claude Code');

		// Name, then Provider, then Directory.
		await press(TAB, TAB);
		await press(project);
		expect(frame()).toContain(project);
		await press(CTRL_S);

		const create = fake.requests.find((r) => r.method === 'agents.create');
		expect(create?.args).toEqual([
			{
				name: path.basename(project),
				provider: 'codex',
				cwd: project,
				groupId: undefined,
				model: undefined,
				effort: undefined,
				customPath: undefined,
				customArgs: undefined,
				env: undefined,
				ssh: undefined,
				autoRunFolderPath: undefined,
				nudgeMessage: undefined,
				newSessionMessage: undefined,
			},
		]);
		// The form is gone, the host's event put the agent in the list, and the status bar says so.
		expect(frame()).not.toContain('New agent');
		expect(frame()).toContain(path.basename(project));
		expect(frame()).toContain(`Created ${path.basename(project)}.`);
		unmount();
	});

	it('walks the fields with Tab and Shift-Tab, steps a choice with the arrows, and saves from the button', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('n', 'Typed Name', TAB);
		// Provider: Right steps Codex -> OpenCode.
		await press(RIGHT);
		expect(frame()).toContain('‹ OpenCode ›');
		await press(TAB, project, TAB);
		// Group: Right steps (none) -> Core.
		await press(RIGHT);
		expect(frame()).toContain('‹ 🎼 Core ›');
		await press(SHIFT_TAB);
		expect(frame()).toContain(project);
		// Down to the end and press Enter on the button.
		for (let i = 0; i < 14; i++) await press(DOWN);
		await press(ENTER);

		const create = fake.requests.find((r) => r.method === 'agents.create');
		expect(create?.args[0]).toMatchObject({
			name: 'Typed Name',
			provider: 'opencode',
			cwd: project,
			groupId: 'g1',
		});
		unmount();
	});

	it('shows path completions and takes the top one with Right', async () => {
		const parent = path.dirname(project);
		const prefix = `${parent}/${path.basename(project).slice(0, 6)}`;
		const { press, frame, unmount } = await mount();
		await press('n', TAB, TAB, prefix);
		expect(frame()).toContain(`${project}/`);
		await press(RIGHT);
		expect(frame()).toContain(`${project}/`);
		unmount();
	});

	it('drops a blank env value instead of sending it (blank means unset)', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('n', TAB, TAB, project);
		// Down to Environment: Group, Model, Effort, SSH remote, Binary path, Extra args, Environment.
		for (let i = 0; i < 7; i++) await press(DOWN);
		await press('KEEP=yes', ENTER, 'BLANK=', ENTER);
		expect(frame()).toContain('KEEP=yes');
		expect(frame()).toContain('BLANK (unset)');
		await press(CTRL_S);
		const create = fake.requests.find((r) => r.method === 'agents.create');
		expect((create?.args[0] as { env?: unknown }).env).toEqual({ KEEP: 'yes' });
		unmount();
	});

	it('keeps the form open and says why when the directory is unusable', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('n', TAB, TAB, '/definitely/not/a/real/dir-xyz');
		await press(CTRL_S);
		expect(frame()).toContain('New agent');
		expect(frame()).toContain('does not exist');
		expect(fake.requests.some((r) => r.method === 'agents.create')).toBe(false);
		unmount();
	});

	it("shows the host's refusal and stays open so nothing typed is lost", async () => {
		const { press, frame, unmount } = await mount({ failures: { 'agents.create': 'rejected' } });
		await press('n', TAB, TAB, project, CTRL_S);
		expect(frame()).toContain('New agent');
		expect(frame()).toContain('fake rejected');
		expect(frame()).toContain(project);
		unmount();
	});

	it('closes on Esc without calling the host', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('n', TAB, TAB, project, ESC);
		expect(frame()).not.toContain('New agent');
		expect(fake.requests.filter((r) => r.method === 'agents.create')).toEqual([]);
		unmount();
	});

	it('edits the selected agent from fresh host values and sends only the change (AG-4)', async () => {
		const { press, frame, fake, unmount } = await mount();
		// Cursor starts on the Core header; one step down is Deskbound.
		await press('j', 'E');
		expect(frame()).toContain('Edit agent: Deskbound');
		expect(fake.requests[0]).toEqual({ method: 'agents.get', args: ['d1'] });
		// Name is focused; add to it.
		await press(BACKSPACE, BACKSPACE, '2!');
		await press(CTRL_S);
		expect(fake.requests.filter((r) => r.method === 'agents.update')).toEqual([
			{ method: 'agents.update', args: ['d1', { name: 'Deskbou2!' }] },
		]);
		expect(frame()).toContain('Saved Deskbou2!.');
		unmount();
	});

	it('makes no call when an edit changed nothing', async () => {
		const { press, fake, frame, unmount } = await mount();
		await press('j', 'E', CTRL_S);
		expect(fake.requests.filter((r) => r.method === 'agents.update')).toEqual([]);
		expect(frame()).not.toContain('Edit agent:');
		unmount();
	});

	it('locks the directory of a busy agent and shows the reason (AG-4)', async () => {
		const { press, frame, unmount } = await mount();
		// Core header, Deskbound, Ungrouped header, Busy One.
		await press('j', 'j', 'j', 'E');
		expect(frame()).toContain('Edit agent: Busy One');
		await press(TAB, TAB);
		expect(frame()).toContain('Stop the agent before changing its working directory.');
		expect(frame()).toContain('(read-only)');
		unmount();
	});

	it('is read-only without a desktop: says so and opens nothing', async () => {
		const { press, frame, unmount } = await mount({}, false);
		await press('n');
		expect(frame()).not.toContain('New agent');
		expect(frame()).toContain('No desktop attached');
		unmount();
	});

	it('is reachable from the palette and from the agent menu, not only from its key', async () => {
		const first = await mount();
		await first.press(CTRL_K, 'New agent', ENTER);
		expect(first.frame()).toContain('New agent');
		first.unmount();

		const second = await mount();
		await second.press('j', 'm');
		expect(second.frame()).toContain('Edit agent');
		const editAt = agentMenuEntries().findIndex((entry) => entry.label === 'Edit agent');
		await second.press(...Array(editAt).fill('j'), ENTER);
		expect(second.frame()).toContain('Edit agent: Deskbound');
		second.unmount();
	});
});
