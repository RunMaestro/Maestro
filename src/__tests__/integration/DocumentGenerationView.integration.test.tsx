import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AustinFactsDisplay,
	DocumentGenerationView,
} from '../../renderer/components/InlineWizard/DocumentGenerationView';
import type { GeneratedDocument } from '../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../renderer/types';

const austinFactsMock = vi.hoisted(() => {
	const parseFactWithLinks = (fact: string) => {
		const segments: Array<
			{ type: 'text'; content: string } | { type: 'link'; text: string; url: string }
		> = [];
		const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = linkPattern.exec(fact)) !== null) {
			if (match.index > lastIndex) {
				segments.push({ type: 'text', content: fact.slice(lastIndex, match.index) });
			}
			segments.push({ type: 'link', text: match[1], url: match[2] });
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < fact.length) {
			segments.push({ type: 'text', content: fact.slice(lastIndex) });
		}

		return segments;
	};

	return {
		getNextAustinFact: vi.fn(),
		parseFactWithLinks: vi.fn(parseFactWithLinks),
	};
});

vi.mock('../../renderer/components/Wizard/services/austinFacts', () => austinFactsMock);

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#1a1a1a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: '#1c4c7a',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const createDocument = (
	filename: string,
	content: string,
	overrides: Partial<GeneratedDocument> = {}
): GeneratedDocument => ({
	filename,
	content,
	taskCount: 0,
	...overrides,
});

const typeFact = async (plainText: string): Promise<void> => {
	await act(async () => {
		vi.advanceTimersByTime(plainText.length * 25 + 25);
	});
};

