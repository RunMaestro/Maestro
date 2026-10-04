import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, GroupRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { createFakeClient } from './fakeClient';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The file readers see one agent; the desktop reports different ones, so a frame says which source drew it. */
const FILE_SESSIONS = {
	sessions: [{ id: 'f1', name: 'FromFile', toolType: 'claude-code' }],
};

const DESK_AGENTS: AgentRecord[] = [
	{
		id: 'd1',
		name: 'Deskbound',
		toolType: 'claude-code',
		groupId: 'g1',
		activeTabId: 't1',
		aiTabs: [
			{ id: 't1', name: 'live-tab' },
			{ id: 'hidden', name: 'consult', hidden: true },
		],
	},
	{ id: 'd2', name: 'Ungrouped Desk', toolType: 'codex' },
];
const DESK_GROUPS: GroupRecord[] = [{ id: 'g1', name: 'Core', emoji: '🎼' }];

const entry = (id: string, source: string, text: string, timestamp = 1_700_000_000_000) => ({
	id,
	timestamp,
	source,
	text,
});

function resizeStdout(
	stdout: object & { emit: (event: string) => boolean },
	columns: number,
	rows: number
) {
	Object.defineProperty(stdout, 'columns', { value: columns, configurable: true });
	Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
	stdout.emit('resize');
}

