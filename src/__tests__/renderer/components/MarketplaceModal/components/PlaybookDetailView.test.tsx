import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
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

	it('shows the Form interaction badge by default and Guided plus scope when declared', () => {
		const { getByText, queryByText, rerender } = render(<PlaybookDetailView {...baseProps()} />);
		expect(getByText('Form')).toBeTruthy();
		expect(queryByText('Machine')).toBeNull();

		rerender(
			<PlaybookDetailView
				{...baseProps({ playbook: makePlaybook({ interaction: 'guided', scope: 'machine' }) })}
			/>
		);
		expect(getByText('Guided')).toBeTruthy();
		expect(getByText('Machine').getAttribute('title')).toBe(
			'This playbook configures your machine, not just this project.'
		);
	});

	it('lists the merged parameter form with type, default, and required marker', () => {
		const prompt = [
			'<!-- CONFIGURE: How many items to process -->',
			'**MAX_ITEMS:** `25`',
			'',
			'<!-- CONFIGURE: The pull request to review -->',
			'**PR_URL:** `https://github.com/OWNER/REPO/pull/XXX`',
		].join('\n');
		const playbook = makePlaybook({
			prompt,
			parameters: [
				{ name: 'MAX_ITEMS', type: 'number', min: 1 },
				{ name: 'PR_URL', type: 'url' },
				{ name: 'EXTRA_TAGS', type: 'multi-enum', options: ['a', 'b'], required: false },
			],
		});
		const { getByTestId, getByText } = render(<PlaybookDetailView {...baseProps({ playbook })} />);

		expect(getByText('Configuration (3)')).toBeTruthy();

		const maxItems = within(getByTestId('playbook-param-MAX_ITEMS'));
		expect(maxItems.getByText('number')).toBeTruthy();
		expect(maxItems.getByText('25')).toBeTruthy();
		expect(maxItems.queryByLabelText('Required')).toBeNull();
		expect(getByTestId('playbook-param-MAX_ITEMS').getAttribute('title')).toBe(
			'How many items to process'
		);

		// A placeholder default is no default, so the parameter is required.
		const prUrl = within(getByTestId('playbook-param-PR_URL'));
		expect(prUrl.getByText('url')).toBeTruthy();
		expect(prUrl.getByText('No default')).toBeTruthy();
		expect(prUrl.getByLabelText('Required')).toBeTruthy();

		const extra = within(getByTestId('playbook-param-EXTRA_TAGS'));
		expect(extra.getByText('multi-enum')).toBeTruthy();
		expect(extra.queryByLabelText('Required')).toBeNull();
	});

	it('says when a playbook has no parameters and hides the instructions without a prompt', () => {
		const { getByText, queryByTestId } = render(<PlaybookDetailView {...baseProps()} />);
		expect(getByText('No parameters to configure.')).toBeTruthy();
		expect(queryByTestId('playbook-agent-instructions')).toBeNull();
	});

	it('shows the raw prompt in a collapsed Agent instructions disclosure', () => {
		const playbook = makePlaybook({ prompt: 'Do the thing with [MAX_ITEMS].' });
		const { getByTestId } = render(<PlaybookDetailView {...baseProps({ playbook })} />);

		const disclosure = getByTestId('playbook-agent-instructions');
		expect(disclosure.tagName).toBe('DETAILS');
		expect(disclosure.hasAttribute('open')).toBe(false);
		expect(within(disclosure).getByText('Agent instructions')).toBeTruthy();
		expect(within(disclosure).getByTestId('markdown').textContent).toBe(
			'Do the thing with [MAX_ITEMS].'
		);
	});

	it('lists manifest assets, or notes that they are discovered at install', () => {
		const { getByText, rerender } = render(<PlaybookDetailView {...baseProps()} />);
		expect(
			getByText(
				"Not listed in the manifest. Any files in the playbook's assets folder are discovered at install."
			)
		).toBeTruthy();

		rerender(
			<PlaybookDetailView
				{...baseProps({ playbook: makePlaybook({ assets: ['config.yaml', 'Dockerfile'] }) })}
			/>
		);
		expect(getByText('Assets (2)')).toBeTruthy();
		expect(getByText('config.yaml')).toBeTruthy();
		expect(getByText('Dockerfile')).toBeTruthy();
	});
});
