import { describe, expect, it, vi } from 'vitest';
import { createPianolaScopeWorkerDeps } from '../../../cli/commands/pianola-scope-watch';
import type { MaestroClient } from '../../../cli/services/maestro-client';
import { MAX_PERSISTED_SESSION_LOGS } from '../../../shared/deferredSessionContent';

describe('scope worker persisted transcript boundary', () => {
	it('accepts a shorter history but refuses a possibly truncated window', async () => {
		const messages = Array.from({ length: MAX_PERSISTED_SESSION_LOGS }, (_, index) => ({
			id: `message-${index}`,
			role: 'assistant',
			source: 'ai',
			content: 'Example',
			timestamp: '2026-11-04T00:00:00.000Z',
		}));
		const sendCommand = vi.fn(async () => ({
			success: true,
			agentId: 'agent',
			tabId: 'tab',
			messages: messages.slice(0, MAX_PERSISTED_SESSION_LOGS - 1),
		}));
		const deps = createPianolaScopeWorkerDeps({ sendCommand } as unknown as Pick<
			MaestroClient,
			'sendCommand'
		>);
		const target = { agentId: 'agent', tabId: 'tab', projectPath: '/project' };
		await expect(deps.readTranscript(target)).resolves.toMatchObject({
			messages: messages.slice(0, MAX_PERSISTED_SESSION_LOGS - 1),
		});
		sendCommand.mockResolvedValueOnce({ success: true, agentId: 'agent', tabId: 'tab', messages });
		await expect(deps.readTranscript(target)).rejects.toThrow('Scope transcript may be truncated');
	});
});
