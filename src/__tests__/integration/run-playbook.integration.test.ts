import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Playbook, SessionInfo } from '../../shared/types';

const state = vi.hoisted(() => ({
	detectAgent: vi.fn(),
	executePlaybook: vi.fn(),
	findPlaybookById: vi.fn(),
	formatError: vi.fn(),
	formatInfo: vi.fn(),
	formatRunEvent: vi.fn(),
	formatWarning: vi.fn(),
	getAgentDefinition: vi.fn(),
	getCliActivityForSession: vi.fn(),
	getSessionById: vi.fn(),
	homeDir: vi.fn(),
	isSessionBusyWithCli: vi.fn(),
	readFileSync: vi.fn(),
	emitError: vi.fn(),
	platform: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		readFileSync: state.readFileSync,
		default: {
			...actual,
			readFileSync: state.readFileSync,
		},
	};
});

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const mockedOs = {
		...actual,
		homedir: state.homeDir,
		platform: state.platform,
	};
	return {
		...mockedOs,
		default: mockedOs,
	};
});

vi.mock('../../cli/services/storage', () => ({
	getSessionById: state.getSessionById,
}));

vi.mock('../../cli/services/playbooks', () => ({
	findPlaybookById: state.findPlaybookById,
}));

vi.mock('../../cli/services/batch-processor', () => ({
	runPlaybook: state.executePlaybook,
}));

vi.mock('../../cli/services/agent-spawner', () => ({
	detectAgent: state.detectAgent,
}));

vi.mock('../../main/agents/definitions', () => ({
	getAgentDefinition: state.getAgentDefinition,
}));

vi.mock('../../shared/cli-activity', () => ({
	getCliActivityForSession: state.getCliActivityForSession,
	isSessionBusyWithCli: state.isSessionBusyWithCli,
}));

vi.mock('../../cli/output/jsonl', () => ({
	emitError: state.emitError,
}));

vi.mock('../../cli/output/formatter', () => ({
	formatRunEvent: state.formatRunEvent,
	formatError: state.formatError,
	formatInfo: state.formatInfo,
	formatWarning: state.formatWarning,
}));

import { runPlaybook } from '../../cli/commands/run-playbook';

let originalEnv: NodeJS.ProcessEnv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;
let dateSpy: ReturnType<typeof vi.spyOn> | undefined;

