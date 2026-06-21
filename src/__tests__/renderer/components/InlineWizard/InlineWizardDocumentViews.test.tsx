import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AustinFactsDisplay } from '../../../../renderer/components/InlineWizard/AustinFactsDisplay';
import { DocumentGenerationView } from '../../../../renderer/components/InlineWizard/DocumentGenerationView';
import { StreamingDocumentPreview } from '../../../../renderer/components/InlineWizard/StreamingDocumentPreview';
import type { Theme } from '../../../../renderer/types';
import type { GeneratedDocument } from '../../../../renderer/components/Wizard/WizardContext';

const factState = vi.hoisted(() => ({
	index: 0,
	facts: ['Visit [Austin](https://austin.example) today.', 'Second Austin fact.'],
}));

vi.mock('../../../../renderer/components/Wizard/services/austinFacts', () => ({
	getNextAustinFact: vi.fn(() => {
		const fact = factState.facts[factState.index % factState.facts.length];
		factState.index += 1;
		return fact;
	}),
	parseFactWithLinks: vi.fn((fact: string) => {
		if (fact === 'Unsupported segment fact.') {
			return [
				{ type: 'text', content: 'Known ' },
				{ type: 'unsupported', content: 'hidden' },
				{ type: 'text', content: 'visible' },
			];
		}

		const match = fact.match(/^(.*)\[([^\]]+)\]\(([^)]+)\)(.*)$/);
		if (!match) return [{ type: 'text', content: fact }];
		return [
			{ type: 'text', content: match[1] },
			{ type: 'link', text: match[2], url: match[3] },
			{ type: 'text', content: match[4] },
		];
	}),
}));

vi.mock('lucide-react', () => ({
	ChevronDown: ({ className }: { className?: string }) => (
		<svg data-testid="chevron-down-icon" className={className} />
	),
	ChevronRight: ({ className }: { className?: string }) => (
		<svg data-testid="chevron-right-icon" className={className} />
	),
	FileText: ({ className }: { className?: string }) => (
		<svg data-testid="file-text-icon" className={className} />
	),
	Check: ({ className }: { className?: string }) => (
		<svg data-testid="check-icon" className={className} />
	),
	Code2: ({ className }: { className?: string }) => (
		<svg data-testid="code-icon" className={className} />
	),
	AlignLeft: ({ className }: { className?: string }) => (
		<svg data-testid="align-left-icon" className={className} />
	),
}));

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#202020',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

const documents: GeneratedDocument[] = [
	{
		filename: 'Phase-01.md',
		content: '# Phase 1\n\nBuild the foundation.\n\n- [ ] First task\n- [x] Done task',
		taskCount: 2,
	},
	{
		filename: 'Phase-02.md',
		content: '# Phase 2\n\nShip the next slice.\n\n- [ ] Another task',
		taskCount: 1,
	},
];

