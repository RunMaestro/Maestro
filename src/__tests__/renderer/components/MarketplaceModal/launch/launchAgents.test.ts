/**
 * Tests for launchAgents: how the launch dialog describes and gates the agent a launch runs on.
 *
 * Pure functions, so these pin the exact words and values the card, the "Existing agent" list,
 * the New Agent modal's first draft and the Launch button's blockers are built from.
 */

import { describe, it, expect } from 'vitest';
import {
	evaluateLaunchGate,
	firstLaunchBlocker,
	initialNewAgentDraft,
	launchableSessions,
	summarizeLaunchDraft,
	summarizeLaunchSession,
	type LaunchBlockers,
	type LaunchGateContext,
} from '../../../../../renderer/components/MarketplaceModal/launch/launchAgents';
import type { NewAgentDraft } from '../../../../../renderer/components/NewInstanceModal/types';
import type { PlaybookLaunchSpec } from '../../../../../shared/marketplace-types';
import { createMockSession } from '../../../../helpers';

function spec(overrides: Partial<PlaybookLaunchSpec> = {}): PlaybookLaunchSpec {
	return { inputs: [], outro: { summary: 'Done.', nextSteps: [] }, ...overrides };
}

function draft(overrides: Partial<NewAgentDraft> = {}): NewAgentDraft {
	return { agentId: 'codex', workingDir: '/work/new', name: 'New one', ...overrides };
}

