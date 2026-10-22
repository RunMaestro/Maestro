/**
 * @file system-prompt-delivery.test.ts
 * @description The one rule set for getting a Maestro system prompt into a
 * spawned agent, shared by `process:spawn`, Cue, Group Chat, and cross-agent
 * consults.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

vi.mock('fs/promises', () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { isWindows } from '../../../shared/platformDetection';
import {
	applySystemPromptDelivery,
	redactSystemPromptArg,
	systemPromptTempFileName,
	SYSTEM_PROMPT_TEMP_FILE_TTL_MS,
	type SystemPromptDeliveryInput,
} from '../../../main/utils/system-prompt-delivery';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';

const base = (overrides: Partial<SystemPromptDeliveryInput> = {}): SystemPromptDeliveryInput => ({
	args: ['--print'],
	prompt: 'do the thing',
	systemPrompt: 'SYSTEM',
	supportsAppendSystemPrompt: true,
	isResume: false,
	isSshSession: false,
	sessionId: 'sess-1',
	...overrides,
});

describe('applySystemPromptDelivery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isWindows).mockReturnValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('is a no-op without a system prompt', async () => {
		const input = base({ systemPrompt: undefined });
		const result = await applySystemPromptDelivery(input);
		expect(result).toEqual({ args: ['--print'], prompt: 'do the thing' });
		expect(result.delivery).toBeUndefined();
	});

	it('passes the native flag inline for supporting agents (and leaves the prompt alone)', async () => {
		const input = base();
		const result = await applySystemPromptDelivery(input);
		expect(result.args).toEqual(['--print', '--append-system-prompt', 'SYSTEM']);
		expect(result.prompt).toBe('do the thing');
		expect(result.delivery).toBe('cli-arg');
		// Inputs are not mutated.
		expect(input.args).toEqual(['--print']);
	});

	it('re-sends the native flag on resume (the flag is not in the transcript)', async () => {
		const result = await applySystemPromptDelivery(base({ isResume: true }));
		expect(result.delivery).toBe('cli-arg');
		expect(result.args).toContain('--append-system-prompt');
	});

	it('writes a temp file on Windows local and schedules its cleanup', async () => {
		vi.useFakeTimers();
		vi.mocked(isWindows).mockReturnValue(true);

		const result = await applySystemPromptDelivery(base());

		expect(result.delivery).toBe('file');
		expect(result.tempFile).toMatch(/maestro-sysprompt-sess-1-\d+-[0-9a-f]{8}\.txt$/);
		expect(result.args).toEqual(['--print', '--append-system-prompt-file', result.tempFile]);
		expect(fsp.writeFile).toHaveBeenCalledWith(result.tempFile, 'SYSTEM', {
			encoding: 'utf-8',
			mode: 0o600,
		});

		expect(fsp.unlink).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(SYSTEM_PROMPT_TEMP_FILE_TTL_MS + 1);
		expect(fsp.unlink).toHaveBeenCalledWith(result.tempFile);
	});

	it('builds a Windows-safe temp file name from a user-typed session id', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const result = await applySystemPromptDelivery(
			base({ sessionId: 'group-chat-1-participant-feature/auth a|b what?:*"<>\\' })
		);
		const name = result.tempFile!.split(/[\\/]/).pop()!;
		expect(name).toMatch(/^maestro-sysprompt-[A-Za-z0-9_-]+-\d+-[0-9a-f]{8}\.txt$/);
		expect(name).toContain('participant-feature_auth_a_b_what_');
	});

	it('caps the slug and keeps same-millisecond names apart', () => {
		const a = systemPromptTempFileName('x'.repeat(500));
		const b = systemPromptTempFileName('x'.repeat(500));
		expect(a).not.toBe(b);
		expect(a.match(/^maestro-sysprompt-(x+)-/)![1]).toHaveLength(64);
	});

	it('falls back to the inline flag (no throw) when the temp file write fails', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('EINVAL'));

		const result = await applySystemPromptDelivery(base());

		expect(result.delivery).toBe('cli-arg');
		expect(result.tempFile).toBeUndefined();
		expect(result.args).toEqual(['--print', '--append-system-prompt', 'SYSTEM']);
		expect(fsp.unlink).not.toHaveBeenCalled();
	});

	it('passes inline over SSH even on Windows (no CreateProcess limit in a stdin script)', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const result = await applySystemPromptDelivery(base({ isSshSession: true }));
		expect(result.delivery).toBe('cli-arg');
		expect(fsp.writeFile).not.toHaveBeenCalled();
	});

	it('embeds into the prompt for agents without the native flag', async () => {
		const result = await applySystemPromptDelivery(base({ supportsAppendSystemPrompt: false }));
		expect(result.delivery).toBe('embedded');
		expect(result.args).toEqual(['--print']);
		expect(result.prompt).toBe(embedSystemPromptInPrompt('SYSTEM', 'do the thing'));
	});

	it('skips the embed on resume (already in the first turn of the transcript)', async () => {
		const result = await applySystemPromptDelivery(
			base({ supportsAppendSystemPrompt: false, isResume: true })
		);
		expect(result.delivery).toBe('skipped-resume');
		expect(result.prompt).toBe('do the thing');
		expect(result.args).toEqual(['--print']);
	});

	it('sends the system prompt as the sole prompt when there is no user prompt', async () => {
		const result = await applySystemPromptDelivery(
			base({ supportsAppendSystemPrompt: false, prompt: undefined })
		);
		expect(result.delivery).toBe('sole-prompt');
		expect(result.prompt).toBe('SYSTEM');
	});
});

describe('redactSystemPromptArg', () => {
	it('replaces the inline system prompt with its length', () => {
		expect(redactSystemPromptArg(['-p', '--append-system-prompt', 'SECRET', '--x'])).toEqual([
			'-p',
			'--append-system-prompt',
			'<6 chars>',
			'--x',
		]);
	});

	it('returns args untouched when there is no inline system prompt', () => {
		const args = ['--append-system-prompt-file', '/tmp/f.txt'];
		expect(redactSystemPromptArg(args)).toBe(args);
	});
});
