import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { extractCopilotUsageFromDisk } from '../../../main/group-chat/copilot-usage-extractor';

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
}));
import { readFileRemote } from '../../../main/utils/remote-fs';

const SHUTDOWN_LINE = (currentTokens: number): string =>
	JSON.stringify({
		type: 'session.shutdown',
		data: {
			currentTokens,
			modelMetrics: {
				'claude-sonnet-4.6': {
					requests: { count: 1, cost: 1 },
					usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
				},
			},
		},
	});

describe('extractCopilotUsageFromDisk', () => {
	let tmpDir: string;
	let originalConfigDir: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-usage-test-'));
		originalConfigDir = process.env.COPILOT_CONFIG_DIR;
		process.env.COPILOT_CONFIG_DIR = tmpDir;
		vi.mocked(readFileRemote).mockReset();
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) delete process.env.COPILOT_CONFIG_DIR;
		else process.env.COPILOT_CONFIG_DIR = originalConfigDir;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function writeLocalEvents(sessionId: string, lines: string[]): Promise<void> {
		const dir = path.join(tmpDir, 'session-state', sessionId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n'));
	}

	it('returns the latest shutdown when multiple are present', async () => {
		const sessionId = 'aaaa-bbbb';
		await writeLocalEvents(sessionId, [
			SHUTDOWN_LINE(10000),
			'{"type":"assistant.message","data":{"content":"hi"}}',
			SHUTDOWN_LINE(45000),
		]);

		const usage = await extractCopilotUsageFromDisk(sessionId, 200000, null);

		expect(usage).toEqual({ contextUsage: 23, tokenCount: 45000 });
	});

	it('returns null when no shutdown event is present', async () => {
		const sessionId = 'no-shutdown';
		await writeLocalEvents(sessionId, [
			'{"type":"user.message","data":{"content":"hi"}}',
			'{"type":"assistant.message","data":{"content":"there"}}',
		]);

		const usage = await extractCopilotUsageFromDisk(sessionId, 200000, null);

		expect(usage).toBeNull();
	});

	it('returns null when the events file is missing', async () => {
		const usage = await extractCopilotUsageFromDisk('does-not-exist', 200000, null);
		expect(usage).toBeNull();
	});

	it('clamps the context percentage to 100 when tokens exceed the window', async () => {
		const sessionId = 'overflow';
		await writeLocalEvents(sessionId, [SHUTDOWN_LINE(250000)]);

		const usage = await extractCopilotUsageFromDisk(sessionId, 200000, null);

		expect(usage).toEqual({ contextUsage: 100, tokenCount: 250000 });
	});

	it('reads from the SSH remote when one is provided', async () => {
		vi.mocked(readFileRemote).mockResolvedValue({
			success: true,
			data: SHUTDOWN_LINE(60000),
		});

		const usage = await extractCopilotUsageFromDisk(
			'remote-session',
			200000,
			// Minimal SshRemoteConfig — only the fields readFileRemote uses.
			{
				id: 'r1',
				name: 'remote',
				host: 'remote.example',
				port: 22,
				username: 'pedram',
				privateKeyPath: '/tmp/key',
			} as never
		);

		expect(usage).toEqual({ contextUsage: 30, tokenCount: 60000 });
		expect(readFileRemote).toHaveBeenCalledWith(
			expect.stringContaining('/.copilot/session-state/remote-session/events.jsonl'),
			expect.any(Object)
		);
	});

	it('returns null when the remote read fails', async () => {
		vi.mocked(readFileRemote).mockResolvedValue({ success: false, error: 'no such file' });

		const usage = await extractCopilotUsageFromDisk('remote-session', 200000, {
			id: 'r1',
			name: 'remote',
			host: 'remote.example',
			port: 22,
			username: 'pedram',
			privateKeyPath: '/tmp/key',
		} as never);

		expect(usage).toBeNull();
	});

	it('returns null for invalid inputs', async () => {
		expect(await extractCopilotUsageFromDisk('', 200000, null)).toBeNull();
		expect(await extractCopilotUsageFromDisk('x', 0, null)).toBeNull();
	});
});