describe('summarizeLaunchSession', () => {
	it('names the agent, its provider, its folder and that it has no model of its own', () => {
		const summary = summarizeLaunchSession(
			createMockSession({
				name: 'Alpha',
				toolType: 'claude-code',
				cwd: '/work/alpha',
				autoRunFolderPath: '/work/alpha/.maestro/playbooks',
			})
		);

		expect(summary).toEqual({
			name: 'Alpha',
			provider: 'Claude Code',
			model: null,
			folder: '/work/alpha',
			remote: false,
		});
	});

	it('shows the model the agent is set to', () => {
		const summary = summarizeLaunchSession(
			createMockSession({ customModel: 'opus', autoRunFolderPath: '/a' })
		);

		expect(summary.model).toBe('opus');
	});

	it('uses the provider display name, not its id', () => {
		const summary = summarizeLaunchSession(
			createMockSession({ toolType: 'codex', autoRunFolderPath: '/a' })
		);

		expect(summary.provider).toBe('Codex');
	});

	it('says why a launch cannot run on an agent with no Auto Run folder', () => {
		const summary = summarizeLaunchSession(createMockSession({ autoRunFolderPath: undefined }));

		expect(summary.problem).toBe(
			'This agent has no Auto Run folder. Set one in its Auto Run panel, then launch again.'
		);
	});

	it('leaves no problem key on an agent that can be launched on', () => {
		const summary = summarizeLaunchSession(createMockSession({ autoRunFolderPath: '/a' }));

		expect('problem' in summary).toBe(false);
	});

	it('marks an agent whose SSH remote is on as remote', () => {
		const summary = summarizeLaunchSession(
			createMockSession({
				autoRunFolderPath: '/a',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);

		expect(summary.remote).toBe(true);
	});

	it('marks an agent that already spawned on a remote as remote', () => {
		const summary = summarizeLaunchSession(
			createMockSession({ autoRunFolderPath: '/a', sshRemoteId: 'remote-1' })
		);

		expect(summary.remote).toBe(true);
	});

	it('does not mark an agent whose SSH config is switched off as remote', () => {
		const summary = summarizeLaunchSession(
			createMockSession({
				autoRunFolderPath: '/a',
				sessionSshRemoteConfig: { enabled: false, remoteId: null },
			})
		);

		expect(summary.remote).toBe(false);
	});
});

describe('summarizeLaunchDraft', () => {
	it('describes the captured settings the way a stored agent is described', () => {
		const summary = summarizeLaunchDraft(draft({ customModel: 'gpt-5' }));

		expect(summary).toEqual({
			name: 'New one',
			provider: 'Codex',
			model: 'gpt-5',
			folder: '/work/new',
			remote: false,
		});
	});

	it('says the provider default when the draft sets no model', () => {
		expect(summarizeLaunchDraft(draft()).model).toBeNull();
		expect(summarizeLaunchDraft(draft({ customModel: '' })).model).toBeNull();
	});

	it('marks a draft whose SSH remote is on and chosen as remote', () => {
		const summary = summarizeLaunchDraft(
			draft({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } })
		);

		expect(summary.remote).toBe(true);
	});

	it('does not mark a draft with SSH on but no remote chosen as remote', () => {
		const summary = summarizeLaunchDraft(
			draft({ sessionSshRemoteConfig: { enabled: true, remoteId: null } })
		);

		expect(summary.remote).toBe(false);
	});

	it('never reports a problem: a new agent gets an Auto Run folder', () => {
		expect('problem' in summarizeLaunchDraft(draft())).toBe(false);
	});
});

describe('launchableSessions', () => {
	it('keeps the agents that have an Auto Run folder, in the order given', () => {
		const a = createMockSession({ id: 'a', autoRunFolderPath: '/a' });
		const b = createMockSession({ id: 'b', autoRunFolderPath: undefined });
		const c = createMockSession({ id: 'c', autoRunFolderPath: '/c' });
		const d = createMockSession({ id: 'd', autoRunFolderPath: '' });

		expect(launchableSessions([c, b, a, d]).map((session) => session.id)).toEqual(['c', 'a']);
	});

	it('returns nothing for no agents', () => {
		expect(launchableSessions([])).toEqual([]);
	});
});

describe('initialNewAgentDraft', () => {
	it('names the agent for the playbook and starts in the current agent folder', () => {
		const current = createMockSession({ cwd: '/work/alpha' });

		expect(initialNewAgentDraft('Message Bus', current)).toEqual({
			name: 'Message Bus',
			workingDir: '/work/alpha',
		});
	});

	it('names the agent for the playbook and leaves the folder out when no agent is selected', () => {
		expect(initialNewAgentDraft('Message Bus', undefined)).toEqual({ name: 'Message Bus' });
	});

	it('takes the SSH remote along with a remote folder', () => {
		const current = createMockSession({
			cwd: '/home/dev/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(initialNewAgentDraft('Message Bus', current)).toEqual({
			name: 'Message Bus',
			workingDir: '/home/dev/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
	});

	it('reads the remote from a spawned agent that carries only an id', () => {
		const current = createMockSession({ cwd: '/home/dev/app', sshRemoteId: 'remote-2' });

		expect(initialNewAgentDraft('Message Bus', current).sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
		});
	});

	it('adds no SSH config for a local agent', () => {
		const current = createMockSession({
			cwd: '/work/alpha',
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
		});

		expect('sessionSshRemoteConfig' in initialNewAgentDraft('Message Bus', current)).toBe(false);
	});
});

describe('evaluateLaunchGate', () => {
	const local: LaunchGateContext = {
		runningVersion: '1.0.0',
		platform: 'darwin',
		sshRemote: false,
		maestroCliInstalled: true,
	};

	it('is open for a playbook with no preconditions', () => {
		expect(evaluateLaunchGate(spec(), local)).toEqual({ available: true, notes: [] });
	});

	it('blocks a playbook that runs on another platform, with the reason', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { platforms: ['darwin'] } }), {
			...local,
			platform: 'win32',
		});

		expect(gate.available).toBe(false);
		expect(gate.blockedReason).toBe('This playbook runs on macOS only.');
		expect(gate.cliReason).toBeUndefined();
	});

	it('does not refuse a platform it cannot read (web-desktop): main checks it again', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { platforms: ['darwin'] } }), {
			...local,
			platform: '',
		});

		expect(gate).toEqual({ available: true, notes: [] });
	});

	it('still refuses a Maestro version that is too old when the platform is unknown', () => {
		const gate = evaluateLaunchGate(
			spec({ minMaestroVersion: '9.0.0', preconditions: { platforms: ['darwin'] } }),
			{ ...local, platform: '' }
		);

		expect(gate.available).toBe(false);
		expect(gate.blockedReason).toBe('Launch needs Maestro 9.0.0 or newer (this is 1.0.0).');
	});

	it('blocks a playbook that needs a newer Maestro, with the reason', () => {
		const gate = evaluateLaunchGate(spec({ minMaestroVersion: '9.0.0' }), local);

		expect(gate.available).toBe(false);
		expect(gate.blockedReason).toBe('Launch needs Maestro 9.0.0 or newer (this is 1.0.0).');
	});

	it('waits for maestro-cli when the playbook requires it and it is not installed', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { maestroCli: 'required' } }), {
			...local,
			maestroCliInstalled: false,
		});

		expect(gate.available).toBe(false);
		expect(gate.blockedReason).toBeUndefined();
		expect(gate.cliReason).toBe(
			'This playbook drives Maestro through maestro-cli, which is not installed. Install maestro-cli to launch it.'
		);
	});

	it('opens once maestro-cli is installed', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { maestroCli: 'required' } }), local);

		expect(gate).toEqual({ available: true, notes: [] });
	});

	it('refuses a required maestro-cli on an SSH remote even when it is installed here', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { maestroCli: 'required' } }), {
			...local,
			sshRemote: true,
		});

		expect(gate.available).toBe(false);
		expect(gate.cliReason).toBe(
			'This playbook drives Maestro through maestro-cli, which is not available on remote agents.'
		);
	});

	it('only notes a missing optional maestro-cli', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { maestroCli: 'optional' } }), {
			...local,
			maestroCliInstalled: false,
		});

		expect(gate.available).toBe(true);
		expect(gate.cliReason).toBeUndefined();
		expect(gate.notes).toEqual([
			'maestro-cli is not installed, so any step that calls it is skipped or uses a fallback.',
		]);
	});

	it('only notes an optional maestro-cli on an SSH remote', () => {
		const gate = evaluateLaunchGate(spec({ preconditions: { maestroCli: 'optional' } }), {
			...local,
			sshRemote: true,
		});

		expect(gate.available).toBe(true);
		expect(gate.notes).toEqual([
			'maestro-cli is not available on remote agents, so any step that calls it is skipped or uses a fallback.',
		]);
	});

	it('reports the machine problem before the maestro-cli one', () => {
		const gate = evaluateLaunchGate(
			spec({ preconditions: { platforms: ['darwin'], maestroCli: 'required' } }),
			{ ...local, platform: 'linux', maestroCliInstalled: false }
		);

		expect(gate.blockedReason).toBe('This playbook runs on macOS only.');
		expect(gate.cliReason).toBeUndefined();
	});

	it('does not change the spec it was given', () => {
		const given = spec({ preconditions: { platforms: ['darwin'] } });

		evaluateLaunchGate(given, { ...local, platform: '' });

		expect(given.preconditions?.platforms).toEqual(['darwin']);
	});
});

