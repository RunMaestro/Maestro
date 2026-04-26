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
// readPromptFile in cue-config-normalizer uses fs.realpathSync.native to harden
// its containment check. These tests use fake paths (`/projects/test/...`) that
// don't exist on disk, so we stub realpath as an identity function — the
// mocked paths have no symlinks, making this the correct canonical path.
const mockRealpathSyncNative = vi.fn((p: string) => p);
vi.mock('fs', () => {
	const realpathSync = (p: string) => mockRealpathSyncNative(p);
	(realpathSync as unknown as { native: (p: string) => string }).native = (p: string) =>
		mockRealpathSyncNative(p);
	return {
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
		readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
		realpathSync,
	};
});

// Must import after mocks
import {
	findAncestorCueConfigRoot,
	loadCueConfig,
	loadCueConfigDetailed,
	watchCueYaml,
	validateCueConfig,
} from '../../../main/cue/cue-yaml-loader';
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
    event: time.heartbeat
    prompt: From canonical
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].name).toBe('canonical-sub');
		});

		it('parses an action: command shell subscription with no prompt', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: lint-on-save
    event: file.changed
    watch: 'src/**/*.ts'
    action: command
    command:
      mode: shell
      shell: npm run lint
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions).toHaveLength(1);
			const sub = result!.subscriptions[0];
			expect(sub.action).toBe('command');
			expect(sub.command).toEqual({ mode: 'shell', shell: 'npm run lint' });
			// `prompt` is back-filled from the command spec so the dispatch sentinel is non-empty.
			expect(sub.prompt).toBe('npm run lint');
		});

		it('parses an action: command cli send subscription', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: relay
    event: agent.completed
    source_session: researcher
    action: command
    command:
      mode: cli
      cli:
        command: send
        target: '{{CUE_FROM_AGENT}}'
        message: 'Result: {{CUE_SOURCE_OUTPUT}}'
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			const sub = result!.subscriptions[0];
			expect(sub.action).toBe('command');
			expect(sub.command).toEqual({
				mode: 'cli',
				cli: {
					command: 'send',
					target: '{{CUE_FROM_AGENT}}',
					message: 'Result: {{CUE_SOURCE_OUTPUT}}',
				},
			});
		});

		it('falls back to legacy maestro-cue.yaml when canonical does not exist', () => {
			// Only legacy path exists
			mockExistsSync.mockImplementation(
				(p: string) => String(p).includes('maestro-cue.yaml') && !String(p).includes('.maestro/')
			);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: legacy-sub
    event: time.heartbeat
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
    event: time.heartbeat
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
			expect(result!.subscriptions[0].event).toBe('time.heartbeat');
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
    event: time.heartbeat
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
    event: time.heartbeat
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
    event: time.heartbeat
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

		it('resolves prompt_file to prompt content when prompt is empty', () => {
			// First call: existsSync for config file (true), then for prompt file path (true)
			let readCallCount = 0;
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				readCallCount++;
				if (String(p).endsWith('.maestro/prompts/worker-pipeline.md')) {
					return 'Prompt from external file';
				}
				return `
subscriptions:
  - name: test-sub
    event: time.heartbeat
    prompt_file: .maestro/prompts/worker-pipeline.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			// The normalizer reads the prompt file at config-load time and stores the
			// resolved content on `prompt`. The raw `prompt_file` field from YAML is
			// internal-only (CueSubscriptionDocument) and not part of the runtime contract.
			expect(result!.subscriptions[0].prompt).toBe('Prompt from external file');
		});

		it('keeps inline prompt when both prompt and prompt_file exist', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: test-sub
    event: time.heartbeat
    prompt: Inline prompt text
    prompt_file: .maestro/prompts/should-be-ignored.md
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result!.subscriptions[0].prompt).toBe('Inline prompt text');
		});

		it('resolves output_prompt_file to output_prompt content', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				if (String(p).endsWith('.maestro/prompts/format-output.md')) {
					return 'Format the output as markdown';
				}
				return `
subscriptions:
  - name: test-sub
    event: time.heartbeat
    prompt: Do the thing
    output_prompt_file: .maestro/prompts/format-output.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			// Same rationale as the prompt_file test above: output_prompt_file is
			// resolved into output_prompt at config-load time.
			expect(result!.subscriptions[0].output_prompt).toBe('Format the output as markdown');
		});

		it('keeps inline output_prompt when both output_prompt and output_prompt_file exist', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: test-sub
    event: time.heartbeat
    prompt: Do the thing
    output_prompt: Inline output prompt
    output_prompt_file: .maestro/prompts/should-be-ignored.md
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result!.subscriptions[0].output_prompt).toBe('Inline output prompt');
		});

		it('sets output_prompt to undefined when output_prompt_file is missing', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				if (String(p).endsWith('.maestro/prompts/missing.md')) {
					throw new Error('ENOENT: no such file or directory');
				}
				return `
subscriptions:
  - name: test-sub
    event: time.heartbeat
    prompt: Do the thing
    output_prompt_file: .maestro/prompts/missing.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].output_prompt).toBeUndefined();
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

	describe('loadCueConfigDetailed', () => {
		it('returns { ok: false, reason: "missing" } when no config file exists', () => {
			mockExistsSync.mockReturnValue(false);

			const result = loadCueConfigDetailed('/projects/test');

			expect(result).toEqual({ ok: false, reason: 'missing' });
		});

		it('returns { ok: false, reason: "parse-error" } for malformed YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('{ invalid yaml [');

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe('parse-error');
				if (result.reason === 'parse-error') {
					expect(result.message).toBeTruthy();
				}
			}
		});

		it('returns { ok: false, reason: "parse-error" } when YAML root is not a mapping', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('- a\n- b\n- c\n');

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(false);
			if (!result.ok && result.reason === 'parse-error') {
				expect(result.message).toMatch(/mapping/);
			}
		});

		it('skips per-subscription validation errors and surfaces them as warnings', () => {
			// Lenient loader: a single broken subscription must not block valid
			// subs in the same YAML. The bad sub is dropped, others load, and
			// the failure is surfaced as a warning so the user can fix it.
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bad-sub
    event: time.heartbeat
    prompt: Hi
  - name: good-sub
    event: time.heartbeat
    prompt: Check status
    interval_minutes: 5
`);

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.subscriptions.map((s) => s.name)).toEqual(['good-sub']);
				expect(result.warnings).toEqual(
					expect.arrayContaining([
						expect.stringMatching(/Skipped invalid subscription.*interval_minutes/),
					])
				);
			}
		});

		it('returns { ok: false, reason: "invalid" } only for config-level errors', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions: not-an-array
`);

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(false);
			if (!result.ok && result.reason === 'invalid') {
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringMatching(/subscriptions/)])
				);
			}
		});

		it('returns { ok: true, config, warnings: [] } for a valid config', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: heartbeat-sub
    event: time.heartbeat
    prompt: Check status
    interval_minutes: 5
`);

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.subscriptions).toHaveLength(1);
				expect(result.config.subscriptions[0].name).toBe('heartbeat-sub');
				expect(result.warnings).toEqual([]);
			}
		});

		it('surfaces a warning when prompt_file references a missing file', () => {
			let readCount = 0;
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				readCount++;
				if (String(p).endsWith('.maestro/prompts/missing.md')) {
					throw new Error('ENOENT: no such file');
				}
				return `
subscriptions:
  - name: file-sub
    event: time.heartbeat
    prompt_file: .maestro/prompts/missing.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfigDetailed('/projects/test');

			expect(readCount).toBeGreaterThanOrEqual(1);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.warnings.length).toBeGreaterThan(0);
				expect(result.warnings[0]).toContain('file-sub');
				expect(result.warnings[0]).toContain('missing.md');
			}
		});

		it('surfaces a warning when output_prompt_file references a missing file', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				if (String(p).endsWith('.maestro/prompts/missing-output.md')) {
					throw new Error('ENOENT: no such file');
				}
				return `
subscriptions:
  - name: out-sub
    event: time.heartbeat
    prompt: Main prompt
    output_prompt_file: .maestro/prompts/missing-output.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.warnings.length).toBeGreaterThan(0);
				expect(result.warnings[0]).toContain('out-sub');
				expect(result.warnings[0]).toContain('missing-output.md');
			}
		});

		it('returns no warnings when prompt_file resolves successfully', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation((p: string) => {
				if (String(p).endsWith('.maestro/prompts/exists.md')) {
					return 'Resolved prompt body';
				}
				return `
subscriptions:
  - name: file-sub
    event: time.heartbeat
    prompt_file: .maestro/prompts/exists.md
    interval_minutes: 5
`;
			});

			const result = loadCueConfigDetailed('/projects/test');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.warnings).toEqual([]);
				expect(result.config.subscriptions[0].prompt).toBe('Resolved prompt body');
			}
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
					{ name: 'test', event: 'time.heartbeat', prompt: 'Do it', interval_minutes: 5 },
				],
				settings: { timeout_minutes: 30, timeout_on_fail: 'break' },
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('treats null config as valid empty config (comments-only file)', () => {
			const result = validateCueConfig(null);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('rejects non-object non-null config', () => {
			const result = validateCueConfig(42);
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
				subscriptions: [{ event: 'time.heartbeat', prompt: 'Test', interval_minutes: 5 }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('"name"')]));
		});

		it('requires interval_minutes for time.heartbeat', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'time.heartbeat', prompt: 'Do it' }],
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

		it('accepts prompt_file as alternative to prompt', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt_file: '.maestro/prompts/test.md',
						interval_minutes: 5,
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('rejects subscription with neither prompt nor prompt_file', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'time.heartbeat', interval_minutes: 5 }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						'"prompt", "prompt_file", "fan_out_prompt_files", or "fan_out_prompts" is required'
					),
				])
			);
		});

		it('accepts a fan-out subscription with fan_out_prompt_files and no prompt/prompt_file', () => {
			// Regression: Commit 7 externalized per-agent fan-out prompts to
			// individual files. The validator USED to require `prompt` or
			// `prompt_file`, so these YAMLs were rejected by the lenient
			// loader partition — which caused the entire pipeline to vanish
			// from the UI when the user saved differing per-agent prompts.
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'fan-out',
						event: 'app.startup',
						fan_out: ['A', 'B', 'C'],
						fan_out_prompt_files: [
							'.maestro/prompts/a.md',
							'.maestro/prompts/b.md',
							'.maestro/prompts/c.md',
						],
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it('accepts a fan-out subscription with legacy inline fan_out_prompts', () => {
			// Same requirement for the older inline array shape.
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'legacy-fan-out',
						event: 'app.startup',
						fan_out: ['A', 'B'],
						fan_out_prompts: ['do A', 'do B'],
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it('rejects a fan-out subscription with empty fan_out_prompt_files array', () => {
			// Empty array carries no prompts — don't let it slip past the
			// "at least one prompt source" check.
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'empty-fan-out-files',
						event: 'app.startup',
						fan_out: ['A'],
						fan_out_prompt_files: [],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						'"prompt", "prompt_file", "fan_out_prompt_files", or "fan_out_prompts" is required'
					),
				])
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
				subscriptions: [{ name: 'test', event: 'time.heartbeat', interval_minutes: 5 }],
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

		it('rejects unknown event types with a helpful message', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'typo', event: 'file.change', prompt: 'Do it', watch: 'src/**' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('unknown event type "file.change"')])
			);
			expect(result.errors[0]).toContain('Valid types:');
		});

		it('rejects completely bogus event types', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'bogus', event: 'webhook.incoming', prompt: 'Run' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('unknown event type "webhook.incoming"')])
			);
		});

		it('does not reject known event types as unknown', () => {
			const knownTypes = [
				{ event: 'time.heartbeat', interval_minutes: 5 },
				{ event: 'time.scheduled', schedule_times: ['09:00'] },
				{ event: 'file.changed', watch: '**/*.ts' },
				{ event: 'agent.completed', source_session: 'agent-1' },
				{ event: 'github.pull_request' },
				{ event: 'github.issue' },
				{ event: 'task.pending', watch: '*.md' },
			];
			for (const typeConfig of knownTypes) {
				const result = validateCueConfig({
					subscriptions: [{ name: 'test', prompt: 'Run', ...typeConfig }],
				});
				expect(result.errors.filter((e: string) => e.includes('unknown event type'))).toHaveLength(
					0
				);
			}
		});

		it('rejects invalid gh_state values for GitHub triggers', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: 'test', event: 'github.pull_request', prompt: 'Run', gh_state: 'invalid' },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('"gh_state" must be one of')])
			);
		});

		it('rejects gh_state "merged" for github.issue events', () => {
			const result = validateCueConfig({
				subscriptions: [{ name: 'test', event: 'github.issue', prompt: 'Run', gh_state: 'merged' }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining('"merged" is only valid for github.pull_request'),
				])
			);
		});

		it('accepts valid gh_state values for GitHub triggers', () => {
			for (const ghState of ['open', 'closed', 'merged', 'all']) {
				const result = validateCueConfig({
					subscriptions: [
						{ name: 'test', event: 'github.pull_request', prompt: 'Run', gh_state: ghState },
					],
				});
				const ghStateErrors = result.errors.filter((e: string) => e.includes('gh_state'));
				expect(ghStateErrors).toHaveLength(0);
			}
		});

		describe('action: command', () => {
			it('accepts a shell command subscription with no prompt', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'lint',
							event: 'time.heartbeat',
							interval_minutes: 5,
							action: 'command',
							command: { mode: 'shell', shell: 'npm run lint' },
						},
					],
				});
				expect(result.valid).toBe(true);
				expect(result.errors).toHaveLength(0);
			});

			it('accepts a cli send subscription with target', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'forward',
							event: 'agent.completed',
							source_session: 'researcher',
							action: 'command',
							command: {
								mode: 'cli',
								cli: { command: 'send', target: '{{CUE_FROM_AGENT}}' },
							},
						},
					],
				});
				expect(result.valid).toBe(true);
				expect(result.errors).toHaveLength(0);
			});

			it('rejects a command subscription missing the command field', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'broken',
							event: 'time.heartbeat',
							interval_minutes: 5,
							action: 'command',
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"command" is required')])
				);
			});

			it('rejects a shell command with empty shell string', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'broken',
							event: 'time.heartbeat',
							interval_minutes: 5,
							action: 'command',
							command: { mode: 'shell', shell: '   ' },
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"command.shell" is required')])
				);
			});

			it('rejects a cli command with missing target', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'broken',
							event: 'agent.completed',
							source_session: 'a',
							action: 'command',
							command: { mode: 'cli', cli: { command: 'send', target: '' } },
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"command.cli.target" is required')])
				);
			});

			it('rejects a cli command with unsupported sub-command', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'broken',
							event: 'agent.completed',
							source_session: 'a',
							action: 'command',
							command: { mode: 'cli', cli: { command: 'broadcast', target: 'x' } },
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"command.cli.command" must be "send"')])
				);
			});

			it('rejects an unknown action value', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'bad',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'x',
							action: 'invalid',
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"action" must be')])
				);
			});

			it('rejects an unknown command.mode', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'bad',
							event: 'time.heartbeat',
							interval_minutes: 5,
							action: 'command',
							command: { mode: 'rocket', shell: 'true' },
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"command.mode" must be')])
				);
			});

			it('still requires prompt or prompt_file when action is "prompt" (or omitted)', () => {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: 'no-prompt',
							event: 'time.heartbeat',
							interval_minutes: 5,
							action: 'prompt',
						},
					],
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toEqual(
					expect.arrayContaining([expect.stringContaining('"prompt", "prompt_file"')])
				);
			});
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

		it('parses gh_state from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: merged-prs
    event: github.pull_request
    prompt: Review merged PR
    gh_state: merged
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].gh_state).toBe('merged');
		});

		it('ignores invalid gh_state values during parsing', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bad-state
    event: github.pull_request
    prompt: Review
    gh_state: invalid
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].gh_state).toBeUndefined();
		});

		it('defaults gh_state to undefined when not specified', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: pr-watch
    event: github.pull_request
    prompt: Review
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].gh_state).toBeUndefined();
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

	describe('loadCueConfig with agent_id', () => {
		it('parses agent_id from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bound-sub
    event: time.heartbeat
    prompt: Do something
    interval_minutes: 5
    agent_id: session-abc-123
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].agent_id).toBe('session-abc-123');
		});

		it('defaults agent_id to undefined when not specified', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: unbound-sub
    event: time.heartbeat
    prompt: Do something
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].agent_id).toBeUndefined();
		});

		it('ignores non-string agent_id', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bad-id
    event: time.heartbeat
    prompt: Do something
    interval_minutes: 5
    agent_id: 12345
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].agent_id).toBeUndefined();
		});
	});

	describe('loadCueConfig with label', () => {
		it('parses label field from YAML', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: morning-check
    event: time.heartbeat
    prompt: Do morning checks
    interval_minutes: 60
    label: Morning Check
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].label).toBe('Morning Check');
		});

		it('defaults label to undefined when not specified', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: no-label
    event: time.heartbeat
    prompt: Do stuff
    interval_minutes: 5
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].label).toBeUndefined();
		});

		it('ignores non-string label values', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: bad-label
    event: time.heartbeat
    prompt: Do stuff
    interval_minutes: 5
    label: 12345
`);

			const result = loadCueConfig('/projects/test');
			expect(result).not.toBeNull();
			expect(result!.subscriptions[0].label).toBeUndefined();
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
	});

	describe('validateCueConfig — name validation', () => {
		it('rejects empty string subscription name', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: '', event: 'time.heartbeat', prompt: 'Do it', interval_minutes: 5 },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining('"name" is required and must be a non-empty string'),
				])
			);
		});

		it('rejects whitespace-only subscription name', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: '   ', event: 'time.heartbeat', prompt: 'Do it', interval_minutes: 5 },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining('"name" is required and must be a non-empty string'),
				])
			);
		});

		it('rejects duplicate subscription names', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: 'dupe', event: 'time.heartbeat', prompt: 'First', interval_minutes: 5 },
					{ name: 'dupe', event: 'file.changed', prompt: 'Second', watch: 'src/**' },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('duplicate subscription name "dupe"')])
			);
		});

		it('accepts unique subscription names', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: 'sub-a', event: 'time.heartbeat', prompt: 'First', interval_minutes: 5 },
					{ name: 'sub-b', event: 'file.changed', prompt: 'Second', watch: 'src/**' },
				],
			});
			// Check no name-related errors
			const nameErrors = result.errors.filter(
				(e: string) => e.includes('duplicate') || e.includes('"name"')
			);
			expect(nameErrors).toHaveLength(0);
		});

		it('detects duplicates after trimming whitespace', () => {
			const result = validateCueConfig({
				subscriptions: [
					{ name: 'watcher', event: 'time.heartbeat', prompt: 'First', interval_minutes: 5 },
					{ name: '  watcher  ', event: 'file.changed', prompt: 'Second', watch: 'src/**' },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('duplicate subscription name "watcher"')])
			);
		});
	});

	describe('validateCueConfig — schedule_times range validation', () => {
		it('rejects schedule_times with hour out of range (25:00)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['25:00'],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('invalid hour (0-23) or minute (0-59)')])
			);
		});

		it('rejects schedule_times with minute out of range (12:60)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['12:60'],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('invalid hour (0-23) or minute (0-59)')])
			);
		});

		it('rejects schedule_times with both hour and minute out of range (99:99)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['99:99'],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('invalid hour (0-23) or minute (0-59)')])
			);
		});

		it('accepts schedule_times with valid boundary value 00:00', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['00:00'],
					},
				],
			});
			const timeErrors = result.errors.filter((e: string) => e.includes('invalid hour'));
			expect(timeErrors).toHaveLength(0);
		});

		it('accepts schedule_times with valid boundary value 23:59', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['23:59'],
					},
				],
			});
			const timeErrors = result.errors.filter((e: string) => e.includes('invalid hour'));
			expect(timeErrors).toHaveLength(0);
		});

		// The trigger config UI lets users type either `6:30` or `06:30`. Save
		// emits canonical HH:MM, but legacy YAML and hand-edits may carry the
		// short form — accept it at validation time and let the normalizer
		// pad to two digits so the trigger source's includes-check still matches
		// the wall clock.
		it('accepts schedule_times with single-digit hour (6:30)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.scheduled',
						prompt: 'Do it',
						schedule_times: ['6:30'],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('normalizes single-digit hours to HH:MM when loading the config', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(`
subscriptions:
  - name: morning
    event: time.scheduled
    prompt: Do it
    schedule_times:
      - '6:30'
      - '17:00'
`);
			const result = loadCueConfigDetailed('/projects/test');
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.subscriptions[0].schedule_times).toEqual(['06:30', '17:00']);
			}
		});
	});

	describe('validateCueConfig — interval_minutes upper bound', () => {
		it('rejects interval_minutes above 10080 (7 days)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt: 'Do it',
						interval_minutes: 10081,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('10080')]));
		});

		it('accepts interval_minutes at upper bound (10080)', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt: 'Do it',
						interval_minutes: 10080,
					},
				],
			});
			const intervalErrors = result.errors.filter((e: string) => e.includes('interval_minutes'));
			expect(intervalErrors).toHaveLength(0);
		});

		it('rejects NaN interval_minutes', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt: 'Do it',
						interval_minutes: NaN,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('interval_minutes')])
			);
		});

		it('rejects Infinity interval_minutes', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt: 'Do it',
						interval_minutes: Infinity,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('interval_minutes')])
			);
		});

		it('accepts normal interval_minutes value', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'test',
						event: 'time.heartbeat',
						prompt: 'Do it',
						interval_minutes: 60,
					},
				],
			});
			const intervalErrors = result.errors.filter((e: string) => e.includes('interval_minutes'));
			expect(intervalErrors).toHaveLength(0);
		});
	});

	describe('watch glob validation (Fix 6)', () => {
		it('accepts valid glob pattern for file.changed', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'good-glob',
						event: 'file.changed',
						prompt: 'test',
						watch: '**/*.ts',
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('accepts valid glob pattern for task.pending', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'good-task-glob',
						event: 'task.pending',
						prompt: 'test',
						watch: 'docs/**/*.md',
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it('rejects empty watch string for file.changed', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'empty-glob',
						event: 'file.changed',
						prompt: 'test',
						watch: '',
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e: string) => e.includes('watch'))).toBe(true);
		});

		it('rejects empty watch string for task.pending', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'empty-task-glob',
						event: 'task.pending',
						prompt: 'test',
						watch: '',
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e: string) => e.includes('watch'))).toBe(true);
		});

		it('picomatch accepts unbalanced bracket pattern without throwing', () => {
			// picomatch treats [*.ts as a literal — it does NOT throw
			// so the try/catch validation passes it as valid
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'unbalanced-bracket',
						event: 'file.changed',
						prompt: 'test',
						watch: '[*.ts',
					},
				],
			});
			// picomatch does not throw on this pattern, so validation passes
			expect(result.valid).toBe(true);
		});

		it('accepts complex valid glob patterns', () => {
			const patterns = ['src/**/*.{ts,tsx}', '*.md', 'docs/**/README.md', '!node_modules/**'];
			for (const watch of patterns) {
				const result = validateCueConfig({
					subscriptions: [
						{
							name: `glob-${watch.replace(/[^a-z]/gi, '')}`,
							event: 'file.changed',
							prompt: 'test',
							watch,
						},
					],
				});
				const watchErrors = result.errors.filter((e: string) => e.includes('glob pattern'));
				expect(watchErrors).toHaveLength(0);
			}
		});

		it('rejects non-string watch value for file.changed', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'non-string-watch',
						event: 'file.changed',
						prompt: 'test',
						watch: 123 as unknown as string,
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e: string) => e.includes('watch'))).toBe(true);
		});
	});

	describe('loadCueConfig with filter (continued)', () => {
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

	describe('validateCueConfig — app.startup', () => {
		it('accepts a minimal app.startup subscription', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'init',
						event: 'app.startup',
						prompt: 'Set up workspace',
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('accepts app.startup with optional filter', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'init-filtered',
						event: 'app.startup',
						prompt: 'Set up workspace',
						filter: { reason: 'engine_start' },
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('accepts app.startup with prompt_file instead of prompt', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'init-file',
						event: 'app.startup',
						prompt_file: 'prompts/init.md',
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('rejects app.startup without prompt or prompt_file', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						name: 'init-no-prompt',
						event: 'app.startup',
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						'"prompt", "prompt_file", "fan_out_prompt_files", or "fan_out_prompts" is required'
					),
				])
			);
		});

		it('rejects app.startup without name', () => {
			const result = validateCueConfig({
				subscriptions: [
					{
						event: 'app.startup',
						prompt: 'Init',
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual(
				expect.arrayContaining([expect.stringContaining('"name" is required')])
			);
		});
	});

	describe('findAncestorCueConfigRoot', () => {
		it('returns null when no ancestor has a cue config', () => {
			mockExistsSync.mockReturnValue(false);
			const result = findAncestorCueConfigRoot('/projects/parent/child');
			expect(result).toBeNull();
		});

		it('finds a parent directory with .maestro/cue.yaml', () => {
			mockExistsSync.mockImplementation((p: string) => {
				const s = String(p);
				// Parent has .maestro/cue.yaml, child does not
				return s === '/projects/parent/.maestro/cue.yaml';
			});
			const result = findAncestorCueConfigRoot('/projects/parent/child');
			expect(result).toBe('/projects/parent');
		});

		it('does not return the input directory itself', () => {
			// Even if the input dir has a cue.yaml, it should only look at ancestors
			mockExistsSync.mockImplementation((p: string) => {
				return String(p) === '/projects/parent/child/.maestro/cue.yaml';
			});
			const result = findAncestorCueConfigRoot('/projects/parent/child');
			expect(result).toBeNull();
		});

		it('finds grandparent config when parent has none', () => {
			mockExistsSync.mockImplementation((p: string) => {
				return String(p) === '/projects/.maestro/cue.yaml';
			});
			const result = findAncestorCueConfigRoot('/projects/parent/child');
			expect(result).toBe('/projects');
		});

		it('stops after depth limit even if ancestor exists further up', () => {
			// Place cue.yaml 6 levels up — beyond the 5-level search depth
			mockExistsSync.mockImplementation((p: string) => {
				return String(p) === '/a/.maestro/cue.yaml';
			});
			const result = findAncestorCueConfigRoot('/a/b/c/d/e/f/g');
			// /a is 6 levels up from /a/b/c/d/e/f/g — should not be found
			expect(result).toBeNull();
		});

		it('finds ancestor with legacy maestro-cue.yaml', () => {
			mockExistsSync.mockImplementation((p: string) => {
				const s = String(p);
				// No canonical, but legacy exists at parent
				return s === '/projects/parent/maestro-cue.yaml';
			});
			const result = findAncestorCueConfigRoot('/projects/parent/child');
			expect(result).toBe('/projects/parent');
		});
	});
});
