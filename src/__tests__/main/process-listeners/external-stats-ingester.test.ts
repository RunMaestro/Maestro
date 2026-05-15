/**
 * Tests for ExternalStatsIngester — the file-driven companion to the
 * process-driven stats listener. Subscribes to the coordinator's per-file
 * 'append' / 'create' events, tails JSONL deltas, parses each line through
 * the per-agent output parser, and on result messages inserts a row tagged
 * `source: 'external-fs'` via the shared retry helper.
 *
 * The coordinator is faked as a bare `EventEmitter` so the test can drive
 * synthetic events directly. The agent parser is faked as a single-line
 * lookup table so we can express "this exact line should be classified as
 * a result message" deterministically. The filesystem is faked through the
 * `fsImpl` injection point — no real I/O happens here.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ExternalStatsIngester } from '../../../main/process-listeners/external-stats-ingester';
import type { AgentOutputParser, ParsedEvent } from '../../../main/parsers';
import type { ToolType } from '../../../shared/types';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';
import type { StatsDB } from '../../../main/stats';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';
import { APPEND_EVENT, CREATE_EVENT } from '../../../main/storage/external-session-coordinator';

// --- helpers ----------------------------------------------------------------

const RESULT_LINE = '{"type":"result","session_id":"sess-1"}';
const FILE_PATH = '/tmp/maestro-test-session.jsonl';

function makeActivityEvent(overrides: Partial<SessionActivityEvent> = {}): SessionActivityEvent {
	return {
		agentId: 'claude-code',
		sessionId: 'sess-1',
		projectPath: '/proj',
		lastActivityAt: 1_700_000_000_000,
		source: 'external',
		sizeBytes: 0,
		...overrides,
	};
}

/**
 * Minimal AgentOutputParser stub that classifies one specific line as a result
 * message and returns null for everything else. Each method is a `vi.fn` so
 * the test can override behavior for the throw case.
 */
function makeParser(agentId: ToolType, resultLine: string = RESULT_LINE): AgentOutputParser {
	const resultEvent: ParsedEvent = {
		type: 'result',
		sessionId: 'sess-1',
		text: 'done',
	};
	return {
		agentId,
		parseJsonLine: vi.fn((line: string) => (line === resultLine ? resultEvent : null)),
		isResultMessage: vi.fn((event: ParsedEvent) => event.type === 'result'),
		extractSessionId: vi.fn((event: ParsedEvent) => event.sessionId ?? null),
		extractUsage: vi.fn(() => null),
		extractSlashCommands: vi.fn(() => null),
		parseJsonObject: vi.fn(() => null),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromParsed: vi.fn(() => null),
		detectErrorFromExit: vi.fn(() => null),
	};
}

interface FakeFileHandle {
	read: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

/**
 * Build a minimal `fs.promises`-shaped fake whose `stat` returns the
 * configured size and whose `open(...).read()` fills the buffer with the
 * configured content slice. Tracks every call so tests can assert that the
 * ingester read from the right offset.
 */
function makeFsImpl(content: string) {
	const stat = vi.fn(async (_path: string) => ({ size: Buffer.byteLength(content, 'utf-8') }));
	const open = vi.fn(async (_path: string, _flags: string): Promise<FakeFileHandle> => {
		return {
			read: vi.fn(async (buf: Buffer, _off: number, length: number, position: number) => {
				const slice = Buffer.from(content, 'utf-8').subarray(position, position + length);
				slice.copy(buf, 0, 0, slice.length);
				return { bytesRead: slice.length, buffer: buf };
			}),
			close: vi.fn(async () => {}),
		};
	});
	return { stat, open };
}

// --- tests ------------------------------------------------------------------

describe('ExternalStatsIngester', () => {
	let coordinator: EventEmitter;
	let statsDB: StatsDB;
	let logger: ProcessListenerDependencies['logger'];

	beforeEach(() => {
		vi.clearAllMocks();
		coordinator = new EventEmitter();
		statsDB = {
			isReady: vi.fn(() => true),
			insertQueryEvent: vi.fn(() => 'event-id-1'),
		} as unknown as StatsDB;
		logger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};
	});

	it("inserts a stats row with source: 'external-fs' when the parser flags a result line on 'append'", async () => {
		const parser = makeParser('claude-code');
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(
			APPEND_EVENT,
			makeActivityEvent({
				agentId: 'claude-code',
				sessionId: 'sess-1',
				projectPath: '/proj',
				lastActivityAt: 1_700_000_001_000,
			}),
			FILE_PATH
		);

		// Allow the queued microtasks for fs.stat / fs.open / retry helper to settle.
		await vi.waitFor(() => expect(statsDB.insertQueryEvent).toHaveBeenCalledTimes(1));

		expect(statsDB.insertQueryEvent).toHaveBeenCalledWith({
			sessionId: 'sess-1',
			agentType: 'claude-code',
			source: 'external-fs',
			startTime: 1_700_000_001_000,
			duration: 0,
			projectPath: '/proj',
			tabId: undefined,
		});
		expect(parser.parseJsonLine).toHaveBeenCalledWith(RESULT_LINE);
		expect(fsImpl.stat).toHaveBeenCalledWith(FILE_PATH);
	});

	it("also reacts to 'create' events (used by OpenCode's per-message file layout)", async () => {
		const parser = makeParser('opencode');
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['opencode', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(
			CREATE_EVENT,
			makeActivityEvent({ agentId: 'opencode', sessionId: 'oc-sess-1' }),
			'/tmp/opencode-msg.json'
		);

		await vi.waitFor(() => expect(statsDB.insertQueryEvent).toHaveBeenCalledTimes(1));
		expect(statsDB.insertQueryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'oc-sess-1',
				agentType: 'opencode',
				source: 'external-fs',
			})
		);
	});

