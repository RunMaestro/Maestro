import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { TabSwitcherModal } from '../../renderer/components/TabSwitcherModal';
import { logger } from '../../renderer/utils/logger';
import type { AITab, FilePreviewTab, Theme } from '../../renderer/types';

const PROJECT_ROOT = '/workspace/project';

type NamedSession = {
	agentId: string;
	agentSessionId: string;
	projectPath: string;
	sessionName: string;
	starred?: boolean;
	lastActivityAt?: number;
};

function createTheme(): Theme {
	return {
		id: 'custom',
		name: 'Integration Theme',
		mode: 'dark',
		colors: {
			bgMain: '#111827',
			bgSidebar: '#1f2937',
			bgActivity: '#0f172a',
			border: '#374151',
			textMain: '#f9fafb',
			textDim: '#9ca3af',
			accent: '#2563eb',
			accentDim: '#1d4ed8',
			accentText: '#93c5fd',
			accentForeground: '#ffffff',
			success: '#16a34a',
			warning: '#f59e0b',
			error: '#dc2626',
		},
	};
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-alpha',
		agentSessionId: 'alpha111-2222-3333-4444-555555555555',
		name: 'Alpha Plan',
		starred: false,
		logs: [{ id: 'log-1', timestamp: Date.now() - 120_000, source: 'stdout', text: 'ready' }],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle',
		usageStats: {
			inputTokens: 20_000,
			outputTokens: 10_000,
			cacheReadInputTokens: 5000,
			cacheCreationInputTokens: 5000,
			totalCostUsd: 0.42,
			contextWindow: 100_000,
		},
		...overrides,
	};
}

function createFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-readme',
		path: `${PROJECT_ROOT}/README.md`,
		name: 'README',
		extension: '.md',
		content: '# README',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: '# Draft README',
		createdAt: 1700000000000,
		lastModified: 1700000000000,
		...overrides,
	};
}

function renderSwitcher(overrides: Partial<React.ComponentProps<typeof TabSwitcherModal>> = {}) {
	const props = {
		theme: createTheme(),
		tabs: [createTab()],
		fileTabs: [] as FilePreviewTab[],
		activeTabId: 'tab-alpha',
		activeFileTabId: null,
		projectRoot: PROJECT_ROOT,
		agentId: 'claude-code',
		shortcut: { id: 'tab-switcher', label: 'Tab Switcher', keys: ['Meta', 'Alt', 'T'] },
		onTabSelect: vi.fn(),
		onFileTabSelect: vi.fn(),
		onNamedSessionSelect: vi.fn(),
		onClose: vi.fn(),
		colorBlindMode: false,
		...overrides,
	} satisfies React.ComponentProps<typeof TabSwitcherModal>;

	render(
		<LayerStackProvider>
			<TabSwitcherModal {...props} />
		</LayerStackProvider>
	);

	return props;
}

function mockNamedSessions(sessions: NamedSession[]) {
	vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue(sessions);
}

