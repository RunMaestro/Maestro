/**
 * The readiness check: every gap an unattended engine would hit, reported at
 * once, by name and path only.
 *
 * Workspaces, cue.yaml files and secret files are real (temp dirs); the binary
 * and tool probes are injected so the result does not depend on what this
 * machine has installed. The real `planSessionTurn` is still exercised for the
 * provider-support checks it owns (no parser, unknown provider).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	checkCueReadiness,
	formatCueReadiness,
	type CueReadinessInputs,
} from '../../../main/cue/cue-readiness';
import { planSessionTurn } from '../../../shared/maestro-lib/run/session';
import type { SessionInfo } from '../../../shared/types';

const SENTINEL = 'sentinel-ready-4b7e-do-not-leak';

let tmp: string;
let runSecrets: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-readiness-')));
	runSecrets = path.join(tmp, 'run-secrets');
	fs.mkdirSync(runSecrets);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function workspace(name: string, yaml?: string): string {
	const root = path.join(tmp, name);
	fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
	if (yaml !== undefined) fs.writeFileSync(path.join(root, '.maestro', 'cue.yaml'), yaml);
	return root;
}

const beat = (name: string, extra = '') =>
	`subscriptions:\n  - name: ${name}\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: hi\n${extra}`;

function agent(overrides: Partial<SessionInfo> & { id: string; projectRoot: string }): SessionInfo {
	return {
		name: overrides.id,
		toolType: 'codex',
		cwd: overrides.projectRoot,
		...overrides,
	} as SessionInfo;
}

/** Binaries "exist" unless a test says otherwise; tools likewise. */
function inputs(overrides: Partial<CueReadinessInputs>): CueReadinessInputs {
	return {
		sessions: [],
		agentConfigs: {},
		sshRemotes: [],
		secretLookup: { env: {}, runSecretsDir: runSecrets },
		now: () => new Date('2026-10-06T12:00:00Z'),
		...overrides,
		probes: {
			// The real planner, minus the PATH probe: any provider binary is found.
			planSessionTurn: (request) =>
				planSessionTurn({ ...request, command: request.command ?? process.execPath }),
			isGhInstalled: async () => true,
			binaryExists: async () => true,
			...overrides.probes,
		},
	};
}

