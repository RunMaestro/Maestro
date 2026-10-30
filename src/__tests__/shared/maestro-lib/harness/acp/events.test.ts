import { describe, expect, it } from 'vitest';
import { AcpEventTranslator } from '../../../../../shared/maestro-lib/harness/acp/events';
import { AcpOutputParser } from '../../../../../shared/maestro-lib/harness/acp/output-parser';
import {
	acpPermissionOpenRequest,
	acpPermissionResponse,
} from '../../../../../shared/maestro-lib/harness/acp/interactions';

const context = { sessionId: 'maestro-a', spawnGeneration: 2, provider: 'qwen3-coder' };

describe('ACP event translation', () => {
	it('normalizes text, tools, usage, and final results', () => {
		const translator = new AcpEventTranslator();
		expect(
			translator.handle({
				sessionId: 'acp-a',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'NATIVE_OK' },
				},
			}).lines[0]
		).toContain('NATIVE_OK');
		expect(
			translator.handle({
				sessionId: 'acp-a',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'call-a',
					status: 'completed',
				},
			}).lines[0]
		).toContain('call-a');
		expect(
			translator.handle({
				sessionId: 'acp-a',
				update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
			}).lines[0]
		).toContain('contextWindow');
		expect(translator.finalText).toBe('NATIVE_OK');

		const parser = new AcpOutputParser('qwen3-coder');
		expect(
			parser.parseJsonLine(
				'{"type":"acp.result","sessionId":"acp-a","stopReason":"end_turn","text":"NATIVE_OK"}'
			)
		).toMatchObject({
			type: 'result',
			text: 'NATIVE_OK',
		});
	});
});

describe('ACP permission mapping', () => {
	it('preserves native option IDs and maps all standard option kinds', () => {
		const request = acpPermissionOpenRequest(
			{
				toolCall: { toolCallId: 'call-a', title: 'Run tests?', name: 'Bash' },
				options: [
					{ optionId: 'once', name: 'Allow once', kind: 'allow_once' },
					{ optionId: 'always', name: 'Allow always', kind: 'allow_always' },
					{ optionId: 'deny', name: 'Deny', kind: 'reject_once' },
					{ optionId: 'never', name: 'Never', kind: 'reject_always' },
				],
			},
			context
		);
		expect(request.options.map((option) => option.kind)).toEqual([
			'allow-once',
			'allow-always',
			'reject-once',
			'reject-always',
		]);
		expect(acpPermissionResponse({ outcome: 'selected', optionId: 'always' })).toEqual({
			outcome: { outcome: 'selected', optionId: 'always' },
		});
		expect(acpPermissionResponse({ outcome: 'cancelled', reason: 'timeout' })).toEqual({
			outcome: { outcome: 'cancelled' },
		});
	});
});