	it('retries on transient DB failure and eventually inserts (first 2 attempts throw, 3rd succeeds)', async () => {
		const parser = makeParser('claude-code');
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		vi.mocked(statsDB.insertQueryEvent)
			.mockImplementationOnce(() => {
				throw new Error('SQLITE_BUSY-1');
			})
			.mockImplementationOnce(() => {
				throw new Error('SQLITE_BUSY-2');
			})
			.mockImplementationOnce(() => 'event-id-after-retries');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);

		// 3 attempts with 100ms + 200ms backoff means the final call lands around
		// ~300ms after the first attempt. Loose `waitFor` is fine; we're not
		// validating exact timing, just eventual success.
		await vi.waitFor(
			() => {
				expect(statsDB.insertQueryEvent).toHaveBeenCalledTimes(3);
			},
			{ timeout: 2000 }
		);

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Stats DB insert failed'),
			expect.any(String),
			expect.objectContaining({ sessionId: 'sess-1' })
		);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('does NOT insert and DOES warn-log when the parser throws on a line', async () => {
		const parser = makeParser('claude-code');
		vi.mocked(parser.parseJsonLine).mockImplementation(() => {
			throw new Error('parser exploded');
		});
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);

		// Wait one tick for the async handler to settle.
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Parser threw on line'),
				expect.any(String),
				expect.objectContaining({
					agentId: 'claude-code',
					sessionId: 'sess-1',
				})
			)
		);

		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();
	});

	it('skips lines the parser classifies as non-result events without inserting', async () => {
		const parser = makeParser('claude-code');
		// parseJsonLine returns a non-result event for any line we feed it.
		vi.mocked(parser.parseJsonLine).mockImplementation(
			(): ParsedEvent => ({ type: 'text', text: 'partial chunk', sessionId: 'sess-1' })
		);
		const fsImpl = makeFsImpl('{"type":"assistant","text":"chunk"}\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);

		// Give microtasks a chance to settle then assert nothing happened.
		await new Promise((r) => setTimeout(r, 10));
		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();
		expect(parser.isResultMessage).toHaveBeenCalled();
	});

	it('tails by delta: a second append reads only the new bytes, not the whole file', async () => {
		const parser = makeParser('claude-code');
		// First chunk: a non-result chunk. Second chunk: the result line.
		const firstChunk = '{"type":"assistant","text":"think"}\n';
		const secondChunk = RESULT_LINE + '\n';

		let totalContent = firstChunk;
		const stat = vi.fn(async () => ({ size: Buffer.byteLength(totalContent, 'utf-8') }));
		const readCalls: Array<{ position: number; length: number }> = [];
		const open = vi.fn(async () => ({
			read: vi.fn(async (buf: Buffer, _off: number, length: number, position: number) => {
				readCalls.push({ position, length });
				const slice = Buffer.from(totalContent, 'utf-8').subarray(position, position + length);
				slice.copy(buf, 0, 0, slice.length);
				return { bytesRead: slice.length, buffer: buf };
			}),
			close: vi.fn(async () => {}),
		}));

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: { stat, open } as unknown as ConstructorParameters<
				typeof ExternalStatsIngester
			>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);
		await vi.waitFor(() => expect(readCalls).toHaveLength(1));
		expect(readCalls[0]).toEqual({
			position: 0,
			length: Buffer.byteLength(firstChunk, 'utf-8'),
		});
		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();

		// Simulate the agent appending more bytes; size grows by `secondChunk`.
		totalContent = firstChunk + secondChunk;
		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);

		await vi.waitFor(() => expect(statsDB.insertQueryEvent).toHaveBeenCalledTimes(1));
		expect(readCalls).toHaveLength(2);
		expect(readCalls[1]).toEqual({
			position: Buffer.byteLength(firstChunk, 'utf-8'),
			length: Buffer.byteLength(secondChunk, 'utf-8'),
		});
	});

	it('does nothing when no parser is registered for the agent', async () => {
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map(), // empty registry
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);
		await new Promise((r) => setTimeout(r, 10));

		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();
	});

	it('skips processing entirely when the stats DB is not ready', async () => {
		vi.mocked(statsDB.isReady).mockReturnValue(false);
		const parser = makeParser('claude-code');
		const fsImpl = makeFsImpl(RESULT_LINE + '\n');

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: fsImpl as unknown as ConstructorParameters<typeof ExternalStatsIngester>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);
		await new Promise((r) => setTimeout(r, 10));

		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();
	});

	it('warn-logs and recovers when fs.stat rejects (file went away mid-event)', async () => {
		const parser = makeParser('claude-code');
		const stat = vi.fn(async () => {
			throw new Error('ENOENT: file gone');
		});
		const open = vi.fn();

		new ExternalStatsIngester({
			coordinator,
			statsDB,
			parsersByAgent: new Map([['claude-code', parser]]),
			logger,
			fsImpl: { stat, open } as unknown as ConstructorParameters<
				typeof ExternalStatsIngester
			>[0]['fsImpl'],
		});

		coordinator.emit(APPEND_EVENT, makeActivityEvent(), FILE_PATH);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to stat'),
				expect.any(String),
				expect.any(Object)
			)
		);

		expect(open).not.toHaveBeenCalled();
		expect(statsDB.insertQueryEvent).not.toHaveBeenCalled();
	});
});
