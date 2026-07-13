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
		transport.stdout(
			`{"id":"${frame.id}","type":"prompt_result","success":true,"result":{"text":"done"}}\n`
		);
		await expect(prompt).resolves.toMatchObject({ command: 'prompt', success: true });
	});
});
