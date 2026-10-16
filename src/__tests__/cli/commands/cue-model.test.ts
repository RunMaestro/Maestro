/**
 * @file cue-model.test.ts
 * @description Tests for `maestro-cli cue model` - reading and changing the
 * model tier, exact model, and effort of one Cue subscription. Runs against a
 * real temp project root so the cue.yaml round-trip is asserted on disk; only
 * the agent lookup is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

const mockReadSessions = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => mockReadSessions(),
	// Exact id or exact name is all these tests need from the real resolver.
	resolveAgentId: (input: string) => {
		const sessions = mockReadSessions() as Array<{ id: string; name: string }>;
		const hit = sessions.find((s) => s.id === input || s.name === input);
		if (!hit) throw new Error(`Agent not found: ${input}`);
		return hit.id;
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { cueModel } from '../../../cli/commands/cue-model';

function session(overrides: Record<string, unknown> = {}) {
	return {
		id: 'agent-alpha',
		name: 'Alpha',
		toolType: 'claude-code',
		projectRoot: '/projects/alpha',
		cwd: '/projects/alpha',
		...overrides,
	};
}

function writeCueYaml(projectRoot: string, subscriptions: Record<string, unknown>[]): void {
	fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), yaml.dump({ subscriptions }));
}

function readSub(projectRoot: string, name: string): Record<string, unknown> {
	const raw = fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8');
	const parsed = yaml.load(raw) as { subscriptions: Record<string, unknown>[] };
	return parsed.subscriptions.find((sub) => sub.name === name)!;
}

const review = {
	name: 'review',
	event: 'github.pull_request',
	enabled: true,
	prompt: 'Review {{CUE_GH_URL}}',
	agent_id: 'agent-alpha',
};

describe('cue model', () => {
	let projectRoot = '';
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	/** The single JSON object the command printed. */
	function jsonOutput(): Record<string, unknown> {
		return JSON.parse(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0] as string);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-model-'));
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// The real exit never returns; throwing reproduces that for the code under test.
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);
		mockReadSessions.mockReturnValue([session({ projectRoot })]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('sets a tier and effort on a non-scheduled subscription and reports what it resolves to', async () => {
		writeCueYaml(projectRoot, [review]);

		await cueModel('review', { tier: 'high', effort: 'low', json: true });

		expect(readSub(projectRoot, 'review')).toMatchObject({ tier: 'high', effort: 'low' });
		expect(jsonOutput()).toMatchObject({
			ok: true,
			name: 'review',
			agent_id: 'agent-alpha',
			changed: true,
			tier: 'high',
			model: '',
			effort: 'low',
			resolved_model: 'opus',
			resolved_effort: 'low',
			warnings: [],
		});
	});

	it('reads the current choice and writes nothing when no setting flag is passed', async () => {
		writeCueYaml(projectRoot, [{ ...review, model: 'claude-opus-4-7' }]);
		const before = fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8');

		await cueModel('review', { json: true });

		expect(jsonOutput()).toMatchObject({
			changed: false,
			tier: '',
			model: 'claude-opus-4-7',
			resolved_model: 'claude-opus-4-7',
		});
		expect(fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8')).toBe(before);
	});

	it('--tier replaces a pinned model; --clear-model and --clear-effort fall back to the agent', async () => {
		writeCueYaml(projectRoot, [{ ...review, model: 'claude-opus-4-7', effort: 'high' }]);

		await cueModel('review', { tier: 'low', json: true });
		expect(readSub(projectRoot, 'review')).toMatchObject({ tier: 'low', effort: 'high' });
		expect(readSub(projectRoot, 'review')).not.toHaveProperty('model');

		await cueModel('review', { clearModel: true, clearEffort: true, json: true });
		expect(readSub(projectRoot, 'review')).toEqual(review);
		expect(jsonOutput()).toMatchObject({ changed: true, tier: '', model: '', effort: '' });
	});

	it('warns at write time when the provider cannot honor a tier', async () => {
		mockReadSessions.mockReturnValue([session({ projectRoot, toolType: 'codex' })]);
		writeCueYaml(projectRoot, [review]);

		await cueModel('review', { tier: 'high', json: true });

		const out = jsonOutput();
		expect(out.tier).toBe('high');
		expect(out.warnings).toHaveLength(1);
		expect((out.warnings as string[])[0]).toMatch(/codex has no model tier mapping/);
	});

	it('prints a human summary with the resolved model', async () => {
		writeCueYaml(projectRoot, [review]);

		await cueModel('review', { tier: 'high' });

		const lines = consoleSpy.mock.calls.map((call) => call[0] as string);
		expect(lines[0]).toBe("Set 'review' on agent Alpha: tier high");
		expect(lines[1]).toMatch(/runs as: model opus, effort provider default/);
	});

	it('rejects a typo, a tier with a model, and a clear with a set', async () => {
		writeCueYaml(projectRoot, [review]);

		await expect(cueModel('review', { tier: 'hgih', json: true })).rejects.toThrow(/exit/);
		expect(jsonOutput()).toMatchObject({ ok: false, code: 'BAD_TIER' });

		await expect(cueModel('review', { tier: 'high', model: 'opus', json: true })).rejects.toThrow(
			/exit/
		);
		expect(jsonOutput()).toMatchObject({ ok: false, code: 'TIER_AND_MODEL' });

		await expect(
			cueModel('review', { tier: 'high', clearModel: true, json: true })
		).rejects.toThrow(/exit/);
		expect(jsonOutput()).toMatchObject({ ok: false, code: 'CLEAR_AND_SET_MODEL' });

		expect(readSub(projectRoot, 'review')).toEqual(review);
		expect(processExitSpy).toHaveBeenCalledTimes(3);
	});

	it('refuses a command subscription', async () => {
		writeCueYaml(projectRoot, [
			review,
			{
				name: 'deploy',
				event: 'agent.completed',
				enabled: true,
				source_session: 'Alpha',
				source_sub: 'review',
				action: 'command',
				command: { mode: 'shell', shell: 'echo done' },
				agent_id: 'agent-alpha',
			},
		]);

		await expect(cueModel('deploy', { tier: 'high', json: true })).rejects.toThrow(/exit/);

		expect(jsonOutput()).toMatchObject({ ok: false, code: 'UPDATE_FAILED' });
		expect(readSub(projectRoot, 'deploy')).not.toHaveProperty('tier');
	});

	it('reports an unknown subscription', async () => {
		writeCueYaml(projectRoot, [review]);

		await expect(cueModel('ghost', { tier: 'high', json: true })).rejects.toThrow(/exit/);

		expect(jsonOutput()).toMatchObject({ ok: false, code: 'NOT_FOUND' });
	});

	it('needs --agent when two agents each have a subscription with that name', async () => {
		const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-model-b-'));
		try {
			mockReadSessions.mockReturnValue([
				session({ projectRoot }),
				session({ id: 'agent-bravo', name: 'Bravo', projectRoot: otherRoot }),
			]);
			writeCueYaml(projectRoot, [review]);
			writeCueYaml(otherRoot, [{ ...review, agent_id: 'agent-bravo' }]);

			await expect(cueModel('review', { tier: 'high', json: true })).rejects.toThrow(/exit/);
			expect(jsonOutput()).toMatchObject({ ok: false, code: 'AMBIGUOUS_NAME' });

			await cueModel('review', { tier: 'high', agent: 'Bravo', json: true });
			expect(readSub(otherRoot, 'review')).toMatchObject({ tier: 'high' });
			expect(readSub(projectRoot, 'review')).not.toHaveProperty('tier');
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	describe('--data-dir', () => {
		const priorDataDir = process.env.MAESTRO_USER_DATA;
		afterEach(() => {
			if (priorDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = priorDataDir;
		});

		it('reads the agent list from the given directory, over an inherited MAESTRO_USER_DATA', async () => {
			// A server's agent list, and through each agent's project root its
			// cue.yaml, comes from the data directory. The flag must be applied
			// before the first store read, or the edit lands in the wrong agent set.
			const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-model-data-'));
			try {
				process.env.MAESTRO_USER_DATA = path.join(os.tmpdir(), 'inherited-elsewhere');
				let seenDataDir: string | undefined;
				mockReadSessions.mockImplementation(() => {
					seenDataDir = process.env.MAESTRO_USER_DATA;
					return [session({ projectRoot })];
				});
				writeCueYaml(projectRoot, [review]);

				await cueModel('review', { tier: 'high', dataDir, json: true });

				expect(seenDataDir).toBe(path.resolve(dataDir));
				expect(readSub(projectRoot, 'review')).toMatchObject({ tier: 'high' });
			} finally {
				fs.rmSync(dataDir, { recursive: true, force: true });
			}
		});

		it('refuses a directory that does not exist and never creates it or reads agents', async () => {
			const missing = path.join(projectRoot, 'no-such-data-dir');
			writeCueYaml(projectRoot, [review]);

			await expect(
				cueModel('review', { tier: 'high', dataDir: missing, json: true })
			).rejects.toThrow('process.exit(1)');

			expect(jsonOutput()).toMatchObject({ success: false, code: 'DATA_DIR_NOT_FOUND' });
			expect(mockReadSessions).not.toHaveBeenCalled();
			expect(fs.existsSync(missing)).toBe(false);
			expect(readSub(projectRoot, 'review')).not.toHaveProperty('tier');
		});
	});
});
