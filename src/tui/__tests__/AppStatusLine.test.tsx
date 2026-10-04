import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { createFakeClient } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';

const USAGE = {
	inputTokens: 1_000,
	outputTokens: 500,
	cacheReadInputTokens: 80_000,
	cacheCreationInputTokens: 3_000,
	totalCostUsd: 1.5,
	contextWindow: 200_000,
};

const AGENTS = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		state: 'idle',
		activeTabId: 't1',
		customModel: 'opus',
		customEffort: 'high',
		aiTabs: [
			{ id: 't1', name: 'first', usageStats: USAGE },
			{ id: 't2', name: 'second' },
		],
	},
];

describe('the status line in the App (CH-6)', () => {
	let dir: string;

	const paths = () => ({
		userDataDir: dir,
		sessionsFile: path.join(dir, 'maestro-sessions.json'),
		groupsFile: path.join(dir, 'maestro-groups.json'),
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
	});

	const mount = async (withClient: boolean) => {
		const fake = createFakeClient({ agents: AGENTS() });
		if (!withClient) {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions: AGENTS() })
			);
		}
		const instance = render(<App paths={paths()} client={withClient ? fake.client : undefined} />);
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
		return { ...instance, press, frame: () => instance.lastFrame() ?? '' };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-status-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('shows provider, model, effort, context, and cost for the tab on screen', async () => {
		const { press, frame, unmount } = await mount(true);
		await press('j', ENTER);
		expect(frame()).toContain('Claude Code · opus · high · ctx 42% (84.0K/200.0K) · $1.50');
		unmount();
	});

	it('follows the tab: a tab with no usage yet shows dashes', async () => {
		const { press, frame, unmount } = await mount(true);
		await press('j', 'T', 'j', ENTER);
		expect(frame()).toContain('ctx - · -');
		unmount();
	});

	it('draws without a desktop attached, from the store files', async () => {
		const { press, frame, unmount } = await mount(false);
		await press('j', ENTER);
		expect(frame()).toContain('ctx 42% (84.0K/200.0K) · $1.50');
		unmount();
	});
});
