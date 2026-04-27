import { describe, expect, it } from 'vitest';
import { buildCueRunSummary, getCueEventDetail } from '../../../shared/cue/cue-summary';
import type { CueEvent, CueRunResult } from '../../../shared/cue/contracts';

function makeEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'file.changed',
		timestamp: '2026-04-27T12:00:00.000Z',
		triggerName: 'sub',
		payload: {},
		...overrides,
	};
}

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'sess-1',
		sessionName: 'rc',
		subscriptionName: 'Maestro-chain-2',
		event: makeEvent(),
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 1000,
		startedAt: '2026-04-27T12:00:00.000Z',
		endedAt: '2026-04-27T12:00:01.000Z',
		...overrides,
	};
}

describe('getCueEventDetail', () => {
	it('formats github.issue with number and title', () => {
		const event = makeEvent({
			type: 'github.issue',
			payload: { number: 891, title: 'Feature: Support arbitrary CLI agents' },
		});
		expect(getCueEventDetail(event)).toBe('#891 Feature: Support arbitrary CLI agents');
	});

	it('formats github.pull_request with number only when title missing', () => {
		const event = makeEvent({
			type: 'github.pull_request',
			payload: { number: 909 },
		});
		expect(getCueEventDetail(event)).toBe('#909');
	});

	it('returns just the basename for file.changed', () => {
		const event = makeEvent({
			type: 'file.changed',
			payload: { path: '/repo/src/main/cue.ts' },
		});
		expect(getCueEventDetail(event)).toBe('cue.ts');
	});

	it('formats task.pending with count and noun agreement', () => {
		expect(
			getCueEventDetail(
				makeEvent({ type: 'task.pending', payload: { filename: 'deploy.md', taskCount: 1 } })
			)
		).toBe('deploy.md (1 task)');
		expect(
			getCueEventDetail(
				makeEvent({ type: 'task.pending', payload: { filename: 'deploy.md', taskCount: 3 } })
			)
		).toBe('deploy.md (3 tasks)');
		expect(
			getCueEventDetail(
				makeEvent({ type: 'task.pending', payload: { filename: 'deploy.md', taskCount: 0 } })
			)
		).toBe('deploy.md');
	});

	it('credits the source agent for agent.completed', () => {
		const event = makeEvent({
			type: 'agent.completed',
			payload: { sourceSession: 'builder' },
		});
		expect(getCueEventDetail(event)).toBe('from builder');
	});

	it('returns undefined for events with no useful payload', () => {
		expect(getCueEventDetail(makeEvent({ type: 'app.startup', payload: {} }))).toBeUndefined();
		expect(getCueEventDetail(makeEvent({ type: 'time.heartbeat', payload: {} }))).toBeUndefined();
		expect(getCueEventDetail(makeEvent({ type: 'time.scheduled', payload: {} }))).toBeUndefined();
		expect(getCueEventDetail(makeEvent({ type: 'github.issue', payload: {} }))).toBeUndefined();
	});

	it('truncates very long cli.trigger prompts', () => {
		const long = 'do '.repeat(100);
		const detail = getCueEventDetail(
			makeEvent({ type: 'cli.trigger', payload: { cliPrompt: long } })
		);
		expect(detail?.endsWith('…')).toBe(true);
		expect(detail?.length).toBe(81);
	});
});

describe('buildCueRunSummary', () => {
	it('strips -chain-N suffix and surfaces chain index after agent (legacy YAML)', () => {
		const result = makeResult({
			subscriptionName: 'Maestro-chain-2',
			sessionName: 'rc',
			pipelineName: undefined,
			event: makeEvent({
				type: 'github.issue',
				payload: { number: 891, title: 'Feature: Support arbitrary CLI agents' },
			}),
		});
		expect(buildCueRunSummary(result)).toBe(
			'"Maestro" · rc #2 — #891 Feature: Support arbitrary CLI agents'
		);
	});

	it('uses pipeline_name as the trigger label when set (preferred over chain stripping)', () => {
		const result = makeResult({
			subscriptionName: 'Maestro-chain-2',
			sessionName: 'rc',
			pipelineName: 'PR Triage Main',
			event: makeEvent({
				type: 'github.issue',
				payload: { number: 891, title: 'Feature: Support arbitrary CLI agents' },
			}),
		});
		expect(buildCueRunSummary(result)).toBe(
			'"PR Triage Main" · rc #2 — #891 Feature: Support arbitrary CLI agents'
		);
	});

	it('marks fan-in subscriptions with (fan-in) tag', () => {
		const result = makeResult({
			subscriptionName: 'Maestro-fanin',
			sessionName: 'rc',
			pipelineName: undefined,
			event: makeEvent({ type: 'agent.completed', payload: { sourceSession: 'builder' } }),
		});
		expect(buildCueRunSummary(result)).toBe('"Maestro" · rc (fan-in) — from builder');
	});

	it('handles fan-in tracker colon-keyed names by taking the first segment', () => {
		const result = makeResult({
			subscriptionName: 'Maestro-chain-2:Maestro-chain-3',
			sessionName: 'rc',
			pipelineName: undefined,
			event: makeEvent({ type: 'time.heartbeat', payload: {} }),
		});
		expect(buildCueRunSummary(result)).toBe('"Maestro" · rc #2');
	});

	it('omits the agent half when sessionName equals subscriptionName', () => {
		const result = makeResult({
			subscriptionName: 'Hourly Sync',
			sessionName: 'Hourly Sync',
			event: makeEvent({ type: 'time.heartbeat', payload: {} }),
		});
		expect(buildCueRunSummary(result)).toBe('"Hourly Sync"');
	});

	it('omits the detail half when the event has no useful payload', () => {
		const result = makeResult({
			subscriptionName: 'Boot Hook',
			sessionName: 'rc',
			event: makeEvent({ type: 'app.startup', payload: {} }),
		});
		expect(buildCueRunSummary(result)).toBe('"Boot Hook" · rc');
	});

	it('drops the legacy [CUE] prefix, (eventType) suffix, and -chain-N suffix', () => {
		const summary = buildCueRunSummary(
			makeResult({
				subscriptionName: 'Maestro-chain-4',
				sessionName: 'rc',
				event: makeEvent({
					type: 'github.pull_request',
					payload: { number: 909, title: 'fix(cli): register copilot-cli' },
				}),
			})
		);
		expect(summary.startsWith('[CUE]')).toBe(false);
		expect(summary).not.toContain('(github.pull_request)');
		expect(summary).not.toContain('-chain-');
	});
});