describe('TabSwitcherModal integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Element.prototype.scrollIntoView = vi.fn();
		mockNamedSessions([]);
		vi.mocked(window.maestro.claude.updateSessionName).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agentSessions.setSessionName).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('syncs open Claude tab names and switches to a filtered file tab', async () => {
		const props = renderSwitcher({
			tabs: [
				createTab({ id: 'tab-scratch', agentSessionId: null, name: null, usageStats: undefined }),
				createTab({ id: 'tab-alpha', name: 'Alpha Plan' }),
			],
			fileTabs: [createFileTab()],
			activeTabId: 'tab-alpha',
			activeFileTabId: 'file-readme',
			colorBlindMode: true,
		});

		await waitFor(() => {
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				PROJECT_ROOT,
				'alpha111-2222-3333-4444-555555555555',
				'Alpha Plan'
			);
		});

		expect(screen.getByRole('dialog', { name: 'Tab Switcher' })).toBeInTheDocument();
		expect(screen.getByText('Open Tabs (3)')).toBeInTheDocument();
		expect(screen.getByText('Alpha Plan')).toBeInTheDocument();
		expect(screen.getByText('40.0K tokens')).toBeInTheDocument();
		expect(screen.getByText('$0.42')).toBeInTheDocument();
		expect(screen.getByText('README')).toBeInTheDocument();
		expect(screen.getByText('MD')).toBeInTheDocument();
		expect(screen.getByText('File')).toBeInTheDocument();
		expect(screen.getByText('●')).toBeInTheDocument();

		const search = screen.getByPlaceholderText('Search open tabs...');
		fireEvent.change(search, { target: { value: 'read' } });

		expect(screen.getByText('README')).toBeInTheDocument();
		expect(screen.queryByText('Alpha Plan')).not.toBeInTheDocument();

		fireEvent.keyDown(search, { key: 'Enter' });

		expect(props.onFileTabSelect).toHaveBeenCalledWith('file-readme');
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('loads same-project named sessions and selects a closed session', async () => {
		mockNamedSessions([
			{
				agentId: 'claude-code',
				agentSessionId: 'closed11-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'Closed Discovery',
				starred: true,
				lastActivityAt: Date.now() - 60_000,
			},
			{
				agentId: 'claude-code',
				agentSessionId: 'alpha111-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'Already Open',
			},
			{
				agentId: 'claude-code',
				agentSessionId: 'uuidonly-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'UUIDONLY',
			},
			{
				agentId: 'claude-code',
				agentSessionId: 'other111-2222-3333-4444-555555555555',
				projectPath: '/workspace/other',
				sessionName: 'Other Project',
			},
			{
				agentId: 'opencode',
				agentSessionId: 'wrong111-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'Wrong Agent',
			},
		]);
		const props = renderSwitcher();

		fireEvent.click(screen.getByRole('button', { name: /All Named/ }));

		expect(await screen.findByText('Closed Discovery')).toBeInTheDocument();
		expect(screen.getByText('Alpha Plan')).toBeInTheDocument();
		expect(screen.queryByText('Already Open')).not.toBeInTheDocument();
		expect(screen.queryByText('UUIDONLY')).not.toBeInTheDocument();
		expect(screen.queryByText('Other Project')).not.toBeInTheDocument();
		expect(screen.queryByText('Wrong Agent')).not.toBeInTheDocument();
		expect(screen.getByText('Closed')).toBeInTheDocument();
		expect(screen.getByText('2 sessions')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Closed Discovery').closest('button')!);

		expect(props.onNamedSessionSelect).toHaveBeenCalledWith(
			'closed11-2222-3333-4444-555555555555',
			PROJECT_ROOT,
			'Closed Discovery',
			true
		);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('uses provider session storage for non-Claude agents and cycles into starred mode', async () => {
		mockNamedSessions([
			{
				agentId: 'opencode',
				agentSessionId: 'closedoc-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'OpenCode Closed Star',
				starred: true,
			},
			{
				agentId: 'claude-code',
				agentSessionId: 'ignored1-2222-3333-4444-555555555555',
				projectPath: PROJECT_ROOT,
				sessionName: 'Claude Star',
				starred: true,
			},
		]);
		const props = renderSwitcher({
			agentId: 'opencode',
			tabs: [
				createTab({
					id: 'tab-opencode',
					agentSessionId: 'openoc11-2222-3333-4444-555555555555',
					name: 'OpenCode Star',
					starred: true,
				}),
			],
			activeTabId: 'tab-opencode',
		});

		await waitFor(() => {
			expect(window.maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
				'opencode',
				PROJECT_ROOT,
				'openoc11-2222-3333-4444-555555555555',
				'OpenCode Star'
			);
		});
		expect(window.maestro.claude.updateSessionName).not.toHaveBeenCalled();

		const search = screen.getByPlaceholderText('Search open tabs...');
		fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });

		const starredSearch = screen.getByPlaceholderText('Search starred sessions...');
		expect(await screen.findByText('OpenCode Closed Star')).toBeInTheDocument();
		expect(screen.getByText('OpenCode Star')).toBeInTheDocument();
		expect(screen.queryByText('Claude Star')).not.toBeInTheDocument();
		expect(screen.getByText('2 starred')).toBeInTheDocument();

		fireEvent.change(starredSearch, { target: { value: 'closed' } });
		fireEvent.keyDown(starredSearch, { key: 'Enter' });

		expect(props.onNamedSessionSelect).toHaveBeenCalledWith(
			'closedoc-2222-3333-4444-555555555555',
			PROJECT_ROOT,
			'OpenCode Closed Star',
			true
		);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('selects open and file tabs directly, scrolls the list, and cycles view modes', async () => {
		const props = renderSwitcher({
			tabs: [
				createTab({
					id: 'tab-uuid',
					agentSessionId: 'bravo11-2222-3333-4444-555555555555',
					name: null,
					logs: [],
					usageStats: {
						inputTokens: 100,
						outputTokens: 50,
						totalCostUsd: 0,
						contextWindow: 0,
					},
				}),
				createTab({
					id: 'tab-new',
					agentSessionId: null,
					name: null,
					logs: [],
					usageStats: undefined,
				}),
				createTab({
					id: 'tab-starred',
					agentSessionId: 'starred1-2222-3333-4444-555555555555',
					name: 'Starred Tab',
					starred: true,
				}),
				createTab({
					id: 'tab-second',
					agentSessionId: 'second1-2222-3333-4444-555555555555',
					name: 'Second Tab',
				}),
			],
			fileTabs: [createFileTab()],
			activeTabId: 'tab-new',
			activeFileTabId: null,
		});

		await screen.findByText('BRAVO11');
		expect(screen.getByText('New Session')).toBeInTheDocument();

		const scrollContainer = document.querySelector('.overflow-y-auto') as HTMLElement;
		scrollContainer.scrollTop = 104;
		fireEvent.scroll(scrollContainer);

		fireEvent.change(screen.getByPlaceholderText('Search open tabs...'), {
			target: { value: 'tab' },
		});
		expect(screen.getByText('Second Tab')).toBeInTheDocument();
		expect(screen.getByText('Starred Tab')).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText('Search open tabs...'), { target: { value: '' } });

		fireEvent.click(screen.getByText('BRAVO11').closest('button')!);
		expect(props.onTabSelect).toHaveBeenCalledWith('tab-uuid');

		fireEvent.click(screen.getByText('README').closest('button')!);
		expect(props.onFileTabSelect).toHaveBeenCalledWith('file-readme');

		fireEvent.click(screen.getByRole('button', { name: /All Named/ }));
		expect(screen.getByPlaceholderText('Search named sessions...')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^Starred \(/ }));
		expect(screen.getByPlaceholderText('Search starred sessions...')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Open Tabs/ }));
		expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();

		const search = screen.getByPlaceholderText('Search open tabs...');
		fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
		expect(screen.getByPlaceholderText('Search starred sessions...')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByPlaceholderText('Search starred sessions...'), {
			key: 'Tab',
			shiftKey: true,
		});
		expect(screen.getByPlaceholderText('Search named sessions...')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByPlaceholderText('Search named sessions...'), {
			key: 'Tab',
			shiftKey: true,
		});
		expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();

		const openSearch = screen.getByPlaceholderText('Search open tabs...');
		fireEvent.keyDown(openSearch, { key: 'Tab' });
		expect(screen.getByPlaceholderText('Search named sessions...')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByPlaceholderText('Search named sessions...'), { key: 'Tab' });
		expect(screen.getByPlaceholderText('Search starred sessions...')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByPlaceholderText('Search starred sessions...'), { key: 'Tab' });
		expect(screen.getByPlaceholderText('Search open tabs...')).toBeInTheDocument();
	});

	it('warns on provider name-sync failures', async () => {
		const syncError = new Error('provider sync failed');
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
		vi.mocked(window.maestro.agentSessions.setSessionName).mockRejectedValueOnce(syncError);

		renderSwitcher({
			agentId: 'opencode',
			tabs: [
				createTab({
					id: 'tab-opencode',
					agentSessionId: 'openoc11-2222-3333-4444-555555555555',
					name: 'OpenCode Named',
				}),
			],
			activeTabId: 'tab-opencode',
		});

		await waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				'[TabSwitcher] Failed to sync tab name:',
				undefined,
				syncError
			);
		});
		warnSpy.mockRestore();
	});

	it('warns on recoverable name-sync failures and closes through the layer stack', async () => {
		const syncError = new Error('sync failed');
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		vi.mocked(window.maestro.claude.updateSessionName).mockRejectedValueOnce(syncError);
		const props = renderSwitcher();

		await waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				'[TabSwitcher] Failed to sync tab name:',
				undefined,
				syncError
			);
		});

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});
});
