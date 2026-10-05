import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { MaestroRuntime } from '../../shared/maestro-lib';
import { Root } from '../Root';
import type { TuiStartup } from '../startup';
import { createFakeClient, type FakeClient } from './fakeClient';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const AGENTS = [{ id: 'd1', name: 'Deskbound', toolType: 'claude-code', aiTabs: [] }];
const HEADLESS = { kind: 'headless', pid: 812, label: 'headless pid 812' } as const;
const IN_PROCESS = { kind: 'in-process', label: 'this TUI' } as const;

function inProcess(fake: FakeClient, work: { turns?: number; runs?: number } = {}): TuiStartup {
	const client = Object.assign(fake.client, {
		turnsInFlight: () => work.turns ?? 0,
		roundsInFlight: () => 0,
		consultsInFlight: () => 0,
		runs: { activeRuns: () => Array.from({ length: work.runs ?? 0 }, () => ({})) },
	}) as unknown as MaestroRuntime;
	return { branch: 'in-process', client };
}

describe('Root: Start background host', () => {
	let dir: string;
	const paths = () => ({
		userDataDir: dir,
		sessionsFile: path.join(dir, 'maestro-sessions.json'),
		groupsFile: path.join(dir, 'maestro-groups.json'),
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
	});

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-root-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const renderRoot = async (props: Omit<Parameters<typeof Root>[0], 'paths'>) => {
		const instance = render(<Root paths={paths()} {...props} />);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 30, configurable: true });
		stdout.emit('resize');
		await tick();
		return instance;
	};

	it('swaps the TUI runtime for the detached host and shows its label', async () => {
		const own = createFakeClient({ agents: AGENTS, host: IN_PROCESS });
		const host = createFakeClient({ agents: AGENTS, host: HEADLESS });
		const attach: TuiStartup = { branch: 'attach', client: host.client };
		const runHostStart = vi.fn(async () => ({ ok: true as const }));
		const changed: TuiStartup[] = [];
		const { stdin, lastFrame, unmount } = await renderRoot({
			startup: inProcess(own),
			backgroundHost: { runHostStart, restart: async () => attach },
			onStartupChange: (next) => changed.push(next),
		});
		expect(lastFrame()).toContain('host: this TUI');

		stdin.write('B');
		await tick(60);
		expect(runHostStart).toHaveBeenCalledOnce();
		expect(changed).toEqual([attach]);
		expect(lastFrame()).toContain('host: headless pid 812');
		expect(lastFrame()).toContain('Background host started');
		unmount();
	});

	it('refuses and keeps the runtime while a run is going', async () => {
		const own = createFakeClient({ agents: AGENTS, host: IN_PROCESS });
		const runHostStart = vi.fn(async () => ({ ok: true as const }));
		const { stdin, lastFrame, unmount } = await renderRoot({
			startup: inProcess(own, { runs: 1 }),
			backgroundHost: { runHostStart, restart: async () => inProcess(own) },
		});
		stdin.write('B');
		await tick(60);
		expect(runHostStart).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('1 Auto Run running here');
		expect(lastFrame()).toContain('host: this TUI');
		unmount();
	});

	it('says it cannot start a host where none is wired', async () => {
		const own = createFakeClient({ agents: AGENTS, host: IN_PROCESS });
		const { stdin, lastFrame, unmount } = await renderRoot({ startup: inProcess(own) });
		stdin.write('B');
		await tick(60);
		expect(lastFrame()).toContain('A background host cannot be started from here.');
		unmount();
	});
});
