/**
 * Tests for the Cue YAML loader module.
 *
 * Tests cover:
 * - Loading and parsing maestro-cue.yaml files
 * - Handling missing files
 * - Merging with default settings
 * - Validation of subscription fields per event type
 * - YAML file watching with debounce
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chokidar
const mockChokidarOn = vi.fn().mockReturnThis();
const mockChokidarClose = vi.fn();
vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: mockChokidarOn,
		close: mockChokidarClose,
	})),
}));

// Mock fs
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Must import after mocks
import { loadCueConfig, watchCueYaml, validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import * as chokidar from 'chokidar';

describe('cue-yaml-loader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('loadCueConfig', () => {
		it('returns null when neither canonical nor legacy file exists', () => {
			mockExistsSync.mockReturnValue(false);
			const result = loadCueConfig('/projects/test');
			expect(result).toBeNull();
		});

		it('loads from canonical .maestro/cue.yaml path first', () => {
			// Canonical path exists
			mockExistsSync.mockImplementation((p: string) => String(p).includes('.maestro/cue.yaml'));
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: canonical-sub
    event: time.interval
    prompt: From canonical
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].name).toBe('canonical-sub');
		});

		it('falls back to legacy maestro-cue.yaml when canonical does not exist', () => {
			// Only legacy path exists
			mockExistsSync.mockImplementation(
				(p: string) => String(p).includes('maestro-cue.yaml') && !String(p).includes('.maestro/')
			);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: legacy-sub
    event: time.interval
    prompt: From legacy
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].name).toBe('legacy-sub');
		});

		it('parses a valid YAML config with subscriptions and settings', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: daily-check
    event: time.interval
    enabled: true
    prompt: Check all tests
    interval_minutes: 60
  - name: watch-src
    event: file.changed
    enabled: true
    prompt: Run lint
    watch: "src/**/*.ts"
