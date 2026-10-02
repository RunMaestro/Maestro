import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import yaml from 'js-yaml';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan } from '../../../shared/pianola/pianola-tasks';

const { state, connect, sendCommand, disconnect } = vi.hoisted(() => ({
	state: { programs: [] as PianolaProgram[], asks: [] as PianolaAsk[], plans: [] as PianolaPlan[] },
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
	writePianolaAsks: (asks: PianolaAsk[]) => {
		state.asks = asks;
		return asks;
	},
	readPianolaPlans: () => state.plans,
	readPianolaDecisions: () => [],
	readPianolaSupervisorTargets: () => [],
	readPianolaProgramLoopMemo: () => ({}),
}));

import {
	pianolaProgramApply,
	updateGeneratedCueYaml,
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
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	connect.mockResolvedValue(undefined);
	sendCommand.mockResolvedValue({ success: true, sessionId: 'session-1' });
});

describe('portfolio CLI commands', () => {
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
		expect(sendCommand).toHaveBeenCalledTimes(1);
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
			expect(sendCommand.mock.calls[0][0].sessionSshRemoteConfig.remoteId).toBe('wsl-dev');
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
	it('replaces an empty inline subscriptions list with parseable generated entries', () => {
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
