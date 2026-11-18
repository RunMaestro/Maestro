import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentDisplayName } from '../../../../../../shared/agentMetadata';
import {
	AUTO_CONTINUE_MESSAGE,
	containsDeferredResponsePhrase,
} from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/deferredResponse';
import { extractStreamingTextFromChunk } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/streamingChunks';
import { isStructuredThinkingResponse } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/thinkingFilters';
import { getConversationProviderName } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/providerName';
import {
	fetchExistingDocsForWizard,
	readExistingDocuments,
} from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/existingDocs';

describe('ConversationScreen utils', () => {
	describe('containsDeferredResponsePhrase', () => {
		it('detects async-sounding response phrases', () => {
			expect(containsDeferredResponsePhrase('Let me research this for you.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me investigate that further.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me look into this more.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me think about this more carefully.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me analyze the requirements.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me examine the codebase.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me check on that.')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me explore the possibilities.')).toBe(true);
			expect(containsDeferredResponsePhrase('Give me a moment to think.')).toBe(true);
			expect(containsDeferredResponsePhrase("I'll get back to you on that.")).toBe(true);
			expect(containsDeferredResponsePhrase('Researching this now...')).toBe(true);
			expect(containsDeferredResponsePhrase('Let me take a closer look at this.')).toBe(true);
		});

		it('does not match normal conversational phrases', () => {
			expect(containsDeferredResponsePhrase('I can help you with that.')).toBe(false);
			expect(containsDeferredResponsePhrase('What type of project is this?')).toBe(false);
			expect(containsDeferredResponsePhrase('Let me know if you have questions.')).toBe(false);
			expect(containsDeferredResponsePhrase('Let me explain how this works.')).toBe(false);
			expect(containsDeferredResponsePhrase('I researched this topic yesterday.')).toBe(false);
			expect(containsDeferredResponsePhrase("I'm ready to create your Playbook.")).toBe(false);
			expect(containsDeferredResponsePhrase('')).toBe(false);
		});

		it('matches case-insensitively and exports the auto-continue message', () => {
			expect(containsDeferredResponsePhrase('LET ME RESEARCH THIS')).toBe(true);
			expect(containsDeferredResponsePhrase('Let Me Research This')).toBe(true);
			expect(AUTO_CONTINUE_MESSAGE).toBe('Please proceed with your analysis.');
		});
	});

	describe('extractStreamingTextFromChunk', () => {
		it('extracts content block deltas from newline-delimited JSON', () => {
			const chunk = [
				JSON.stringify({
					type: 'stream_event',
					event: { type: 'content_block_delta', delta: { text: 'Hello ' } },
				}),
				JSON.stringify({
					type: 'stream_event',
					event: { type: 'content_block_delta', delta: { text: 'world' } },
				}),
			].join('\n');

			expect(extractStreamingTextFromChunk(chunk)).toBe('Hello world');
		});

		it('ignores assistant complete messages and invalid JSON', () => {
			const chunk = [
				'not-json',
				JSON.stringify({ type: 'assistant', message: { content: [{ text: 'done' }] } }),
				JSON.stringify({
					type: 'stream_event',
					event: { type: 'other', delta: { text: 'skip' } },
				}),
			].join('\n');

			expect(extractStreamingTextFromChunk(chunk)).toBe('');
		});

		it.each([
			'Hello from Grok',
			'  Hello\nworld',
			'{"confidence":80,"message":"Ready',
			'{"ready":false,"message":"Which project?',
			'{"confidence":80,"message":"Ready","ready":true}',
			'{"message":"Ready","confidence":80,"ready":true}',
			'{\n  "message": "Ready",\n  "confidence": 80\n}',
			'Example:\n```json\n{"type":"text","data":"example"}\n```',
		])('preserves normalized Grok preview %j', (answer) => {
			expect(extractStreamingTextFromChunk(answer, 'grok')).toBe(answer);
		});

		it.each([
			{ type: 'thought', data: 'private reasoning' },
			{ type: 'thought', data: '' },
			{ type: 'tool_call', id: 'tool-1', name: 'read_file', arguments: { path: 'x' } },
			{ type: 'tool_call_update', id: 'orphan', status: 'completed' },
			{ type: 'usage', usage: { inputTokens: 1 } },
			{ type: 'error', message: 'provider failed' },
			{ message: 'provider failed', type: 'error' },
			{ type: 'end', reason: 'EndTurn' },
			{ type: 'future_metadata', data: 'not an answer' },
		])('hides Grok $type envelopes without raw fallback', (event) => {
			expect(extractStreamingTextFromChunk(` \n${JSON.stringify(event)}`, 'grok')).toBe('');
		});

		it('holds undecided records and reconstructs escaped native answers at every split', () => {
			const answer = 'First "line"\nnext';
			const record = JSON.stringify({ type: 'text', data: answer });
			for (let split = 1; split < record.length; split++) {
				const prefix = record.slice(0, split);
				expect(extractStreamingTextFromChunk(prefix, 'grok')).toBe('');
				expect(extractStreamingTextFromChunk(prefix + record.slice(split), 'grok')).toBe(answer);
			}
			expect(extractStreamingTextFromChunk('{"message":"provider failed', 'grok')).toBe('');
		});

		it('projects accumulated native text once while filtering interleaved non-answer events', () => {
			const first = JSON.stringify({ type: 'text', data: 'Hello ' });
			const second = JSON.stringify({ type: 'text', data: 'world' });
			const stream = [
				JSON.stringify({ type: 'thought', data: 'hidden' }),
				first,
				JSON.stringify({ type: 'tool_call_update', id: 'orphan' }),
			].join('\n');
			expect(extractStreamingTextFromChunk(stream + '\n' + second.slice(0, -2), 'grok')).toBe(
				'Hello '
			);
			const complete = stream + '\n' + second + '\n{"type":"error","message":"failed"}';
			expect(extractStreamingTextFromChunk(complete, 'grok')).toBe('Hello world');
		});

		it.each(['claude-code', 'codex', 'antigravity'] as const)(
			'preserves the existing %s stream-event projection',
			(agent) => {
				const event = JSON.stringify({
					type: 'stream_event',
					event: { type: 'content_block_delta', delta: { text: 'Reference answer' } },
				});
				expect(extractStreamingTextFromChunk(event, agent)).toBe('Reference answer');
				expect(extractStreamingTextFromChunk('plain text', agent)).toBe('');
			}
		);

		it('handles empty and whitespace-only chunks', () => {
			expect(extractStreamingTextFromChunk('')).toBe('');
			expect(extractStreamingTextFromChunk('\n \n')).toBe('');
			expect(extractStreamingTextFromChunk('', 'grok')).toBe('');
			expect(extractStreamingTextFromChunk('\n \n', 'grok')).toBe('');
		});
	});

	describe('isStructuredThinkingResponse', () => {
		it('detects structured wizard JSON so it can be hidden from thinking display', () => {
			expect(isStructuredThinkingResponse('{"confidence":80,"message":"Ready"}')).toBe(true);
			expect(isStructuredThinkingResponse('  {"message":"Hello"}')).toBe(true);
			expect(isStructuredThinkingResponse('plain thinking text')).toBe(false);
			expect(isStructuredThinkingResponse('{"other":true}')).toBe(false);
		});
	});

	describe('getConversationProviderName', () => {
		it('maps known agents to user-facing provider labels', () => {
			expect(getConversationProviderName('claude-code')).toBe('Claude');
			expect(getConversationProviderName('opencode')).toBe('OpenCode');
			expect(getConversationProviderName('codex')).toBe('Codex');
			expect(getConversationProviderName('factory-droid')).toBe('Factory Droid');
			expect(getConversationProviderName('grok')).toBe('Grok CLI');
			for (const agent of ['grok', 'codex', 'antigravity'] as const) {
				expect(getConversationProviderName(agent)).toBe(getAgentDisplayName(agent));
			}
			expect(getConversationProviderName(null)).toBeUndefined();
		});
	});

	describe('existing document helpers', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('reads listed documents and skips unreadable entries', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['one.md', 'two.md'],
			});
			vi.mocked(window.maestro.autorun.readDoc)
				.mockResolvedValueOnce({ success: true, content: 'one' })
				.mockResolvedValueOnce({ success: false, error: 'missing' });

			await expect(readExistingDocuments('/project/.maestro/playbooks')).resolves.toEqual([
				{ filename: 'one.md', content: 'one' },
			]);
		});

		it('continues reading when one document throws', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['bad.md', 'good.md'],
			});
			vi.mocked(window.maestro.autorun.readDoc)
				.mockRejectedValueOnce(new Error('bad file'))
				.mockResolvedValueOnce({ success: true, content: 'good' });

			await expect(readExistingDocuments('/project/.maestro/playbooks')).resolves.toEqual([
				{ filename: 'good.md', content: 'good' },
			]);
		});

		it('returns an empty list when listing fails or throws', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
				success: false,
				error: 'nope',
			});
			await expect(readExistingDocuments('/project/.maestro/playbooks')).resolves.toEqual([]);

			vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(new Error('boom'));
			await expect(readExistingDocuments('/project/.maestro/playbooks')).resolves.toEqual([]);
		});

		it('only fetches docs for continue mode', async () => {
			await expect(fetchExistingDocsForWizard('/project', 'fresh')).resolves.toEqual([]);
			await expect(fetchExistingDocsForWizard('/project', null)).resolves.toEqual([]);
			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
		});

		it('uses the Playbooks folder when fetching continue-mode docs', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: [],
			});

			await fetchExistingDocsForWizard('/project', 'continue');

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/project/.maestro/playbooks');
		});
	});
});
