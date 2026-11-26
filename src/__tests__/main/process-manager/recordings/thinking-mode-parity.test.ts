/**
 * T2: the same provider stream records the same `thinking` entries in every agent mode.
 *
 * A local and an SSH turn read the provider's stdout through the desktop's `StdoutHandler` (an SSH
 * turn's stdout reaches the same handler), which emits `thinking-chunk`. A hosted turn reads it on
 * the Federation host through `createTurnEventMapper()`. Both route a partial `text` event by one
 * rule (`partialTextRoute()`), so with Thinking sticky a Claude reply leaves the same `thinking`
 * copy on a hosted tab as on a local and an SSH one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(() => null),
}));

import { StdoutHandler } from '../../../../main/process-manager/handlers/StdoutHandler';
import { DataBufferManager } from '../../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess } from '../../../../main/process-manager/types';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
import {
	createTurnEventMapper,
	partialTextRoute,
} from '../../../../shared/maestro-lib/turns/turn-events';
import { DEFAULT_TAB_DEFAULTS } from '../../../../shared/maestro-lib/agents/rules';
import type { ClientResult } from '../../../../shared/maestro-lib/client/types';
import { runAgentTurn } from '../../../../shared/maestro-lib/turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../../../shared/maestro-lib/runtime';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../../../shared/maestro-lib/run/fakeAgent';
import { AGENT_MODES, type AgentMode } from '../../../helpers/mockSession';
import { CAPTURED_RECORDINGS } from './captured';
import { DOCUMENTED_RECORDINGS } from './documented';
import { RECORDINGS, type TurnRecording } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');
const T0 = Date.parse('2026-10-04T12:00:00Z');

const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistantText = (text: string) => ({
	type: 'assistant',
	message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** Two Claude messages with no tool between: the desktop keeps them as one thinking entry. */
const TWO_MESSAGES: TurnRecording = {
	name: 'two-messages',
	description: 'Two assistant text messages in a row, then the result.',
	toolType: 'claude-code',
	chunks: [
		jsonLine({ type: 'system', subtype: 'init', session_id: 'sess-two-1' }),
		jsonLine(assistantText('First part. ')),
		jsonLine(assistantText('Second part.')),
		jsonLine({ type: 'result', result: 'First part. Second part.', session_id: 'sess-two-1' }),
	],
	exitCode: 0,
};

const STREAMS: TurnRecording[] = [
	CAPTURED_RECORDINGS['captured-claude-code-normal'],
	TWO_MESSAGES,
	RECORDINGS.interleaved,
	CAPTURED_RECORDINGS['captured-opencode-normal'],
	...Object.values(DOCUMENTED_RECORDINGS),
];

/** The thinking chunks a desktop turn emits for the stream (a local or an SSH process). */
function desktopThinking(recording: TurnRecording, mode: Exclude<AgentMode, 'hosted'>): string[] {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = new DataBufferManager(processes, emitter);
	const handler = new StdoutHandler({ processes, emitter, bufferManager });
	const sessionId = `${mode}-${recording.name}`;
	processes.set(sessionId, {
		sessionId,
		toolType: recording.toolType,
		cwd: '/tmp',
		pid: 4242,
		isTerminal: false,
		startTime: Date.now(),
		isStreamJsonMode: true,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		stderrBuffer: '',
		contextWindow: 200000,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		outputParser: createOutputParser(recording.toolType)!,
		streamedText: '',
		...(mode === 'ssh' ? { sshRemoteId: 'remote-1', sshRemoteHost: 'build-box' } : {}),
	} as ManagedProcess);
	const chunks: string[] = [];
	emitter.on('thinking-chunk', (_sid: string, text: string) => chunks.push(text));
	emitter.on('tool-execution', () => chunks.push(TOOL));
	for (const chunk of recording.chunks) handler.handleData(sessionId, chunk);
	return chunks;
}

/** A tool card in an ordered chunk list: it closes the thinking entry before it. */
const TOOL = '\u0000tool';

/**
 * The thinking entries a sticky local or SSH tab keeps: the renderer appends each chunk to the
 * open thinking entry, and a tool card closes it.
 */
function desktopKept(recording: TurnRecording): string[] {
	const kept: string[] = [];
	let open = false;
	for (const chunk of desktopThinking(recording, 'local')) {
		if (chunk === TOOL) open = false;
		else if (open) kept[kept.length - 1] += chunk;
		else {
			kept.push(chunk);
			open = true;
		}
	}
	return kept;
}