settings:
  timeout_minutes: 15
  timeout_on_fail: continue
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions).toHaveLength(2);
			expect(result!.subscriptions[0].name).toBe('daily-check');
			expect(result!.subscriptions[0].event).toBe('time.interval');
			expect(result!.subscriptions[0].interval_minutes).toBe(60);
			expect(result!.subscriptions[1].name).toBe('watch-src');
			expect(result!.subscriptions[1].watch).toBe('src/**/*.ts');
			expect(result!.settings.timeout_minutes).toBe(15);
			expect(result!.settings.timeout_on_fail).toBe('continue');
		});

		it('uses default settings when settings section is missing', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: test-sub
    event: time.interval
    prompt: Do stuff
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.settings.timeout_minutes).toBe(30);
			expect(result!.settings.timeout_on_fail).toBe('break');
			expect(result!.settings.max_concurrent).toBe(1);
			expect(result!.settings.queue_size).toBe(10);
		});

		it('defaults enabled to true when not specified', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: test-sub
    event: time.interval
    prompt: Do stuff
    interval_minutes: 10
`);

			const result = loadCueConfig('/projects/test');
			expect(result!.subscriptions[0].enabled).toBe(true);
		});

		it('respects enabled: false', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: disabled-sub
    event: time.interval
    enabled: false
    prompt: Do stuff
    interval_minutes: 10
`);

			const result = loadCueConfig('/projects/test');
			expect(result!.subscriptions[0].enabled).toBe(false);
		});

		it('returns null for empty YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('');
			const result = loadCueConfig('/projects/test');
			expect(result).toBeNull();
		});

		it('throws on malformed YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('{ invalid yaml [');
			expect(() => loadCueConfig('/projects/test')).toThrow();
		});

		it('handles agent.completed with source_session array', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: fan-in-trigger
    event: agent.completed
    prompt: All agents done
    source_session:
      - agent-1
      - agent-2
`);

			const result = loadCueConfig('/projects/test');
			expect(result!.subscriptions[0].source_session).toEqual(['agent-1', 'agent-2']);
		});
	});

	describe('watchCueYaml', () => {
		it('watches both canonical and legacy file paths', () => {
			watchCueYaml('/projects/test', vi.fn());
			// Should watch both .maestro/cue.yaml (canonical) and maestro-cue.yaml (legacy)
			expect(chokidar.watch).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.stringContaining('.maestro/cue.yaml'),
					expect.stringContaining('maestro-cue.yaml'),
				]),
				expect.objectContaining({ persistent: true, ignoreInitial: true })
			);
		});

		it('calls onChange with debounce on file change', () => {
			const onChange = vi.fn();
			watchCueYaml('/projects/test', onChange);

			// Simulate a 'change' event via the mock's on handler
			const changeHandler = mockChokidarOn.mock.calls.find(
				(call: unknown[]) => call[0] === 'change'
			)?.[1];
			expect(changeHandler).toBeDefined();

			changeHandler!();
			expect(onChange).not.toHaveBeenCalled(); // Not yet — debounced

			vi.advanceTimersByTime(1000);
			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it('debounces multiple rapid changes', () => {
			const onChange = vi.fn();
			watchCueYaml('/projects/test', onChange);

			const changeHandler = mockChokidarOn.mock.calls.find(
				(call: unknown[]) => call[0] === 'change'
			)?.[1];

			changeHandler!();
			vi.advanceTimersByTime(500);
			changeHandler!();
			vi.advanceTimersByTime(500);
			changeHandler!();
			vi.advanceTimersByTime(1000);

			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it('cleanup function closes watcher', () => {
			const cleanup = watchCueYaml('/projects/test', vi.fn());
			cleanup();
			expect(mockChokidarClose).toHaveBeenCalled();
		});

		it('registers handlers for add, change, and unlink events', () => {
			watchCueYaml('/projects/test', vi.fn());
			const registeredEvents = mockChokidarOn.mock.calls.map((call: unknown[]) => call[0]);
			expect(registeredEvents).toContain('add');
			expect(registeredEvents).toContain('change');
			expect(registeredEvents).toContain('unlink');
		});
	});

	describe('validateCueConfig', () => {
		it('returns valid for a correct config', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: 'test', event: 'time.interval', prompt: 'Do it', interval_minutes: 5 },
				],
				settings: { timeout_minutes: 30, timeout_on_fail: 'break' },
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('rejects non-object config', () => {
			const result = validateCueConfig(null);
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('non-null object');
		});

		it('requires subscriptions array', () => {
			const result = validateCueConfig({ settings: {} });
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('subscriptions');
		});

		it('requires name on subscriptions', () => {
			const result = validateCueConfig({
				subscriptions: [{ event: 'time.interval', prompt: 'Test', interval_minutes: 5 }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('"name"')]));
		});

		it('requires interval_minutes for time.interval', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'time.interval', prompt: 'Do it' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('interval_minutes')])
			);
		});

		it('requires watch for file.changed', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'file.changed', prompt: 'Do it' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('watch')]));
		});

		it('requires source_session for agent.completed', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'agent.completed', prompt: 'Do it' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('source_session')])
			);
		});

		it('rejects invalid timeout_on_fail value', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { timeout_on_fail: 'invalid' },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('timeout_on_fail')])
			);
		});

		it('accepts valid timeout_on_fail values', () => {
			const breakResult = validateCueConfig({
				subscriptions: [],
				settings: { timeout_on_fail: 'break' },
			});
			expect(breakResult.valid).toBe(true);

			const continueResult = validateCueConfig({
				subscriptions: [],
				settings: { timeout_on_fail: 'continue' },
			});
			expect(continueResult.valid).toBe(true);
		});

		it('rejects invalid max_concurrent value', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { max_concurrent: 0 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('max_concurrent')])
			);
		});

		it('rejects max_concurrent above 10', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { max_concurrent: 11 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('max_concurrent')])
			);
		});

		it('rejects non-integer max_concurrent', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { max_concurrent: 1.5 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('max_concurrent')])
			);
		});

		it('accepts valid max_concurrent values', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { max_concurrent: 5 },
			});
			expect(result.valid).toBe(true);
		});

		it('rejects negative queue_size', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { queue_size: -1 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('queue_size')])
			);
		});

		it('rejects queue_size above 50', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { queue_size: 51 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('queue_size')])
			);
		});

		it('accepts valid queue_size values including 0', () => {
			const result = validateCueConfig({
				subscriptions: [],
				settings: { queue_size: 0 },
			});
			expect(result.valid).toBe(true);
		});

		it('requires prompt to be a non-empty string', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'time.interval', interval_minutes: 5 }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('"prompt"')]));
		});

		it('accepts valid filter with string/number/boolean values', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'file.changed',
						prompt: 'Do it',
						watch: 'src/**',
						filter: { extension: '.ts', active: true, priority: 5 },
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('rejects filter with nested object values', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'file.changed',
						prompt: 'Do it',
						watch: 'src/**',
						filter: { nested: { deep: 'value' } },
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('filter key "nested"')])
			);
		});

		it('rejects filter that is an array', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'file.changed',
						prompt: 'Do it',
						watch: 'src/**',
						filter: ['not', 'valid'],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('"filter" must be a plain object')])
			);
		});

		it('rejects filter with null value', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'file.changed',
						prompt: 'Do it',
						watch: 'src/**',
						filter: null,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('"filter" must be a plain object')])
			);
		});
	});

	describe('loadCueConfig with GitHub events', () => {
		it('parses repo and poll_minutes from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: pr-watch
    event: github.pull_request
    prompt: Review the PR
    repo: owner/repo
    poll_minutes: 10
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].repo).toBe('owner/repo');
			expect(result!.subscriptions[0].poll_minutes).toBe(10);
		});

		it('defaults poll_minutes to undefined when not specified', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: issue-watch
    event: github.issue
    prompt: Triage issue
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].poll_minutes).toBeUndefined();
			expect(result!.subscriptions[0].repo).toBeUndefined();
		});
	});

	describe('validateCueConfig for GitHub events', () => {
		it('accepts valid github.pull_request subscription', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'pr-watch', event: 'github.pull_request', prompt: 'Review it' }],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('accepts github.pull_request with repo and poll_minutes', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'pr-watch',
						event: 'github.pull_request',
						prompt: 'Review it',
						repo: 'owner/repo',
						poll_minutes: 10,
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('rejects github.pull_request with poll_minutes < 1', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'pr-watch',
						event: 'github.pull_request',
						prompt: 'Review',
						poll_minutes: 0.5,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('poll_minutes')])
			);
		});

		it('rejects github.pull_request with poll_minutes = 0', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'pr-watch',
						event: 'github.pull_request',
						prompt: 'Review',
						poll_minutes: 0,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('poll_minutes')])
			);
		});

		it('rejects github.issue with non-string repo', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'issue-watch',
						event: 'github.issue',
						prompt: 'Triage',
						repo: 123,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('"repo" must be a string')])
			);
		});

		it('accepts github.issue with filter', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'issue-watch',
						event: 'github.issue',
						prompt: 'Triage',
						filter: { author: 'octocat', labels: 'bug' },
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe('validateCueConfig for task.pending events', () => {
		it('accepts valid task.pending subscription', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						prompt: 'Process tasks',
						watch: 'tasks/**/*.md',
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('requires watch for task.pending', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'task-queue', event: 'task.pending', prompt: 'Process tasks' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('watch')]));
		});

		it('accepts task.pending with poll_minutes', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						prompt: 'Process',
						watch: 'tasks/**/*.md',
						poll_minutes: 5,
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('rejects task.pending with poll_minutes < 1', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						prompt: 'Process',
						watch: 'tasks/**/*.md',
						poll_minutes: 0,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('poll_minutes')])
			);
		});
	});

	describe('loadCueConfig with task.pending', () => {
		it('parses watch and poll_minutes from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: task-queue
    event: task.pending
    prompt: Process the tasks
    watch: "tasks/**/*.md"
    poll_minutes: 2
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].event).toBe('task.pending');
			expect(result!.subscriptions[0].watch).toBe('tasks/**/*.md');
			expect(result!.subscriptions[0].poll_minutes).toBe(2);
		});
	});

	describe('loadCueConfig with filter', () => {
		it('parses filter field from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: ts-only
    event: file.changed
    prompt: Review it
    watch: "src/**/*"
    filter:
      extension: ".ts"
      path: "!*.test.ts"
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].filter).toEqual({
				extension: '.ts',
				path: '!*.test.ts',
			});
		});

		it('parses filter with boolean and numeric values', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: filtered
    event: agent.completed
    prompt: Do it
    source_session: agent-1
    filter:
      active: true
      exitCode: 0
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].filter).toEqual({
				active: true,
				exitCode: 0,
			});
		});

		it('ignores filter with invalid nested values', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bad-filter
    event: file.changed
    prompt: Do it
    watch: "src/**"
    filter:
      nested:
        deep: value
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].filter).toBeUndefined();
		});
	});
});
