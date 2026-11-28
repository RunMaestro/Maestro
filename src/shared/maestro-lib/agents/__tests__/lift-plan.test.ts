/**
 * The lift plan: the record-only refusals, the remote working directory, and the `import_agent`
 * payload with the summary a person reads before anything moves.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { SshRemoteConfig } from '../../../types';
import { setMaestroLibImageRefResolver } from '../../host';
import type { AgentRecord } from '../../store/records';
import { liftRefusal, liftRemoteCwd, liftSshRemoteId, planAgentLift } from '../lift-plan';
import { formatLiftPlan } from '../lift-run';

const remote = { id: 'remote-1', name: 'build-box', federation: true } as SshRemoteConfig;

function sshAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'agent-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/Users/me/placeholder',
		state: 'idle',
		sessionSshRemoteConfig: {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/home/me/docs',
		},
		activeTabId: 'tab-2',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Main',
				agentSessionId: 'sess-1',
				starred: true,
				showThinking: 'on',
				customModel: 'opus',
				logs: [
					{ id: 'l1', timestamp: 1, source: 'user', text: 'hi' },
					{ id: 'l2', timestamp: 2, source: 'ai', text: 'hello' },
					{ bad: true },
				],
			},
			{ id: 'tab-2', name: null, agentSessionId: null, logs: [] },
			{ id: 'tab-hidden', hidden: true, logs: [] },
		],
		...overrides,
	};
}

describe('liftSshRemoteId / liftRemoteCwd', () => {
	it('reads the SSH remote and the override as the working directory', () => {
		const agent = sshAgent();
		expect(liftSshRemoteId(agent)).toBe('remote-1');
		expect(liftRemoteCwd(agent)).toBe('/home/me/docs');
	});

	it('falls back to cwd without an override', () => {
		const agent = sshAgent({
			cwd: '/home/me/repo',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		expect(liftRemoteCwd(agent)).toBe('/home/me/repo');
	});

	it('is undefined for a disabled or absent SSH config', () => {
		expect(
			liftSshRemoteId(sshAgent({ sessionSshRemoteConfig: { enabled: false, remoteId: 'r' } }))
		).toBeUndefined();
		expect(liftSshRemoteId(sshAgent({ sessionSshRemoteConfig: undefined }))).toBeUndefined();
	});
});

describe('liftRefusal', () => {
	it('is null for a liftable SSH agent', () => {
		expect(liftRefusal(sshAgent(), [remote])).toBeNull();
	});

	it('refuses an agent that was already lifted, naming its target', () => {
		const refusal = liftRefusal(
			sshAgent({ liftedTo: { peer: 'build-box', agentId: 'host-9', at: 1 } }),
			[remote]
		);
		expect(refusal?.code).toBe('already-lifted');
		expect(refusal?.message).toContain('build-box:host-9');
	});

	it('refuses a local agent', () => {
		expect(liftRefusal(sshAgent({ sessionSshRemoteConfig: undefined }), [remote])?.code).toBe(
			'not-ssh'
		);
	});

	it('refuses an agent whose remote is gone', () => {
		expect(liftRefusal(sshAgent(), [])?.code).toBe('remote-missing');
	});

	it('refuses while a tab, a hidden one included, is busy', () => {
		const agent = sshAgent();
		agent.aiTabs = [...(agent.aiTabs ?? []), { id: 'tab-x', hidden: true, state: 'busy' }];
		expect(liftRefusal(agent, [remote])?.code).toBe('busy');
	});

	it('refuses an agent with no visible tab', () => {
		expect(liftRefusal(sshAgent({ aiTabs: [{ id: 'h', hidden: true }] }), [remote])?.code).toBe(
			'no-tabs'
		);
	});
});

describe('planAgentLift', () => {
	it('builds the import payload from the remote cwd, tabs and settings', () => {
		const plan = planAgentLift({
			agent: sshAgent({ customModel: 'opus', customEffort: 'high', customArgs: '--verbose' }),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(plan.input.agent).toMatchObject({
			name: 'Docs',
			provider: 'claude-code',
			cwd: '/home/me/docs',
			model: 'opus',
			effort: 'high',
			customArgs: '--verbose',
		});
		expect(plan.input.agent).not.toHaveProperty('ssh');
		expect(plan.input.activeTabId).toBe('tab-2');
		expect(plan.input.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		const [first] = plan.input.tabs;
		expect(first).toMatchObject({
			name: 'Main',
			agentSessionId: 'sess-1',
			starred: true,
			showThinking: 'on',
			model: 'opus',
		});
		// The malformed transcript entry is skipped.
		expect(first.logs.map((entry) => entry.id)).toEqual(['l1', 'l2']);
		expect(plan.summary.tabs).toEqual([
			{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', entries: 2 },
			{ id: 'tab-2', name: null, agentSessionId: null, entries: 0 },
		]);
		expect(plan.summary.stays).toContainEqual(
			expect.objectContaining({ kind: 'hidden-tab', ref: 'tab-hidden' })
		);
	});

	it('withholds secrets unless asked and always sends the session-dir selector', () => {
		const agent = sshAgent({
			customEnvVars: {
				FOO: 'bar',
				ANTHROPIC_API_KEY: 'sk-secret',
				CLAUDE_CONFIG_DIR: '~/.claude-work',
			},
		});
		const plan = planAgentLift({ agent, remote, peer: 'build-box', withEnv: false });
		expect(plan.input.agent.env).toEqual({ FOO: 'bar', CLAUDE_CONFIG_DIR: '~/.claude-work' });
		expect(plan.summary.env.withheld).toEqual(['ANTHROPIC_API_KEY']);
		expect(plan.summary.env.sessionDir).toEqual({
			key: 'CLAUDE_CONFIG_DIR',
			value: '~/.claude-work',
		});
		expect(plan.summary.stays).toContainEqual(
			expect.objectContaining({ kind: 'secret-env', ref: 'ANTHROPIC_API_KEY' })
		);
		// The summary carries keys, never values.
		expect(JSON.stringify(plan.summary)).not.toContain('sk-secret');

		const withEnv = planAgentLift({ agent, remote, peer: 'build-box', withEnv: true });
		expect(withEnv.input.agent.env?.ANTHROPIC_API_KEY).toBe('sk-secret');
		expect(withEnv.summary.env.secretsSent).toEqual(['ANTHROPIC_API_KEY']);
	});

	it('inherits the provider-level env when the agent has none of its own', () => {
		const plan = planAgentLift({
			agent: sshAgent({ customEnvVars: undefined }),
			remote,
			peer: 'build-box',
			providerEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-b' },
			withEnv: false,
		});
		expect(plan.input.agent.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-b' });
	});

	it('moves queued messages for moving tabs and keeps commands and image refs here', () => {
		const plan = planAgentLift({
			agent: sshAgent({
				executionQueue: [
					{
						id: 'q1',
						tabId: 'tab-1',
						type: 'message',
						text: 'next',
						images: ['data:image/png;base64,AA', 'maestro-image://store/x'],
					},
					{ id: 'q2', tabId: 'tab-1', type: 'command', command: '/commit' },
					{ id: 'q3', tabId: 'tab-hidden', type: 'message', text: 'consult' },
				],
			}),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(plan.input.queue).toEqual([
			{ tabId: 'tab-1', text: 'next', images: ['data:image/png;base64,AA'] },
		]);
		expect(plan.movedQueueItemIds).toEqual(['q1']);
		expect(plan.summary.queued).toEqual(['q1']);
		const kinds = plan.summary.stays.map((stay) => `${stay.kind}:${stay.ref}`);
		expect(kinds).toEqual(
			expect.arrayContaining(['queued-image:q1', 'queued-command:q2', 'queued-command:q3'])
		);
	});

	// Parity R50: a message the person held moves held, so the host does not run it.
	it('moves a held queued message held, and a ready one ready (R50)', () => {
		const plan = planAgentLift({
			agent: sshAgent({
				executionQueue: [
					{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'ready' },
					{ id: 'q2', tabId: 'tab-1', type: 'message', text: 'held', paused: true },
				],
			}),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(plan.input.queue).toEqual([
			{ tabId: 'tab-1', text: 'ready' },
			{ tabId: 'tab-1', text: 'held', held: true },
		]);
	});

	// Parity R57: a host too old to keep a moved message held would run it at once: the held one
	// stays here, held, and the plan says so; the ready one moves.
	it('keeps a held message here when the host does not keep it held, and says so (R57)', () => {
		const plan = planAgentLift({
			agent: sshAgent({
				executionQueue: [
					{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'ready' },
					{ id: 'q2', tabId: 'tab-1', type: 'message', text: 'held', paused: true },
				],
			}),
			remote,
			peer: 'build-box',
			withEnv: false,
			hostKeepsHeld: false,
		});
		expect(plan.input.queue).toEqual([{ tabId: 'tab-1', text: 'ready' }]);
		expect(plan.movedQueueItemIds).toEqual(['q1']);
		expect(plan.summary.stays).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'queued-held', ref: 'q2', reason: expect.any(String) }),
			])
		);
		expect(formatLiftPlan(plan.summary, true)).toContain('Queue item q2: The host runs a moved');
	});

	// Parity R55: settings are codified at send. A queued message moves with the model, effort,
	// read-only and save to History choices it was queued with, so the host runs it on them.
	it('moves a queued message with the settings it was queued with (R55)', () => {
		const plan = planAgentLift({
			agent: sshAgent({
				executionQueue: [
					{
						id: 'q1',
						tabId: 'tab-1',
						type: 'message',
						text: 'frozen',
						turnSettings: { model: 'opus', effort: 'high' },
						readOnlyMode: true,
						turnSaveToHistory: false,
					},
					// The sender's own read-only choice decides over the item's flag.
					{
						id: 'q2',
						tabId: 'tab-1',
						type: 'message',
						text: 'writable',
						readOnlyMode: true,
						turnReadOnly: false,
					},
					{ id: 'q3', tabId: 'tab-1', type: 'message', text: 'no choice' },
					// Writable when queued is no choice: the host tab's read-only state decides, as a
					// local drain lets the tab lock it further (CodeRabbit on #2171).
					{ id: 'q5', tabId: 'tab-1', type: 'message', text: 'writable', readOnlyMode: false },
					// A malformed stored value is not sent.
					{
						id: 'q4',
						tabId: 'tab-1',
						type: 'message',
						text: 'bad',
						turnSettings: { model: 7 },
						turnSaveToHistory: 'yes',
					},
				],
			}),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(plan.input.queue).toEqual([
			{
				tabId: 'tab-1',
				text: 'frozen',
				overrides: { model: 'opus', effort: 'high', readOnly: true, saveToHistory: false },
			},
			{ tabId: 'tab-1', text: 'writable', overrides: { readOnly: false } },
			{ tabId: 'tab-1', text: 'no choice' },
			{ tabId: 'tab-1', text: 'writable' },
			{ tabId: 'tab-1', text: 'bad' },
		]);
	});

	describe('with an image store registered', () => {
		const STORED = 'maestro-image://store/abc.png';
		const STORED_DATA = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;

		afterEach(() => setMaestroLibImageRefResolver(() => null));

		function registerStore(): void {
			setMaestroLibImageRefResolver((ref) =>
				ref === STORED ? { buffer: Buffer.from('png-bytes'), mediaType: 'image/png' } : null
			);
		}

		it('moves a stored image on a queued message as its bytes', () => {
			registerStore();
			const plan = planAgentLift({
				agent: sshAgent({
					executionQueue: [
						{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'next', images: [STORED] },
					],
				}),
				remote,
				peer: 'build-box',
				withEnv: false,
			});
			expect(plan.input.queue).toEqual([{ tabId: 'tab-1', text: 'next', images: [STORED_DATA] }]);
			expect(plan.summary.stays.map((stay) => stay.kind)).not.toContain('queued-image');
		});

		it('moves transcript images as their bytes and drops a ref this machine cannot read', () => {
			registerStore();
			const plan = planAgentLift({
				agent: sshAgent({
					aiTabs: [
						{
							id: 'tab-1',
							name: 'Main',
							agentSessionId: 'sess-1',
							logs: [
								{
									id: 'l1',
									timestamp: 1,
									source: 'user',
									text: 'see',
									images: [STORED, 'data:image/png;base64,AA', 'maestro-image://store/gone.png'],
								},
								{ id: 'l2', timestamp: 2, source: 'ai', text: 'ok' },
							],
						},
					],
					activeTabId: 'tab-1',
				}),
				remote,
				peer: 'build-box',
				withEnv: false,
			});
			const logs = plan.input.tabs[0].logs;
			expect(logs[0].images).toEqual([STORED_DATA, 'data:image/png;base64,AA']);
			expect(logs[1]).not.toHaveProperty('images');
			// Parity R52: the plan the person confirms names the image that does not move, by tab.
			expect(plan.summary.stays).toEqual(
				expect.arrayContaining([
					{
						kind: 'transcript-image',
						ref: 'tab-1',
						count: 1,
						reason:
							'1 image(s) in the conversation "Main" (tab-1) could not be read from this machine\'s image store and do not move. They stay in this machine\'s copy.',
					},
				])
			);
			expect(formatLiftPlan(plan.summary, true)).toContain('Images of tab tab-1: 1 image(s)');
		});
	});

	it('keeps an Auto Run folder under the cwd and drops one outside it', () => {
		const inside = planAgentLift({
			agent: sshAgent({ autoRunFolderPath: '/home/me/docs/playbooks' }),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(inside.input.agent.autoRunFolderPath).toBe('/home/me/docs/playbooks');

		const outside = planAgentLift({
			agent: sshAgent({ autoRunFolderPath: '/Users/me/elsewhere' }),
			remote,
			peer: 'build-box',
			withEnv: false,
		});
		expect(outside.input.agent).not.toHaveProperty('autoRunFolderPath');
		expect(outside.summary.stays).toContainEqual(
			expect.objectContaining({ kind: 'auto-run-folder' })
		);
	});
});
