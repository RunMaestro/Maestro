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
		const report = await checkCueReadiness(
			inputs({
				sessions: [agent({ id: 'idle', toolType: 'hermes', projectRoot: root })],
			})
		);
		expect(report).toMatchObject({ ready: true, agents: 0, workspaces: 0 });
	});
});