describe('App attached to a desktop through a client', () => {
	let dir: string;
	const paths = () => ({
		userDataDir: dir,
		sessionsFile: path.join(dir, 'maestro-sessions.json'),
		groupsFile: path.join(dir, 'maestro-groups.json'),
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
	});
	const renderWith = async (client: Parameters<typeof App>[0]['client']) => {
		const instance = render(<App paths={paths()} client={client} />);
		await tick();
		resizeStdout(instance.stdout, 140, 30);
		await tick();
		return instance;
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-client-'));
		fs.writeFileSync(path.join(dir, 'maestro-sessions.json'), JSON.stringify(FILE_SESSIONS));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('discovers and connects, then draws the desktop agents and labels the host', async () => {
		const fake = createFakeClient({ agents: DESK_AGENTS, groups: DESK_GROUPS });
		const { lastFrame, unmount } = await renderWith(fake.client);
		const frame = lastFrame() ?? '';
		expect(fake.calls).toEqual(['discover', 'connect']);
		expect(frame).toContain('host: desktop pid 4121');
		expect(frame).toContain('▾ 🎼 Core');
		expect(frame).toContain('Deskbound');
		expect(frame).toContain('Ungrouped Desk');
		// The file's agent is gone: the tree comes from the client.
		expect(frame).not.toContain('FromFile');
		unmount();
	});

	it('adds an agent to the tree when the client pushes agent.added', async () => {
		const fake = createFakeClient({ agents: DESK_AGENTS, groups: DESK_GROUPS });
		const { lastFrame, unmount } = await renderWith(fake.client);
		expect(lastFrame()).not.toContain('Newcomer');

		fake.push({
			type: 'agent.added',
			agent: { id: 'd3', name: 'Newcomer', toolType: 'opencode', groupId: 'g1' },
		});
		await tick();
		expect(lastFrame()).toContain('Newcomer');

		fake.push({ type: 'agent.removed', agentId: 'd3' });
		await tick();
		expect(lastFrame()).not.toContain('Newcomer');

		fake.push({
			type: 'agent.updated',
			agent: { ...DESK_AGENTS[1]!, name: 'Renamed Desk' },
		});
		await tick();
		expect(lastFrame()).toContain('Renamed Desk');
		expect(lastFrame()).not.toContain('Ungrouped Desk');
		unmount();
	});

	it('moves a folded group when the client pushes groups.changed', async () => {
		const fake = createFakeClient({ agents: DESK_AGENTS, groups: DESK_GROUPS });
		const { lastFrame, unmount } = await renderWith(fake.client);
		fake.push({
			type: 'groups.changed',
			groups: [{ id: 'g1', name: 'Renamed Group', emoji: '🎼' }],
		});
		await tick();
		expect(lastFrame()).toContain('Renamed Group');
		unmount();
	});

	it('keeps the last data and says reconnecting when the host is lost, then recovers', async () => {
		const fake = createFakeClient({ agents: DESK_AGENTS, groups: DESK_GROUPS });
		fake.setState('connected');
		const { lastFrame, unmount } = await renderWith(fake.client);
		fake.push({ type: 'host.lost', reason: 'socket closed' });
		await tick();
		expect(lastFrame()).toContain('host: desktop pid 4121 (reconnecting)');
		expect(lastFrame()).toContain('Deskbound');

		fake.push({
			type: 'host.connected',
			host: { kind: 'desktop', pid: 4121, label: 'desktop pid 4121' },
			resumed: true,
		});
		await tick();
		expect(lastFrame()).toContain('host: desktop pid 4121');
		expect(lastFrame()).not.toContain('reconnecting');
		unmount();
	});

	it('falls back to the store files, read-only, when no desktop is running', async () => {
		const fake = createFakeClient({ discoverError: 'host-unavailable' });
		const { lastFrame, unmount } = await renderWith(fake.client);
		const frame = lastFrame() ?? '';
		expect(fake.calls).toEqual(['discover']);
		expect(frame).toContain('host: read-only');
		expect(frame).toContain('FromFile');
		unmount();
	});

	it('says why it is read-only when the desktop is too old or refuses the TUI', async () => {
		const tooOld = createFakeClient({ connectError: 'unsupported' });
		const first = await renderWith(tooOld.client);
		expect(first.lastFrame()).toContain('host: read-only (desktop too old)');
		expect(first.lastFrame()).toContain('FromFile');
		first.unmount();

		const refused = createFakeClient({ connectError: 'unauthorized' });
		const second = await renderWith(refused.client);
		expect(second.lastFrame()).toContain('host: read-only (desktop refused)');
		second.unmount();
	});

	it('works with no client at all, as before', async () => {
		const { lastFrame, unmount } = await renderWith(undefined);
		expect(lastFrame()).toContain('host: read-only');
		expect(lastFrame()).toContain('FromFile');
		unmount();
	});

	describe('transcripts', () => {
		// With no agent in the file the cursor has no row to hold on to, so it starts on the first
		// row of the desktop's tree instead of on a header the file happened to share.
		beforeEach(() => {
			fs.writeFileSync(path.join(dir, 'maestro-sessions.json'), JSON.stringify({ sessions: [] }));
		});

		const openDeskbound = async (fake: ReturnType<typeof createFakeClient>) => {
			const instance = await renderWith(fake.client);
			// Rows: Core, Deskbound, Ungrouped, Ungrouped Desk.
			instance.stdin.write('j');
			await tick();
			return instance;
		};

		it('reads the active tab transcript through the client and draws it', async () => {
			const fake = createFakeClient({
				agents: DESK_AGENTS,
				groups: DESK_GROUPS,
				transcripts: {
					'd1:t1': [entry('l1', 'user', 'Please **fix** it'), entry('l2', 'ai', 'All fixed')],
				},
			});
			const { lastFrame, unmount } = await openDeskbound(fake);
			await tick(40);
			const frame = lastFrame() ?? '';
			expect(frame).toContain('Deskbound · Claude Code · tab: live-tab');
			expect(frame).toContain('Please fix it');
			expect(frame).toContain('All fixed');
			expect(fake.transcriptReads).toContain('d1:t1');
			// A hidden consult tab is not in the strip.
			expect(frame).toContain('1 tab');
			unmount();
		});

		it('reads it again after a turn event on that tab, and ignores another tab', async () => {
			const fake = createFakeClient({
				agents: DESK_AGENTS,
				groups: DESK_GROUPS,
				transcripts: { 'd1:t1': [entry('l1', 'user', 'First question')] },
			});
			const { lastFrame, unmount } = await openDeskbound(fake);
			await tick(40);
			expect(lastFrame()).toContain('First question');
			expect(lastFrame()).not.toContain('Second answer');
			const readsBefore = fake.transcriptReads.length;

			fake.push({
				type: 'turn',
				agentId: 'd1',
				tabId: 'other-tab',
				event: { kind: 'started', at: 1 },
			});
			await tick(300);
			expect(fake.transcriptReads.length).toBe(readsBefore);

			fake.setTranscript('d1', 't1', [
				entry('l1', 'user', 'First question'),
				entry('l2', 'ai', 'Second answer', 1_700_000_001_000),
			]);
			const at = 1_700_000_000_500;
			fake.push({ type: 'turn', agentId: 'd1', tabId: 't1', event: { kind: 'started', at } });
			fake.push({
				type: 'turn',
				agentId: 'd1',
				tabId: 't1',
				event: { kind: 'text', at: at + 100, text: 'Second' },
			});
			fake.push({
				type: 'turn',
				agentId: 'd1',
				tabId: 't1',
				event: { kind: 'outcome', at: at + 1000, outcome: 'completed', exitCode: 0 },
			});
			await tick(300);
			// The stored transcript holds the turn now, so it replaces the streamed copy.
			expect(lastFrame()).toContain('Second answer');
			// The burst of three events cost one read.
			expect(fake.transcriptReads.length).toBe(readsBefore + 1);
			unmount();
		});
	});
});
