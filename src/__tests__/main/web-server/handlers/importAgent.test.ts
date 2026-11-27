/**
 * @file importAgent.test.ts
 * @description The desktop bridge answers `import_agent` (a Federation lift onto a remote that runs
 * Maestro itself). Before this handler the message was echoed and the lift stopped with "the
 * running Maestro app does not support the 'import_agent' command".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const importAgentIntoDesktop = vi.fn();
const buildDesktopAgentImportDeps = vi.fn((enqueue: unknown, processTable: unknown) => ({
	enqueue,
	processTable,
}));
vi.mock('../../../../main/federation/import-agent', () => ({
	importAgentIntoDesktop: (...args: unknown[]) => importAgentIntoDesktop(...args),
	buildDesktopAgentImportDeps: (enqueue: unknown, processTable: unknown) =>
		buildDesktopAgentImportDeps(enqueue, processTable),
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { handleImportAgent } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type {
	MessageHandlerContext,
	WebClient,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers/types';

let send: ReturnType<typeof vi.fn>;
let enqueueCommand: ReturnType<typeof vi.fn>;

function run(message: Record<string, unknown>, callbacks: Record<string, unknown> = {}): void {
	handleImportAgent(
		{
			send,
			sendError: vi.fn(),
			callbacks: { enqueueCommand, ...callbacks },
		} as unknown as MessageHandlerContext,
		{} as WebClient,
		{ type: 'import_agent', requestId: 'r1', ...message } as WebClientMessage
	);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const wire = {
	agent: { name: 'Substrate', toolType: 'claude-code', cwd: '/work/substrate' },
	tabs: [{ id: 'tA', agentSessionId: 'sess-A', logs: [] }],
	queue: [{ tabId: 'tA', text: 'go on' }],
};

beforeEach(() => {
	send = vi.fn();
	enqueueCommand = vi.fn().mockResolvedValue({ success: true });
	importAgentIntoDesktop.mockReset();
	buildDesktopAgentImportDeps.mockClear();
});

describe('handleImportAgent', () => {
	it('reads the wire the way the headless host does and replies with the new agent', async () => {
		importAgentIntoDesktop.mockResolvedValue({
			ok: true,
			receipt: { agentId: 'agent-1', queued: 1 },
		});
		run(wire);
		await flush();
		expect(importAgentIntoDesktop.mock.calls[0][0]).toEqual({
			agent: { name: 'Substrate', provider: 'claude-code', cwd: '/work/substrate' },
			tabs: [{ id: 'tA', agentSessionId: 'sess-A', logs: [] }],
			queue: [{ tabId: 'tA', text: 'go on' }],
		});
		expect(send).toHaveBeenCalledWith(expect.anything(), {
			type: 'import_agent_result',
			success: true,
			sessionId: 'agent-1',
			queued: 1,
			requestId: 'r1',
		});
	});

	it('queues through the bridge enqueue, in the background, on the named tab', async () => {
		importAgentIntoDesktop.mockResolvedValue({ ok: true, receipt: { agentId: 'a', queued: 0 } });
		run(wire);
		await flush();
		const { enqueue } = buildDesktopAgentImportDeps.mock.results[0].value as {
			enqueue: (
				a: string,
				t: string,
				text: string,
				images?: string[],
				held?: boolean
			) => Promise<unknown>;
		};
		await enqueue('a', 'tA', 'go on', ['img']);
		expect(enqueueCommand).toHaveBeenCalledWith('a', 'go on', 'ai', 'tA', ['img'], true, false);
		// Parity R50: a message held where it came from is queued held (Queue Held).
		await enqueue('a', 'tA', 'later', undefined, true);
		expect(enqueueCommand).toHaveBeenLastCalledWith(
			'a',
			'later',
			'ai',
			'tA',
			undefined,
			true,
			true
		);
	});

	it('hands the import the live process table, never the stored busy state (T7)', async () => {
		importAgentIntoDesktop.mockResolvedValue({ ok: true, receipt: { agentId: 'a', queued: 0 } });
		const processManager = { get: vi.fn(), kill: vi.fn(), closeAgent: vi.fn() };
		const getSessions = vi.fn(() => []);
		run(wire, {
			getSessions,
			getDebugPackageDeps: () => ({ getProcessManager: () => processManager }),
		});
		await flush();
		expect(buildDesktopAgentImportDeps.mock.calls[0][1]).toBe(processManager);
		expect(getSessions).not.toHaveBeenCalled();
	});

	it('refuses a tab without an id before importing anything', async () => {
		run({ ...wire, tabs: [{ logs: [] }] });
		await flush();
		expect(importAgentIntoDesktop).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(expect.anything(), {
			type: 'import_agent_result',
			success: false,
			error: 'Every imported tab needs an id.',
			requestId: 'r1',
		});
	});

	it('marks a missing group as not found, the way a client tells it from a failure', async () => {
		importAgentIntoDesktop.mockResolvedValue({
			ok: false,
			code: 'not-found',
			message: 'No group g9.',
		});
		run(wire);
		await flush();
		expect(send).toHaveBeenCalledWith(expect.anything(), {
			type: 'import_agent_result',
			success: false,
			error: 'Not found: No group g9.',
			requestId: 'r1',
		});
	});

	it('reports a thrown import as a failure instead of leaving the client to time out', async () => {
		importAgentIntoDesktop.mockRejectedValue(new Error('disk full'));
		run(wire);
		await flush();
		expect(send).toHaveBeenCalledWith(expect.anything(), {
			type: 'import_agent_result',
			success: false,
			error: 'Failed to import agent: disk full',
			requestId: 'r1',
		});
	});
});
