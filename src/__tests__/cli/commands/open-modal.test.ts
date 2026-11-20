/**
 * @file open-modal.test.ts
 * @description Tests for `maestro-cli open <surface> --group <id>` and
 * `--agent <id>`.
 *
 * The Delegation Graph opens on one group from two places a pointer can reach
 * (the group's right-click menu, and a command in the palette), so the CLI has
 * to reach it too. These tests pin what is easy to get wrong: the group goes
 * over the wire as a FULL id (the user may type a prefix), `--group` on a
 * surface that takes none says that and never "Group not found", and nothing
 * is sent when either check fails. Edit Agent is one agent's form, so it takes
 * `--agent` under the same rules.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

const GROUPS = [
	{ id: 'group-platform-1', name: 'Platform', emoji: '' },
	{ id: 'group-research-2', name: 'Research', emoji: '🔬' },
	// A worktree group: its agents come from the worktree flow, so it has no
	// Group Settings to open.
	{ id: 'group-worktree-3', name: 'Worktrees', emoji: '', kind: 'worktree' },
];

const AGENTS = [
	{ id: 'agent-builder-1', name: 'Builder' },
	{ id: 'agent-reviewer-2', name: 'Reviewer' },
];

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn((key: string) =>
		key === 'encoreFeatures' ? { maestroCue: true } : undefined
	),
	readGroups: vi.fn(() => GROUPS),
	resolveGroupId: vi.fn((partial: string) => {
		const match = GROUPS.find((group) => group.id.startsWith(partial));
		if (!match) throw new Error(`Group not found: ${partial}`);
		return match.id;
	}),
	resolveAgentId: vi.fn((partial: string) => {
		const match = AGENTS.find((agent) => agent.id.startsWith(partial));
		if (!match) throw new Error(`Agent not found: ${partial}`);
		return match.id;
	}),
	getSessionById: vi.fn((id: string) => AGENTS.find((agent) => agent.id === id)),
}));

import { openModal } from '../../../cli/commands/open-modal';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, resolveGroupId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

interface SentMessage {
	type?: string;
	surface?: string;
	tab?: string;
	subTab?: string;
	group?: string;
	agent?: string;
}

/** Capture the message the command puts on the wire. */
function captureSend(): { sent: SentMessage | null } {
	const captured: { sent: SentMessage | null } = { sent: null };
	vi.mocked(withMaestroClient).mockImplementation(async (action) => {
		const client = {
			sendCommand: vi.fn().mockImplementation((msg: SentMessage) => {
				captured.sent = msg;
				return Promise.resolve({ type: 'open_modal_result', success: true });
			}),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		return action(client);
	});
	return captured;
}

/** `fail()` ends in `process.exit`; a throw stands in for the process ending. */
class ExitError extends Error {}

describe('open command: --group', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new ExitError();
		});
	});

	it('opens the Delegation Graph on every agent when no group is given', async () => {
		const captured = captureSend();

		await openModal('delegation-graph', {});

		expect(captured.sent).toMatchObject({ type: 'open_modal', surface: 'delegation-graph' });
		expect(captured.sent?.group).toBeUndefined();
		expect(resolveGroupId).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith('Opened Delegation Graph in Maestro.');
	});

	it('sends the full group id for a prefix, and names the group in the reply', async () => {
		const captured = captureSend();

		await openModal('delegation-graph', { group: 'group-res' });

		expect(captured.sent).toMatchObject({
			type: 'open_modal',
			surface: 'delegation-graph',
			group: 'group-research-2',
		});
		expect(consoleSpy).toHaveBeenCalledWith(
			'Opened Delegation Graph on the group Research in Maestro.'
		);
	});

	it('prints the right-click way in after a group open', async () => {
		captureSend();

		await openModal('delegation-graph', { group: 'group-platform-1' });

		const printed = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(printed).toContain(
			'For one group: right-click the group in the Left Bar > Delegation Graph.'
		);
	});

	it('reports the group in --json', async () => {
		captureSend();

		await openModal('delegation', { group: 'group-platform-1', json: true });

		const payload = JSON.parse(String(consoleSpy.mock.calls[0][0]));
		expect(payload).toMatchObject({
			success: true,
			surface: 'delegation-graph',
			group: 'group-platform-1',
		});
	});

	it('reports an empty group in --json when none was asked for', async () => {
		captureSend();

		await openModal('delegation-graph', { json: true });

		expect(JSON.parse(String(consoleSpy.mock.calls[0][0])).group).toBe('');
	});

	it('refuses a group that does not exist and sends nothing', async () => {
		const captured = captureSend();

		await expect(openModal('delegation-graph', { group: 'nope' })).rejects.toBeInstanceOf(
			ExitError
		);

		expect(consoleErrorSpy).toHaveBeenCalledWith(formatError('Group not found: nope'));
		expect(captured.sent).toBeNull();
	});

	it('refuses --group on a surface that takes none, before the group is looked up', async () => {
		const captured = captureSend();

		await expect(openModal('cue', { group: 'nope' })).rejects.toBeInstanceOf(ExitError);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			formatError('Maestro Cue does not open on one group, so --group does not apply.')
		);
		expect(resolveGroupId).not.toHaveBeenCalled();
		expect(captured.sent).toBeNull();
	});

	it('marks the surfaces that open on a group in --list', async () => {
		await openModal(undefined, { list: true, json: true });

		const surfaces = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Array<{
			id: string;
			group_scoped: boolean;
		}>;
		expect(surfaces.filter((surface) => surface.group_scoped).map((surface) => surface.id)).toEqual(
			['delegation-graph', 'group-settings']
		);
	});
});

