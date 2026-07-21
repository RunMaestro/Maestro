/**
 * Tests for SymphonyModal/components/RepositoryDetailView - issue partitioning,
 * document dropdown + click-outside, document selection, start-button gating,
 * loading states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

const openUrlSpy = vi.fn();
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlSpy(...args),
}));

vi.mock('../../../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '',
	createMarkdownComponents: () => ({}),
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: ({ size }: { size?: number }) => <span data-testid="spinner" data-size={size} />,
}));

vi.mock('../../../../../renderer/components/ui/GhostIconButton', () => ({
	GhostIconButton: ({
		children,
		onClick,
		title,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		title?: string;
	}) => (
		<button onClick={onClick} title={title}>
			{children}
		</button>
	),
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className }: { className?: string }) => (
			<svg data-testid={`icon-${name}`} className={className} />
		);
		C.displayName = name;
		return C;
	};
	return {
		ArrowLeft: icon('ArrowLeft'),
		Music: icon('Music'),
		ExternalLink: icon('ExternalLink'),
		GitPullRequest: icon('GitPullRequest'),
		GitBranch: icon('GitBranch'),
		FileText: icon('FileText'),
		CheckCircle: icon('CheckCircle'),
		Play: icon('Play'),
		Lock: icon('Lock'),
		ChevronDown: icon('ChevronDown'),
	};
});

import { RepositoryDetailView } from '../../../../../renderer/components/SymphonyModal/components/RepositoryDetailView';
import { mockTheme, makeRepo, makeIssue } from '../_fixtures';
import { SYMPHONY_BLOCKING_LABEL } from '../../../../../shared/symphony-constants';
import type { SymphonyIssue } from '../../../../../shared/symphony-types';

const baseProps = (overrides: Partial<React.ComponentProps<typeof RepositoryDetailView>> = {}) => ({
	theme: mockTheme,
	repo: makeRepo({ tags: ['foo'], maintainer: { name: 'alice', url: 'https://m' } }),
	issues: [] as SymphonyIssue[],
	isLoadingIssues: false,
	selectedIssue: null,
	documentPreview: null,
	isLoadingDocument: false,
	isStarting: false,
	onBack: vi.fn(),
	onSelectIssue: vi.fn(),
	onStartContribution: vi.fn(),
	onPreviewDocument: vi.fn(),
	...overrides,
});

beforeEach(() => {
	openUrlSpy.mockReset();
});

describe('RepositoryDetailView', () => {
	it('renders the repo header with name + category', () => {
		const { getByText } = render(<RepositoryDetailView {...baseProps()} />);
		expect(getByText(/Maestro Symphony:/)).toBeTruthy();
		expect(getByText('example')).toBeTruthy();
	});

	it('shows loading skeletons while issues load', () => {
		const { container } = render(
			<RepositoryDetailView {...baseProps({ isLoadingIssues: true })} />
		);
		expect(container.querySelectorAll('.animate-pulse').length).toBe(3);
	});

	it('partitions issues into In Progress / Available / Blocked sections', () => {
		const issues: SymphonyIssue[] = [
			makeIssue({ number: 1, title: 'A1', status: 'available' }),
			makeIssue({
				number: 2,
				title: 'B2',
				status: 'available',
				labels: [{ name: SYMPHONY_BLOCKING_LABEL, color: 'red' }],
			}),
			makeIssue({ number: 3, title: 'C3', status: 'in_progress' }),
		];
		const { getByText } = render(<RepositoryDetailView {...baseProps({ issues })} />);
		expect(getByText('In Progress (1)')).toBeTruthy();
		expect(getByText('Available Issues (1)')).toBeTruthy();
		expect(getByText('Blocked (1)')).toBeTruthy();
	});

	it('calls onBack when the back button is clicked', () => {
		const onBack = vi.fn();
		const { getByTitle } = render(<RepositoryDetailView {...baseProps({ onBack })} />);
		fireEvent.click(getByTitle('Back (Esc)'));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('opens external repo URL when the repo-link button is clicked', () => {
		const repo = makeRepo({ url: 'https://github.com/m/e' });
		const { getByText } = render(<RepositoryDetailView {...baseProps({ repo })} />);
		fireEvent.click(getByText('example'));
		expect(openUrlSpy).toHaveBeenCalledWith('https://github.com/m/e');
	});

	it('shows the "select an issue" empty state when issues exist but none selected', () => {
		const issues = [makeIssue({ number: 1, status: 'available' })];
		const { getByText } = render(<RepositoryDetailView {...baseProps({ issues })} />);
		expect(getByText('Select an issue to see details')).toBeTruthy();
	});

	it('auto-loads the first document when selectedIssue gains documents', () => {
		const onPreviewDocument = vi.fn();
		const issue = makeIssue({
			number: 1,
			documentPaths: [
				{ name: 'one.md', path: 'p/one.md', isExternal: false },
				{ name: 'two.md', path: 'p/two.md', isExternal: true },
			],
		});
		render(
			<RepositoryDetailView
				{...baseProps({ selectedIssue: issue, onPreviewDocument, issues: [issue] })}
			/>
		);
		expect(onPreviewDocument).toHaveBeenCalledWith('p/one.md', false);
	});

	it('opens the document dropdown and selects a different doc', () => {
		const onPreviewDocument = vi.fn();
		const issue = makeIssue({
			documentPaths: [
				{ name: 'one.md', path: 'p/one.md', isExternal: false },
				{ name: 'two.md', path: 'p/two.md', isExternal: true },
			],
		});
		const { getByText, getAllByRole } = render(
			<RepositoryDetailView
				{...baseProps({ selectedIssue: issue, onPreviewDocument, issues: [issue] })}
			/>
		);
		onPreviewDocument.mockClear();
		// open dropdown by clicking the toggle (which displays current doc name)
		fireEvent.click(getByText('one.md'));
		// select two.md from the menu
		const buttons = getAllByRole('button').filter((b) => b.textContent === 'two.md');
		fireEvent.click(buttons[0]);
		expect(onPreviewDocument).toHaveBeenCalledWith('p/two.md', true);
	});

	it('closes the dropdown on outside mousedown', () => {
		const issue = makeIssue({
			documentPaths: [
				{ name: 'one.md', path: 'p/one.md', isExternal: false },
				{ name: 'two.md', path: 'p/two.md', isExternal: false },
			],
		});
		const { getByText, queryByRole, container } = render(
			<RepositoryDetailView {...baseProps({ selectedIssue: issue, issues: [issue] })} />
		);
		fireEvent.click(getByText('one.md'));
		// two.md visible as menu option
		expect(queryByRole('button', { name: 'two.md' })).toBeTruthy();
		// fire mousedown on root container (outside dropdownRef)
		act(() => {
			document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			// dispatch event on body element to ensure outside
			const ev = new MouseEvent('mousedown', { bubbles: true });
			Object.defineProperty(ev, 'target', { value: container });
			document.dispatchEvent(ev);
		});
		// menu should disappear after outside click
		expect(queryByRole('button', { name: 'two.md' })).toBeNull();
	});

	it('renders the loading spinner while a document is loading', () => {
		const issue = makeIssue();
		const { getAllByTestId } = render(
			<RepositoryDetailView
				{...baseProps({
					selectedIssue: issue,
					issues: [issue],
					isLoadingDocument: true,
				})}
			/>
		);
		expect(getAllByTestId('spinner').length).toBeGreaterThan(0);
	});

	it('renders the markdown preview when documentPreview is set', () => {
		const issue = makeIssue();
		const { getByTestId } = render(
			<RepositoryDetailView
				{...baseProps({
					selectedIssue: issue,
					issues: [issue],
					documentPreview: '# Hello',
				})}
			/>
		);
		expect(getByTestId('markdown').textContent).toBe('# Hello');
	});

	it('disables the Start button when the selected issue is blocked and shows the Blocked message', () => {
		const onStart = vi.fn();
		const blocked = makeIssue({
			number: 5,
			status: 'available',
			labels: [{ name: SYMPHONY_BLOCKING_LABEL, color: 'red' }],
		});
		const { getByText, getByRole } = render(
			<RepositoryDetailView
				{...baseProps({
					selectedIssue: blocked,
					issues: [blocked],
					onStartContribution: onStart,
				})}
			/>
		);
		expect(getByText(/Blocked by a dependency/)).toBeTruthy();
		const startBtn = getByRole('button', { name: /Start Symphony/ });
		expect((startBtn as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(startBtn);
		expect(onStart).not.toHaveBeenCalled();
	});

	it('fires onStartContribution when an available issue is selected and the button is clicked', () => {
		const onStart = vi.fn();
		const issue = makeIssue({ status: 'available' });
		const { getByRole } = render(
			<RepositoryDetailView
				{...baseProps({
					selectedIssue: issue,
					issues: [issue],
					onStartContribution: onStart,
				})}
			/>
		);
		fireEvent.click(getByRole('button', { name: /Start Symphony/ }));
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it('shows "Starting..." spinner when isStarting is true', () => {
		const issue = makeIssue();
		const { getByText, getAllByTestId } = render(
			<RepositoryDetailView
				{...baseProps({ selectedIssue: issue, issues: [issue], isStarting: true })}
			/>
		);
		expect(getByText('Starting...')).toBeTruthy();
		expect(getAllByTestId('spinner').length).toBeGreaterThan(0);
	});
});
