/**
 * `--log-format json`: every engine log line is one JSON object a log shipper
 * can index. The shape is the contract the server deployment reads, and the
 * id allowlist is what keeps a run payload (prompt text, trigger data) from
 * being shipped off the box.
 */

import { describe, it, expect } from 'vitest';
import { buildJsonLogLine, formatJsonLogLine } from '../../shared/jsonLogLine';

describe('formatJsonLogLine', () => {
	it('emits exactly one line of valid JSON with timestamp, level and message', () => {
		const line = formatJsonLogLine({
			timestamp: Date.UTC(2026, 9, 6, 12, 0, 0),
			level: 'warn',
			message: 'first line\nsecond line',
		});
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual({
			timestamp: '2026-10-06T12:00:00.000Z',
			level: 'warn',
			message: 'first line\nsecond line',
		});
	});

	it('lifts the run identifiers out of a run payload', () => {
		const line = buildJsonLogLine({
			level: 'cue',
			message: '[CUE] Run finished: nightly (completed)',
			context: 'Cue',
			data: {
				type: 'runFinished',
				runId: 'run-1',
				sessionId: 'agent-1',
				subscriptionName: 'nightly',
				pipelineId: 'Build Pipeline',
				status: 'completed',
			},
		});
		expect(line).toMatchObject({
			level: 'info',
			category: 'cue',
			context: 'Cue',
			event: 'runFinished',
			runId: 'run-1',
			sessionId: 'agent-1',
			subscriptionName: 'nightly',
			pipelineId: 'Build Pipeline',
			status: 'completed',
		});
	});

	it('never copies fields outside the allowlist', () => {
		const line = JSON.parse(
			formatJsonLogLine({
				level: 'info',
				message: 'm',
				data: { runId: 'r', prompt: 'secret prompt', token: 'sk-123', env: { API_KEY: 'x' } },
			})
		);
		expect(line.runId).toBe('r');
		expect(JSON.stringify(line)).not.toMatch(/secret prompt|sk-123|API_KEY/);
	});

	it('maps Maestro levels onto the four standard ones', () => {
		expect(buildJsonLogLine({ level: 'error', message: '' }).level).toBe('error');
		expect(buildJsonLogLine({ level: 'debug', message: '' }).level).toBe('debug');
		expect(buildJsonLogLine({ level: 'autorun', message: '' })).toMatchObject({
			level: 'info',
			category: 'autorun',
		});
		expect(buildJsonLogLine({ level: 'info', message: '' }).category).toBeUndefined();
	});

	it('ignores non-object or non-string id data', () => {
		expect(buildJsonLogLine({ level: 'info', message: 'm', data: 'text' })).not.toHaveProperty(
			'runId'
		);
		expect(
			buildJsonLogLine({ level: 'info', message: 'm', data: { runId: 42, sessionId: '' } })
		).not.toHaveProperty('runId');
	});
});