describe('open command: Edit Agent', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new ExitError();
		});
	});

	it('sends the full agent id for a prefix, and names the agent in the reply', async () => {
		const captured = captureSend();

		await openModal('agent-settings', { agent: 'agent-rev' });

		expect(captured.sent).toMatchObject({
			type: 'open_modal',
			surface: 'agent-settings',
			agent: 'agent-reviewer-2',
		});
		expect(captured.sent?.tab).toBeUndefined();
		expect(consoleSpy).toHaveBeenCalledWith('Opened Edit Agent for the agent Reviewer in Maestro.');
	});

	it('opens the form on the tab asked for, by its label or its id', async () => {
		const captured = captureSend();

		await openModal('edit-agent', { agent: 'agent-builder-1', tab: 'Peers' });

		expect(captured.sent).toMatchObject({
			surface: 'agent-settings',
			agent: 'agent-builder-1',
			tab: 'peers',
		});
		expect(consoleSpy).toHaveBeenCalledWith(
			'Opened Edit Agent (peers tab) for the agent Builder in Maestro.'
		);
	});

	it('prints the right-click way in, which reaches any agent', async () => {
		captureSend();

		await openModal('agent-settings', { agent: 'agent-builder-1' });

		const printed = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(printed).toContain('For any agent: right-click the agent in the Left Bar > Edit Agent.');
	});

	it('reports the agent in --json', async () => {
		captureSend();

		await openModal('agent-settings', { agent: 'agent-builder-1', tab: 'models', json: true });

		expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toMatchObject({
			success: true,
			surface: 'agent-settings',
			tab: 'models',
			agent: 'agent-builder-1',
		});
	});

	it('is refused without --agent before the app is asked', async () => {
		captureSend();

		await expect(openModal('agent-settings', {})).rejects.toBeInstanceOf(ExitError);

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('pass --agent');
	});

	it('refuses an agent that does not exist and sends nothing', async () => {
		const captured = captureSend();

		await expect(openModal('agent-settings', { agent: 'nope' })).rejects.toBeInstanceOf(ExitError);

		expect(consoleErrorSpy).toHaveBeenCalledWith(formatError('Agent not found: nope'));
		expect(captured.sent).toBeNull();
	});

	it('refuses --agent on a surface that takes none, before the agent is looked up', async () => {
		const captured = captureSend();

		await expect(openModal('cue', { agent: 'nope' })).rejects.toBeInstanceOf(ExitError);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			formatError("Maestro Cue is not one agent's, so --agent does not apply.")
		);
		expect(resolveAgentId).not.toHaveBeenCalled();
		expect(captured.sent).toBeNull();
	});

	it("marks the surfaces that are one agent's in --list", async () => {
		await openModal(undefined, { list: true, json: true });

		const surfaces = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Array<{
			id: string;
			agent_scoped: boolean;
		}>;
		expect(surfaces.filter((surface) => surface.agent_scoped).map((surface) => surface.id)).toEqual(
			['agent-settings']
		);
	});
});

describe('open command: Group Settings', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new ExitError();
		});
	});

	it('opens Group Settings on the group named by a prefix', async () => {
		const captured = captureSend();

		await openModal('group-settings', { group: 'group-plat' });

		expect(captured.sent).toMatchObject({
			type: 'open_modal',
			surface: 'group-settings',
			group: 'group-platform-1',
		});
		expect(consoleSpy).toHaveBeenCalledWith(
			'Opened Group Settings on the group Platform in Maestro.'
		);
	});

	it('is refused without --group before the app is asked', async () => {
		captureSend();

		await expect(openModal('group-settings', {})).rejects.toBeInstanceOf(ExitError);

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('pass --group');
	});

	it('is refused for a worktree group, which takes no defaults', async () => {
		captureSend();

		await expect(openModal('group-settings', { group: 'group-work' })).rejects.toBeInstanceOf(
			ExitError
		);

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('worktree group');
	});
});
