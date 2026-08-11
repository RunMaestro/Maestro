import { describe, expect, it } from 'vitest';
import {
	buildCueRunSummary,
	extractCueOutputExcerpt,
	getCueEventDetail,
	humanizeCueEventType,
} from '../../../shared/cue/cue-summary';
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

	it('formats time triggers as a cadence when an interval is present', () => {
		expect(
			getCueEventDetail(makeEvent({ type: 'time.heartbeat', payload: { interval_minutes: 3 } }))
		).toBe('every 3 min');
		expect(
			getCueEventDetail(makeEvent({ type: 'time.heartbeat', payload: { interval_minutes: 60 } }))
		).toBe('hourly');
		expect(
			getCueEventDetail(makeEvent({ type: 'time.scheduled', payload: { intervalMinutes: 120 } }))
		).toBe('every 2 hr');
	});
});

describe('humanizeCueEventType', () => {
	it('maps known event types to their display labels', () => {
		expect(humanizeCueEventType('time.heartbeat')).toBe('Heartbeat Timer');
		expect(humanizeCueEventType('github.pull_request')).toBe('Pull Request');
		expect(humanizeCueEventType('task.pending')).toBe('Pending Task');
	});

	it('prettifies unknown/legacy types instead of leaking machine jargon', () => {
		expect(humanizeCueEventType('custom.special_thing')).toBe('Custom Special_thing');
		expect(humanizeCueEventType(undefined)).toBe('Trigger');
		expect(humanizeCueEventType('')).toBe('Trigger');
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
			'"Maestro" · rc #2 - #891 Feature: Support arbitrary CLI agents'
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
			'"PR Triage Main" · rc #2 - #891 Feature: Support arbitrary CLI agents'
		);
	});

	it('marks fan-in subscriptions with (fan-in) tag', () => {
		const result = makeResult({
			subscriptionName: 'Maestro-fanin',
			sessionName: 'rc',
			pipelineName: undefined,
			event: makeEvent({ type: 'agent.completed', payload: { sourceSession: 'builder' } }),
		});
		expect(buildCueRunSummary(result)).toBe('"Maestro" · rc (fan-in) - from builder');
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

describe('extractCueOutputExcerpt', () => {
	it('returns undefined for empty / whitespace / nullish input', () => {
		expect(extractCueOutputExcerpt(undefined)).toBeUndefined();
		expect(extractCueOutputExcerpt(null)).toBeUndefined();
		expect(extractCueOutputExcerpt('')).toBeUndefined();
		expect(extractCueOutputExcerpt('   \n\t  ')).toBeUndefined();
	});

	it('takes up to two complete sentences from the stdout', () => {
		const stdout =
			'Briefing written to 2026-05-13-AM.md. Podcast generated at 2026-05-13-Podcast.mp3 (2.3 MB / ~2.34M bytes). Top of the day: Calendar is light.';
		expect(extractCueOutputExcerpt(stdout)).toBe(
			'Briefing written to 2026-05-13-AM.md. Podcast generated at 2026-05-13-Podcast.mp3 (2.3 MB / ~2.34M bytes).'
		);
	});

	it('does not split inside filenames or decimals', () => {
		// `.md` followed by lowercase / digits shouldn't terminate a sentence.
		const stdout = 'Saved to plan.md and updated 2.34M bytes.';
		expect(extractCueOutputExcerpt(stdout)).toBe('Saved to plan.md and updated 2.34M bytes.');
	});

	it('drops the second sentence when adding it would exceed the cap', () => {
		const first = 'First sentence here.';
		const second = `Word${' word'.repeat(60)}.`; // ~300 chars, starts uppercase so split fires
		const stdout = `${first} ${second}`;
		expect(extractCueOutputExcerpt(stdout, { maxChars: 100 })).toBe(first);
	});

	it('returns the single sentence even when only one fits', () => {
		const stdout = 'Done. The next sentence is much longer than the cap allows by design.';
		expect(extractCueOutputExcerpt(stdout, { maxChars: 50 })).toBe('Done.');
	});

	it('returns undefined when even the first sentence exceeds the cap', () => {
		const stdout = `${'word '.repeat(80).trim()}.`;
		expect(extractCueOutputExcerpt(stdout, { maxChars: 50 })).toBeUndefined();
	});

	it('strips markdown formatting before counting', () => {
		const stdout = '**Bold lead.** Plain follow-up sentence.';
		expect(extractCueOutputExcerpt(stdout)).toBe('Bold lead. Plain follow-up sentence.');
	});

	it('strips ANSI color codes from stdout', () => {
		const stdout = '\x1b[32mAll green.\x1b[0m Status nominal.';
		expect(extractCueOutputExcerpt(stdout)).toBe('All green. Status nominal.');
	});

	it('handles bullet-list output by treating list lines as a single flowed sentence', () => {
		// stripMarkdown turns "- item" into "- item"; whitespace normalization
		// joins the lines. Without terminal punctuation, the whole thing reads
		// as one "sentence" - verify we still return something useful and don't
		// crash.
		const stdout = '# Briefing\n\n- Item one\n- Item two\n- Item three';
		const out = extractCueOutputExcerpt(stdout, { maxChars: 240 });
		expect(out).toBe('Briefing - Item one - Item two - Item three');
	});

	it('respects maxSentences=1', () => {
		const stdout = 'First. Second. Third.';
		expect(extractCueOutputExcerpt(stdout, { maxSentences: 1 })).toBe('First.');
	});

	it('drops markdown table grids so they never reach the History summary', () => {
		const stdout = [
			'All four steps complete.',
			'',
			'| Step | Result |',
			'|------|--------|',
			'| 1. Build | Pass |',
			'| 2. Test | Pass |',
		].join('\n');
		const out = extractCueOutputExcerpt(stdout);
		expect(out).toBe('All four steps complete.');
		expect(out).not.toContain('|');
	});
});
