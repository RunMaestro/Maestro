import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import yaml from 'js-yaml';
import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan } from '../../../shared/pianola/pianola-tasks';

const { state, connect, sendCommand, disconnect } = vi.hoisted(() => ({
	state: {
		programs: [] as PianolaProgram[],
		asks: [] as PianolaAsk[],
		plans: [] as PianolaPlan[],
		targets: [] as PianolaSupervisedTarget[],
	},
	connect: vi.fn(),
	sendCommand: vi.fn(),
	disconnect: vi.fn(),
}));
vi.mock('../../../cli/commands/pianola', () => ({ ensurePianolaEnabled: vi.fn() }));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connect;
		sendCommand = sendCommand;
		disconnect = disconnect;
	},
}));
vi.mock('../../../cli/services/agent-run-store', () => ({ readAgentRuns: vi.fn(() => []) }));
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(() => [{ id: 'wsl-dev', name: 'Dev Box' }]),
	getConfigDirectory: vi.fn(() => 'C:\\fake\\maestro-dev'),
}));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaPrograms: () => state.programs,
	upsertPianolaProgram: (program: PianolaProgram) => {
		state.programs = [...state.programs.filter((p) => p.id !== program.id), program];
		return state.programs;
	},
	readPianolaAsks: () => state.asks,
	updatePianolaAsks: (update: (asks: PianolaAsk[]) => PianolaAsk[]) => {
		state.asks = update(state.asks);
		return state.asks;
	},
	readPianolaPlans: () => state.plans,
	readPianolaDecisions: () => [],
	readPianolaSupervisorTargets: () => state.targets,
	writePianolaSupervisorTargets: (targets: PianolaSupervisedTarget[]) => {
		state.targets = targets;
		return targets;
	},
	readPianolaProgramLoopMemo: () => ({}),
}));

import {
	pianolaProgramApply,
	updateGeneratedCueYaml,
	pianolaProgramStatus,
	pianolaEscalate,
	pianolaResolve,
	pianolaDismiss,
	pianolaNeedsMe,
	pianolaBrief,
} from '../../../cli/commands/pianola-portfolio';

beforeEach(() => {
	state.programs = [];
	state.asks = [];
	state.plans = [];
	state.targets = [];
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	connect.mockResolvedValue(undefined);
	sendCommand.mockImplementation(async (command) =>
		command.type === 'get_sessions' ? { sessions: [] } : { success: true, sessionId: 'session-1' }
	);
});

