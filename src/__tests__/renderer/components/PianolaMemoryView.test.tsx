import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryView } from '../../../renderer/components/PianolaModal/MemoryView';
import { mockTheme } from '../../helpers/mockTheme';
import type {
	MemoryConfig,
	MemoryPacket,
	MemoryRequest,
	MemoryState,
} from '../../../shared/pianola/memory';

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
const progress: MemoryState['progress'] = {
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
			if (request.action === 'status') return { config, progress };
			if (request.action === 'sources' || request.action === 'list') return [];
			if (request.action === 'recall') return packet;
			throw new Error('Unexpected memory request');
		});
		render(<MemoryView theme={mockTheme} />);
		await screen.findByRole('button', { name: 'Memory bank' });
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

describe('Pianola memory setup', () => {
	it('keeps tuning advanced and starts learning with one consented action', async () => {
		const requests: MemoryRequest[] = [];
		let current = config;
		vi.mocked(window.maestro.pianola.memory).mockImplementation(async (request) => {
			requests.push(request);
			if (request.action === 'status') return { config: current, progress };
			if (request.action === 'sources') return [];
			if (request.action === 'configure') {
				current = { ...current, ...request.config };
				return { config: current, progress };
			}
			if (request.action === 'discover') return [];
			if (request.action === 'start') return { config: current, progress };
			throw new Error('Unexpected memory request');
		});
		render(<MemoryView theme={mockTheme} />);
		await screen.findByRole('combobox', { name: 'Processing provider' });
		expect(screen.getByText('Advanced settings').closest('details')).not.toHaveAttribute('open');
		expect(
			screen.queryByRole('button', { name: 'Discover selected history' })
		).not.toBeInTheDocument();

		fireEvent.change(screen.getByRole('combobox', { name: 'Processing provider' }), {
			target: { value: 'openai' },
		});
		expect(screen.getByRole('button', { name: 'Save & start learning' })).toBeDisabled();
		fireEvent.click(screen.getByText('Advanced settings'));
		expect(screen.getByRole('textbox', { name: 'Extraction model' })).toHaveValue('gpt-5.4-mini');
		fireEvent.click(screen.getByRole('checkbox', { name: /Allow OpenAI to process/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Save & start learning' }));

		await waitFor(() => expect(requests.map((request) => request.action)).toContain('start'));
		const configure = requests.find((request) => request.action === 'configure');
		expect(configure).toMatchObject({
			action: 'configure',
			config: {
				mode: 'hosted',
				hostedProvider: 'openai',
				hostedConsent: true,
				model: 'gpt-5.4-mini',
			},
		});
		expect(
			requests
				.map((request) => request.action)
				.filter((action) => ['configure', 'discover', 'start'].includes(action))
		).toEqual(['configure', 'discover', 'start']);
	});

	it('auto-fills an installed CLI account without API-only controls', async () => {
		vi.mocked(window.maestro.pianola.memory).mockImplementation(async (request) => {
			if (request.action === 'status')
				return {
					config,
					progress,
					cliProviders: [
						{
							id: 'claude-code',
							name: 'Claude Code',
							path: 'C:\\tools\\claude.exe',
							model: 'sonnet',
						},
					],
					apiCredentials: { OPENAI_API_KEY: false },
				};
			if (request.action === 'sources') return [];
			throw new Error('Unexpected memory request');
		});
		render(<MemoryView theme={mockTheme} />);
		const picker = await screen.findByRole('combobox', { name: 'Processing provider' });
		fireEvent.change(picker, { target: { value: 'claude-code' } });
		expect(screen.getByText(/Detected: sonnet/)).toBeInTheDocument();
		expect(
			screen.queryByRole('spinbutton', { name: 'Spending limit (USD)' })
		).not.toBeInTheDocument();
		expect(screen.queryByRole('option', { name: 'Oh My Pi CLI' })).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Advanced settings'));
		expect(screen.getByRole('textbox', { name: 'Extraction model' })).toHaveValue('sonnet');
		expect(screen.getByRole('spinbutton', { name: 'Lifetime dollar cap (USD)' })).toHaveValue(0);
		fireEvent.change(picker, { target: { value: 'openai' } });
		expect(screen.queryByText(/Detected: sonnet/)).not.toBeInTheDocument();
	});

	it('discloses hosted qualification independently of local extraction', async () => {
		vi.mocked(window.maestro.pianola.memory).mockImplementation(async (request) => {
			if (request.action === 'status')
				return {
					config: {
						...config,
						qualification: {
							provider: 'hosted' as const,
							model: 'qwen3.6',
							endpoint: 'https://api.example.test',
						},
					},
					progress,
				};
			if (request.action === 'sources' || request.action === 'list') return [];
			throw new Error('Unexpected memory request');
		});
		render(<MemoryView theme={mockTheme} />);
		fireEvent.click(await screen.findByText('Advanced settings'));
		expect(
			screen.getByText(/Hosted qualification sends the question and candidate assertions/)
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Memory bank' }));
		const query = await screen.findByPlaceholderText('Recall a preference, fact, or decision…');
		fireEvent.change(query, { target: { value: 'storage decision' } });
		expect(
			screen.getByRole('checkbox', {
				name: 'Optional hosted model review (sends question and candidate assertions)',
			})
		).toBeInTheDocument();
	});
});
