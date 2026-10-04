import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, GroupRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { agentMenuEntries } from '../palette/agentMenu';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const BACKSPACE = '\u007f';
const CTRL_K = '\u000b';

const GROUPS = (): GroupRecord[] => [
	{ id: 'g1', name: 'Core', emoji: '🎼' },
	{ id: 'g2', name: 'Empty' },
];

const AGENTS = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'codex',
		groupId: 'g1',
		state: 'idle',
		aiTabs: [{ id: 't1', name: 'one' }],
	},
	{ id: 'a2', name: 'Beta', toolType: 'codex', state: 'busy', aiTabs: [{ id: 't2' }] },
	{
		id: 'a3',
		name: 'Gamma',
		toolType: 'codex',
		state: 'idle',
		aiTabs: [{ id: 't3' }, { id: 't4' }],
	},
];

// Rows from the top: Core, Alpha, Empty, Ungrouped, Beta, Gamma.
const TO_ALPHA = ['j'];
const TO_BETA = ['j', 'j', 'j', 'j'];
const TO_GAMMA = ['j', 'j', 'j', 'j', 'j'];

describe('renaming, deleting, and grouping in the App', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({ agents: AGENTS(), groups: GROUPS(), ...options });
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
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-manage-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('renames an agent with the exact client call, and the list shows the new name (AG-5)', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'R');
		expect(frame()).toContain('Rename agent: Alpha');
		await press(...Array(5).fill(BACKSPACE), 'Alpine');
		await press(ENTER);

		expect(fake.requests).toEqual([{ method: 'agents.rename', args: ['a1', 'Alpine'] }]);
		expect(frame()).not.toContain('Rename agent');
		expect(frame()).toContain('Renamed Alpha to Alpine.');
		expect(frame()).toContain('Alpine');
		unmount();
	});

	it('keeps a blank name in the prompt and sends nothing', async () => {
		const { press, frame, methods, unmount } = await mount();
		await press(...TO_ALPHA, 'R', ...Array(5).fill(BACKSPACE), ENTER);
		expect(frame()).toContain('Rename agent: Alpha');
		expect(frame()).toContain('The name cannot be empty.');
		expect(methods()).toEqual([]);
		unmount();
	});

	it('closes an unchanged rename without a call', async () => {
		const { press, frame, methods, unmount } = await mount();
		await press(...TO_ALPHA, 'R', ENTER);
		expect(frame()).not.toContain('Rename agent');
		expect(frame()).toContain('Name unchanged.');
		expect(methods()).toEqual([]);
		unmount();
	});

	it("shows the host's refusal on the prompt and leaves it open", async () => {
		const { press, frame, unmount } = await mount({ failures: { 'agents.rename': 'rejected' } });
		await press(...TO_ALPHA, 'R', 'x', ENTER);
		expect(frame()).toContain('Rename agent: Alpha');
		expect(frame()).toContain('fake rejected');
		await press(ESC);
		expect(frame()).not.toContain('Rename agent');
		unmount();
	});

	it('confirms a delete by saying what is removed and kept, and cancels with n or Esc (AG-5)', async () => {
		const { press, frame, methods, unmount } = await mount();
		await press(...TO_GAMMA, 'X');
		expect(frame()).toContain('Delete agent: Gamma');
		expect(frame()).toContain('Removes');
		expect(frame()).toContain('Its 2 tabs and the transcripts stored in them');
		expect(frame()).toContain('Keeps');
		expect(frame()).toContain('Its History entries');
		expect(frame()).toContain("The provider's own session files");

		await press('n');
		expect(frame()).not.toContain('Delete agent');
		await press('X', ESC);
		expect(frame()).not.toContain('Delete agent');
		expect(methods()).toEqual([]);
		unmount();
	});

	it('deletes an agent through the client and drops it from the list', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_GAMMA, 'X', 'y');
		expect(fake.requests).toEqual([{ method: 'agents.remove', args: ['a3'] }]);
		expect(frame()).toContain('Deleted Gamma.');
		// The notice names it; the list no longer does.
		expect(frame().replace('Deleted Gamma.', '')).not.toContain('Gamma');
		expect(frame()).toContain('History');
		unmount();
	});

	it('also confirms with Enter, and warns when a turn is running', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_BETA, 'X');
		expect(frame()).toContain('A turn is running. It is stopped first.');
		await press(ENTER);
		expect(fake.requests).toEqual([{ method: 'agents.remove', args: ['a2'] }]);
		unmount();
	});

	it('creates a group with a name and an emoji (GR-1)', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press('N');
		expect(frame()).toContain('New group');
		await press('Ops', TAB, '🚀');
		await press(ENTER);
		expect(fake.requests).toEqual([
			{ method: 'groups.create', args: [{ name: 'Ops', emoji: '🚀' }] },
		]);
		expect(frame()).toContain('Created group 🚀 Ops.');
		expect(frame()).toContain('🚀 Ops');
		unmount();
	});

	it('creates a group without an emoji when the box is left empty', async () => {
		const { press, fake, unmount } = await mount();
		await press('N', 'Ops', ENTER);
		expect(fake.requests).toEqual([{ method: 'groups.create', args: [{ name: 'Ops' }] }]);
		unmount();
	});

	it('renames the group under the cursor (GR-1)', async () => {
		const { press, frame, fake, unmount } = await mount();
		// The cursor starts on the Core header.
		await press('R');
		expect(frame()).toContain('Rename group: Core');
		await press(...Array(4).fill(BACKSPACE), 'Platform', ENTER);
		expect(fake.requests).toEqual([{ method: 'groups.rename', args: ['g1', 'Platform'] }]);
		expect(frame()).toContain('Platform');
		unmount();
	});

	it('deletes a group, keeps its agents, and says so before it does (GR-1)', async () => {
		const { press, frame, methods, fake, unmount } = await mount();
		await press('X');
		expect(frame()).toContain('Delete group: 🎼 Core');
		expect(frame()).toContain('All 1 agent, which become ungrouped');
		await press('y');
		expect(fake.requests).toEqual([{ method: 'groups.remove', args: ['g1'] }]);
		expect(methods()).not.toContain('agents.remove');
		// Alpha is still listed, now under Ungrouped.
		expect(frame()).toContain('Alpha');
		expect(frame()).not.toContain('🎼');
		unmount();
	});

	it('explains that Bookmarks and Ungrouped are not groups', async () => {
		const { press, frame, methods, unmount } = await mount();
		// Down to the Ungrouped header: Core, Alpha, Empty, Ungrouped.
		await press('j', 'j', 'j', 'R');
		expect(frame()).toContain('Ungrouped is not a group');
		expect(frame()).not.toContain('Rename group');
		await press('X');
		expect(frame()).toContain('Ungrouped is not a group');
		expect(methods()).toEqual([]);
		unmount();
	});

	it('moves an agent to another group from a picker that starts on its own (GR-2)', async () => {
		const { press, frame, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'g');
		expect(frame()).toContain('Move to group: Alpha');
		expect(frame()).toContain('Ungrouped');
		expect(frame()).toContain('current');
		await press('j', ENTER);
		expect(fake.requests).toEqual([{ method: 'groups.moveAgent', args: ['a1', 'g2'] }]);
		expect(frame()).toContain('Moved Alpha to Empty.');
		unmount();
	});

	it('moves an agent to ungrouped with a null group id (GR-2)', async () => {
		const { press, fake, unmount } = await mount();
		await press(...TO_ALPHA, 'g', 'k', ENTER);
		expect(fake.requests).toEqual([{ method: 'groups.moveAgent', args: ['a1', null] }]);
		unmount();
	});

	it('sends nothing when the agent is already in the chosen group', async () => {
		const { press, frame, methods, unmount } = await mount();
		await press(...TO_ALPHA, 'g', ENTER);
		expect(frame()).toContain('Alpha is already in 🎼 Core.');
		expect(methods()).toEqual([]);
		unmount();
	});

	it('puts the cursor on the moved agent in its new group', async () => {
		const { press, frame, unmount } = await mount();
		await press(...TO_ALPHA, 'g', 'j', ENTER);
		await tick(60);
		// The conversation pane follows the cursor, so it names the agent that was moved.
		expect(frame()).toMatch(/Empty[\s\S]*›[^\n]*Alpha/);
		unmount();
	});

	it('reaches rename, delete, and move through the agent menu (three ways in)', async () => {
		const entries = agentMenuEntries();
		const at = (label: string) => entries.findIndex((entry) => entry.label === label);
		expect(at('Rename agent')).toBeGreaterThan(-1);
		expect(at('Delete agent')).toBeGreaterThan(-1);
		expect(at('Move to group')).toBeGreaterThan(-1);

		const { press, frame, unmount } = await mount();
		await press(...TO_ALPHA, 'm');
		expect(frame()).toContain('Rename agent');
		expect(frame()).toContain('Delete agent');
		expect(frame()).toContain('Move to group');
		await press(...Array(at('Delete agent')).fill('j'), ENTER);
		expect(frame()).toContain('Delete agent: Alpha');
		unmount();
	});

	it('reaches the group actions through the command palette (three ways in)', async () => {
		const { press, frame, unmount } = await mount();
		await press(CTRL_K, 'New group', ENTER);
		expect(frame()).toContain('New group');
		expect(frame()).toContain('Emoji');
		unmount();
	});

	it('refuses every change without a desktop attached', async () => {
		const { press, frame, unmount } = await mount({}, false);
		for (const key of ['R', 'X', 'g', 'N']) {
			await press(key);
			expect(frame()).toContain('No desktop attached');
			expect(frame()).not.toContain('Rename');
			expect(frame()).not.toContain('Delete');
			expect(frame()).not.toContain('Move to group:');
			expect(frame()).not.toContain('New group');
		}
		unmount();
	});
});
