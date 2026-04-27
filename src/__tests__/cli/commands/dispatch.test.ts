/**
 * @file dispatch.test.ts
 * @description Tests for the new `maestro-cli dispatch` command
 *
 * `dispatch` is the dedicated desktop-handoff verb introduced in PR1 of the
 * CLI surface refactor. It splits the desktop-handoff half of `send --live`
 * into a standalone command that returns addressable tab/session IDs so
 * external consumers (Maestro-Discord, Cue) can address the same tab on
 * follow-up calls.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	readSettingValue: vi.fn(),
}));

import { dispatch, runDispatch } from '../../../cli/commands/dispatch';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, readSettingValue } from '../../../cli/services/storage';

describe('dispatch command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('default (active tab) flow', () => {
		it('sends send_command with no tabId and surfaces the desktop-supplied tabId', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
				tabId: 'tab-active-99',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Hello world', {});

			expect(mockSendCommand).toHaveBeenCalledWith(
				{
					type: 'send_command',
					sessionId: 'agent-abc-123',
					command: 'Hello world',
					inputMode: 'ai',
				},
				'command_result'
			);

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({
				success: true,
				agentId: 'agent-abc-123',
				sessionId: 'tab-active-99',
				tabId: 'tab-active-99',
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('returns null tab/session IDs when the desktop omits tabId (no active tab)', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Hello world', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.tabId).toBeNull();
			expect(output.sessionId).toBeNull();
		});
	});

	describe('--new-tab flow', () => {
		it('sends new_ai_tab_with_prompt and returns the freshly-created tabId', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'new_ai_tab_with_prompt_result',
				success: true,
				tabId: 'tab-fresh-42',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Open a new conversation', { newTab: true });

			expect(mockSendCommand).toHaveBeenCalledWith(
				{
					type: 'new_ai_tab_with_prompt',
					sessionId: 'agent-abc-123',
					prompt: 'Open a new conversation',
				},
				'new_ai_tab_with_prompt_result'
			);

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(true);
			expect(output.tabId).toBe('tab-fresh-42');
			expect(output.sessionId).toBe('tab-fresh-42');
		});

		it('emits NEW_TAB_NO_ID when the desktop acks --new-tab without a tabId', async () => {
			// --new-tab's contract is to surface a fresh tab id for chaining.
			// If the desktop omits it (older build / race), we must fail loudly
			// with a dedicated code rather than returning `tabId: null` from a
			// "successful" response — downstream consumers (Maestro-Discord,
			// Cue) need to distinguish this from a generic command failure.
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'new_ai_tab_with_prompt_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Open a new conversation', { newTab: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('NEW_TAB_NO_ID');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects --new-tab combined with --force as INVALID_OPTIONS (a new tab is never busy)', async () => {
			await dispatch('agent-abc', 'Hello', { newTab: true, force: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTIONS');
			expect(output.error).toContain('--new-tab cannot be combined with --force');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('--session <tabId> flow', () => {
		it('forwards the requested tabId in send_command so the desktop targets that tab', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
				tabId: 'tab-xyz',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Follow up', { session: 'tab-xyz' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				{
					type: 'send_command',
					sessionId: 'agent-abc-123',
					command: 'Follow up',
					inputMode: 'ai',
					tabId: 'tab-xyz',
				},
				'command_result'
			);

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.tabId).toBe('tab-xyz');
		});

		it('falls back to the caller-supplied tabId when the desktop response omits it', async () => {
			// An older desktop build (or a shape change) may not echo tabId
			// back. The CLI should still report the tabId the caller asked for
			// so chained dispatches keep working without relying on the desktop.
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Follow up', { session: 'tab-xyz' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.tabId).toBe('tab-xyz');
		});

		it('rejects --session combined with --new-tab as INVALID_OPTIONS', async () => {
			await dispatch('agent-abc', 'Hello', { newTab: true, session: 'tab-xyz' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTIONS');
			expect(output.error).toBe('--new-tab cannot be combined with --session');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('--force flag', () => {
		it('includes force=true in the payload when allowConcurrentSend is enabled', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(readSettingValue).mockReturnValue(true);
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
				tabId: 'tab-active',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			await dispatch('agent-abc', 'Concurrent message', { force: true });

			expect(readSettingValue).toHaveBeenCalledWith('allowConcurrentSend');
			expect(mockSendCommand).toHaveBeenCalledWith(
				{
					type: 'send_command',
					sessionId: 'agent-abc-123',
					command: 'Concurrent message',
					inputMode: 'ai',
					force: true,
				},
				'command_result'
			);
		});

		it('emits FORCE_NOT_ALLOWED when allowConcurrentSend is disabled', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(readSettingValue).mockReturnValue(false);

			await dispatch('agent-abc', 'Concurrent message', { force: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('FORCE_NOT_ALLOWED');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('error mapping', () => {
		it('maps connection errors to MAESTRO_NOT_RUNNING', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

			await dispatch('agent-abc', 'Hello', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('MAESTRO_NOT_RUNNING');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		// MaestroClient throws three distinct error strings before any WebSocket
		// activity. They must map to MAESTRO_NOT_RUNNING — not COMMAND_FAILED —
		// so downstream consumers (Maestro-Discord, Cue) can distinguish "app
		// down" from "command rejected" via the error code.
		it.each([
			['Maestro desktop app is not running'],
			['Maestro discovery file is stale (app may have crashed)'],
			['Not connected to Maestro'],
		])('maps MaestroClient error "%s" to MAESTRO_NOT_RUNNING', async (errorMessage) => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(withMaestroClient).mockRejectedValue(new Error(errorMessage));

			await dispatch('agent-abc', 'Hello', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('MAESTRO_NOT_RUNNING');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('maps unknown-session errors to SESSION_NOT_FOUND', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('bad-session-id');
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Unknown session ID'));

			await dispatch('bad-session-id', 'Hello', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('SESSION_NOT_FOUND');
		});

		it('maps agent resolution failures to AGENT_NOT_FOUND', async () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('No agent matching "bogus"');
			});

			await dispatch('bogus', 'Hello', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('AGENT_NOT_FOUND');
			expect(output.error).toBe('No agent matching "bogus"');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('runDispatch (programmatic API)', () => {
		// runDispatch is exported so `send --live` can delegate to it during
		// the deprecation window without re-shelling. The legacy `send --live`
		// integration is covered in send.test.ts; here we just confirm the
		// programmatic shape returns rather than calling process.exit.
		it('returns a structured success result without exiting the process', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'command_result',
				success: true,
				tabId: 'tab-active-1',
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});

			const result = await runDispatch('agent-abc', 'Hello', {});

			expect(result.success).toBe(true);
			expect(result.agentId).toBe('agent-abc-123');
			expect(result.tabId).toBe('tab-active-1');
			expect(result.sessionId).toBe('tab-active-1');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('returns a structured failure result on validation errors without exiting', async () => {
			const result = await runDispatch('agent-abc', 'Hello', {
				newTab: true,
				session: 'tab-xyz',
			});

			expect(result.success).toBe(false);
			expect(result.code).toBe('INVALID_OPTIONS');
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});
});
