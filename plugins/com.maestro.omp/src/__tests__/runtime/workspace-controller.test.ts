import { describe, expect, it } from 'vitest';
import { OmpRpcClient, OmpWorkspaceController, type OmpRpcTransport } from '../../runtime';

class FakeTransport implements OmpRpcTransport {
	readonly writes: string[] = [];
	private readonly frameListeners: Array<(chunk: string) => void> = [];
	send(frame: string): void {
		this.writes.push(frame);
	}
	onFrame(listener: (chunk: Uint8Array | string) => void): () => void {
		this.frameListeners.push(listener as (chunk: string) => void);
		return () =>
			this.frameListeners.splice(
				this.frameListeners.indexOf(listener as (chunk: string) => void),
				1
			);
	}
	onDiagnostic(): () => void {
		return () => undefined;
	}
	onClosed(): () => void {
		return () => undefined;
	}
	stdout(frame: string): void {
		for (const listener of this.frameListeners) listener(frame);
	}
}

function sessionState() {
	return {
		sessionId: 's-1',
		thinkingLevel: 'medium',
		isStreaming: false,
		isCompacting: false,
		steeringMode: 'all',
		followUpMode: 'all',
		interruptMode: 'immediate',
		autoCompactionEnabled: true,
		messageCount: 0,
		queuedMessageCount: 0,
		todoPhases: [],
	};
}

async function initializeController(
	controller: OmpWorkspaceController,
	transport: FakeTransport
): Promise<void> {
	transport.stdout('{"type":"ready"}\n');
	const initialized = controller.initialize();
	await Promise.resolve();
	for (let index = 0; index < 5; index++) {
		const frame = JSON.parse(transport.writes[index] ?? '') as { id: string; type: string };
		const data =
			frame.type === 'get_state'
				? sessionState()
				: frame.type === 'get_available_commands'
					? { commands: [{ name: 'help', description: 'Show slash commands', aliases: ['h'] }] }
					: { models: [] };
		transport.stdout(
			`{"id":"${frame.id}","type":"response","command":"${frame.type}","success":true,"data":${JSON.stringify(data)}}\n`
		);
	}
	await initialized;
}

describe('OmpWorkspaceController', () => {
	it('performs ready setup then requires state, commands, and models before exposing one workspace controller as ready', async () => {
		const transport = new FakeTransport();
		const client = new OmpRpcClient(transport);
		const controller = new OmpWorkspaceController('workspace-a', client, {
			tools: [],
			uriSchemes: [],
		});
		transport.stdout('{"type":"ready"}\n');
		const initialized = controller.initialize();
		await Promise.resolve();
		for (let index = 0; index < 5; index++) {
			const frame = JSON.parse(transport.writes[index] ?? '') as { id: string; type: string };
			transport.stdout(
				`{"id":"${frame.id}","type":"response","command":"${frame.type}","success":true,"data":${frame.type === 'get_state' ? JSON.stringify(sessionState()) : frame.type === 'get_available_commands' ? '{"commands":[{"name":"help","description":"Show available slash commands","aliases":["h"]}]}' : '{"models":[]}'}}\n`
			);
		}

		await initialized;
		expect(controller.state).toBe('ready');
		expect(controller.selectedSessionId).toBe('s-1');
		expect(controller.availableCommands).toEqual([
			{ name: 'help', description: 'Show available slash commands', aliases: ['h'] },
		]);

		const prompt = controller.command({ type: 'prompt', message: 'continue' });
		await Promise.resolve();
		const frame = JSON.parse(transport.writes[5] ?? '') as { id: string; type: string };
		expect(frame.type).toBe('prompt');
		transport.stdout(`{"id":"${frame.id}","type":"response","command":"prompt","success":true}\n`);
		await expect(prompt).resolves.toMatchObject({ command: 'prompt', success: true });
	});

	it('routes real host tool call and cancellation identifiers without accepting malformed or late callbacks', async () => {
		const transport = new FakeTransport();
		const calls: Array<{
			id: string;
			toolCallId: string;
			toolName: string;
			arguments: unknown;
			signal: AbortSignal | undefined;
		}> = [];
		const cancels: string[] = [];
		let resolveTool!: (value: unknown) => void;
		const pendingTool = new Promise<unknown>((resolve) => {
			resolveTool = resolve;
		});
		const controller = new OmpWorkspaceController('workspace-a', new OmpRpcClient(transport), {
			tools: [],
			uriSchemes: [],
			brokers: {
				tools: {
					call: async (request) => {
						calls.push(request);
						return pendingTool;
					},
					cancel: (targetId) => cancels.push(targetId),
				},
			},
		});
		await initializeController(controller, transport);

		transport.stdout(
			'{"type":"host_tool_call","id":"callback-1","toolCallId":"tool-1","toolName":"read_file","arguments":{"path":"README.md"}}\n'
		);
		await Promise.resolve();
		expect(calls).toEqual([
			expect.objectContaining({
				id: 'callback-1',
				toolCallId: 'tool-1',
				toolName: 'read_file',
				arguments: { path: 'README.md' },
			}),
		]);
		transport.stdout(
			'{"type":"host_tool_cancel","id":"callback-cancel","targetId":"callback-1"}\n'
		);
		expect(cancels).toEqual(['callback-1']);
		expect(calls[0]?.signal?.aborted).toBe(true);
		resolveTool({ text: 'contents' });
		await Promise.resolve();
		await Promise.resolve();
		expect(JSON.parse(transport.writes.at(-1) ?? '')).toEqual({
			type: 'host_tool_result',
			id: 'callback-1',
			result: {
				content: [{ type: 'text', text: '{"text":"contents"}' }],
			},
		});

		transport.stdout('{"type":"host_tool_call","id":"bad","toolCallId":"tool-2","name":"wrong"}\n');
		await Promise.resolve();
		expect(calls).toHaveLength(1);
		controller.markStopped();
		transport.stdout(
			'{"type":"host_tool_call","id":"late","toolCallId":"tool-3","toolName":"read_file","arguments":{}}\n'
		);
		await Promise.resolve();
		expect(calls).toHaveLength(1);
	});

	it('rejects direct bash RPC even after the managed controller is ready', async () => {
		const transport = new FakeTransport();
		const controller = new OmpWorkspaceController('workspace-bash', new OmpRpcClient(transport), {
			tools: [],
			uriSchemes: [],
		});
		await initializeController(controller, transport);
		const writesBefore = transport.writes.length;
		await expect(controller.command({ type: 'bash', command: 'whoami' })).rejects.toThrow(
			'raw OMP bash RPC is unavailable'
		);
		expect(transport.writes).toHaveLength(writesBefore);
	});
});
