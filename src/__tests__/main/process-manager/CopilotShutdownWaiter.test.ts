// src/__tests__/main/process-manager/CopilotShutdownWaiter.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	waitForCopilotShutdown,
	readCopilotFinalAnswer,
	resolveCopilotEventsPath,
} from '../../../main/process-manager/CopilotShutdownWaiter';

const AGENT_SESSION_ID = 'cp-test-session';

describe('CopilotShutdownWaiter', () => {
	let configDir: string;
	let eventsPath: string;

	beforeEach(async () => {
		configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-cpshutdown-'));
		eventsPath = path.join(configDir, 'session-state', AGENT_SESSION_ID, 'events.jsonl');
		await fs.mkdir(path.dirname(eventsPath), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(configDir, { recursive: true, force: true });
	});

	describe('resolveCopilotEventsPath', () => {
		it('builds the canonical session-state path', () => {
			const p = resolveCopilotEventsPath(AGENT_SESSION_ID, configDir);
			expect(p).toBe(eventsPath);
		});
	});

	describe('waitForCopilotShutdown', () => {
		it('returns "observed" immediately when the shutdown marker is already present', async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1234 } }),
				].join('\n') + '\n'
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 1000,
				inactivityMs: 500,
				pollIntervalMs: 25,
			});

			expect(result).toBe('observed');
		});

		it('returns "observed" once the shutdown marker is written during the wait', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }) + '\n'
			);

			const waitPromise = waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 2000,
				inactivityMs: 1500,
				pollIntervalMs: 25,
			});

			setTimeout(() => {
				void fs.appendFile(
					eventsPath,
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1 } }) + '\n'
				);
			}, 60);

			await expect(waitPromise).resolves.toBe('observed');
		});

		it('returns "inactive" when the file goes idle without ever writing shutdown', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }) + '\n'
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 2000,
				inactivityMs: 150,
				pollIntervalMs: 25,
			});

			expect(result).toBe('inactive');
		});

		it('returns "missing" when the events file never appears', async () => {
			// Don't write anything — the events.jsonl never materializes.
			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 2000,
				inactivityMs: 150,
				pollIntervalMs: 25,
			});

			expect(result).toBe('missing');
		});

		it('returns "timeout" when the file is busy but no shutdown arrives before the hard cap', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }) + '\n'
			);

			let stopAppending = false;
			(async () => {
				let i = 0;
				while (!stopAppending) {
					await fs.appendFile(
						eventsPath,
						JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: `${i++}` } }) +
							'\n'
					);
					await new Promise((r) => setTimeout(r, 20));
				}
			})();

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 250,
				inactivityMs: 10_000, // never trip the inactivity check
				pollIntervalMs: 25,
			});
			stopAppending = true;

			expect(result).toBe('timeout');
		});

		it('accepts shutdown markers with whitespace between key and value', async () => {
			await fs.writeFile(
				eventsPath,
				'{ "type": "session.shutdown", "data": { "currentTokens": 7 } }\n'
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 500,
				inactivityMs: 250,
				pollIntervalMs: 25,
			});

			expect(result).toBe('observed');
		});
	});

	describe('readCopilotFinalAnswer', () => {
		it('returns the latest content-bearing assistant.message with no phase', async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: "I'll delegate this to the coding agent.", toolRequests: [] },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: {
							content: '',
							toolRequests: [{ name: 'shell', toolCallId: 'tc1' }],
						},
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Subagent finished. Here is the final answer.', toolRequests: [] },
					}),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1 } }),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'Subagent finished. Here is the final answer.' });
		});

		it('skips assistant.messages with phase !== final_answer (e.g. commentary)', async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'real answer', toolRequests: [] },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'side note', phase: 'commentary', toolRequests: [] },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'real answer' });
		});

		it('returns null when no qualifying assistant.message exists', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }) + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it('returns null when events.jsonl is missing', async () => {
			await fs.rm(eventsPath, { force: true });

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it('tolerates malformed JSON lines and keeps scanning', async () => {
			await fs.writeFile(
				eventsPath,
				[
					'not-json',
					'',
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'good final', toolRequests: [] },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'good final' });
		});
	});
});
