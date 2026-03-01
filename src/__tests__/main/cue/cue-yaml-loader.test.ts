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
		it('returns null when file does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			const result = loadCueConfig('/projects/test');
			expect(result).toBeNull();
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
		it('watches the correct file path', () => {
			watchCueYaml('/projects/test', vi.fn());
			expect(chokidar.watch).toHaveBeenCalledWith(
				expect.stringContaining('maestro-cue.yaml'),
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
	});
});
