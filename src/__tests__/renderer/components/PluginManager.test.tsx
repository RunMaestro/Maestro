/**
 * Tests for PluginManager modal component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PluginManager } from '../../../renderer/components/PluginManager';
import type { Theme } from '../../../renderer/types';
import type { LoadedPlugin } from '../../../shared/plugin-types';

// Mock the Modal component to simplify testing
vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		children,
		title,
		onClose,
	}: {
		children: React.ReactNode;
		title: string;
		onClose: () => void;
	}) => (
		<div data-testid="modal" data-title={title}>
			<button data-testid="modal-close" onClick={onClose}>
				Close
			</button>
			{children}
		</div>
	),
}));

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#333',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const mockPlugins: LoadedPlugin[] = [
	{
		manifest: {
			id: 'active-plugin',
			name: 'Active Plugin',
			version: '1.0.0',
			description: 'An active plugin',
			author: 'Test Author',
			main: 'index.js',
			permissions: ['stats:read', 'process:write'],
		},
		state: 'active',
		path: '/plugins/active-plugin',
	},
	{
		manifest: {
			id: 'disabled-plugin',
			name: 'Disabled Plugin',
			version: '0.5.0',
			description: 'A disabled plugin',
			author: 'Other Author',
			main: 'index.js',
			permissions: ['settings:read'],
		},
		state: 'disabled',
		path: '/plugins/disabled-plugin',
	},
	{
		manifest: {
			id: 'error-plugin',
			name: 'Error Plugin',
			version: '0.1.0',
			description: 'A broken plugin',
			author: 'Bug Author',
			main: 'index.js',
			permissions: ['middleware'],
		},
		state: 'error',
		path: '/plugins/error-plugin',
		error: 'Failed to load: missing dependency',
	},
];

describe('PluginManager', () => {
	const defaultProps = {
		theme: mockTheme,
		plugins: mockPlugins,
		loading: false,
		onClose: vi.fn(),
		onEnablePlugin: vi.fn().mockResolvedValue(undefined),
		onDisablePlugin: vi.fn().mockResolvedValue(undefined),
		onRefresh: vi.fn().mockResolvedValue(undefined),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders plugin list with names and versions', () => {
		render(<PluginManager {...defaultProps} />);

		expect(screen.getByText('Active Plugin')).toBeInTheDocument();
		expect(screen.getByText('v1.0.0')).toBeInTheDocument();
		expect(screen.getByText('Disabled Plugin')).toBeInTheDocument();
		expect(screen.getByText('Error Plugin')).toBeInTheDocument();
	});

	it('shows plugin count', () => {
		render(<PluginManager {...defaultProps} />);

		expect(screen.getByText('3 plugins discovered')).toBeInTheDocument();
	});

	it('shows loading state', () => {
		render(<PluginManager {...defaultProps} loading={true} />);

		expect(screen.getByText('Loading plugins...')).toBeInTheDocument();
	});

	it('shows empty state when no plugins', () => {
		render(<PluginManager {...defaultProps} plugins={[]} />);

		expect(screen.getByText('No plugins installed')).toBeInTheDocument();
	});

	it('shows error message for error-state plugins', () => {
		render(<PluginManager {...defaultProps} />);

		expect(screen.getByText('Failed to load: missing dependency')).toBeInTheDocument();
	});

	it('shows permission badges', () => {
		render(<PluginManager {...defaultProps} />);

		expect(screen.getByText('stats:read')).toBeInTheDocument();
		expect(screen.getByText('process:write')).toBeInTheDocument();
		expect(screen.getByText('settings:read')).toBeInTheDocument();
		expect(screen.getByText('middleware')).toBeInTheDocument();
	});

	it('shows author names', () => {
		render(<PluginManager {...defaultProps} />);

		expect(screen.getByText('by Test Author')).toBeInTheDocument();
		expect(screen.getByText('by Other Author')).toBeInTheDocument();
	});

	it('calls onDisablePlugin when toggling active plugin', async () => {
		render(<PluginManager {...defaultProps} />);

		const toggleButtons = screen.getAllByTitle('Disable plugin');
		fireEvent.click(toggleButtons[0]);

		await waitFor(() => {
			expect(defaultProps.onDisablePlugin).toHaveBeenCalledWith('active-plugin');
		});
	});

	it('calls onEnablePlugin when toggling disabled plugin', async () => {
		render(<PluginManager {...defaultProps} />);

		const toggleButtons = screen.getAllByTitle('Enable plugin');
		fireEvent.click(toggleButtons[0]);

		await waitFor(() => {
			expect(defaultProps.onEnablePlugin).toHaveBeenCalledWith('disabled-plugin');
		});
	});

	it('calls onRefresh when Refresh button is clicked', async () => {
		render(<PluginManager {...defaultProps} />);

		const refreshButton = screen.getByText('Refresh');
		fireEvent.click(refreshButton);

		await waitFor(() => {
			expect(defaultProps.onRefresh).toHaveBeenCalledOnce();
		});
	});

	it('calls shell.showItemInFolder when Open Folder is clicked', async () => {
		render(<PluginManager {...defaultProps} />);

		const openFolderButton = screen.getByText('Open Folder');
		fireEvent.click(openFolderButton);

		await waitFor(() => {
			expect(window.maestro.plugins.getDir).toHaveBeenCalled();
			expect(window.maestro.shell.showItemInFolder).toHaveBeenCalledWith('/tmp/plugins');
		});
	});

	it('singular plugin text when only one plugin', () => {
		render(<PluginManager {...defaultProps} plugins={[mockPlugins[0]]} />);

		expect(screen.getByText('1 plugin discovered')).toBeInTheDocument();
	});
});
