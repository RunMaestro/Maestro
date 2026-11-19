// Source: src/__tests__/renderer/components/PianolaMemoryView.test.tsx
// Source: src/__tests__/renderer/components/GitGraphView.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { MemoryView } from '../../../renderer/components/PianolaModal/MemoryView';
import { mockTheme } from '../../helpers/mockTheme';
import type { MemoryConfig } from '../../../shared/pianola/memory';
import type { MemoryPacket } from '../../../shared/pianola/memory';
import type { MemoryRequest } from '../../../shared/pianola/memory';
import type { MemoryState } from '../../../shared/pianola/memory';
import { beforeAll } from 'vitest';
import { act } from '@testing-library/react';
import { GitGraphView } from '../../../renderer/components/GitGraphView';
import type { GitGraphNode } from '../../../renderer/services/git';
import type { Theme } from '../../../renderer/types';
describeSourceSuite('PianolaMemoryView', () => {
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
});
describeSourceSuite('GitGraphView', () => {
	const theme = {
		name: 'test-theme',
		colors: {
			accent: 'rgb(1, 2, 3)',
			bgSidebar: 'rgb(10, 11, 12)',
			textMain: 'rgb(255, 255, 255)',
			border: 'rgb(50, 50, 50)',
		},
	} as unknown as Theme;

	const node = (hash: string, minute: number, parents: string[] = [], refs: string[] = []) => ({
		hash,
		shortHash: hash,
		parents,
		refs,
		author: 'Test Author',
		date: `2026-08-28T10:0${minute}:00Z`,
		subject: `commit ${hash}`,
	});

	// main:    c1 --- c2 ------ m1 (HEAD)
	//                    \     /
	// feature:  f1 ------ f2 --
	const NODES: GitGraphNode[] = [
		node('m1', 5, ['c2', 'f2'], ['HEAD -> main']),
		node('c1', 1, [], ['main']),
		node('f2', 4, ['f1']),
		node('f1', 2, ['c1'], ['feature']),
		node('c2', 3, ['c1']),
	];

	beforeAll(() => {
		// @gitgraph measures its labels with getBBox, which jsdom does not implement.
		if (!('getBBox' in SVGElement.prototype)) {
			Object.defineProperty(SVGElement.prototype, 'getBBox', {
				value: () => ({ x: 0, y: 0, width: 40, height: 12 }),
				writable: true,
			});
		}
	});

	// The core populates the React component from a setTimeout(0) scheduled while it
	// is built, so the graph is empty until that flushes.
	const renderGraph = async (props: Partial<Parameters<typeof GitGraphView>[0]> = {}) => {
		const view = render(<GitGraphView nodes={NODES} theme={theme} {...props} />);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		return view;
	};

	const dotFor = (hash: string) => document.querySelector(`[data-commit-dot="${hash}"]`)!;

	describe('GitGraphView', () => {
		it('draws a dot for every commit', async () => {
			await renderGraph();
			for (const hash of ['c1', 'c2', 'f1', 'f2', 'm1']) {
				expect(dotFor(hash)).toBeTruthy();
			}
		});

		// A 5px dot is a ~10px target. The invisible hit circle is what makes a dot
		// in a dense graph actually clickable, and it has to be CONCENTRIC with the
		// drawn dot or the clickable region sits beside what the user is aiming at.
		it('gives each dot a hit area far larger than the dot, centered on it', async () => {
			await renderGraph();
			const circles = Array.from(dotFor('c2').querySelectorAll('circle'));
			const hit = circles.find((c) => c.getAttribute('fill') === 'transparent')!;
			const drawn = circles[circles.length - 1];

			expect(Number(hit.getAttribute('r'))).toBeGreaterThan(Number(drawn.getAttribute('r')) * 2);
			expect(Number(hit.getAttribute('r'))).toBeGreaterThanOrEqual(10);
			expect(hit.getAttribute('cx')).toBe(drawn.getAttribute('cx'));
			expect(hit.getAttribute('cy')).toBe(drawn.getAttribute('cy'));
		});

		// The dot is centered on `template.commit.dot.size`, which is where @gitgraph
		// offsets the branch paths to. Anywhere else and the dot floats off its line.
		it('centers the dot where the branch line is drawn', async () => {
			await renderGraph();
			const drawn = Array.from(dotFor('c2').querySelectorAll('circle')).pop()!;
			expect(drawn.getAttribute('cx')).toBe('5');
			expect(drawn.getAttribute('cy')).toBe('5');
		});

		it('selects a commit when its dot is clicked', async () => {
			const onCommitClick = vi.fn();
			await renderGraph({ onCommitClick });
			fireEvent.click(dotFor('f1'));
			expect(onCommitClick).toHaveBeenCalledWith('f1');
		});

		it('marks only the selected commit', async () => {
			const { rerender } = await renderGraph({ selectedHash: 'c2' });
			expect(dotFor('c2').getAttribute('data-selected')).toBe('true');
			expect(dotFor('f2').getAttribute('data-selected')).toBeNull();

			rerender(<GitGraphView nodes={NODES} theme={theme} selectedHash="f2" />);
			expect(dotFor('f2').getAttribute('data-selected')).toBe('true');
			expect(dotFor('c2').getAttribute('data-selected')).toBeNull();
		});

		// This is the regression that made the arrow keys look broken. The selection
		// used to be baked into the @gitgraph core, and `<Gitgraph>` reads its `graph`
		// prop only in its constructor - so every keypress swapped the core, remounted
		// the SVG, and the momentarily empty scroll container snapped back to the top
		// of the graph. The user lost their place on every press.
		it('does not rebuild the graph when the selection moves', async () => {
			const { rerender } = await renderGraph({ selectedHash: 'm1' });
			const svg = document.querySelector('svg');
			const dot = dotFor('c1');

			rerender(<GitGraphView nodes={NODES} theme={theme} selectedHash="c1" />);

			// Same DOM nodes, so nothing was torn down and no scroll state was lost.
			expect(document.querySelector('svg')).toBe(svg);
			expect(dotFor('c1')).toBe(dot);
			expect(dot.getAttribute('data-selected')).toBe('true');
		});

		// New commits must still reach the screen, which needs the remount that the
		// selection must not trigger.
		it('rebuilds the graph when the commits change', async () => {
			const { rerender } = await renderGraph();
			expect(dotFor('m1')).toBeTruthy();

			const fewer = NODES.filter((n) => n.hash !== 'm1');
			rerender(<GitGraphView nodes={fewer} theme={theme} />);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(document.querySelector('[data-commit-dot="m1"]')).toBeNull();
			expect(dotFor('c2')).toBeTruthy();
		});

		it('renders each commit subject', async () => {
			await renderGraph();
			expect(screen.getByText('commit c2')).toBeTruthy();
		});
	});
});
