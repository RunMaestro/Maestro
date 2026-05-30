import { describe, it, expect } from 'vitest';

import {
	DEFAULT_EVENT_PROMPTS,
	defaultPromptFor,
} from '../../../../../renderer/components/CuePipelineEditor/cueEventConstants';
import type { CueEventType } from '../../../../../shared/cue-pipeline-types';

const ALL_EVENT_TYPES: CueEventType[] = [
	'app.startup',
	'time.heartbeat',
	'time.scheduled',
	'file.changed',
	'agent.completed',
	'github.pull_request',
	'github.issue',
	'task.pending',
	'cli.trigger',
];

describe('DEFAULT_EVENT_PROMPTS', () => {
	it('has an entry for every CueEventType (no undefined fallthroughs)', () => {
		for (const eventType of ALL_EVENT_TYPES) {
			expect(DEFAULT_EVENT_PROMPTS).toHaveProperty(eventType);
			expect(typeof DEFAULT_EVENT_PROMPTS[eventType]).toBe('string');
		}
	});

	it('GitHub templates include their dedicated template variables', () => {
		expect(DEFAULT_EVENT_PROMPTS['github.issue']).toContain('{{CUE_GH_URL}}');
		expect(DEFAULT_EVENT_PROMPTS['github.issue']).toContain('{{CUE_GH_BODY}}');
		expect(DEFAULT_EVENT_PROMPTS['github.pull_request']).toContain('{{CUE_GH_URL}}');
		expect(DEFAULT_EVENT_PROMPTS['github.pull_request']).toContain('{{CUE_GH_BRANCH}}');
	});

	it('file.changed template references CUE_FILE_PATH', () => {
		expect(DEFAULT_EVENT_PROMPTS['file.changed']).toContain('{{CUE_FILE_PATH}}');
	});

	it('agent.completed template references CUE_SOURCE_OUTPUT', () => {
		expect(DEFAULT_EVENT_PROMPTS['agent.completed']).toContain('{{CUE_SOURCE_OUTPUT}}');
	});

	it('task.pending template references CUE_TASK_LIST', () => {
		expect(DEFAULT_EVENT_PROMPTS['task.pending']).toContain('{{CUE_TASK_LIST}}');
	});

	it('cli.trigger template references CUE_CLI_PROMPT', () => {
		expect(DEFAULT_EVENT_PROMPTS['cli.trigger']).toContain('{{CUE_CLI_PROMPT}}');
	});

	it('time-based and startup triggers default to empty string', () => {
		expect(DEFAULT_EVENT_PROMPTS['time.heartbeat']).toBe('');
		expect(DEFAULT_EVENT_PROMPTS['time.scheduled']).toBe('');
		expect(DEFAULT_EVENT_PROMPTS['app.startup']).toBe('');
	});
});

describe('defaultPromptFor', () => {
	it('returns the template for each event type', () => {
		for (const eventType of ALL_EVENT_TYPES) {
			expect(defaultPromptFor(eventType)).toBe(DEFAULT_EVENT_PROMPTS[eventType]);
		}
	});

	it('returns empty string for an unknown event type (defensive)', () => {
		expect(defaultPromptFor('something.unknown' as CueEventType)).toBe('');
	});
});
