/**
 * @file cue-control.test.ts
 * @description Tests for `cue enable|disable|gate|screen|activity`: name
 * resolution (refusing an ambiguous name), the toggle, gate and screen
 * messages, and error-frame handling.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));

import {
	cueActivity,
	cueDisable,
	cueEnable,
	cueGate,
	cueScreen,
	resolveSubscription,
} from '../../../cli/commands/cue-control';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const subs = [
	{
		id: 'a1::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: true,
	},
	{
		id: 'a2::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a2',
		sessionName: 'Two',
		enabled: true,
	},
	{
		id: 'a1::p::on-pr',
		name: 'on-pr',
		eventType: 'github.pull_request',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: false,
	},
];

function mockBridge(responses: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				sent.push(payload);
				return Promise.resolve(responses[payload.type as string]);
			}),
		} as never)
	);
	return sent;
}

describe('resolveSubscription', () => {
	it('matches a full id, a unique name, or a name narrowed by agent', () => {
		expect(resolveSubscription(subs, 'a2::p::nightly').sessionId).toBe('a2');
		expect(resolveSubscription(subs, 'on-pr').id).toBe('a1::p::on-pr');
		expect(resolveSubscription(subs, 'nightly', 'a2').id).toBe('a2::p::nightly');
	});

	it('refuses a name several agents share, and an unknown name', () => {
		expect(() => resolveSubscription(subs, 'nightly')).toThrow(/names 2 subscriptions/);
		expect(() => resolveSubscription(subs, 'nope')).toThrow(/No Cue subscription/);
	});
});

describe('cue enable/disable/activity', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('enable sends the resolved id with enabled:true', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: true },
		});
		await cueEnable('on-pr', {});
		expect(sent[1]).toEqual({
			type: 'toggle_cue_subscription',
			subscriptionId: 'a1::p::on-pr',
			enabled: true,
		});
	});

	it('disable exits non-zero when the engine reports failure', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: false },
		});
		await expect(cueDisable('on-pr', {})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('activity passes agent and limit, and fails on an error frame', async () => {
		const sent = mockBridge({ get_cue_activity: { type: 'cue_activity', entries: [] } });
		await cueActivity({ agent: 'a1', limit: '5' });
		expect(sent[0]).toEqual({ type: 'get_cue_activity', sessionId: 'a1', limit: 5 });

		mockBridge({ get_cue_activity: { type: 'error', message: 'Cue activity not available' } });
		await expect(cueActivity({})).rejects.toThrow('__exit__');
	});

	it('activity prints why a gate skipped an event', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBridge({
			get_cue_activity: {
				type: 'cue_activity',
				entries: [
					{
						id: 'r1',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:00:00Z'),
						status: 'gated',
						result: 'The comment is praise and asks for nothing.',
						duration: 40,
					},
					{
						id: 'r2',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:01:00Z'),
						status: 'completed',
						result: 'Opened a fix.',
						duration: 9000,
					},
				],
			},
		});

		await cueActivity({});

		const lines = logSpy.mock.calls.map((call) => String(call[0]));
		expect(lines[0]).toMatch(/gated\s+on-pr\s+\[github\.issue\]/);
		expect(lines[0]).toContain('- The comment is praise and asks for nothing.');
		// A run's output is not echoed on the one-line form.
		expect(lines[1]).toMatch(/completed\s+on-pr/);
		expect(lines[1]).not.toContain('Opened a fix.');
	});

	it('activity prints a blocked run with the reason the screen refused it', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBridge({
			get_cue_activity: {
				type: 'cue_activity',
				entries: [
					{
						id: 'r1',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:00:00Z'),
						status: 'blocked',
						result: 'The new comments ({{CUE_NEW_COMMENTS}}) scored 0.97.',
						duration: 40,
					},
				],
			},
		});

		await cueActivity({});

		const line = String(logSpy.mock.calls[0][0]);
		expect(line).toMatch(/blocked\s+on-pr\s+\[github\.issue\]/);
		expect(line).toContain('- The new comments ({{CUE_NEW_COMMENTS}}) scored 0.97.');
	});

	it('activity rejects a bad --limit before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueActivity({ limit: 'lots' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});
});

describe('cue gate', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const gated = [
		...subs,
		{
			id: 'a1::p::triage',
			name: 'triage',
			eventType: 'github.issue',
			sessionId: 'a1',
			sessionName: 'One',
			enabled: true,
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'skip' as const,
		},
	];
	const ready = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [{ taskId: 'cue-gate', state: 'ready', detail: 'Runs on Qwen.' }],
	};
	const off = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [
			{
				taskId: 'cue-gate',
				state: 'off',
				detail: 'Cue gate is off.',
				suggestedAction: 'Assign it a local model or an endpoint in Settings > Local Models.',
			},
		],
	};
	const written = (updated: string[]) => ({
		type: 'set_cue_subscription_gate_result',
		success: true,
		updated,
	});
	const printed = () => logSpy.mock.calls.map((call) => String(call[0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('shows a gate and its policy without writing anything', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await cueGate('triage', {});
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(printed()).toEqual([
			'triage (One)',
			'  gate: the comment reports a bug',
			'  if no model can answer: skip the event',
		]);
	});

	it('says so when a subscription has no gate, and reads back as JSON', async () => {
		mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await cueGate('on-pr', {});
		expect(printed()[0]).toBe('on-pr (One) has no gate. Every event starts a run.');

		logSpy.mockClear();
		await cueGate('on-pr', { json: true });
		expect(JSON.parse(printed()[0])).toEqual({
			subscriptionId: 'a1::p::on-pr',
			name: 'on-pr',
			gate: null,
			gateOnUnavailable: null,
		});

		logSpy.mockClear();
		await cueGate('triage', { json: true });
		expect(JSON.parse(printed()[0])).toMatchObject({
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'skip',
		});
	});

	it('sets a trimmed condition with the default policy and names every subscription changed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr', 'on-pr-cmd-a']),
			local_models_task_readiness: ready,
		});
		await cueGate('on-pr', { set: '  the PR changes source code  ' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_gate',
			subscriptionId: 'a1::p::on-pr',
			gate: 'the PR changes source code',
			gateOnUnavailable: 'run',
		});
		expect(printed()).toEqual([
			'Gate set on on-pr, on-pr-cmd-a (One): the PR changes source code',
			'  if no model can answer: start the run and warn',
		]);
	});

	it('warns when the gate was written but no model will check it', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueGate('on-pr', { set: 'the PR changes source code' });
		expect(printed()[2]).toBe(
			'Note: Cue gate is off. Assign it a local model or an endpoint in Settings > Local Models. Until it can answer, every event starts a run unchecked.'
		);

		// The consequence follows the policy that was written.
		logSpy.mockClear();
		await cueGate('on-pr', { set: 'the PR changes source code', onUnavailable: 'skip' });
		expect(printed()[2]).toMatch(/Until it can answer, every event is skipped\.$/);
	});

	it('does not fail a good write when readiness cannot be read', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
					if (payload.type === 'local_models_task_readiness') {
						return Promise.reject(new Error('timed out'));
					}
					if (payload.type === 'get_cue_subscriptions') {
						return Promise.resolve({ subscriptions: gated });
					}
					return Promise.resolve(written(['on-pr']));
				}),
			} as never)
		);
		await cueGate('on-pr', { set: 'the PR changes source code' });
		expect(printed()).toHaveLength(2);
	});

	it('keeps the half that was not passed: a new condition keeps the policy, a new policy the condition', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['triage']),
			local_models_task_readiness: ready,
		});
		await cueGate('triage', { set: 'the comment asks for a change' });
		expect(sent[1]).toMatchObject({
			gate: 'the comment asks for a change',
			gateOnUnavailable: 'skip',
		});

		sent.length = 0;
		await cueGate('triage', { onUnavailable: 'run' });
		expect(sent[1]).toMatchObject({
			gate: 'the comment reports a bug',
			gateOnUnavailable: 'run',
		});
	});

	it('refuses a policy for a subscription that has no gate', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: gated } });
		await expect(cueGate('on-pr', { onUnavailable: 'skip' })).rejects.toThrow('__exit__');
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(String(errorSpy.mock.calls[0][0])).toContain('has no gate to set a policy on');
	});

	it('removes a gate with a null condition and no policy', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['triage']),
		});
		await cueGate('triage', { clear: true });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_gate',
			subscriptionId: 'a1::p::triage',
			gate: null,
		});
		expect(printed()).toEqual(['Removed the gate from triage (One).']);
	});

	it('reports a JSON result for a write, with no readiness lookup', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueGate('on-pr', { set: 'the PR changes source code', json: true });
		expect(sent.map((frame) => frame.type)).toEqual([
			'get_cue_subscriptions',
			'set_cue_subscription_gate',
		]);
		expect(JSON.parse(printed()[0])).toEqual({
			success: true,
			subscriptionId: 'a1::p::on-pr',
			updated: ['on-pr'],
			gate: 'the PR changes source code',
			gateOnUnavailable: 'run',
		});
	});

	it('refuses bad flags before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueGate('on-pr', { set: '   ' })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { set: 'x'.repeat(1001) })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { onUnavailable: 'maybe' })).rejects.toThrow('__exit__');
		await expect(cueGate('on-pr', { clear: true, set: 'a bug' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	it('exits non-zero when the engine refuses the write or the bridge answers with an error', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: {
				type: 'set_cue_subscription_gate_result',
				success: false,
				error: 'Could not write the gate.',
			},
		});
		await expect(cueGate('on-pr', { set: 'a bug' })).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('Could not write the gate.');

		mockBridge({
			get_cue_subscriptions: { subscriptions: gated },
			set_cue_subscription_gate: { type: 'error', message: 'Cue gate editing is not available' },
		});
		await expect(cueGate('on-pr', { clear: true })).rejects.toThrow('__exit__');
	});
});

describe('cue screen', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const screened = [
		...subs,
		{
			id: 'a1::p::triage',
			name: 'triage',
			eventType: 'github.issue',
			sessionId: 'a1',
			sessionName: 'One',
			enabled: true,
			screenInjection: true,
			injectionThreshold: 0.6,
		},
	];
	const ready = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [{ taskId: 'injection-screen', state: 'ready', detail: 'Runs on Prompt Guard.' }],
	};
	const off = {
		type: 'local_models_task_readiness_result',
		success: true,
		readiness: [
			{
				taskId: 'injection-screen',
				state: 'off',
				detail: 'Prompt-injection screen is off.',
				suggestedAction: 'Assign it a classifier model in Settings > Local Models.',
			},
		],
	};
	const written = (updated: string[]) => ({
		type: 'set_cue_subscription_injection_screen_result',
		success: true,
		updated,
	});
	const printed = () => logSpy.mock.calls.map((call) => String(call[0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('shows the screen without writing anything', async () => {
		const sent = mockBridge({ get_cue_subscriptions: { subscriptions: screened } });
		await cueScreen('triage', {});
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(printed()).toEqual([
			'triage (One)',
			'  injection screen: on (untrusted text is always screened)',
			'  blocks at a score of: 0.6',
		]);
	});

	it('reads the default back as auto at 0.8, and as JSON', async () => {
		mockBridge({ get_cue_subscriptions: { subscriptions: screened } });
		await cueScreen('on-pr', {});
		expect(printed()).toEqual([
			'on-pr (One)',
			'  injection screen: auto (commands that use untrusted text are screened)',
			'  blocks at a score of: 0.8',
		]);

		logSpy.mockClear();
		await cueScreen('on-pr', { json: true });
		expect(JSON.parse(printed()[0])).toEqual({
			subscriptionId: 'a1::p::on-pr',
			name: 'on-pr',
			mode: 'auto',
			threshold: 0.8,
		});
	});

	it('sets a mode, keeps the threshold the screen had, and names every subscription changed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage', 'triage-cmd-a']),
			local_models_task_readiness: ready,
		});
		await cueScreen('triage', { mode: 'auto' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_injection_screen',
			subscriptionId: 'a1::p::triage',
			mode: 'auto',
			threshold: 0.6,
		});
		expect(printed()).toEqual([
			'Injection screen on triage, triage-cmd-a (One): auto (commands that use untrusted text are screened)',
			'  blocks at a score of: 0.6',
		]);
	});

	it('changes only the threshold when only --threshold is passed', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage']),
			local_models_task_readiness: ready,
		});
		await cueScreen('triage', { threshold: '0.9' });
		expect(sent[1]).toMatchObject({ mode: 'on', threshold: 0.9 });
	});

	it('sends no threshold when the screen is turned off', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['triage']),
		});
		await cueScreen('triage', { mode: 'off' });
		expect(sent[1]).toEqual({
			type: 'set_cue_subscription_injection_screen',
			subscriptionId: 'a1::p::triage',
			mode: 'off',
		});
		// Nothing will be screened, so readiness is not asked.
		expect(sent).toHaveLength(2);
		expect(printed()).toEqual(['Injection screen on triage (One): off (never screened)']);
	});

	it('warns when the screen was written but no classifier will run it', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['on-pr']),
			local_models_task_readiness: off,
		});
		await cueScreen('on-pr', { mode: 'on' });
		expect(printed()[2]).toBe(
			'Note: Prompt-injection screen is off. Assign it a classifier model in Settings > Local Models. Until it can run, a screened command is blocked and a screened prompt starts unscreened with a warning.'
		);
	});

	it('prints JSON for a write, without a readiness round trip', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: written(['on-pr']),
		});
		await cueScreen('on-pr', { mode: 'on', threshold: '0.5', json: true });
		expect(sent).toHaveLength(2);
		expect(JSON.parse(printed()[0])).toEqual({
			success: true,
			subscriptionId: 'a1::p::on-pr',
			updated: ['on-pr'],
			mode: 'on',
			threshold: 0.5,
		});
	});

	it('refuses bad flags before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueScreen('on-pr', { mode: 'sometimes' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { threshold: '0' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { threshold: 'high' })).rejects.toThrow('__exit__');
		await expect(cueScreen('on-pr', { mode: 'off', threshold: '0.5' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});

	it('refuses a threshold on a screen that is off, instead of writing one that does nothing', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: {
				subscriptions: [{ ...screened[3], screenInjection: false, injectionThreshold: undefined }],
			},
		});
		await expect(cueScreen('triage', { threshold: '0.5' })).rejects.toThrow('__exit__');
		expect(sent.map((frame) => frame.type)).toEqual(['get_cue_subscriptions']);
		expect(String(errorSpy.mock.calls[0][0])).toContain('has its screen off');
	});

	it('exits non-zero when the engine refuses the write or the bridge answers with an error', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: {
				type: 'set_cue_subscription_injection_screen_result',
				success: false,
				error: 'Could not write the screen.',
			},
		});
		await expect(cueScreen('on-pr', { mode: 'on' })).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('Could not write the screen.');

		mockBridge({
			get_cue_subscriptions: { subscriptions: screened },
			set_cue_subscription_injection_screen: {
				type: 'error',
				message: 'Cue injection screen editing is not available',
			},
		});
		await expect(cueScreen('on-pr', { mode: 'off' })).rejects.toThrow('__exit__');
	});
});
