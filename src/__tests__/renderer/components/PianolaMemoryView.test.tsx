import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryView } from '../../../renderer/components/PianolaModal/MemoryView';
import { mockTheme } from '../../helpers/mockTheme';
import type { MemoryConfig, MemoryPacket, MemoryRequest } from '../../../shared/pianola/memory';

const config: MemoryConfig = {
	enabled: true,
	userId: 'owner',
	roots: [],
	exclusions: [],
	mode: 'local',
	endpoint: 'http://127.0.0.1:11434',
	model: 'qwen3:8b',
	hostedConsent: false,
	inputPrice: 0,
	outputPrice: 0,
	tokenBudget: 1000,
	dollarBudget: 0,
	ongoing: false,
};
const packet: MemoryPacket = {
	assessment: { mode: 'advisory-evidence', answerability: 'unassessed' },
	memories: [],
	context: '',
	embeddingSpace: 'synthetic',
	ranking: [],
	overflow: {
		rowTruncatedIds: [],
		omittedMemoryIds: [],
		omissions: [],
		omittedEvidence: 0,
		omittedAlternatives: 0,
	},
};

afterEach(cleanup);

describe('Pianola memory recall controls', () => {
	it('opts only the current search into hosted reranking', async () => {
		const requests: MemoryRequest[] = [];
		vi.mocked(window.maestro.pianola.memory).mockImplementation(async (request) => {
			requests.push(request);
			if (request.action === 'status')
				return {
					config,
					progress: {
						running: false,
						paused: false,
						phase: 'idle',
						sources: 0,
						completed: 0,
						failed: 0,
						excluded: 0,
						pending: 0,
						memories: 0,
						inputTokens: 0,
						outputTokens: 0,
						reservedTokens: 0,
						dollars: 0,
						error: null,
						embeddingSpace: 'synthetic',
					},
				};
			if (request.action === 'sources' || request.action === 'list') return [];
			if (request.action === 'recall') return packet;
			throw new Error('Unexpected memory request');
		});
		render(<MemoryView theme={mockTheme} />);
		expect(await screen.findByText('Recall reranking')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Memory bank' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled());
		fireEvent.change(screen.getByPlaceholderText('Recall a preference, fact, or decision…'), {
			target: { value: 'storage decision' },
		});
		fireEvent.click(
			screen.getByLabelText('Hosted rerank (sends question and shortlisted assertions)')
		);
		fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await waitFor(() => expect(requests.map((request) => request.action)).toContain('recall'));
		const recall = requests.find((request) => request.action === 'recall');
		expect(recall).toMatchObject({
			action: 'recall',
			query: { query: 'storage decision', rerank: true, qualify: false },
		});
	});
});