describe('checkCueReadiness', () => {
	it('reports ready for a healthy data dir', async () => {
		const root = workspace('ok', beat('ok-beat'));
		fs.writeFileSync(path.join(runSecrets, 'OK_TOKEN'), 'tok\n');
		const report = await checkCueReadiness(
			inputs({ sessions: [agent({ id: 'ok', projectRoot: root, requiredSecrets: ['OK_TOKEN'] })] })
		);
		expect(report).toEqual({
			ready: true,
			checkedAt: '2026-10-06T12:00:00.000Z',
			agents: 1,
			workspaces: 1,
			subscriptions: 1,
			gaps: [],
		});
		expect(formatCueReadiness(report)[0]).toMatch(/^Ready:/);
	});

	it('reports every gap kind at once', async () => {
		const coder = workspace(
			'coder',
			[
				'subscriptions:',
				'  - name: pr-review',
				'    event: github.pull_request',
				'    prompt: review',
				'  - name: deploy-hook',
				'    event: webhook.received',
				'    prompt: deploy',
				'    webhook:',
				'      secret_env: HOOK_SECRET',
				'  - name: fan',
				'    event: time.heartbeat',
				'    interval_minutes: 60',
				'    prompt: hi',
				'    fan_out: [Nobody]',
				'  - name: pinned',
				'    event: time.heartbeat',
				'    interval_minutes: 60',
				'    prompt: hi',
				'    agent_id: gone',
				'',
			].join('\n')
		);
		const herald = workspace('herald', beat('herald-beat'));
		const ghost = workspace('ghost', beat('ghost-beat'));
		const broken = workspace('broken', 'subscriptions: [\n');
		const promptless = workspace(
			'promptless',
			'subscriptions:\n  - name: needs-file\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt_file: .maestro/prompts/missing.md\n'
		);
		const remote = workspace('remote', beat('remote-beat'));

		const report = await checkCueReadiness(
			inputs({
				sessions: [
					agent({
						id: 'coder',
						name: 'Coder',
						toolType: 'claude-code',
						projectRoot: coder,
						requiredSecrets: ['DEPLOY_TOKEN'],
					}),
					agent({ id: 'herald', name: 'Herald', toolType: 'hermes', projectRoot: herald }),
					agent({
						id: 'ghost',
						name: 'Ghost',
						projectRoot: ghost,
						cwd: path.join(ghost, 'not-checked-out'),
					}),
					agent({ id: 'broken', projectRoot: broken }),
					agent({ id: 'promptless', projectRoot: promptless }),
					agent({
						id: 'remote',
						name: 'Remote',
						projectRoot: remote,
						sessionSshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
					}),
				],
				agentConfigs: { 'claude-code': { customPath: path.join(tmp, 'missing', 'claude') } },
				probes: {
					planSessionTurn: (request) =>
						planSessionTurn({ ...request, command: request.command ?? process.execPath }),
					isGhInstalled: async () => false,
					binaryExists: async () => false,
				},
			})
		);

		expect(report.ready).toBe(false);
		const kinds = report.gaps.map(
			(g) => `${g.kind}:${g.agentName ?? g.subscription ?? g.workspace}`
		);
		expect(kinds.sort()).toEqual(
			[
				`binary-missing:Coder`,
				`cue-config:${broken}`,
				`cue-config:${promptless}`,
				`not-a-git-checkout:pr-review`,
				`secret-missing:Coder`,
				`secret-missing:deploy-hook`,
				`ssh-remote:Remote`,
				`tool-missing:pr-review`,
				`tool-missing:pr-review`,
				`unknown-agent:fan`,
				`unknown-agent:pinned`,
				`unsupported-provider:Herald`,
				`workspace-missing:Ghost`,
			].sort()
		);
		expect(report.gaps.filter((g) => g.kind === 'tool-missing').map((g) => g.tool)).toEqual([
			'gh',
			'git',
		]);
		const lines = formatCueReadiness(report);
		expect(lines[0]).toBe(
			`Not ready: ${report.gaps.length} gap(s) across 5 agent(s), 6 workspace(s), 8 subscription(s).`
		);
		expect(lines).toHaveLength(report.gaps.length + 1);
	});

	it('checks a tool only when something needs it', async () => {
		const root = workspace('plain', beat('plain-beat'));
		let ghProbed = false;
		let gitProbed = false;
		await checkCueReadiness(
			inputs({
				sessions: [agent({ id: 'plain', projectRoot: root })],
				probes: {
					isGhInstalled: async () => ((ghProbed = true), false),
					binaryExists: async () => ((gitProbed = true), false),
				},
			})
		);
		expect(ghProbed).toBe(false);
		expect(gitProbed).toBe(false);
	});

	it('needs no git when a GitHub trigger names its repo', async () => {
		const root = workspace(
			'named',
			'subscriptions:\n  - name: prs\n    event: github.pull_request\n    repo: acme/web\n    prompt: review\n'
		);
		const report = await checkCueReadiness(
			inputs({
				sessions: [agent({ id: 'named', projectRoot: root })],
				probes: { binaryExists: async () => false },
			})
		);
		expect(report.gaps).toEqual([]);
	});

	it('accepts a GH_TOKEN secret file, and reports one that cannot be used', async () => {
		const yaml =
			'subscriptions:\n  - name: prs\n    event: github.pull_request\n    repo: acme/web\n    prompt: review\n';
		const root = workspace('gh-token', yaml);
		const run = () =>
			checkCueReadiness(inputs({ sessions: [agent({ id: 'gh-token', projectRoot: root })] }));

		fs.writeFileSync(path.join(runSecrets, 'GH_TOKEN'), `${SENTINEL}\n`);
		expect((await run()).gaps).toEqual([]);

		fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), '');
		const report = await run();
		expect(report.gaps).toEqual([
			{
				kind: 'secret-unusable',
				subscription: 'prs',
				secret: 'GITHUB_TOKEN',
				message: `GitHub trigger "prs" reads its token from GITHUB_TOKEN (${path.join(runSecrets, 'GITHUB_TOKEN')}) is empty.`,
			},
		]);
		expect(JSON.stringify(report)).not.toContain(SENTINEL);
	});

	it('names the token secret file as a remedy when gh is missing', async () => {
		const root = workspace(
			'no-gh',
			'subscriptions:\n  - name: prs\n    event: github.pull_request\n    repo: acme/web\n    prompt: review\n'
		);
		const report = await checkCueReadiness(
			inputs({
				sessions: [agent({ id: 'no-gh', projectRoot: root })],
				probes: { isGhInstalled: async () => false },
			})
		);
		expect(report.gaps.map((g) => g.message)).toEqual([
			expect.stringContaining('$CREDENTIALS_DIRECTORY/GH_TOKEN, /run/secrets/GH_TOKEN'),
		]);
	});

	it('reports an unusable secret file and never a secret value', async () => {
		const root = workspace('secrets', beat('secrets-beat'));
		fs.writeFileSync(path.join(runSecrets, 'GOOD_TOKEN'), `${SENTINEL}\n`);
		fs.writeFileSync(path.join(runSecrets, 'EMPTY_TOKEN'), '');
		const report = await checkCueReadiness(
			inputs({
				sessions: [
					agent({
						id: 'secrets',
						name: 'Secrets',
						projectRoot: root,
						requiredSecrets: ['GOOD_TOKEN', 'EMPTY_TOKEN', 'MISSING_TOKEN'],
					}),
				],
				secretLookup: { env: { MISSING_TOKEN: '' }, runSecretsDir: runSecrets },
			})
		);
		expect(report.gaps.map((g) => [g.kind, g.secret])).toEqual([
			['secret-missing', 'MISSING_TOKEN'],
			['secret-unusable', 'EMPTY_TOKEN'],
		]);
		expect(JSON.stringify(report)).not.toContain(SENTINEL);
		expect(formatCueReadiness(report).join('\n')).not.toContain(SENTINEL);
	});

	it('does not ask for a provider binary from an agent that only runs commands', async () => {
		const root = workspace(
			'shell',
			'subscriptions:\n  - name: tidy\n    event: time.heartbeat\n    interval_minutes: 60\n    action: command\n    command:\n      mode: shell\n      shell: "echo hi"\n'
		);
		let planned = false;
		const report = await checkCueReadiness(
			inputs({
				sessions: [agent({ id: 'shell', toolType: 'hermes', projectRoot: root })],
				probes: {
					planSessionTurn: async () => {
						planned = true;
						return { ok: false, reason: 'not-installed', error: 'x' };
					},
				},
			})
		);
		expect(planned).toBe(false);
		expect(report.ready).toBe(true);
	});

	it('ignores agents with no Cue config, so unrelated desktop agents add no gaps', async () => {
		const root = workspace('no-config');
		const cue = workspace('cue', beat('beat'));
		const report = await checkCueReadiness(
			inputs({
				sessions: [
					agent({ id: 'idle', toolType: 'hermes', projectRoot: root }),
					agent({ id: 'runner', projectRoot: cue }),
				],
			})
		);
		expect(report).toMatchObject({ ready: true, agents: 1, workspaces: 1, gaps: [] });
	});

	describe('disabled subscriptions', () => {
		/** An enabled heartbeat beside `disabled`, so the data dir is otherwise ready. */
		const withHealthyBeat = (disabled: string) => `${beat('live')}${disabled}    enabled: false\n`;

		it('needs no gh or GitHub token for a disabled GitHub trigger', async () => {
			const root = workspace(
				'gh-off',
				withHealthyBeat('  - name: prs\n    event: github.pull_request\n    prompt: review\n')
			);
			fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), '');
			let toolProbed = false;
			const report = await checkCueReadiness(
				inputs({
					sessions: [agent({ id: 'gh-off', projectRoot: root })],
					probes: {
						isGhInstalled: async () => ((toolProbed = true), false),
						binaryExists: async () => ((toolProbed = true), false),
					},
				})
			);
			expect(toolProbed).toBe(false);
			expect(report).toMatchObject({ ready: true, subscriptions: 2, gaps: [] });
		});

		it('needs no webhook secret for a disabled webhook', async () => {
			const root = workspace(
				'hook-off',
				withHealthyBeat(
					'  - name: deploy-hook\n    event: webhook.received\n    prompt: deploy\n    webhook:\n      secret_env: HOOK_SECRET\n'
				)
			);
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'hook-off', projectRoot: root })] })
			);
			expect(report).toMatchObject({ ready: true, gaps: [] });
		});

		it('reports no unknown agent for a disabled fan-out or pin', async () => {
			const root = workspace(
				'fan-off',
				withHealthyBeat(
					'  - name: fan\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: hi\n    fan_out: [Nobody]\n'
				) +
					'  - name: pinned\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: hi\n    agent_id: gone\n    enabled: false\n'
			);
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'fan-off', projectRoot: root })] })
			);
			expect(report).toMatchObject({ ready: true, agents: 1, subscriptions: 3, gaps: [] });
		});

		it('needs no provider binary for an agent whose only prompt subscription is disabled', async () => {
			const root = workspace(
				'prompt-off',
				'subscriptions:\n  - name: tidy\n    event: time.heartbeat\n    interval_minutes: 60\n    action: command\n    command:\n      mode: shell\n      shell: "echo hi"\n' +
					'  - name: ask\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: hi\n    enabled: false\n'
			);
			let planned = false;
			const report = await checkCueReadiness(
				inputs({
					sessions: [agent({ id: 'prompt-off', toolType: 'hermes', projectRoot: root })],
					probes: {
						planSessionTurn: async () => {
							planned = true;
							return { ok: false, reason: 'not-installed', error: 'x' };
						},
					},
				})
			);
			expect(planned).toBe(false);
			expect(report.ready).toBe(true);
		});

		it('still reports a cue.yaml that does not parse', async () => {
			const root = workspace('broken-off', 'subscriptions: [\n');
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'broken-off', projectRoot: root })] })
			);
			expect(report.gaps.map((g) => g.kind)).toContain('cue-config');
		});
	});

	describe('owner of unpinned subscriptions', () => {
		const owned = (owner?: string, extra = '') =>
			`${owner ? `settings:\n  owner_agent_id: ${owner}\n` : ''}${beat('shared')}${extra}`;
		/** Each agent needs its own secret, none set, so a gap names exactly who was checked. */
		const pair = (root: string, overrides: Partial<SessionInfo>[] = []) =>
			['first', 'second'].map((id, i) =>
				agent({ id, name: id, projectRoot: root, requiredSecrets: [`${id}_KEY`], ...overrides[i] })
			);
		const checked = (gaps: { agentId?: string }[]) => [
			...new Set(gaps.flatMap((g) => (g.agentId ? [g.agentId] : []))),
		];

		it('checks only the first candidate when no owner_agent_id is set', async () => {
			const root = workspace('shared', owned());
			const report = await checkCueReadiness(
				inputs({ sessions: pair(root, [{}, { toolType: 'hermes' }]) })
			);
			expect(checked(report.gaps)).toEqual(['first']);
			expect(report.agents).toBe(1);
		});

		it('checks only the agent owner_agent_id names, by id or by name', async () => {
			const byId = workspace('by-id', owned('second'));
			const byName = workspace('by-name', owned('Second'));
			const sessions = [
				...pair(byId),
				agent({ id: 'third', name: 'third', projectRoot: byName, requiredSecrets: ['third_KEY'] }),
				agent({
					id: 'fourth',
					name: 'Second',
					projectRoot: byName,
					requiredSecrets: ['fourth_KEY'],
				}),
			];
			const report = await checkCueReadiness(inputs({ sessions }));
			expect(checked(report.gaps).sort()).toEqual(['fourth', 'second']);
		});

		it('reports an owner_agent_id that matches nobody, and nothing to run', async () => {
			const root = workspace('no-owner', owned('nobody'));
			const report = await checkCueReadiness(inputs({ sessions: pair(root) }));
			expect(report.gaps).toEqual([
				{
					kind: 'cue-config',
					workspace: root,
					message: expect.stringMatching(
						new RegExp(
							`^Cue config in ${root.replace(/[\\.]/g, '\\$&')}: settings\\.owner_agent_id "nobody" does not match`
						)
					),
				},
				{ kind: 'nothing-to-run', message: expect.any(String) },
			]);
			expect(report.agents).toBe(0);
		});

		it('reports an owner_agent_id that is an ambiguous name', async () => {
			const root = workspace('twins', owned('Twin'));
			const report = await checkCueReadiness(
				inputs({ sessions: pair(root, [{ name: 'Twin' }, { name: 'Twin' }]) })
			);
			expect(report.gaps.map((g) => [g.kind, g.workspace])).toEqual([
				['cue-config', root],
				['nothing-to-run', undefined],
			]);
			expect(report.gaps[0].message).toContain('owner_agent_id "Twin" is ambiguous');
		});

		it('still runs pinned subscriptions when no agent owns the unpinned ones', async () => {
			const root = workspace(
				'pinned-only',
				owned('nobody', beat('mine', '    agent_id: second\n').replace('subscriptions:\n', ''))
			);
			const report = await checkCueReadiness(inputs({ sessions: pair(root) }));
			expect(report.gaps.map((g) => g.kind)).toEqual(['cue-config', 'secret-missing']);
			expect(checked(report.gaps)).toEqual(['second']);
		});

		it('never makes a terminal or config-less agent listed first the owner', async () => {
			const root = workspace('real', beat('real-beat'));
			const bare = workspace('bare');
			const report = await checkCueReadiness(
				inputs({
					sessions: [
						agent({ id: 'elsewhere', projectRoot: bare, toolType: 'hermes' }),
						agent({ id: 'shell', projectRoot: root, toolType: 'terminal' }),
						agent({ id: 'real', projectRoot: root, requiredSecrets: ['REAL_KEY'] }),
					],
				})
			);
			expect(checked(report.gaps)).toEqual(['real']);
			expect(report.agents).toBe(1);
		});

		it('sends a pinned subscription only to its agent, even past the owner', async () => {
			const root = workspace(
				'pin',
				owned('first', beat('mine', '    agent_id: second\n').replace('subscriptions:\n', ''))
			);
			const report = await checkCueReadiness(inputs({ sessions: pair(root) }));
			expect(checked(report.gaps).sort()).toEqual(['first', 'second']);
		});

		it('reports a subscription pinned to an agent in another workspace', async () => {
			const here = workspace(
				'here',
				beat('local') + beat('stray', '    agent_id: there\n').replace('subscriptions:\n', '')
			);
			const there = workspace('there');
			const report = await checkCueReadiness(
				inputs({
					sessions: [
						agent({ id: 'here', projectRoot: here }),
						agent({ id: 'there', name: 'There', projectRoot: there }),
					],
				})
			);
			expect(report.gaps).toEqual([
				{
					kind: 'unknown-agent',
					subscription: 'stray',
					workspace: here,
					message: expect.stringContaining(`agent "There" (there), whose workspace is ${there}`),
				},
			]);
		});
	});

	describe('nothing to run', () => {
		it('is not ready for a data dir with no agents (nothing imported)', async () => {
			const report = await checkCueReadiness(inputs({ sessions: [] }));
			expect(report.ready).toBe(false);
			expect(report.gaps).toEqual([
				{ kind: 'nothing-to-run', message: expect.stringContaining('has no agents') },
			]);
			expect(formatCueReadiness(report)[1]).toMatch(/\[nothing-to-run\].*bundle import/);
		});

		it('is not ready when agents exist but no subscription runs on any of them', async () => {
			const root = workspace('no-config');
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'idle', projectRoot: root })] })
			);
			expect(report.gaps).toEqual([
				{
					kind: 'nothing-to-run',
					message: expect.stringContaining('1 agent(s) but no enabled Cue subscription'),
				},
			]);
		});

		it('counts a disabled subscription as nothing to run', async () => {
			const root = workspace('off', beat('off', '    enabled: false\n'));
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'a', projectRoot: root })] })
			);
			expect(report.ready).toBe(false);
			expect(report.gaps.map((g) => g.kind)).toEqual(['nothing-to-run']);
		});

		it('counts no subscription pinned to an agent that is missing', async () => {
			const root = workspace('pinned', beat('orphan', '    agent_id: gone\n'));
			const report = await checkCueReadiness(
				inputs({ sessions: [agent({ id: 'a', projectRoot: root })] })
			);
			expect(report.gaps.map((g) => g.kind).sort()).toEqual(['nothing-to-run', 'unknown-agent']);
		});
	});
});
