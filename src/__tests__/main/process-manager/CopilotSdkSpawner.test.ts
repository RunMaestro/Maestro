import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { CopilotSdkSpawner } from '../../../main/process-manager/spawners/CopilotSdkSpawner';
import type { CopilotConnectionLease } from '../../../main/process-manager/spawners/CopilotConnectionManager';
import type { CopilotConnectionManager } from '../../../main/process-manager/spawners/CopilotConnectionManager';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';

describe('CopilotSdkSpawner startup cancellation', () => {
	it('closes a late-acquired lease without submitting the prompt', async () => {
		const processes = new Map<string, ManagedProcess>();
		const emitter = new EventEmitter();
		const acquisition = Promise.withResolvers<CopilotConnectionLease>();
		const session = {
			sessionId: 'copilot-session',
			on: vi.fn(),
			send: vi.fn(),
			abort: vi.fn(),
		};
		const connections = {
			acquire: vi.fn(() => acquisition.promise),
			close: vi.fn(async () => {}),
			release: vi.fn(),
		};
		const spawner = new CopilotSdkSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false }),
			connections as unknown as CopilotConnectionManager
		);
		const config: ProcessConfig = {
			sessionId: 'copilot-startup',
			toolType: 'copilot-cli',
			cwd: process.cwd(),
			command: 'copilot',
			args: [],
			tabId: 'tab-a',
			harnessControlMode: 'native',
			permissionMode: 'full',
			prompt: 'do not submit',
		};
		spawner.spawn(config);
		const managed = processes.get(config.sessionId)!;
		const closing = managed.harnessControl!.close();
		acquisition.resolve({
			key: 'tab-a',
			identity: 'identity',
			session: session as never,
			client: {} as never,
			handlers: {} as never,
			refs: 1,
			initializing: false,
			closed: false,
			agentId: 'agent-a',
			replacing: false,
		});
		await closing;
		expect(connections.close).toHaveBeenCalledTimes(1);
		expect(session.send).not.toHaveBeenCalled();
	});
});
