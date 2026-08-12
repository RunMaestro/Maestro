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

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readFileTailRemote: vi.fn(),
}));
import { readFileRemote, readFileTailRemote } from '../../../main/utils/remote-fs';

import {
	waitForCopilotShutdown,
	readCopilotFinalAnswer,
	readCopilotShutdownUsage,
	resolveCopilotEventsPath,
} from '../../../main/process-manager/CopilotShutdownWaiter';

const AGENT_SESSION_ID = 'cp-test-session';

// Minimal SshRemoteConfig - only the fields readFileRemote touches.
const SSH_REMOTE = {
	id: 'r1',
	name: 'remote',
	host: 'remote.example',
	port: 22,
	username: 'pedram',
	privateKeyPath: '/tmp/key',
} as never;

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
			// Don't write anything - the events.jsonl never materializes.
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

		it('ignores stale shutdown markers from prior turns of a resumed session', async () => {
			// Regression: a resumed Copilot session appends every turn to one
			// events.jsonl, so the file already holds shutdown markers from earlier
			// turns. Matching one of those returned "observed" instantly and flipped
			// the tab to idle while this turn's subagents were still working - the
			// exact bug where Copilot's "I'm waiting on the X agent..." narration
			// got surfaced as the final answer. The current turn (after the last
			// session.resume) has no shutdown yet, so we must keep waiting.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 100 } }),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: "I'm waiting on the specialist agent to finish.", toolRequests: [] },
					}),
				].join('\n') + '\n'
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				configDir,
				maxWaitMs: 2000,
				inactivityMs: 150,
				pollIntervalMs: 25,
			});

			// Never observed the current turn's shutdown - it goes idle only via the
			// inactivity safety valve, not the stale marker.
			expect(result).toBe('inactive');
		});

		it("observes the CURRENT turn's shutdown even when prior-turn markers exist", async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 100 } }),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
				].join('\n') + '\n'
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
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 200 } }) + '\n'
				);
			}, 60);

			await expect(waitPromise).resolves.toBe('observed');
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

		it('prefers session.task_complete.summary when it appears after the last assistant.message', async () => {
			// Autopilot turn: model emits an empty assistant.message, then calls
			// task_complete with the real conclusion in `summary`.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Older turn answer.', toolRequests: [] },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: {
							content: '',
							toolRequests: [{ name: 'task_complete', toolCallId: 'tc1' }],
						},
					}),
					JSON.stringify({
						type: 'session.task_complete',
						data: { summary: 'Final summary from task_complete tool.' },
					}),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1 } }),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'Final summary from task_complete tool.' });
		});

		it('prefers a later assistant.message over an earlier session.task_complete', async () => {
			// Order matters: whichever final-answer signal is most recent wins.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'session.task_complete',
						data: { summary: 'older task_complete summary' },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'newer assistant final answer', toolRequests: [] },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'newer assistant final answer' });
		});

		it('skips assistant.messages from delegated subagents (parentToolCallId set)', async () => {
			// Subagent replies are serialized into the parent's events.jsonl with
			// parentToolCallId set. They must not be returned as the final answer -
			// the parent will produce its own conclusion later in the file.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'real parent final answer', toolRequests: [] },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: {
							content: 'subagent reply that should be ignored',
							toolRequests: [],
							parentToolCallId: 'call_subagent_xyz',
						},
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'real parent final answer' });
		});

		it('ignores answers from prior turns of a resumed session', async () => {
			// Regression: with a resumed session, the events.jsonl holds the previous
			// turn's final answer. If the current turn (after the last session.resume)
			// produced only tool calls and no final text yet, we must return null
			// rather than resurfacing the stale prior-turn answer as this turn's
			// conclusion.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Stale answer from the previous turn.', toolRequests: [] },
					}),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1 } }),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: '', toolRequests: [{ name: 'shell', toolCallId: 'tc1' }] },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it("returns the current turn's answer, not an earlier turn's, after a resume", async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Old turn answer.', toolRequests: [] },
					}),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1 } }),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'session.task_complete',
						data: { summary: "This turn's real conclusion." },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: "This turn's real conclusion." });
		});

		it('skips session.task_complete events with empty summary', async () => {
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'real answer', toolRequests: [] },
					}),
					JSON.stringify({ type: 'session.task_complete', data: { summary: '' } }),
				].join('\n') + '\n'
			);

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({ content: 'real answer' });
		});
	});

	describe('readCopilotShutdownUsage', () => {
		it('returns currentTokens + cumulative model metrics from the latest session.shutdown', async () => {
			// Snapshot mirrors a real Copilot session.shutdown payload: input
			// metrics are cumulative across the session, cacheReadTokens is a
			// subset of inputTokens, and currentTokens is the live context-window
			// occupancy. The reader surfaces currentTokens as `inputTokens` so the
			// combined-formula gauge tracks "how full is the window".
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'session.shutdown',
						data: {
							currentTokens: 125412,
							currentModel: 'gpt-5.5',
							modelMetrics: {
								'gpt-5.5': {
									usage: {
										inputTokens: 364009,
										outputTokens: 1137,
										cacheReadTokens: 261120,
										cacheWriteTokens: 0,
										reasoningTokens: 516,
									},
								},
							},
						},
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({
				inputTokens: 125412,
				outputTokens: 1137,
				cacheReadInputTokens: 261120,
				cacheCreationInputTokens: 0,
				reasoningTokens: 516,
			});
		});

		it('prefers the LAST session.shutdown event when several appear in the file', async () => {
			// Copilot writes one shutdown per batch spawn - long sessions
			// accumulate many. The newest one is the snapshot the gauge cares
			// about.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'session.shutdown',
						data: {
							currentTokens: 1000,
							modelMetrics: { m: { usage: { outputTokens: 10, cacheReadTokens: 100 } } },
						},
					}),
					JSON.stringify({
						type: 'session.shutdown',
						data: {
							currentTokens: 5000,
							modelMetrics: { m: { usage: { outputTokens: 50, cacheReadTokens: 500 } } },
						},
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({
				inputTokens: 5000,
				outputTokens: 50,
				cacheReadInputTokens: 500,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('returns null when events.jsonl is missing', async () => {
			await fs.rm(eventsPath, { force: true });

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it('returns null when no session.shutdown event has been written yet', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }) + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it('returns null when all token fields are zero (signals "no real data")', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({
					type: 'session.shutdown',
					data: { currentTokens: 0, modelMetrics: {} },
				}) + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});

		it('sums per-model usage rows when Copilot reports more than one (mid-session model switch)', async () => {
			await fs.writeFile(
				eventsPath,
				JSON.stringify({
					type: 'session.shutdown',
					data: {
						currentTokens: 9999,
						modelMetrics: {
							'gpt-5.5': {
								usage: { outputTokens: 100, cacheReadTokens: 1000, reasoningTokens: 5 },
							},
							'claude-sonnet': {
								usage: { outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 25 },
							},
						},
					},
				}) + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({
				inputTokens: 9999,
				outputTokens: 150,
				cacheReadInputTokens: 1500,
				cacheCreationInputTokens: 25,
				reasoningTokens: 5,
			});
		});

		it('tolerates malformed JSON lines and keeps scanning', async () => {
			await fs.writeFile(
				eventsPath,
				[
					'not-json',
					JSON.stringify({
						type: 'session.shutdown',
						data: {
							currentTokens: 200,
							modelMetrics: { m: { usage: { outputTokens: 5 } } },
						},
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({
				inputTokens: 200,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it("reads the CURRENT turn's shutdown usage, not a prior turn's, after a resume", async () => {
			// Regression: a resumed session accumulates one shutdown per turn. The
			// gauge must reflect this turn's snapshot (after the last session.resume),
			// not an earlier turn's stale numbers.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'session.shutdown',
						data: { currentTokens: 1000, modelMetrics: { m: { usage: { outputTokens: 10 } } } },
					}),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'session.shutdown',
						data: { currentTokens: 5000, modelMetrics: { m: { usage: { outputTokens: 50 } } } },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toEqual({
				inputTokens: 5000,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('returns null when only prior-turn shutdowns precede the current resume', async () => {
			// The current turn (after the last session.resume) has not written its
			// shutdown yet, so there is no current-segment usage to report.
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({
						type: 'session.shutdown',
						data: { currentTokens: 1000, modelMetrics: { m: { usage: { outputTokens: 10 } } } },
					}),
					JSON.stringify({ type: 'session.resume', data: { sessionId: AGENT_SESSION_ID } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'working', toolRequests: [] },
					}),
				].join('\n') + '\n'
			);

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, configDir);

			expect(result).toBeNull();
		});
	});

	// Over SSH the events file lives on the remote host, so the readers must go
	// through readFileRemote instead of the local filesystem. Without this the
	// context gauge stays at 0% for every remote Copilot tab.
	describe('SSH-remote sessions', () => {
		beforeEach(() => {
			vi.mocked(readFileRemote).mockReset();
			vi.mocked(readFileTailRemote).mockReset();
		});

		it('reads shutdown usage from the remote events file', async () => {
			vi.mocked(readFileRemote).mockResolvedValue({
				success: true,
				data:
					JSON.stringify({
						type: 'session.shutdown',
						data: {
							currentTokens: 60000,
							modelMetrics: { 'gpt-5.5': { usage: { outputTokens: 200, cacheReadTokens: 1000 } } },
						},
					}) + '\n',
			});

			const result = await readCopilotShutdownUsage(AGENT_SESSION_ID, undefined, SSH_REMOTE);

			expect(result).toEqual({
				inputTokens: 60000,
				outputTokens: 200,
				cacheReadInputTokens: 1000,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
			expect(readFileRemote).toHaveBeenCalledWith(
				expect.stringContaining(`/.copilot/session-state/${AGENT_SESSION_ID}/events.jsonl`),
				SSH_REMOTE
			);
		});

		it('reads the final answer from the remote events file', async () => {
			vi.mocked(readFileRemote).mockResolvedValue({
				success: true,
				data:
					JSON.stringify({
						type: 'session.task_complete',
						data: { summary: 'remote conclusion' },
					}) + '\n',
			});

			const result = await readCopilotFinalAnswer(AGENT_SESSION_ID, undefined, SSH_REMOTE);

			expect(result).toEqual({ content: 'remote conclusion' });
		});

		it('returns null when the remote read fails', async () => {
			vi.mocked(readFileRemote).mockResolvedValue({ success: false, error: 'no such file' });

			expect(await readCopilotShutdownUsage(AGENT_SESSION_ID, undefined, SSH_REMOTE)).toBeNull();
			expect(await readCopilotFinalAnswer(AGENT_SESSION_ID, undefined, SSH_REMOTE)).toBeNull();
		});

		it('waitForCopilotShutdown returns "observed" when the remote tail has the shutdown marker', async () => {
			// First (and only) poll reads from offset 0 and gets the marker.
			vi.mocked(readFileTailRemote).mockResolvedValue({
				success: true,
				data:
					[
						JSON.stringify({ type: 'session.start', data: { sessionId: AGENT_SESSION_ID } }),
						JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 1234 } }),
					].join('\n') + '\n',
			});

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				sshRemote: SSH_REMOTE,
				maxWaitMs: 1000,
				inactivityMs: 500,
				pollIntervalMs: 10,
			});

			expect(result).toBe('observed');
			expect(readFileTailRemote).toHaveBeenCalledWith(
				expect.stringContaining(`/.copilot/session-state/${AGENT_SESSION_ID}/events.jsonl`),
				SSH_REMOTE,
				0
			);
		});

		it('waitForCopilotShutdown reports "missing" when the remote file never appears', async () => {
			vi.mocked(readFileTailRemote).mockResolvedValue({
				success: false,
				error: 'File not found: events.jsonl',
			});

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				sshRemote: SSH_REMOTE,
				maxWaitMs: 1000,
				inactivityMs: 50,
				pollIntervalMs: 10,
			});

			expect(result).toBe('missing');
		});

		it('waitForCopilotShutdown reports "inactive" when the remote tail stops growing without a shutdown', async () => {
			// Model an append-once-then-quiet log: the first poll (offset 0) returns
			// one complete line, every later poll (offset > 0) returns nothing new.
			const line =
				JSON.stringify({ type: 'assistant.message', data: { content: 'working' } }) + '\n';
			vi.mocked(readFileTailRemote).mockImplementation(
				async (_path: string, _ssh, offset: number) =>
					offset === 0 ? { success: true, data: line } : { success: true, data: '' }
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				sshRemote: SSH_REMOTE,
				maxWaitMs: 1000,
				inactivityMs: 50,
				pollIntervalMs: 10,
			});

			expect(result).toBe('inactive');
		});

		it('waitForCopilotShutdown advances the byte offset so each poll only fetches the new tail', async () => {
			// Three appended lines arrive one per poll; the shutdown lands last.
			// Each poll must request the byte offset just past what it already read.
			const start = JSON.stringify({ type: 'session.start', data: {} }) + '\n';
			const msg = JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } }) + '\n';
			const shutdown =
				JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 7 } }) + '\n';
			const tails = [start, msg, shutdown];
			let call = 0;
			const seenOffsets: number[] = [];
			vi.mocked(readFileTailRemote).mockImplementation(
				async (_path: string, _ssh, offset: number) => {
					seenOffsets.push(offset);
					const data = tails[call] ?? '';
					call++;
					return { success: true, data };
				}
			);

			const result = await waitForCopilotShutdown(AGENT_SESSION_ID, {
				sshRemote: SSH_REMOTE,
				maxWaitMs: 1000,
				inactivityMs: 500,
				pollIntervalMs: 10,
			});

			expect(result).toBe('observed');
			// Poll 1 starts at 0; poll 2 skips the consumed `start` bytes; poll 3
			// skips start+msg. Offsets must be strictly increasing, never re-reading.
			expect(seenOffsets[0]).toBe(0);
			expect(seenOffsets[1]).toBe(Buffer.byteLength(start, 'utf8'));
			expect(seenOffsets[2]).toBe(Buffer.byteLength(start + msg, 'utf8'));
		});
	});
});
