import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PlaybookDetailView } from '../../../../../renderer/components/MarketplaceModal/components';
import { makePlaybook, mockTheme } from '../_fixtures';

const openUrlMock = vi.fn();

vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock('../../../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '.marketplace-preview{}',
	createMarkdownComponents: () => ({}),
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

const baseProps = (overrides: Partial<React.ComponentProps<typeof PlaybookDetailView>> = {}) => ({
	theme: mockTheme,
	playbook: makePlaybook(),
	readmeContent: '# README',
	selectedDocFilename: null,
	documentContent: null,
	isLoadingDocument: false,
	targetFolderName: 'test-playbook',
	isImporting: false,
	isRemoteSession: false,
	runningVersion: '1.0.0',
	onBack: vi.fn(),
	onSelectDocument: vi.fn(),
	onTargetFolderChange: vi.fn(),
	onBrowseFolder: vi.fn(),
	onImport: vi.fn(),
	...overrides,
});

describe('PlaybookDetailView', () => {
	beforeEach(() => {
		openUrlMock.mockReset();
	});

	it('renders header, metadata, README markdown, and back button', () => {
		const onBack = vi.fn();
		const { getByText, getByTitle, getByTestId } = render(
			<PlaybookDetailView {...baseProps({ onBack })} />
		);

		expect(getByText('Test Playbook')).toBeTruthy();
		expect(getByText('Description')).toBeTruthy();
		expect(getByText('Author')).toBeTruthy();
		expect(getByText('Documents (2)')).toBeTruthy();
		expect(getByText('Loop: Yes (max 3)')).toBeTruthy();
		expect(getByTestId('markdown').textContent).toBe('# README');

		fireEvent.click(getByTitle('Back to list (Esc)'));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('renders beta, local, and incompatible banners and blocks import', () => {
		const playbook = makePlaybook({
			source: 'local',
			beta: true,
			minMaestroVersion: '99.0.0',
		});
		const { getAllByText, getByText } = render(<PlaybookDetailView {...baseProps({ playbook })} />);

		expect(getAllByText('Local')).toHaveLength(2);
		expect(getByText('BETA')).toBeTruthy();
		expect(getByText('Requires Maestro 99.0.0+')).toBeTruthy();
		expect(
			getByText((_content, element) =>
				Boolean(
					element?.tagName === 'DIV' &&
					element.textContent ===
						"This playbook requires Maestro 99.0.0 or newer. You're running 1.0.0."
				)
			)
		).toBeTruthy();
		expect(
			getByText('This playbook is in beta. Expect rough edges and possible breaking changes.')
		).toBeTruthy();
		expect(getByText('Update Maestro to install').closest('button')).toBeDisabled();
	});

	it('opens author and update URLs', () => {
		const playbook = makePlaybook({ minMaestroVersion: '99.0.0' });
		const { getByText } = render(<PlaybookDetailView {...baseProps({ playbook })} />);

		fireEvent.click(getByText('Maestro Team'));
		expect(openUrlMock).toHaveBeenCalledWith('https://example.com/author');

		fireEvent.click(getByText('Update Maestro'));
		expect(openUrlMock).toHaveBeenCalledWith('https://github.com/RunMaestro/Maestro/releases');
	});

	it('selects documents from sidebar and dropdown and can return to README', () => {
		const onSelectDocument = vi.fn();
		const { getByText, getAllByText } = render(
			<PlaybookDetailView
				{...baseProps({
					selectedDocFilename: 'phase-1',
					documentContent: '# Phase 1',
					onSelectDocument,
				})}
			/>
		);

		expect(getByText('Read more...')).toBeTruthy();
		fireEvent.click(getByText('Read more...'));
		expect(onSelectDocument).toHaveBeenCalledWith('');

		fireEvent.click(getAllByText('2. phase-2.md')[0]);
		expect(onSelectDocument).toHaveBeenCalledWith('phase-2');

		fireEvent.click(getByText('phase-1.md'));
		fireEvent.click(getByText('README.md'));
		expect(onSelectDocument).toHaveBeenCalledWith('');
	});

	it('renders selected document content and loading spinner', () => {
		const { getByTestId, rerender, container } = render(
			<PlaybookDetailView
				{...baseProps({
					selectedDocFilename: 'phase-1',
					documentContent: '# Phase 1',
				})}
			/>
		);

		expect(getByTestId('markdown').textContent).toBe('# Phase 1');

		rerender(<PlaybookDetailView {...baseProps({ isLoadingDocument: true })} />);
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('updates target folder, browses locally, imports, and disables browse remotely', () => {
		const onTargetFolderChange = vi.fn();
		const onBrowseFolder = vi.fn();
		const onImport = vi.fn();
		const { getByPlaceholderText, getByTitle, getByText, rerender } = render(
			<PlaybookDetailView
				{...baseProps({
					onTargetFolderChange,
					onBrowseFolder,
					onImport,
				})}
			/>
		);

		fireEvent.change(getByPlaceholderText('folder-name'), { target: { value: 'new-folder' } });
		expect(onTargetFolderChange).toHaveBeenCalledWith('new-folder');

		fireEvent.click(getByTitle('Browse for folder'));
		expect(onBrowseFolder).toHaveBeenCalledTimes(1);

		fireEvent.click(getByText('Import Playbook'));
		expect(onImport).toHaveBeenCalledTimes(1);

		rerender(<PlaybookDetailView {...baseProps({ isRemoteSession: true })} />);
		expect(getByTitle('Browse is not available for remote sessions')).toBeDisabled();
	});
});
