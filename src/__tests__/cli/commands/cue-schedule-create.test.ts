/**
 * @file cue-schedule-create.test.ts
 * @description Integration tests for `maestro-cli cue schedule` - the create
 * branch (Phase 03 task 1 of the time.once feature). The list/cancel branches
 * are covered in `cue-schedule-list-cancel.test.ts`; this file exercises the
 * end-to-end write path with a real temp directory so the YAML round-trip
 * (mkdir + dump + reload) is asserted on disk, not against a mocked writer.
 *
 * Only the agent lookup (`readSessions`) is mocked - every other dependency
 * (`appendSubscriptionsToYaml`, `loadCueConfigDetailed`,
 * `removeSubscriptionFromYaml`) runs unmodified against the temp project root.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Mocks must be set up before importing the module under test.
const mockReadSessions = vi.fn();
const mockResolveStoredAiTabId = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => mockReadSessions(),
	resolveStoredAiTabId: (agentId: string, tabId: string) =>
		mockResolveStoredAiTabId(agentId, tabId),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { cueSchedule } from '../../../cli/commands/cue-schedule';

type Session = {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
	cwd: string;
};

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-aaaaaaaa-1111',
		name: 'Alpha',
		toolType: 'claude-code',
		projectRoot: '/projects/alpha',
		cwd: '/projects/alpha',
		...overrides,
	};
}

function readCueYaml(projectRoot: string): {
	raw: string;
	parsed: Record<string, unknown>;
} {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const raw = fs.readFileSync(filePath, 'utf-8');
	return { raw, parsed: yaml.load(raw) as Record<string, unknown> };
}

const AUTO_NAME_REGEX = /^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}$/;
// Phase 04 stamps fire_at via toISOString() which always emits a trailing `Z`.
// Accept either `Z` or a `±HH:MM` / `±HHMM` offset so the test stays valid if
// the implementation switches to keeping the user's local offset.
const TZ_SUFFIX_REGEX = /[+-]\d{2}:?\d{2}$|Z$/;

describe('cue schedule (create)', () => {
	let projectRoot = '';
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-create-'));
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('--in 5m --agent X --notify --message writes a single notify sub with default pipeline and auto-name', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);
		const before = Date.now();

		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'hi',
		});

		const after = Date.now();
		expect(processExitSpy).not.toHaveBeenCalled();

		const { parsed } = readCueYaml(projectRoot);
		const subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);

		const sub = subs[0];
		expect(sub.event).toBe('time.once');
		expect(sub.enabled).toBe(true);
		expect(sub.action).toBe('notify');
		expect(sub.agent_id).toBe('agent-alpha');
		expect(sub.pipeline_name).toBe('Tasks');
		expect((sub.notify as Record<string, unknown>).message).toBe('hi');
		// No -notify suffix when only one action is requested (single sub).
		expect(sub.name as string).toMatch(AUTO_NAME_REGEX);

		// fire_at should be ~5 minutes in the future (allowing for test latency).
		const fireMs = Date.parse(sub.fire_at as string);
		expect(Number.isFinite(fireMs)).toBe(true);
		expect(fireMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
		expect(fireMs).toBeLessThanOrEqual(after + 5 * 60_000 + 1000);
		expect(sub.fire_at as string).toMatch(TZ_SUFFIX_REGEX);
	});

	it('--in 1h --agent X --notify --prompt writes TWO subs sharing fire_at and pipeline_name', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await cueSchedule({
			in: '1h',
			agent: 'Alpha',
			notify: true,
			prompt: 'do X',
		});

		expect(processExitSpy).not.toHaveBeenCalled();

		const { parsed } = readCueYaml(projectRoot);
		const subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(2);

		const promptSub = subs.find((s) => s.action === 'prompt')!;
		const notifySub = subs.find((s) => s.action === 'notify')!;
		expect(promptSub).toBeDefined();
		expect(notifySub).toBeDefined();

		// Same fire_at and pipeline_name across both.
		expect(promptSub.fire_at).toBe(notifySub.fire_at);
		expect(promptSub.pipeline_name).toBe('Tasks');
		expect(notifySub.pipeline_name).toBe('Tasks');

		// Auto-name with -prompt / -notify suffix in dual mode.
		expect(promptSub.name as string).toMatch(/^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}-prompt$/);
		expect(notifySub.name as string).toMatch(/^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}-notify$/);
		// Base name (sans suffix) matches across the pair.
		const promptBase = (promptSub.name as string).replace(/-prompt$/, '');
		const notifyBase = (notifySub.name as string).replace(/-notify$/, '');
		expect(promptBase).toBe(notifyBase);

		expect(promptSub.prompt).toBe('do X');
		expect((notifySub.notify as Record<string, unknown>).message).toBe('do X');
	});

	it('--list returns rows for every pending task across multiple agents', async () => {
		const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-create-beta-'));
		try {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
				session({
					id: 'agent-beta',
					name: 'Beta',
					projectRoot: otherRoot,
					cwd: otherRoot,
				}),
			]);

			await cueSchedule({
				in: '5m',
				agent: 'Alpha',
				notify: true,
				message: 'first',
			});
			await cueSchedule({
				in: '1h',
				agent: 'Beta',
				prompt: 'second',
			});

			expect(processExitSpy).not.toHaveBeenCalled();
			consoleSpy.mockClear();

			await cueSchedule({ list: true, json: true });

			expect(processExitSpy).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const rows = JSON.parse(consoleSpy.mock.calls[0][0] as string) as Array<
				Record<string, unknown>
			>;
			expect(rows).toHaveLength(2);
			// Sort order is ascending by fire_at - the 5m task should come first.
			expect(rows[0].agent_id).toBe('agent-alpha');
			expect(rows[0].action).toBe('notify');
			expect(rows[1].agent_id).toBe('agent-beta');
			expect(rows[1].action).toBe('prompt');
		} finally {
			fs.rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it('--cancel removes the named sub and exits 0', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'doomed',
			name: 'my-task',
		});

		expect(processExitSpy).not.toHaveBeenCalled();
		let { parsed } = readCueYaml(projectRoot);
		let subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('my-task');

		consoleSpy.mockClear();
		await cueSchedule({ cancel: 'my-task' });
		expect(processExitSpy).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Cancelled task 'my-task' on agent Alpha.`)
		);

		({ parsed } = readCueYaml(projectRoot));
		subs = (parsed.subscriptions as Array<Record<string, unknown>>) ?? [];
		expect(subs).toHaveLength(0);
	});

	it('missing --agent exits 1 with a useful error', async () => {
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		mockReadSessions.mockReturnValue([]);

		await expect(cueSchedule({ in: '5m', notify: true, message: 'hi' })).rejects.toThrow(
			'process.exit'
		);

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--agent'));
		// No file should be written when validation fails before the write.
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
	});

	it('neither --prompt nor --notify exits 1 with a useful error', async () => {
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await expect(cueSchedule({ in: '5m', agent: 'Alpha' })).rejects.toThrow('process.exit');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		const errMsg = consoleErrorSpy.mock.calls[0]?.[0] as string;
		expect(errMsg).toMatch(/--prompt|--notify/);
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
	});

	it('rejects a create whose name already exists in cue.yaml (exit 1, file unchanged)', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		// First create succeeds.
		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'first',
			name: 'dup-task',
		});
		expect(processExitSpy).not.toHaveBeenCalled();
		expect((readCueYaml(projectRoot).parsed.subscriptions as unknown[]).length).toBe(1);

		// Second create reusing the name must fail loudly - otherwise a later
		// --cancel would delete both (removeSubscriptionFromYaml keys on name).
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		await expect(
			cueSchedule({ in: '10m', agent: 'Alpha', notify: true, message: 'second', name: 'dup-task' })
		).rejects.toThrow('process.exit');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
		// File still holds exactly the original sub.
		const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('dup-task');
	});

	it('--at "YYYY-MM-DD HH:MM" (naive local) converts to ISO-8601 with TZ marker', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		// Use a year safely in the future so the validator (if it ever rejects
		// past timestamps) stays happy. The exact local-vs-UTC conversion is
		// system-dependent - we only assert the resulting ISO string carries a
		// recognizable timezone suffix.
		await cueSchedule({
			at: '2099-12-15 14:30',
			agent: 'Alpha',
			notify: true,
			message: 'future',
		});

		expect(processExitSpy).not.toHaveBeenCalled();
		const { parsed } = readCueYaml(projectRoot);
		const sub = (parsed.subscriptions as Array<Record<string, unknown>>)[0];
		expect(sub.fire_at as string).toMatch(TZ_SUFFIX_REGEX);
	});

	describe('--tab / --here (deliver into an existing AI tab)', () => {
		const CALLER_ENV = ['MAESTRO_CALLER_AGENT_ID', 'MAESTRO_CALLER_TAB_ID'] as const;
		const savedEnv: Record<string, string | undefined> = {};

		beforeEach(() => {
			for (const key of CALLER_ENV) savedEnv[key] = process.env[key];
			for (const key of CALLER_ENV) delete process.env[key];
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
		});

		afterEach(() => {
			for (const key of CALLER_ENV) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
		});

		function onlySub(): Record<string, unknown> {
			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs).toHaveLength(1);
			return subs[0];
		}

		it('--tab resolves a prefix and writes a cli dispatch into that tab', async () => {
			mockResolveStoredAiTabId.mockReturnValue('tab-full-id');

			await cueSchedule({
				in: '1d',
				agent: 'Alpha',
				tab: 'tab-f',
				prompt: 'find more',
				json: true,
			});

			expect(mockResolveStoredAiTabId).toHaveBeenCalledWith('agent-alpha', 'tab-f');
			expect(onlySub()).toMatchObject({
				action: 'command',
				command: {
					mode: 'cli',
					cli: { command: 'send', target: 'agent-alpha', tab: 'tab-full-id', message: 'find more' },
				},
			});
			const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
			expect(out).toMatchObject({ ok: true, tab_id: 'tab-full-id' });
		});

		it('--tab naming no tab of the agent fails before writing', async () => {
			mockResolveStoredAiTabId.mockReturnValue(null);

			await expect(
				cueSchedule({ in: '1d', agent: 'Alpha', tab: 'nope', prompt: 'x', json: true })
			).rejects.toThrow('process.exit');

			expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
				ok: false,
				code: 'TAB_NOT_FOUND',
			});
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		it('--here takes the caller tab and agent from the environment, without a disk check', async () => {
			process.env.MAESTRO_CALLER_AGENT_ID = 'agent-alpha';
			process.env.MAESTRO_CALLER_TAB_ID = 'tab-caller';

			await cueSchedule({ at: '2030-01-01 15:00', here: true, prompt: 'follow up' });

			expect(mockResolveStoredAiTabId).not.toHaveBeenCalled();
			const cli = (onlySub().command as { cli: Record<string, unknown> }).cli;
			expect(cli).toMatchObject({ target: 'agent-alpha', tab: 'tab-caller' });
		});

		it('--here outside an AI tab is refused', async () => {
			await expect(
				cueSchedule({ in: '1h', agent: 'Alpha', here: true, prompt: 'x', json: true })
			).rejects.toThrow('process.exit');

			expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
				code: 'NOT_IN_TAB',
			});
		});

		it('--here with an --agent that does not own the caller tab is refused', async () => {
			process.env.MAESTRO_CALLER_AGENT_ID = 'agent-other';
			process.env.MAESTRO_CALLER_TAB_ID = 'tab-caller';
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
				session({ id: 'agent-other', name: 'Other', projectRoot }),
			]);

			await expect(
				cueSchedule({ in: '1h', agent: 'Alpha', here: true, prompt: 'x', json: true })
			).rejects.toThrow('process.exit');

			expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
				code: 'TAB_AGENT_MISMATCH',
			});
		});

		it.each([
			[{ tab: 't', here: true, prompt: 'x' }, 'CONFLICTING_TAB'],
			[{ tab: 't', notify: true, message: 'm' }, 'TAB_WITHOUT_PROMPT'],
			[{ tab: 't', prompt: 'x', tier: 'low' }, 'MODEL_WITH_TAB'],
		])('rejects %o with %s', async (flags, code) => {
			mockResolveStoredAiTabId.mockReturnValue('t');

			await expect(cueSchedule({ in: '1h', agent: 'Alpha', json: true, ...flags })).rejects.toThrow(
				'process.exit'
			);

			expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({ code });
		});
	});
});
