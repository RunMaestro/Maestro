import { beforeEach, describe, expect, it, vi } from 'vitest';
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

		it('handles empty and whitespace-only chunks', () => {
			expect(extractStreamingTextFromChunk('')).toBe('');
			expect(extractStreamingTextFromChunk('\n \n')).toBe('');
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
			expect(getConversationProviderName('factory-droid')).toBe('factory-droid');
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