describe('portfolio CLI commands', () => {
	it('keeps old metadata after a partial apply and recovers created roles by live identity on retry', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-apply-retry-'));
		const file = path.join(dir, 'manifest.json');
		// Real directories: a successful apply writes `<root>/.maestro/cue.yaml`, and a
		// bare `/new` is rooted on every platform but only writable on Windows.
		const oldRoot = path.join(dir, 'old');
		const newRoot = path.join(dir, 'new');
		const original: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: oldRoot,
			roles: { lead: { name: 'Lead' }, engineer: { name: 'Engineer', agentId: 'eng' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		state.programs = [original];
		fs.writeFileSync(file, JSON.stringify({ programs: [{ ...original, root: newRoot }] }));
		const live: { id: string; name: string; cwd: string; toolType: string }[] = [];
		let failCwd = true;
		sendCommand.mockImplementation(async (command) => {
			if (command.type === 'get_sessions') return { sessions: live };
			if (command.type === 'create_session') {
				live.push({
					id: 'created-lead',
					name: command.name,
					cwd: command.cwd,
					toolType: command.toolType,
				});
				return { success: true, sessionId: 'created-lead' };
			}
			if (command.type === 'update_session_cwd' && command.sessionId === 'eng' && failCwd)
				return { success: false, error: 'Agent is busy' };
			return { success: true };
		});
		const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('exit');
		});
		try {
			await expect(pianolaProgramApply({ file, json: true })).rejects.toThrow('exit');
			expect(state.programs).toEqual([original]);
			failCwd = false;
			await pianolaProgramApply({ file, json: true });
			expect(
				sendCommand.mock.calls.filter(([command]) => command.type === 'create_session')
			).toHaveLength(1);
			expect(
				sendCommand.mock.calls.filter(
					([command]) => command.type === 'update_session_cwd' && command.sessionId === 'eng'
				)
			).toHaveLength(2);
			expect(state.programs[0]).toMatchObject({
				root: newRoot,
				leadAgentId: 'created-lead',
				roles: { lead: { agentId: 'created-lead' }, engineer: { agentId: 'eng' } },
			});
		} finally {
			exit.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it('migrates an existing role to the manifest remote without creating or deleting an agent', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-apply-ssh-'));
		const file = path.join(dir, 'manifest.json');
		const original: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: '/remote',
			remoteId: 'wsl-dev',
			leadAgentId: 'lead',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		state.programs = [original];
		fs.writeFileSync(file, JSON.stringify({ programs: [{ ...original, remoteId: 'new-remote' }] }));
		sendCommand.mockImplementation(async (command) =>
			command.type === 'get_sessions'
				? {
						sessions: [
							{
								id: 'lead',
								name: 'Lead',
								cwd: '/remote',
								toolType: 'omp',
								sessionSshRemoteConfig: { enabled: true, remoteId: 'wsl-dev' },
							},
						],
					}
				: { success: true }
		);
		try {
			await pianolaProgramApply({ file, json: true });
			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'update_session_ssh',
					sessionId: 'lead',
					sshPatch: { enabled: true, remoteId: 'new-remote', workingDirOverride: '/remote' },
				}),
				'update_session_ssh_result'
			);
			expect(
				sendCommand.mock.calls.some(
					([command]) => command.type === 'create_session' || command.type === 'delete_session'
				)
			).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		'templates: {base: &base {name: manual, event: time.heartbeat}}\nsubscriptions: [*base]\n',
		'subscriptions: [&manual {name: manual, event: time.heartbeat}]\ncopy: *manual\n',
	])('preserves aliases and their anchors when expanding inline subscriptions: %s', (raw) => {
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: 'C:\\product',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const updated = updateGeneratedCueYaml(raw, program);
		const parsed = yaml.load(updated) as {
			subscriptions: { name: string; event: string }[];
			copy?: unknown;
		};
		expect(parsed.subscriptions[0]).toEqual({ name: 'manual', event: 'time.heartbeat' });
		expect(parsed.subscriptions.map((sub) => sub.name)).toEqual(['manual', 'product-standup']);
		if (raw.includes('copy:')) expect(parsed.copy).toEqual(parsed.subscriptions[0]);
		expect(updateGeneratedCueYaml(updated, program)).toBe(updated);
	});
	it('does not replace marker text inside hand-written prompt scalars', () => {
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: 'C:\\product',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const prompt =
			'# generated by pianola program apply: begin\nKeep this text.\n# generated by pianola program apply: end\n';
		const raw =
			'subscriptions:\n  - name: manual\n    event: time.heartbeat\n    prompt: |\n' +
			prompt
				.split('\n')
				.filter(Boolean)
				.map((line) => '      ' + line + '\n')
				.join('');
		const updated = updateGeneratedCueYaml(raw, program);
		const parsed = yaml.load(updated) as { subscriptions: { name: string; prompt: string }[] };
		expect(parsed.subscriptions[0].prompt).toBe(prompt);
		expect(parsed.subscriptions.map((sub) => sub.name)).toEqual(['manual', 'product-standup']);
		expect(updateGeneratedCueYaml(updated, program)).toBe(updated);
	});
	it('persists both asks when independent agents escalate concurrently', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-concurrent-escalate-'));
		const entry = path.join(dir, 'portfolio.cjs');
		buildSync({
			entryPoints: [path.resolve(__dirname, '../../../cli/commands/pianola-portfolio.ts')],
			outfile: entry,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			external: ['electron'],
		});
		fs.writeFileSync(
			path.join(dir, 'maestro-settings.json'),
			JSON.stringify({ encoreFeatures: { pianola: true } })
		);
		fs.writeFileSync(path.join(dir, 'maestro-pianola-asks.json'), JSON.stringify({ asks: [] }));
		const workers = ['agent-one', 'agent-two'].map((agent) => {
			const script = [
				'const fs = require("fs");',
				'const escalate = require(' + JSON.stringify(entry) + ').pianolaEscalate;',
				'const read = fs.readFileSync;',
				'fs.readFileSync = function(file, ...args) { const result = read.call(this, file, ...args); if (String(file).endsWith("maestro-pianola-asks.json")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); return result; };',
				'console.log("ready");',
				'process.stdin.once("data", () => { escalate(' +
					JSON.stringify({ title: agent, detail: 'Needs approval', agent, json: true }) +
					'); process.stdin.destroy(); });',
			].join('\n');
			const child = spawn(process.execPath, ['-e', script], {
				env: { ...process.env, MAESTRO_USER_DATA: dir },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let errors = '';
			child.stderr.on('data', (chunk) => {
				errors += String(chunk);
			});
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.on('data', (chunk) => {
					if (String(chunk).includes('ready')) resolve();
				});
				child.once('error', reject);
				child.once('close', (code) => {
					if (code !== 0) reject(new Error(errors));
				});
			});
			const done = new Promise<void>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
			});
			return { child, ready, done };
		});
		try {
			const complete = Promise.all(workers.map((worker) => worker.done));
			await Promise.all(workers.map((worker) => worker.ready));
			for (const worker of workers) worker.child.stdin.end('go\n');
			await complete;
			const saved = JSON.parse(
				fs.readFileSync(path.join(dir, 'maestro-pianola-asks.json'), 'utf8')
			) as { asks: PianolaAsk[] };
			expect(saved.asks.map((ask) => ask.agentId).sort()).toEqual(['agent-one', 'agent-two']);
		} finally {
			for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
	it('pauses and resumes only the program plans and its lead watch', () => {
		state.programs = [
			{
				id: 'product',
				title: 'Product',
				root: 'C:\\product',
				leadAgentId: 'lead',
				roles: { lead: { name: 'Lead', agentId: 'lead' } },
				charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
				status: 'active',
				createdAt: 1,
				updatedAt: 1,
			},
		];
		state.plans = [{ id: 'plan', programId: 'product', title: 'Plan', createdAt: 1, tasks: [] }];
		state.targets = [
			{
				id: 'plan-target',
				kind: 'orchestrate',
				planId: 'plan',
				enabled: true,
				createdAt: 1,
				concurrency: 2,
			},
			{ id: 'watch', kind: 'watch', agentId: 'lead', tabId: 'tab', enabled: true, createdAt: 1 },
			{ id: 'unrelated', kind: 'orchestrate', planId: 'other', enabled: true, createdAt: 1 },
			{
				id: 'other-watch',
				kind: 'watch',
				agentId: 'other',
				tabId: 'other-tab',
				enabled: false,
				createdAt: 1,
			},
		];
		const original = state.targets;
		state.targets[0] = { ...state.targets[0], enabled: false };
		pianolaProgramStatus('product', 'paused', { json: true });
		expect(state.programs[0].status).toBe('paused');
		expect(state.targets).toEqual(original);
		pianolaProgramStatus('product', 'active', { json: true });
		expect(state.targets).toEqual(original);
	});
	it('applies a real-manifest-shaped YAML program once, with its role model and remote root', async () => {
		const file = path.resolve(__dirname, 'fixtures/maestro-programs.yaml');
		await pianolaProgramApply({ file, json: true });
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'create_session',
				toolType: 'omp',
				cwd: '/home/dev/ai-ventures',
				customModel: 'openai-codex/gpt-5.6-sol',
				sessionSshRemoteConfig: expect.objectContaining({ remoteId: 'wsl-dev' }),
			}),
			'create_session_result'
		);
		expect(state.programs[0].roles.lead.agentId).toBe('session-1');
		expect(state.programs[0].leadAgentId).toBe('session-1');
		const saved = state.programs[0];
		await pianolaProgramApply({ file, json: true });
		expect(state.programs[0]).toEqual(saved);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});
	it('retries a role left unassigned by an interrupted apply', async () => {
		state.programs = [
			{
				id: 'ai-ventures',
				title: 'AI Ventures',
				root: '/home/dev/ai-ventures',
				remoteId: 'wsl-dev',
				roles: {
					lead: {
						name: 'AI Ventures Lead',
						agentType: 'omp',
						model: 'openai-codex/gpt-5.6-sol',
						instructions:
							'Project Lead for AI Ventures. Own the roadmap, hand off one bounded outcome at a time as a plan under this program, and direct engineer, qa, and marketing on it.',
					},
				},
				charter: { maxConcurrent: 2, maxAttempts: 3, validationRequired: true },
				status: 'active',
				createdAt: 1,
				updatedAt: 1,
			},
		];
		await pianolaProgramApply({
			file: path.resolve(__dirname, 'fixtures/maestro-programs.yaml'),
			json: true,
		});
		expect(state.programs[0].roles.lead.agentId).toBe('session-1');
	});
	it('resolves remote names to ids and updates existing role configuration and root', async () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, 'fixtures/maestro-programs.yaml'),
			'utf8'
		);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-apply-'));
		const file = path.join(dir, 'program.yaml');
		try {
			fs.writeFileSync(file, source.replace('remoteId: wsl-dev', 'remoteId: Dev Box'));
			await pianolaProgramApply({ file, json: true });
			expect(state.programs[0].remoteId).toBe('wsl-dev');
			expect(
				sendCommand.mock.calls.find(([command]) => command.type === 'create_session')![0]
					.sessionSshRemoteConfig.remoteId
			).toBe('wsl-dev');
			sendCommand.mockClear();
			fs.writeFileSync(
				file,
				source
					.replace('root: /home/dev/ai-ventures', 'root: /home/dev/new-root')
					.replace('model: openai-codex/gpt-5.6-sol', 'model: openai-codex/gpt-6-sol')
					.replace('Project Lead for AI Ventures.', 'Revised Project Lead.')
			);
			await pianolaProgramApply({ file, json: true });
			expect(sendCommand.mock.calls.map((call) => call[0].type)).toEqual([
				'update_session_config',
				'update_session_cwd',
			]);
			expect(sendCommand.mock.calls[0][0].configPatch).toEqual(
				expect.objectContaining({
					customModel: 'openai-codex/gpt-6-sol',
					newSessionMessage: expect.stringContaining('Revised Project Lead.'),
				})
			);
			expect(sendCommand.mock.calls[1][0].newCwd).toBe('/home/dev/new-root');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it('escalates with dedupe, resolves a decision, and keeps separate asks distinct', () => {
		pianolaEscalate({
			title: 'First',
			detail: 'Need answer',
			agent: 'agent-1',
			severity: 'high',
			json: true,
		});
		const id = state.asks[0].id;
		pianolaEscalate({
			title: 'Updated',
			detail: 'More detail',
			agent: 'agent-1',
			severity: 'low',
			json: true,
		});
		expect(state.asks).toHaveLength(1);
		expect(state.asks[0]).toMatchObject({ id, title: 'Updated', severity: 'high' });
		pianolaEscalate({
			title: 'Separate',
			detail: 'Other question',
			agent: 'agent-1',
			distinct: true,
			json: true,
		});
		expect(state.asks).toHaveLength(2);
		pianolaResolve(id, { option: 'Proceed', note: 'Approved', json: true });
		expect(state.asks[0]).toMatchObject({
			status: 'resolved',
			resolution: { option: 'Proceed', note: 'Approved' },
		});
		pianolaDismiss(state.asks[1].id, { json: true });
		expect(state.asks[1].status).toBe('dismissed');
	});
	it('returns the matching needs-me list and brief for a founder', () => {
		pianolaEscalate({ title: 'Approval', detail: 'Choose one', json: true });
		pianolaNeedsMe({ json: true });
		const needs = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
		expect(needs).toEqual([expect.objectContaining({ kind: 'ask', title: 'Approval' })]);
		pianolaBrief({ json: true });
		const brief = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
		expect(brief.needsMe).toEqual(needs);
		expect(brief.inFlight).toEqual([]);
		expect(brief.verified).toEqual([]);
	});
	it('writes product Cue routines and preserves hand-written subscriptions on re-apply', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-cue-'));
		const file = path.join(dir, 'manifest.json');
		const root = path.join(dir, 'product');
		const cue = path.join(root, '.maestro', 'cue.yaml');
		fs.mkdirSync(path.dirname(cue), { recursive: true });
		fs.writeFileSync(
			cue,
			'subscriptions:\n  - name: hand-written\n    event: time.heartbeat\n    interval_minutes: 30\n    prompt: Keep this.\nsettings:\n  max_concurrent: 2\n'
		);
		const program = {
			id: 'product',
			title: 'Product',
			root,
			roles: {
				lead: { name: 'Lead', agentId: 'lead' },
				engineer: { name: 'Engineer', agentId: 'eng' },
				marketing: { name: 'Marketing', agentId: 'market' },
			},
			charter: { maxConcurrent: 2, maxAttempts: 2, validationRequired: true },
		};
		fs.writeFileSync(file, JSON.stringify({ programs: [program] }));
		try {
			await pianolaProgramApply({ file, json: true });
			const first = fs.readFileSync(cue, 'utf8');
			expect(first).toContain('name: hand-written');
			const parsed = yaml.load(first) as { subscriptions: { name: string }[] };
			expect(parsed.subscriptions.map((sub) => sub.name)).toEqual([
				'hand-written',
				'product-standup',
				'product-marketing',
			]);
			expect(first).toContain('# Pipeline: Product standup (color: #06b6d4)');
			// Every generated pipeline owns its own trigger line; a dangling agent.completed chain is
			// flagged "needs attention" by the Pipeline List.
			expect(first).toContain('name: product-marketing');
			expect(first).not.toContain('agent.completed');
			await pianolaProgramApply({ file, json: true });
			expect(fs.readFileSync(cue, 'utf8')).toBe(first);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it('writes portfolio weekly reviews with three distinct recipients and times', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-weekly-'));
		const file = path.join(dir, 'manifest.json');
		const cue = path.join(dir, '.maestro', 'cue.yaml');
		const program = {
			id: 'portfolio',
			title: 'Portfolio',
			root: dir,
			roles: {
				cto: { name: 'CTO', agentId: 'cto' },
				cmo: { name: 'CMO', agentId: 'cmo' },
				social: { name: 'Social', agentId: 'social' },
			},
			charter: { maxConcurrent: 2, maxAttempts: 2, validationRequired: true },
		};
		fs.writeFileSync(file, JSON.stringify({ programs: [program] }));
		try {
			await pianolaProgramApply({ file, json: true });
			const output = fs.readFileSync(cue, 'utf8');
			expect(output).toContain('# Pipeline: Portfolio weekly (color: #f59e0b)');
			for (const [name, time] of [
				['cto', '10:00'],
				['cmo', '11:00'],
				['social', '14:00'],
			]) {
				expect(output).toContain('name: portfolio-weekly-' + name);
				expect(output).toContain("- '" + time + "'");
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		'subscriptions:\r\n  - name: manual\r\n    event: time.heartbeat\r\nsettings:\r\n  max_concurrent: 2\r\n',
		'subscriptions: &manual\n  - name: manual\n    event: time.heartbeat\nsettings:\n  max_concurrent: 2\n',
		'subscriptions: null\nsettings:\n  max_concurrent: 2\n',
		'"subscriptions": []\nsettings:\n  max_concurrent: 2\n',
		'subscriptions: []\nsettings:\n  max_concurrent: 2\n',
		'subscriptions: [{name: manual, event: time.heartbeat}]\nsettings:\n  max_concurrent: 2\n',
		'subscriptions:\n- name: manual\n  event: time.heartbeat\nsettings:\n  max_concurrent: 2\n',
	])('preserves subscriptions and list indentation in %s', (raw) => {
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: 'C:\\product',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const content = updateGeneratedCueYaml(raw, program);
		const parsed = yaml.load(content) as { subscriptions: { name: string }[]; settings: unknown };
		expect(parsed.subscriptions.map((sub) => sub.name)).toEqual(
			raw.includes('manual') ? ['manual', 'product-standup'] : ['product-standup']
		);
		expect(parsed.settings).toEqual({ max_concurrent: 2 });
		expect(updateGeneratedCueYaml(content, program)).toBe(content);
	});
	it.each(['subscriptions: not-an-array\n', 'subscriptions: []\nsettings: [invalid\n'])(
		'leaves invalid Cue unchanged and surfaces an apply warning: %s',
		async (raw) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-invalid-cue-'));
			const file = path.join(dir, 'manifest.json');
			const cue = path.join(dir, '.maestro', 'cue.yaml');
			fs.mkdirSync(path.dirname(cue));
			fs.writeFileSync(cue, raw);
			fs.writeFileSync(
				file,
				JSON.stringify({
					programs: [
						{
							id: 'product',
							title: 'Product',
							root: dir,
							roles: { lead: { name: 'Lead', agentId: 'lead' } },
							charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
						},
					],
				})
			);
			const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await pianolaProgramApply({ file, json: true });
				expect(fs.readFileSync(cue, 'utf8')).toBe(raw);
				expect(warning).toHaveBeenCalledWith(expect.stringContaining('Cue skipped for product:'));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);
	it('replaces an empty inline subscription list with parseable generated entries', () => {
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: 'C:/product',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const content = updateGeneratedCueYaml(
			'subscriptions: []\nsettings:\n  max_concurrent: 2\n',
			program
		);
		const parsed = yaml.load(content) as {
			subscriptions: { name: string }[];
			settings: { max_concurrent: number };
		};
		expect(parsed.subscriptions.map((sub) => sub.name)).toEqual(['product-standup']);
		expect(parsed.settings.max_concurrent).toBe(2);
	});
	it('removes stale generated subscriptions when their role is no longer assigned', () => {
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: 'C:/product',
			roles: { lead: { name: 'Lead', agentId: 'lead' } },
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const original = updateGeneratedCueYaml(
			'subscriptions: []\nsettings:\n  max_concurrent: 2\n',
			program
		);
		const updated = updateGeneratedCueYaml(original, { ...program, roles: {} });
		const parsed = yaml.load(updated) as {
			subscriptions: unknown[];
			settings: { max_concurrent: number };
		};
		expect(parsed.subscriptions).toEqual([]);
		expect(parsed.settings.max_concurrent).toBe(2);
	});
});