describe('Inline Wizard document display components', () => {
	beforeEach(() => {
		factState.index = 0;
		factState.facts = ['Visit [Austin](https://austin.example) today.', 'Second Austin fact.'];
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe('AustinFactsDisplay', () => {
		it('hides when not visible', () => {
			render(<AustinFactsDisplay theme={mockTheme} isVisible={false} />);

			expect(screen.queryByText('Austin Facts')).not.toBeInTheDocument();
		});

		it('types facts, renders completed links, opens them externally, and rotates facts', () => {
			vi.useFakeTimers();
			render(<AustinFactsDisplay theme={mockTheme} centered />);

			expect(screen.getByText('Austin Facts')).toBeInTheDocument();
			act(() => {
				vi.advanceTimersByTime('Visit Austin today.'.length * 25 + 25);
			});

			const link = screen.getByRole('link', { name: 'Austin' });
			fireEvent.click(link);
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://austin.example');

			act(() => {
				vi.advanceTimersByTime(4_800);
			});
			act(() => {
				vi.advanceTimersByTime('Second Austin fact.'.length * 25 + 25);
			});

			expect(screen.getByText(/Second Austin fact/)).toBeInTheDocument();
		});

		it('falls back to window.open when external shell opening is unavailable', () => {
			vi.useFakeTimers();
			vi.mocked(window.maestro.shell.openExternal).mockReturnValue(undefined as never);
			const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
			render(<AustinFactsDisplay theme={mockTheme} />);

			act(() => {
				vi.advanceTimersByTime('Visit Austin today.'.length * 25 + 25);
			});
			fireEvent.click(screen.getByRole('link', { name: 'Austin' }));

			expect(windowOpen).toHaveBeenCalledWith('https://austin.example', '_blank');
		});

		it('ignores unsupported parser segments without dropping following text', () => {
			factState.facts = ['Unsupported segment fact.'];
			vi.useFakeTimers();
			render(<AustinFactsDisplay theme={mockTheme} />);

			act(() => {
				vi.advanceTimersByTime('Unsupported segment fact.'.length * 25 + 25);
			});

			expect(screen.getByText(/Known/)).toBeInTheDocument();
			expect(screen.queryByText('hidden')).not.toBeInTheDocument();
			expect(screen.getByText('visible')).toBeInTheDocument();
		});

		it('renders an in-progress link segment as styled text until the link is fully typed', () => {
			vi.useFakeTimers();
			render(<AustinFactsDisplay theme={mockTheme} />);

			act(() => {
				vi.advanceTimersByTime('Visit Aus'.length * 25);
			});

			expect(screen.queryByRole('link', { name: 'Austin' })).not.toBeInTheDocument();
			expect(screen.getByText('Aus')).toBeInTheDocument();
		});
	});

	describe('StreamingDocumentPreview', () => {
		it('renders raw streaming content, phase progress, and disables markdown for open code blocks', () => {
			render(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'# Draft\n\n```ts\nconst x = 1;'}
					filename="Phase-01.md"
					currentPhase={2}
					totalPhases={3}
				/>
			);

			expect(screen.getByText('Phase-01.md')).toBeInTheDocument();
			expect(screen.getByText('Generating Phase 2 of 3...')).toBeInTheDocument();
			expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Preview/i })).toBeDisabled();
			expect(
				screen.getByTitle('Markdown preview unavailable (code block in progress)')
			).toBeInTheDocument();
		});

		it('toggles markdown preview, opens external links, resets scroll state on filename changes, and resumes auto-scroll', () => {
			const { container, rerender } = render(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'# Ready\n\n[Docs](https://docs.example)'}
					filename="Phase-01.md"
				/>
			);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement;
			Object.defineProperties(scrollContainer, {
				scrollTop: { configurable: true, writable: true, value: 0 },
				scrollHeight: { configurable: true, value: 1000 },
				clientHeight: { configurable: true, value: 200 },
			});

			scrollContainer.scrollTop = 760;
			fireEvent.scroll(scrollContainer);
			expect(screen.queryByRole('button', { name: /Resume auto-scroll/i })).not.toBeInTheDocument();

			scrollContainer.scrollTop = 0;
			fireEvent.scroll(scrollContainer);
			expect(screen.getByRole('button', { name: /Resume auto-scroll/i })).toBeInTheDocument();

			rerender(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'# Ready\n\n[Docs](https://docs.example)\n\nUpdated'}
					filename="Phase-01.md"
				/>
			);
			expect(scrollContainer.scrollTop).toBe(0);
			expect(screen.getByRole('button', { name: /Resume auto-scroll/i })).toBeInTheDocument();

			rerender(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'# Ready\n\n[Docs](https://docs.example)'}
					filename="Phase-02.md"
				/>
			);
			expect(screen.queryByRole('button', { name: /Resume auto-scroll/i })).not.toBeInTheDocument();

			Object.defineProperties(scrollContainer, {
				scrollTop: { configurable: true, writable: true, value: 0 },
				scrollHeight: { configurable: true, value: 1000 },
				clientHeight: { configurable: true, value: 200 },
			});
			fireEvent.scroll(scrollContainer);
			fireEvent.click(screen.getByRole('button', { name: /Preview/i }));
			fireEvent.click(screen.getByRole('link', { name: 'Docs' }));
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://docs.example');
			fireEvent.click(screen.getByRole('button', { name: /Raw/i }));

			fireEvent.click(screen.getByRole('button', { name: /Resume auto-scroll/i }));
			expect(screen.queryByRole('button', { name: /Resume auto-scroll/i })).not.toBeInTheDocument();
			expect(scrollContainer.scrollTop).toBe(1000);
		});

		it('renders the filename fallback and ignores relative markdown links', () => {
			const { rerender } = render(
				<StreamingDocumentPreview theme={mockTheme} content={'Read [Local](./README.md)'} />
			);

			expect(screen.getByText('Generating...')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Preview/i }));
			fireEvent.click(screen.getByRole('link', { name: 'Local' }));
			expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();

			rerender(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'Read [Local](./README.md)'}
					filename="Draft.md"
				/>
			);
			expect(screen.getByText('Draft.md')).toBeInTheDocument();

			rerender(
				<StreamingDocumentPreview theme={mockTheme} content={'Read [Local](./README.md)'} />
			);
			expect(screen.getByText('Generating...')).toBeInTheDocument();
		});

		it('closes incomplete markdown links before rendering preview', () => {
			render(
				<StreamingDocumentPreview
					theme={mockTheme}
					content={'Read [Docs](https://docs.example'}
					filename="Phase-01.md"
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Preview/i }));

			expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
				'href',
				'https://docs.example'
			);
		});
	});

	describe('DocumentGenerationView', () => {
		it('renders the empty fallback and cancel action', () => {
			const onCancel = vi.fn();
			render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
					onCancel={onCancel}
				/>
			);

			expect(screen.getByText('No documents generated yet.')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('shows generating state, elapsed time, pending dots, cancel action, and Austin facts', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
			const onCancel = vi.fn();
			render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[]}
					currentDocumentIndex={0}
					isGenerating={true}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
					onCancel={onCancel}
				/>
			);

			expect(screen.getByText('Generating Auto Run Documents...')).toBeInTheDocument();
			expect(screen.getByText(/creating detailed task documents/i)).toBeInTheDocument();
			expect(screen.getByText('Austin Facts')).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(1_000);
			});
			expect(screen.getByText('Elapsed: 1s')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('renders completed documents, task totals, expandable file descriptions, and exits', () => {
			const onComplete = vi.fn();
			const { rerender } = render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[documents[0]]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={onComplete}
					onDocumentSelect={vi.fn()}
					subfolderName="2026-05-15-plan"
				/>
			);
			rerender(
				<DocumentGenerationView
					theme={mockTheme}
					documents={documents}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={onComplete}
					onDocumentSelect={vi.fn()}
					subfolderName="2026-05-15-plan"
				/>
			);

			expect(screen.getByText('Documentation generation complete.')).toBeInTheDocument();
			expect(screen.getByText('2026-05-15-plan/')).toBeInTheDocument();
			expect(screen.getByText('3')).toBeInTheDocument();
			expect(screen.getByText('Tasks Planned')).toBeInTheDocument();
			expect(screen.getByText('Work Plans Drafted (2)')).toBeInTheDocument();
			expect(screen.getByText('Phase-01.md')).toBeInTheDocument();
			expect(screen.getByText('2 tasks')).toBeInTheDocument();
			expect(screen.getByText('Ship the next slice.')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/ }));
			expect(screen.getByText('Build the foundation.')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Phase-02.md/ }));

			fireEvent.click(screen.getByRole('button', { name: 'Exit Wizard' }));
			expect(onComplete).toHaveBeenCalledTimes(1);
		});

		it('renders a singular task total and truncates long first paragraphs', () => {
			const longDescription = 'A'.repeat(160);
			const singleTaskDocument: GeneratedDocument = {
				filename: 'Phase-04.md',
				content: `# Phase 4\n\n${longDescription}\n\n- [ ] One task`,
				taskCount: 1,
			};

			render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[singleTaskDocument]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
				/>
			);

			expect(screen.getByText('Task Planned')).toBeInTheDocument();
			expect(screen.getByText(`${longDescription.slice(0, 147)}...`)).toBeInTheDocument();
		});

		it('omits the task total when completed generated content has no checklist items', () => {
			render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[
						{
							filename: 'Notes.md',
							content: '# Notes\n\nNo checklist items in this generated document.',
							taskCount: 0,
						},
					]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
				/>
			);

			expect(screen.getByText('Work Plans Drafted (1)')).toBeInTheDocument();
			expect(
				screen.getByText('No checklist items in this generated document.')
			).toBeInTheDocument();
			expect(screen.queryByText(/Tasks? Planned/)).not.toBeInTheDocument();
		});

		it('auto-collapses the previous generated file and omits checklist-only descriptions', async () => {
			const checklistOnlyDocument: GeneratedDocument = {
				filename: 'Phase-03.md',
				content: '# Phase 3\n\n- [ ] Checklist only',
				taskCount: 1,
			};
			const { rerender } = render(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[documents[0]]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
				/>
			);
			rerender(
				<DocumentGenerationView
					theme={mockTheme}
					documents={documents}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
				/>
			);
			expect(screen.getByText('Ship the next slice.').parentElement).toHaveStyle({
				maxHeight: '120px',
			});

			rerender(
				<DocumentGenerationView
					theme={mockTheme}
					documents={[...documents, checklistOnlyDocument]}
					currentDocumentIndex={0}
					isGenerating={false}
					onComplete={vi.fn()}
					onDocumentSelect={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Ship the next slice.').parentElement).toHaveStyle({
					maxHeight: '0px',
				});
			});
			expect(screen.getByText('Phase-03.md')).toBeInTheDocument();
			expect(screen.queryByText(/Checklist only/)).not.toBeInTheDocument();
		});
	});
});
