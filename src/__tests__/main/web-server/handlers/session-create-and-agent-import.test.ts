// Source: src/__tests__/main/web-server/handlers/createSessionProvenance.test.ts
// Source: src/__tests__/main/web-server/handlers/importAgent.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { handleCreateSession } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { WebClientMessage } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { CreateSessionConfig } from '../../../../main/web-server/types';
import { handleImportAgent } from '../../../../main/web-server/handlers/messageHandlers/sessions';
const importAgentIntoDesktop = vi.hoisted(() => vi.fn());
const buildDesktopAgentImportDeps = vi.hoisted(() => vi.fn((enqueue: unknown) => ({ enqueue })));
vi.mock('../../../../main/federation/import-agent', () => ({
	importAgentIntoDesktop: (...args: unknown[]) => importAgentIntoDesktop(...args),
	buildDesktopAgentImportDeps: (enqueue: unknown) => buildDesktopAgentImportDeps(enqueue),
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
describe('createSessionProvenance', () => {
	let createSession: ReturnType<typeof vi.fn>;

	/** Minimal context: only the createSession callback and the send/error sinks. */
	function makeCtx(): MessageHandlerContext {
		return {
			send: vi.fn(),
			sendError: vi.fn(),
			callbacks: { createSession },
		} as unknown as MessageHandlerContext;
	}

	/** Dispatch a create_session message and return the config the callback saw. */
	function created(message: Partial<WebClientMessage>): CreateSessionConfig | undefined {
		handleCreateSession(
			makeCtx(),
			{} as WebClient,
			{
				name: 'Agent',
				toolType: 'codex',
				cwd: '/tmp',
				...message,
			} as WebClientMessage
		);
		expect(createSession).toHaveBeenCalled();
		return createSession.mock.calls[0][4] as CreateSessionConfig | undefined;
	}

	beforeEach(() => {
		createSession = vi.fn().mockResolvedValue({ sessionId: 'new-1' });
	});

	describe('handleCreateSession - context window provenance (finding AD1)', () => {
		it('passes contextWindowSource through the config allowlist', () => {
			const config = created({
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
			});

			expect(config?.customContextWindow).toBe(120000);
			// Without the allowlist entry the number arrives but its provenance does
			// not, so `maestro-cli create-agent --context-window` is silently
			// overridden by the provider's report - the harm AD1 exists to remove.
			expect(config?.contextWindowSource).toBe('user-edited');
		});

		it('leaves provenance unset when the CLI did not send it', () => {
			const config = created({ customContextWindow: 200000 });

			expect(config?.customContextWindow).toBe(200000);
			// Absence is the materialized signal, so it must stay absent rather than
			// being defaulted to anything.
			expect(config?.contextWindowSource).toBeUndefined();
		});

		it('ignores provenance sent without a context window', () => {
			// Provenance describes a value. A source-only payload would leave a marker
			// with nothing to describe, and that orphan would then outrank a provider
			// report for whatever window is set later (review of PR #1362).
			const config = created({ contextWindowSource: 'user-edited' });

			expect(config?.customContextWindow).toBeUndefined();
			expect(config?.contextWindowSource).toBeUndefined();
		});

		it('ignores a provenance value it does not recognise', () => {
			// The field crosses a process boundary from an untrusted client, so only
			// the one supported value is accepted.
			const config = created({
				customContextWindow: 200000,
				contextWindowSource: 'something-else',
			});

			expect(config?.contextWindowSource).toBeUndefined();
		});
	});

	describe('handleCreateSession - duplicate-agent fields', () => {
		it('carries the New Agent modal fields duplicate-agent sends, explicit false included', () => {
			const config = created({
				additionalDirectories: [{ path: '/shared', read: true, write: false }],
				enableMaestroP: false,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: true,
				codexAutoResetOnExhaustion: true,
				codexTransport: 'app-server',
			});

			expect(config).toMatchObject({
				additionalDirectories: [{ path: '/shared', read: true, write: false }],
				enableMaestroP: false,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: true,
				codexAutoResetOnExhaustion: true,
				codexTransport: 'app-server',
			});
		});

		it('drops values that are not the field type', () => {
			const config = created({
				additionalDirectories: [],
				enableMaestroP: 'yes',
				maestroPMode: 'always',
				retryOnAvailabilityErrors: 0,
				codexAutoResetOnExhaustion: false,
				codexTransport: 'grpc',
			});

			expect(config).toBeUndefined();
		});
	});
});
describe('importAgent', () => {
	let send: ReturnType<typeof vi.fn>;
	let enqueueCommand: ReturnType<typeof vi.fn>;

	function run(message: Record<string, unknown>): void {
		handleImportAgent(
			{
				send,
				sendError: vi.fn(),
				callbacks: { enqueueCommand },
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
				enqueue: (a: string, t: string, text: string, images?: string[]) => Promise<unknown>;
			};
			await enqueue('a', 'tA', 'go on', ['img']);
			expect(enqueueCommand).toHaveBeenCalledWith('a', 'go on', 'ai', 'tA', ['img'], true);
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
});
