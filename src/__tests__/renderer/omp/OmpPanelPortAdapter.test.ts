import { describe, expect, it, vi } from 'vitest';
import {
	createOmpWorkspaceAdapter,
	type OmpPanelPort,
} from '../../../../plugins/com.maestro.omp/src/panel/OmpPanelPort';

const snapshot = {
	connection: 'ready' as const,
	models: [],
	sessions: [],
	activeSessionId: null,
};

const activeSnapshot = {
	...snapshot,
	sessions: [
		{
			id: 'session-a',
			title: 'Session',
			updatedAt: 0,
			status: 'idle' as const,
			model: 'anthropic/claude',
			mode: 'build' as const,
			events: [],
			tree: [],
			subagents: [],
			usage: { inputTokens: 0, outputTokens: 0 },
		},
	],
	activeSessionId: 'session-a',
};

describe('createOmpWorkspaceAdapter', () => {
	it('maps mode and approval controls to named closed panel requests', async () => {
		const request = vi.fn(async (kind: string) => ({ kind, requestId: 'r-1', payload: snapshot }));
		const port: OmpPanelPort = {
			request,
			subscribe: vi.fn(() => () => {}),
		};
		const adapter = createOmpWorkspaceAdapter(port);

		expect(await adapter.getSnapshot()).toEqual(snapshot);
		await adapter.setMode('session-a', 'plan');
		await adapter.setThinkingLevel('session-a', 'high');
		await adapter.resolveApproval('session-a', 'approval-a', true);

		expect(request).toHaveBeenNthCalledWith(1, 'omp.commands.refresh', {});
		expect(request).toHaveBeenNthCalledWith(2, 'omp.composer.mode.set', {
			sessionId: 'session-a',
			mode: 'plan',
		});
		expect(request).toHaveBeenNthCalledWith(3, 'omp.thinking.set', {
			sessionId: 'session-a',
			level: 'high',
		});
		expect(request).toHaveBeenNthCalledWith(4, 'omp.approval.resolve', {
			sessionId: 'session-a',
			requestId: 'approval-a',
			approved: true,
		});
	});

	it('reduces streaming and approval events without a replacement view', async () => {
		const listeners = new Map<string, (event: { payload: unknown }) => void>();
		const port: OmpPanelPort = {
			request: vi.fn(async (kind: string) => ({
				kind,
				requestId: 'r-1',
				payload: activeSnapshot,
			})),
			subscribe: vi.fn((kind, listener) => {
				listeners.set(kind, listener);
				return () => listeners.delete(kind);
			}),
		};
		const adapter = createOmpWorkspaceAdapter(port);
		await adapter.getSnapshot();
		const listener = vi.fn();
		adapter.subscribe(listener);
		listeners.get('omp.stream.delta')?.({ payload: { sessionId: 'session-a', delta: 'Hello' } });
		listeners.get('omp.approval.required')?.({
			payload: { sessionId: 'session-a', requestId: 'approval-a', description: 'Apply?' },
		});

		expect(listener).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sessions: [
					expect.objectContaining({
						status: 'waiting-approval',
						events: [
							{ id: 'stream:session-a', kind: 'assistant', text: 'Hello' },
							{
								id: 'approval:approval-a',
								kind: 'approval',
								requestId: 'approval-a',
								description: 'Apply?',
							},
						],
					}),
				],
			})
		);
	});

	it('encodes bounded attachment bytes before dispatching a prompt', async () => {
		const request = vi.fn(async (kind: string) => ({ kind, requestId: 'r-1', payload: {} }));
		const port: OmpPanelPort = { request, subscribe: vi.fn(() => () => {}) };
		const attachment = Object.assign(new File(['diagram'], 'diagram.png', { type: 'image/png' }), {
			arrayBuffer: async () => new TextEncoder().encode('diagram').buffer,
		});

		await createOmpWorkspaceAdapter(port).sendMessage('session-a', 'Inspect this.', [attachment]);

		expect(request).toHaveBeenCalledWith('omp.prompt.send', {
			sessionId: 'session-a',
			text: 'Inspect this.',
			attachments: [
				{
					name: 'diagram.png',
					mediaType: 'image/png',
					size: 7,
					dataBase64: 'ZGlhZ3JhbQ==',
				},
			],
		});
	});

	it('rejects non-image attachments before requesting the panel capability', async () => {
		const request = vi.fn();
		const port: OmpPanelPort = { request, subscribe: vi.fn(() => () => {}) };
		const text = Object.assign(new File(['text'], 'notes.txt', { type: 'text/plain' }), {
			arrayBuffer: vi.fn(),
		});

		await expect(
			createOmpWorkspaceAdapter(port).sendMessage('session-a', 'Inspect this.', [text])
		).rejects.toThrow('unsupported image type');
		expect(request).not.toHaveBeenCalled();
		expect(text.arrayBuffer).not.toHaveBeenCalled();
	});

	it('rejects aggregate attachment overflow before requesting the panel capability', async () => {
		const request = vi.fn();
		const port: OmpPanelPort = { request, subscribe: vi.fn(() => () => {}) };
		const files = Array.from(
			{ length: 8 },
			(_, index) =>
				({
					name: `${index}.png`,
					type: 'image/png',
					size: 128 * 1024,
					arrayBuffer: vi.fn(),
				}) as File
		);

		await expect(
			createOmpWorkspaceAdapter(port).sendMessage('session-a', 'Inspect this.', files)
		).rejects.toThrow('total size limit');
		expect(request).not.toHaveBeenCalled();
		expect(files[0]?.arrayBuffer).not.toHaveBeenCalled();
	});
});