/** The thinking events a Federation host's turn emits for the same stream. */
function hostThinking(recording: TurnRecording): string[] {
	const parser = createOutputParser(recording.toolType)!;
	const mapper = createTurnEventMapper({ agentId: recording.toolType, parser });
	const out: string[] = [];
	for (const line of recording.chunks.join('').split('\n')) {
		if (!line.trim()) continue;
		const event = parser.parseJsonLine(line);
		if (!event) continue;
		for (const mapped of mapper.map(event)) {
			if (mapped.kind === 'thinking') out.push(mapped.text);
			else if (mapped.kind === 'tool') out.push(TOOL);
		}
	}
	return out;
}

function thinkingOf(recording: TurnRecording, mode: AgentMode): string[] {
	return mode === 'hosted' ? hostThinking(recording) : desktopThinking(recording, mode);
}

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

describe('thinking entries from one provider stream (T2)', () => {
	it.each(STREAMS.map((recording) => [recording.name, recording] as const))(
		'%s: the same thinking chunks in all three modes',
		(_name, recording) => {
			const [local, ssh, hosted] = AGENT_MODES.map((mode) => thinkingOf(recording, mode));
			expect(ssh).toEqual(local);
			expect(hosted).toEqual(local);
		}
	);

	it('a Claude reply is a thinking chunk on the host, as on the desktop', () => {
		const recording = CAPTURED_RECORDINGS['captured-claude-code-normal'];
		expect(hostThinking(recording).length).toBeGreaterThan(0);
		expect(partialTextRoute('claude-code', undefined)).toEqual({ thinking: true, answer: true });
		expect(partialTextRoute('codex', undefined)).toEqual({ thinking: false, answer: true });
		expect(partialTextRoute('codex', true)).toEqual({ thinking: true, answer: false });
		expect(partialTextRoute('copilot-cli', true)).toEqual({ thinking: false, answer: false });
	});

	describe('the entries a sticky hosted tab keeps', () => {
		let dir: string;
		let work: string;

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t2-'));
			work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t2-work-'));
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(work, { recursive: true, force: true });
		});

		async function startRuntime(recording: string): Promise<MaestroRuntime> {
			const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) =>
				runAgentTurn(
					{
						...turn,
						launch: {
							...turn.launch,
							command: process.execPath,
							args: [FAKE_AGENT_PATH, ...turn.launch.args],
							sessionCustomEnvVars: {
								...turn.launch.sessionCustomEnvVars,
								FAKE_AGENT_RECORDING: recording,
							},
						},
					},
					{ ...options, stopGraceMs: 200 }
				);
			let id = 0;
			let now = 1_000;
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({
					sessions: [
						{
							id: 'a1',
							name: 'Hosted',
							toolType: 'claude-code',
							cwd: work,
							projectRoot: work,
							aiTabs: [
								{
									id: 't1',
									agentSessionId: null,
									name: null,
									logs: [],
									showThinking: 'sticky',
									saveToHistory: false,
								},
							],
							activeTabId: 't1',
							unifiedTabOrder: [{ type: 'ai', id: 't1' }],
						},
					],
					activeSessionId: 'a1',
				})
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: {
					pid: 100,
					now: () => T0,
					bootTime: () => T0 - 3_600_000,
					isPidAlive: (pid) => pid === 100,
					hostname: () => 'testhost',
					rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
					checkCwd: () => null,
					readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
					watchDirectory: () => ({ close: () => undefined }),
					probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
					turns: { runAgentTurn: fakeProvider },
				},
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			return started.runtime;
		}

		it.each([
			CAPTURED_RECORDINGS['captured-claude-code-normal'],
			TWO_MESSAGES,
			RECORDINGS.interleaved,
		])('$name: keeps the thinking entries a local and an SSH tab keep', async (recording) => {
			const runtime = await startRuntime(writeFakeTurn(work, fakeTurnFromRecording(recording)));
			try {
				let done = false;
				runtime.turns.subscribe('a1', 't1', (event) => {
					if (event.kind === 'outcome') done = true;
				});
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await vi.waitFor(() => expect(done).toBe(true), { timeout: 8_000 });
				let kept: string[] = [];
				await vi.waitFor(
					async () => {
						const transcript = value(await runtime.tabs.transcript('a1', 't1'));
						kept = transcript
							.filter((entry) => entry.source === 'thinking')
							.map((entry) => entry.text);
						expect(kept.length).toBeGreaterThan(0);
					},
					{ timeout: 8_000 }
				);
				expect(kept).toEqual(desktopKept(recording));
			} finally {
				await runtime.connection.close();
			}
		});
	});
});