describe('Inline Wizard document generation integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
		austinFactsMock.getNextAustinFact
			.mockReset()
			.mockReturnValueOnce('Visit [Zilker Park](https://example.com/zilker) for skyline views.')
			.mockReturnValue('Second Austin fact after rotation.');
		austinFactsMock.parseFactWithLinks.mockClear();
		vi.spyOn(window, 'open').mockImplementation(() => null);
		window.maestro = {
			...window.maestro,
			shell: {
				...window.maestro?.shell,
				openExternal: vi.fn().mockReturnValue(true),
			},
		};
	});

	afterEach(() => {
		cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('types linked Austin facts, opens links externally, and rotates to the next fact', async () => {
		render(<AustinFactsDisplay theme={theme} centered />);

		expect(screen.getByText('Austin Facts')).toBeInTheDocument();
		await typeFact('Visit Zilker Park for skyline views.');

		const link = screen.getByRole('link', { name: 'Zilker Park' });
		fireEvent.click(link);

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/zilker');
		expect(window.open).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(4800);
		});
		await typeFact('Second Austin fact after rotation.');

		expect(screen.getByText(/Second Austin fact after rotation/)).toBeInTheDocument();
	});

	it('shows partially typed links as text and falls back to window.open when shell open fails', async () => {
		austinFactsMock.getNextAustinFact
			.mockReset()
			.mockReturnValue('Try [Barton Springs](https://example.com/barton) after standup.');
		vi.mocked(window.maestro.shell.openExternal).mockReturnValue(false);

		render(<AustinFactsDisplay theme={theme} />);

		await act(async () => {
			vi.advanceTimersByTime('Try Barton'.length * 25);
		});

		expect(screen.queryByRole('link', { name: /Barton Springs/ })).not.toBeInTheDocument();

		await typeFact('Try Barton Springs after standup.');

		fireEvent.click(screen.getByRole('link', { name: 'Barton Springs' }));

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/barton');
		expect(window.open).toHaveBeenCalledWith('https://example.com/barton', '_blank');
	});

	it('hides Austin facts when invisible and renders centered layout when requested', () => {
		const { container, rerender } = render(
			<AustinFactsDisplay theme={theme} isVisible={false} centered />
		);

		expect(container).toBeEmptyDOMElement();

		rerender(<AustinFactsDisplay theme={theme} isVisible centered />);

		expect(screen.getByText('Austin Facts')).toBeInTheDocument();
		expect(container.firstElementChild).toHaveClass('px-4', 'py-3', 'rounded-lg');
		expect(container.firstElementChild).not.toHaveClass('absolute');
	});

	it('renders the empty fallback and invokes cancel', () => {
		const onCancel = vi.fn();

		render(
			<DocumentGenerationView
				theme={theme}
				documents={[]}
				currentDocumentIndex={0}
				isGenerating={false}
				onCancel={onCancel}
			/>
		);

		expect(screen.getByText('No documents generated yet.')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('shows generating progress, elapsed time, cancel control, and Austin facts', async () => {
		const onCancel = vi.fn();

		render(
			<DocumentGenerationView
				theme={theme}
				documents={[]}
				currentDocumentIndex={0}
				isGenerating
				onCancel={onCancel}
			/>
		);

		expect(screen.getByText('Generating Auto Run Documents...')).toBeInTheDocument();
		expect(screen.getByText(/This may take a while/)).toBeInTheDocument();
		expect(screen.getByText('Austin Facts')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(screen.getByText(/Elapsed:/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('renders completed documents, task counts, descriptions, and completion callback', () => {
		const onComplete = vi.fn();
		const documents = [
			createDocument(
				'Plan.md',
				'# Plan\n\nBuild the workflow from the generated specification.\n\n- [ ] Design flow\n- [x] Ship flow'
			),
			createDocument('Checklist.md', '# Checklist\n\n- [ ] Verify docs'),
		];

		render(
			<DocumentGenerationView
				theme={theme}
				documents={documents}
				currentDocumentIndex={0}
				isGenerating={false}
				onComplete={onComplete}
				subfolderName="Generated Docs"
			/>
		);

		expect(screen.getByText('Documentation generation complete.')).toBeInTheDocument();
		expect(screen.getByText('Generated Docs/')).toBeInTheDocument();
		expect(screen.getByText('3')).toBeInTheDocument();
		expect(screen.getByText('Tasks Planned')).toBeInTheDocument();
		expect(screen.getByText('Work Plans Drafted (2)')).toBeInTheDocument();
		expect(screen.getByText('2 tasks')).toBeInTheDocument();
		expect(screen.getByText('1 task')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Plan\.md/ }));

		expect(
			screen.getByText('Build the workflow from the generated specification.')
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Exit Wizard' }));

		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('auto-expands a newly added generated document without collapsing a user-toggled file', () => {
		const firstDoc = createDocument(
			'Phase-1.md',
			'# Phase 1\n\nFirst generated plan paragraph.\n\n- [ ] First task'
		);
		const secondDoc = createDocument(
			'Phase-2.md',
			'# Phase 2\n\nSecond generated plan paragraph.\n\n- [ ] Second task'
		);

		const { rerender } = render(
			<DocumentGenerationView
				theme={theme}
				documents={[firstDoc]}
				currentDocumentIndex={0}
				isGenerating={false}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Phase-1\.md/ }));

		rerender(
			<DocumentGenerationView
				theme={theme}
				documents={[firstDoc, secondDoc]}
				currentDocumentIndex={1}
				isGenerating={false}
			/>
		);

		expect(screen.getByText('First generated plan paragraph.')).toBeInTheDocument();
		expect(screen.getByText('Second generated plan paragraph.')).toBeInTheDocument();
	});

	it('collapses generated-file descriptions when users toggle or a newer untouched file arrives', async () => {
		const firstDoc = createDocument(
			'Auto-1.md',
			'# Auto 1\n\nFirst auto-expanded paragraph.\n\n- [ ] First auto task'
		);
		const secondDoc = createDocument(
			'Auto-2.md',
			'# Auto 2\n\nSecond auto-expanded paragraph.\n\n- [ ] Second auto task'
		);

		const { rerender } = render(
			<DocumentGenerationView theme={theme} documents={[]} currentDocumentIndex={0} isGenerating />
		);

		rerender(
			<DocumentGenerationView
				theme={theme}
				documents={[firstDoc]}
				currentDocumentIndex={0}
				isGenerating={false}
			/>
		);
		await act(async () => {});

		rerender(
			<DocumentGenerationView
				theme={theme}
				documents={[firstDoc, secondDoc]}
				currentDocumentIndex={1}
				isGenerating={false}
			/>
		);
		await act(async () => {});

		expect(screen.getByText('Work Plans Drafted (2)')).toBeInTheDocument();
		expect(screen.getByText('First auto-expanded paragraph.')).toBeInTheDocument();
		expect(screen.getByText('Second auto-expanded paragraph.')).toBeInTheDocument();

		expect(screen.getByRole('button', { name: /Auto-2\.md/ })).toBeInTheDocument();
	});

	it('collapses a manually toggled generated-file description', () => {
		const document = createDocument(
			'Manual.md',
			'# Manual\n\nManual collapse paragraph.\n\n- [ ] Manual task'
		);

		render(
			<DocumentGenerationView
				theme={theme}
				documents={[document]}
				currentDocumentIndex={0}
				isGenerating={false}
			/>
		);

		const toggle = screen.getByRole('button', { name: /Manual\.md/ });

		fireEvent.click(toggle);
		expect(screen.getByText('Manual collapse paragraph.').parentElement).toHaveStyle({
			opacity: '1',
		});

		fireEvent.click(toggle);
		expect(screen.getByText('Manual collapse paragraph.').parentElement).toHaveStyle({
			opacity: '0',
		});
	});
});