describe('run playbook CLI command integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		originalEnv = { ...process.env };
		process.env = { ...originalEnv };
		delete process.env.APPDATA;
		delete process.env.XDG_CONFIG_HOME;

		const agent = makeAgent();
		const playbook = makePlaybook();
		state.findPlaybookById.mockReturnValue({ agentId: agent.id, playbook });
		state.getSessionById.mockReturnValue(agent);
		state.getAgentDefinition.mockReturnValue({ name: 'Codex' });
		state.detectAgent.mockResolvedValue({ available: true, path: '/usr/local/bin/codex' });
		state.executePlaybook.mockReturnValue(eventStream(makeCompleteEvent()));
		state.getCliActivityForSession.mockReturnValue(undefined);
		state.isSessionBusyWithCli.mockReturnValue(false);
		state.readFileSync.mockImplementation(() => {
			const error = new Error('missing desktop session store') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			throw error;
		});
		state.homeDir.mockReturnValue('/Users/tester');
		state.platform.mockReturnValue('darwin');
		state.formatError.mockImplementation((message: string) => `ERROR:${message}`);
		state.formatInfo.mockImplementation((message: string) => `INFO:${message}`);
		state.formatRunEvent.mockImplementation((event: { type: string }) => `EVENT:${event.type}`);
		state.formatWarning.mockImplementation((message: string) => `WARN:${message}`);

		exitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((() => undefined as never) as typeof process.exit);
		stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		timeoutSpy = undefined;
		dateSpy = undefined;
	});

	afterEach(() => {
		process.env = originalEnv;
		timeoutSpy?.mockRestore();
		dateSpy?.mockRestore();
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
	});

	it('executes a human-readable run and forwards command options to the batch processor', async () => {
		const agent = makeAgent({ autoRunFolderPath: '/tmp/autorun' });
		const playbook = makePlaybook({
			documents: [
				{ filename: 'brief.md', resetOnCompletion: false },
				{ filename: 'checklist.md', resetOnCompletion: true },
			],
			loopEnabled: true,
			maxLoops: 2,
		});
		state.findPlaybookById.mockReturnValue({ agentId: agent.id, playbook });
		state.getSessionById.mockReturnValue(agent);
		state.executePlaybook.mockReturnValue(
			eventStream({ type: 'start', timestamp: 1 }, makeCompleteEvent())
		);

		await runPlaybook('playbook-1', {
			debug: true,
			dryRun: true,
			history: false,
			synopsis: false,
			verbose: true,
		});

		expect(state.findPlaybookById).toHaveBeenCalledWith('playbook-1');
		expect(state.getSessionById).toHaveBeenCalledWith(agent.id);
		expect(state.detectAgent).toHaveBeenCalledWith('codex');
		expect(state.executePlaybook).toHaveBeenCalledWith(agent, playbook, '/tmp/autorun', {
			debug: true,
			dryRun: true,
			skipSynopsis: true,
			verbose: true,
			writeHistory: false,
		});
		expect(stdoutMessages()).toEqual([
			'INFO:Running playbook: Integration Sweep',
			'INFO:Agent: Coverage Agent',
			'INFO:Documents: 2',
			'INFO:Loop: enabled (max 2)',
			'INFO:Dry run mode - no changes will be made',
			'',
			'EVENT:start',
			'EVENT:complete',
		]);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints loop startup information when no max loop count is configured', async () => {
		const agent = makeAgent();
		const playbook = makePlaybook({ loopEnabled: true, maxLoops: null });
		state.findPlaybookById.mockReturnValue({ agentId: agent.id, playbook });
		state.getSessionById.mockReturnValue(agent);

		await runPlaybook('playbook-1', {});

		const loopInfoCall = state.formatInfo.mock.calls.find(([message]) =>
			String(message).startsWith('Loop: enabled (')
		);
		expect(loopInfoCall).toBeDefined();
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('streams JSON events without human startup output', async () => {
		const startEvent = { type: 'start', timestamp: 10, playbook: { id: 'playbook-1' } };
		const completeEvent = makeCompleteEvent();
		state.executePlaybook.mockReturnValue(eventStream(startEvent, completeEvent));

		await runPlaybook('playbook-1', { json: true });

		expect(state.formatRunEvent).not.toHaveBeenCalled();
		expect(state.executePlaybook.mock.calls[0][3]).toEqual({
			debug: undefined,
			dryRun: undefined,
			skipSynopsis: false,
			verbose: undefined,
			writeHistory: true,
		});
		expect(stdoutMessages().map((line) => JSON.parse(line))).toEqual([startEvent, completeEvent]);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('waits in JSON mode when CLI activity clears before the run starts', async () => {
		makeSleepsImmediate();
		dateSpy = vi.spyOn(Date, 'now');
		dateSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1500).mockReturnValueOnce(1500);
		state.getCliActivityForSession
			.mockReturnValueOnce({
				sessionId: 'agent-1',
				playbookId: 'playbook-busy',
				playbookName: 'Existing Run',
				startedAt: 1,
				pid: 4321,
			})
			.mockReturnValueOnce(undefined);
		state.isSessionBusyWithCli.mockReturnValueOnce(true);
		const completeEvent = makeCompleteEvent();
		state.executePlaybook.mockReturnValue(eventStream(completeEvent));

		await runPlaybook('playbook-1', { json: true, wait: true });

		const output = stdoutMessages().map((line) => JSON.parse(line));
		expect(output).toEqual([
			{ type: 'wait_complete', timestamp: 1500, waitDurationMs: 500 },
			completeEvent,
		]);
		expect(state.executePlaybook).toHaveBeenCalledTimes(1);
	});

	it('waits in human mode across desktop and CLI busy reasons', async () => {
		makeSleepsImmediate();
		dateSpy = vi.spyOn(Date, 'now');
		dateSpy.mockReturnValueOnce(0).mockReturnValueOnce(125000);
		state.readFileSync
			.mockReturnValueOnce(JSON.stringify({ sessions: [{ id: 'agent-1', state: 'busy' }] }))
			.mockReturnValueOnce(JSON.stringify({ sessions: [{ id: 'agent-1', state: 'idle' }] }));
		state.getCliActivityForSession
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({
				sessionId: 'agent-1',
				playbookId: 'playbook-next',
				playbookName: 'Next Run',
				startedAt: 1,
				pid: 9876,
			})
			.mockReturnValueOnce(undefined);
		state.isSessionBusyWithCli.mockReturnValueOnce(true);

		await runPlaybook('playbook-1', { wait: true });

		expect(stdoutMessages()).toEqual([
			'WARN:Agent "Coverage Agent" is busy: Busy in desktop app',
			'INFO:Waiting for agent to become available...',
			'WARN:Still waiting: Running playbook "Next Run" from CLI (PID: 9876)',
			'INFO:Agent available after waiting 2m 5s',
			'',
			'INFO:Running playbook: Integration Sweep',
			'INFO:Agent: Coverage Agent',
			'INFO:Documents: 1',
			'',
			'EVENT:complete',
		]);
	});

	it('formats short human wait durations', async () => {
		await runHumanWaitWithDuration(500);
		expect(stdoutMessages()).toContain('INFO:Agent available after waiting 500ms');

		resetRuntimeSpies();
		await runHumanWaitWithDuration(5000);
		expect(stdoutMessages()).toContain('INFO:Agent available after waiting 5s');
	});

	it('fails immediately when an agent is busy and wait mode is disabled', async () => {
		state.readFileSync.mockReturnValue(
			JSON.stringify({ sessions: [{ id: 'agent-1', state: 'busy' }] })
		);

		await runPlaybook('playbook-1', {});

		expect(stderrMessages()).toEqual([
			'ERROR:Agent "Coverage Agent" is busy: Busy in desktop app. Use --wait to wait for availability.',
		]);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();
	});

	it('emits JSON when CLI activity keeps the agent busy without wait mode', async () => {
		state.getCliActivityForSession.mockReturnValue({
			sessionId: 'agent-1',
			playbookId: 'playbook-busy',
			playbookName: 'Existing Run',
			startedAt: 1,
			pid: 2468,
		});
		state.isSessionBusyWithCli.mockReturnValue(true);

		await runPlaybook('playbook-1', { json: true });

		expect(state.emitError).toHaveBeenCalledWith(
			'Agent "Coverage Agent" is busy: Running playbook "Existing Run" from CLI (PID: 2468). Use --wait to wait for availability.',
			'AGENT_BUSY'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();
	});

	it('reports missing playbooks in human-readable and JSON modes', async () => {
		state.findPlaybookById.mockImplementation(() => {
			throw new Error('Playbook not found: missing');
		});

		await runPlaybook('missing', {});

		expect(stderrMessages()).toEqual(['ERROR:Playbook not found: missing']);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.getSessionById).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.findPlaybookById.mockImplementation(() => {
			throw 'not an error object';
		});

		await runPlaybook('missing', { json: true });

		expect(state.emitError).toHaveBeenCalledWith('Unknown error', 'PLAYBOOK_NOT_FOUND');
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.getSessionById).not.toHaveBeenCalled();
	});

	it('rejects unsupported agent definitions in human-readable and JSON modes', async () => {
		state.getAgentDefinition.mockReturnValue(undefined);

		await runPlaybook('playbook-1', {});

		expect(stderrMessages()).toEqual([
			'ERROR:Agent type "codex" is not supported in CLI batch mode yet.',
		]);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.detectAgent).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.getAgentDefinition.mockReturnValue(undefined);

		await runPlaybook('playbook-1', { json: true });

		expect(state.emitError).toHaveBeenCalledWith(
			'Agent type "codex" is not supported in CLI batch mode yet.',
			'AGENT_UNSUPPORTED'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.detectAgent).not.toHaveBeenCalled();
	});

	it('reports unavailable agent CLIs in human-readable and JSON modes', async () => {
		state.detectAgent.mockResolvedValue({ available: false });

		await runPlaybook('playbook-1', {});

		expect(stderrMessages()).toEqual(['ERROR:Codex CLI not found. Please install Codex.']);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.detectAgent.mockResolvedValue({ available: false });

		await runPlaybook('playbook-1', { json: true });

		expect(state.emitError).toHaveBeenCalledWith(
			'Codex CLI not found. Please install Codex.',
			'CODEX_NOT_FOUND'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();
	});

	it('requires an Auto Run folder before executing', async () => {
		state.getSessionById.mockReturnValue(makeAgent({ autoRunFolderPath: undefined }));

		await runPlaybook('playbook-1', {});

		expect(stderrMessages()).toEqual(['ERROR:Agent does not have an Auto Run folder configured']);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.getSessionById.mockReturnValue(makeAgent({ autoRunFolderPath: undefined }));

		await runPlaybook('playbook-1', { json: true });

		expect(state.emitError).toHaveBeenCalledWith(
			'Agent does not have an Auto Run folder configured',
			'NO_AUTORUN_FOLDER'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(state.executePlaybook).not.toHaveBeenCalled();
	});

	it('reports execution failures in human-readable and JSON modes', async () => {
		state.executePlaybook.mockReturnValue(failingEventStream('stream broke'));

		await runPlaybook('playbook-1', {});

		expect(stderrMessages()).toEqual(['ERROR:Failed to run playbook: stream broke']);
		expect(exitSpy).toHaveBeenCalledWith(1);

		resetRuntimeSpies();
		state.executePlaybook.mockImplementation(() => {
			throw 'bad stream';
		});

		await runPlaybook('playbook-1', { json: true });

		expect(state.emitError).toHaveBeenCalledWith(
			'Failed to run playbook: Unknown error',
			'EXECUTION_ERROR'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('checks desktop busy state from Windows and Linux config locations', async () => {
		state.platform.mockReturnValue('win32');
		process.env.APPDATA = '/Users/tester/AppData/Roaming';
		state.readFileSync.mockReturnValueOnce(
			JSON.stringify({ sessions: [{ id: 'other-agent', state: 'busy' }] })
		);

		await runPlaybook('playbook-1', { json: true });

		expect(String(state.readFileSync.mock.calls[0][0])).toBe(
			'/Users/tester/AppData/Roaming/maestro/maestro-sessions.json'
		);
		expect(exitSpy).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.platform.mockReturnValue('win32');
		delete process.env.APPDATA;
		state.homeDir.mockReturnValue('/Users/fallback');
		state.readFileSync.mockReturnValueOnce(JSON.stringify({ sessions: [] }));

		await runPlaybook('playbook-1', { json: true });

		expect(String(state.readFileSync.mock.calls[0][0])).toBe(
			'/Users/fallback/AppData/Roaming/maestro/maestro-sessions.json'
		);
		expect(exitSpy).not.toHaveBeenCalled();

		resetRuntimeSpies();
		state.platform.mockReturnValue('linux');
		process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
		state.readFileSync.mockReturnValueOnce(
			JSON.stringify({ sessions: [{ id: 'agent-1', state: 'busy' }] })
		);

		await runPlaybook('playbook-1', { json: true });

		expect(String(state.readFileSync.mock.calls[0][0])).toBe(
			'/tmp/xdg-config/maestro/maestro-sessions.json'
		);
		expect(state.emitError).toHaveBeenCalledWith(
			'Agent "Coverage Agent" is busy: Busy in desktop app. Use --wait to wait for availability.',
			'AGENT_BUSY'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);

		resetRuntimeSpies();
		state.platform.mockReturnValue('linux');
		delete process.env.XDG_CONFIG_HOME;
		state.homeDir.mockReturnValue('/home/fallback');
		state.readFileSync.mockReturnValueOnce(JSON.stringify({}));

		await runPlaybook('playbook-1', { json: true });

		expect(String(state.readFileSync.mock.calls[0][0])).toBe(
			'/home/fallback/.config/maestro/maestro-sessions.json'
		);
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

function makeAgent(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'agent-1',
		name: 'Coverage Agent',
		toolType: 'codex',
		cwd: '/workspace/project',
		projectRoot: '/workspace/project',
		autoRunFolderPath: '/workspace/project/.maestro/autorun',
		...overrides,
	};
}

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'playbook-1',
		name: 'Integration Sweep',
		createdAt: 100,
		updatedAt: 200,
		documents: [{ filename: 'brief.md', resetOnCompletion: false }],
		loopEnabled: false,
		maxLoops: null,
		prompt: 'Run the integration sweep.',
		...overrides,
	};
}

function makeCompleteEvent() {
	return {
		type: 'complete',
		timestamp: 20,
		success: true,
		totalElapsedMs: 250,
		totalTasksCompleted: 1,
	};
}

function eventStream(...events: Array<Record<string, unknown>>) {
	return (async function* stream() {
		for (const event of events) {
			yield event;
		}
	})();
}

function failingEventStream(message: string) {
	return (async function* stream() {
		yield { type: 'start', timestamp: 1 };
		throw new Error(message);
	})();
}

function stdoutMessages(): string[] {
	return stdoutSpy.mock.calls.map((args) => args.join(' '));
}

function stderrMessages(): string[] {
	return stderrSpy.mock.calls.map((args) => args.join(' '));
}

function resetRuntimeSpies(): void {
	stdoutSpy.mockClear();
	stderrSpy.mockClear();
	exitSpy.mockClear();
	state.emitError.mockClear();
	state.executePlaybook.mockClear();
	state.detectAgent.mockClear();
	state.getSessionById.mockClear();
	state.getAgentDefinition.mockClear();
	state.findPlaybookById.mockClear();
	state.getCliActivityForSession.mockClear();
	state.isSessionBusyWithCli.mockClear();
	state.readFileSync.mockClear();

	const agent = makeAgent();
	const playbook = makePlaybook();
	state.findPlaybookById.mockReturnValue({ agentId: agent.id, playbook });
	state.getSessionById.mockReturnValue(agent);
	state.getAgentDefinition.mockReturnValue({ name: 'Codex' });
	state.detectAgent.mockResolvedValue({ available: true, path: '/usr/local/bin/codex' });
	state.executePlaybook.mockReturnValue(eventStream(makeCompleteEvent()));
	state.getCliActivityForSession.mockReturnValue(undefined);
	state.isSessionBusyWithCli.mockReturnValue(false);
	state.readFileSync.mockImplementation(() => {
		const error = new Error('missing desktop session store') as NodeJS.ErrnoException;
		error.code = 'ENOENT';
		throw error;
	});
}

async function runHumanWaitWithDuration(durationMs: number): Promise<void> {
	makeSleepsImmediate();
	dateSpy?.mockRestore();
	dateSpy = vi.spyOn(Date, 'now');
	dateSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1000 + durationMs);
	state.getCliActivityForSession.mockReturnValueOnce({
		sessionId: 'agent-1',
		playbookId: 'playbook-busy',
		playbookName: 'Existing Run',
		startedAt: 1,
		pid: 4321,
	});
	state.getCliActivityForSession.mockReturnValueOnce(undefined);
	state.isSessionBusyWithCli.mockReturnValueOnce(true);

	await runPlaybook('playbook-1', { wait: true });
}

function makeSleepsImmediate(): void {
	timeoutSpy?.mockRestore();
	timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		callback: (...args: unknown[]) => void
	) => {
		if (typeof callback === 'function') {
			callback();
		}
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout);
}
