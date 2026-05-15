/**
 * ExternalStatsIngester
 *
 * File-driven companion to {@link import('./stats-listener').setupStatsListener}.
 * Listens for per-file `'append'` / `'create'` events from
 * {@link ExternalSessionCoordinator}, tails the underlying JSONL (delta from
 * the last known byte offset — never re-reads the whole file), parses each
 * line through the agent's registered output parser, and on result messages
 * inserts a `query_events` row with `source: 'external-fs'` via
 * {@link insertQueryEventWithRetry}.
 *
 * Passive by design: no `start()` / `stop()` lifecycle of its own. Constructed
 * after the coordinator is up; cleanup happens implicitly when the coordinator
 * stops and stops firing events. Per-file byte offsets live in memory only —
 * on the next process boot the watcher re-derives them from `fs.stat`.
 *
 * Dedup with the process-driven path is handled upstream: the coordinator only
 * forwards file events for sessions whose annotated `source` is `'external'`,
 * so a session Maestro is already driving locally never reaches the ingester.
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';

import type { AgentOutputParser, ParsedEvent } from '../parsers';
import type { ToolType } from '../../shared/types';
import type { SessionActivityEvent } from '../../shared/sessionActivity';
import type { StatsDB } from '../stats';
import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';
import {
	APPEND_EVENT,
	CREATE_EVENT,
	type ExternalSessionCoordinator,
} from '../storage/external-session-coordinator';
import { insertQueryEventWithRetry } from './insertQueryEventWithRetry';

const LOG_CONTEXT = '[ExternalStatsIngester]';

export interface ExternalStatsIngesterOptions {
	coordinator: ExternalSessionCoordinator | EventEmitter;
	statsDB: StatsDB;
	parsersByAgent: Map<ToolType, AgentOutputParser>;
	logger: ProcessListenerDependencies['logger'];
	/**
	 * Optional injection point for `fs.stat` / `fs.open` so unit tests can
	 * drive the ingester without touching the real filesystem. Defaults to
	 * Node's `fs.promises`.
	 */
	fsImpl?: Pick<typeof fs, 'stat' | 'open'>;
}

/**
 * In-memory byte offset table keyed by absolute file path. We never persist
 * these — on the next process boot we either (a) skip files that have not
 * changed since startup, or (b) restart at the current `fs.stat().size` on the
 * first append.
 */
type OffsetTable = Map<string, number>;

export class ExternalStatsIngester {
	private readonly coordinator: ExternalSessionCoordinator | EventEmitter;
	private readonly statsDB: StatsDB;
	private readonly parsersByAgent: Map<ToolType, AgentOutputParser>;
	private readonly logger: ProcessListenerDependencies['logger'];
	private readonly fsImpl: Pick<typeof fs, 'stat' | 'open'>;
	private readonly offsets: OffsetTable = new Map();

	constructor(options: ExternalStatsIngesterOptions) {
		this.coordinator = options.coordinator;
		this.statsDB = options.statsDB;
		this.parsersByAgent = options.parsersByAgent;
		this.logger = options.logger;
		this.fsImpl = options.fsImpl ?? fs;

		this.coordinator.on(APPEND_EVENT, (event: SessionActivityEvent, filePath: string) => {
			void this.handle(event, filePath);
		});
		this.coordinator.on(CREATE_EVENT, (event: SessionActivityEvent, filePath: string) => {
			void this.handle(event, filePath);
		});
	}

	/**
	 * Process a single file activity event:
	 *   1. `fs.stat` the file, compute byte delta against the last known offset.
	 *   2. Read just the delta (`fs.open` + positional `read`, no whole-file load).
	 *   3. Run each line through the agent's parser and insert a stats row for
	 *      every parsed result message.
	 *
	 * Filesystem failures (file went away mid-event, permission flip) are logged
	 * at `warn` and swallowed — the watcher will retry on the next event.
	 */
	private async handle(event: SessionActivityEvent, filePath: string): Promise<void> {
		if (!filePath) return;

		let endOffset: number;
		try {
			const stats = await this.fsImpl.stat(filePath);
			endOffset = stats.size;
		} catch (err) {
			this.logger.warn(`Failed to stat ${filePath}: ${(err as Error).message}`, LOG_CONTEXT, {
				agentId: event.agentId,
				sessionId: event.sessionId,
			});
			return;
		}

		const startOffset = this.offsets.get(filePath) ?? 0;
		if (endOffset <= startOffset) {
			// Spurious change (touch / metadata) — nothing new to read.
			this.offsets.set(filePath, endOffset);
			return;
		}

		let delta: string;
		try {
			const handle = await this.fsImpl.open(filePath, 'r');
			try {
				const length = endOffset - startOffset;
				const buf = Buffer.alloc(length);
				await handle.read(buf, 0, length, startOffset);
				delta = buf.toString('utf-8');
			} finally {
				await handle.close();
			}
		} catch (err) {
			this.logger.warn(
				`Failed to read delta from ${filePath}: ${(err as Error).message}`,
				LOG_CONTEXT,
				{ agentId: event.agentId, sessionId: event.sessionId }
			);
			return;
		}

		this.offsets.set(filePath, endOffset);
		await this.processBuffer(event, delta);
	}

	/**
	 * Split the delta on newlines and feed each non-empty line through the
	 * agent parser. Lines whose parsed event is a result message produce a
	 * `query_events` row tagged `source: 'external-fs'`. Parser exceptions
	 * are warn-logged and the offending line is skipped — never thrown out.
	 */
	private async processBuffer(event: SessionActivityEvent, content: string): Promise<void> {
		const parser = this.parsersByAgent.get(event.agentId);
		if (!parser) return;

		if (!this.statsDB.isReady()) return;

		for (const rawLine of content.split('\n')) {
			const line = rawLine.trim();
			if (!line) continue;

			let parsed: ParsedEvent | null;
			try {
				parsed = parser.parseJsonLine(line);
			} catch (err) {
				this.logger.warn(`Parser threw on line: ${(err as Error).message}`, LOG_CONTEXT, {
					agentId: event.agentId,
					sessionId: event.sessionId,
				});
				continue;
			}
			if (!parsed) continue;
			if (!parser.isResultMessage(parsed)) continue;

			const queryData: QueryCompleteData = {
				sessionId: event.sessionId,
				agentType: event.agentId,
				source: 'external-fs',
				// We don't have process-manager-style start/duration info from
				// JSONL alone. Use the file's most recent activity timestamp as
				// the row's start_time so dashboard time-range filters bucket
				// the event correctly; duration is left at 0 since the parser
				// can't reconstruct it for sessions Maestro didn't spawn.
				startTime: event.lastActivityAt,
				duration: 0,
				projectPath: event.projectPath || undefined,
			};

			await insertQueryEventWithRetry(this.statsDB, queryData, this.logger);
		}
	}
}
