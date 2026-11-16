/**
 * @vitest-environment node
 *
 * Real-SQL tests for the stream-timed token speed table (stats schema v16):
 * every timed call folds into its provider's model-hour, and reads hand back
 * the same bucket shape the transcript path builds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { canLoadNodeSqlite, openNodeSqliteDb } from '../../helpers/nodeSqlite';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../../../main/stats/migrations';
import {
	recordTokenSpeedSample,
	getTokenSpeedSources,
	clearTokenSpeedCache,
} from '../../../main/stats/token-speed';
import { localHourStart, summarizeTokenSpeed } from '../../../shared/tokenSpeed';

const HOUR = new Date(2026, 10, 15, 14, 0, 0).getTime();

describe.skipIf(!canLoadNodeSqlite())('token_speed_hourly', () => {
	let db: Database.Database;

	beforeEach(() => {
		clearTokenSpeedCache();
		db = openNodeSqliteDb<Database.Database>();
		runMigrations(db);
	});

	it('folds calls into one bucket per provider, model and local hour', () => {
		recordTokenSpeedSample(db, 'pi', {
			endMs: HOUR + 60_000,
			durationMs: 4_000,
			model: 'gpt-5.5',
			inputTokens: 1000,
			outputTokens: 200,
		});
		recordTokenSpeedSample(db, 'pi', {
			endMs: HOUR + 30 * 60_000,
			durationMs: 6_000,
			model: 'gpt-5.5',
			inputTokens: 3000,
			outputTokens: 400,
		});
		recordTokenSpeedSample(db, 'opencode', {
			endMs: HOUR + 90 * 60_000,
			durationMs: 2_000,
			model: '',
			inputTokens: 10,
			outputTokens: 20,
		});

		expect(getTokenSpeedSources(db)).toEqual([
			{
				agentType: 'opencode',
				buckets: [
					{
						startMs: localHourStart(HOUR + 90 * 60_000),
						model: '',
						calls: 1,
						inputTokens: 10,
						outputTokens: 20,
						durationMs: 2_000,
					},
				],
			},
			{
				agentType: 'pi',
				buckets: [
					{
						startMs: HOUR,
						model: 'gpt-5.5',
						calls: 2,
						inputTokens: 4000,
						outputTokens: 600,
						durationMs: 10_000,
					},
				],
			},
		]);
	});

	it('reads only the hours a window starting mid-hour can include', () => {
		const sample = { durationMs: 2_000, model: 'm', inputTokens: 1, outputTokens: 1 };
		recordTokenSpeedSample(db, 'pi', { ...sample, endMs: HOUR - 2 * 3_600_000 });
		recordTokenSpeedSample(db, 'pi', { ...sample, endMs: HOUR + 10 * 60_000 });
		const [pi] = getTokenSpeedSources(db, HOUR + 30 * 60_000);
		expect(pi.buckets.map((b) => b.startMs)).toEqual([HOUR]);
	});

	it('feeds the same summary the transcript buckets do', () => {
		recordTokenSpeedSample(db, 'copilot-cli', {
			endMs: HOUR + 60_000,
			durationMs: 10_000,
			model: '',
			inputTokens: 0,
			outputTokens: 500,
		});
		const summary = summarizeTokenSpeed(getTokenSpeedSources(db), {
			agentLabel: (id) => id,
			modelKey: (m) => m || 'unknown',
			modelLabel: (k) => k,
			nowMs: HOUR + 3_600_000,
			measurableAgents: ['copilot-cli'],
		});
		expect(summary.measuredAgents).toEqual(['copilot-cli']);
		expect(summary.measurableAgents).toEqual(['copilot-cli']);
		expect(summary.overall.avgOutputTps).toBe(50);
	});
});