describe('firstLaunchBlocker', () => {
	const open: LaunchBlockers = {
		gate: { available: true, notes: [] },
		checkingMaestroCli: false,
		confirmationPending: false,
		invalidAnswers: 0,
	};

	it('is null when nothing stands in the way', () => {
		expect(firstLaunchBlocker(open)).toBeNull();
	});

	it('names the playbook-level block first', () => {
		expect(
			firstLaunchBlocker({
				...open,
				gate: { available: false, blockedReason: 'Runs on macOS only.', notes: [] },
				targetProblem: 'Choose the agent to launch on.',
				invalidAnswers: 2,
			})
		).toBe('Runs on macOS only.');
	});

	it('names a missing agent before the answers', () => {
		expect(
			firstLaunchBlocker({
				...open,
				targetProblem: 'Choose the agent to launch on.',
				invalidAnswers: 2,
			})
		).toBe('Choose the agent to launch on.');
	});

	it('names a missing maestro-cli, and says it is still checking while it is unread', () => {
		const gate = { available: false, cliReason: 'maestro-cli is not installed.', notes: [] };

		expect(firstLaunchBlocker({ ...open, gate })).toBe('maestro-cli is not installed.');
		expect(firstLaunchBlocker({ ...open, gate, checkingMaestroCli: true })).toBe(
			'Checking whether maestro-cli is installed...'
		);
	});

	it('counts the answers that need attention', () => {
		expect(firstLaunchBlocker({ ...open, invalidAnswers: 1 })).toBe('1 answer needs attention.');
		expect(firstLaunchBlocker({ ...open, invalidAnswers: 3 })).toBe('3 answers need attention.');
	});

	it('asks for the confirmation last', () => {
		expect(firstLaunchBlocker({ ...open, confirmationPending: true })).toBe(
			'Tick the confirmation to continue.'
		);
		expect(firstLaunchBlocker({ ...open, confirmationPending: true, invalidAnswers: 1 })).toBe(
			'1 answer needs attention.'
		);
	});
});
