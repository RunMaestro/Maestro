/**
 * Tests for EncoreManager modal component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EncoreManager } from '../../../renderer/components/EncoreManager';
import type { Theme } from '../../../renderer/types';
import type { LoadedEncore } from '../../../shared/encore-types';

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

const mockEncores: LoadedEncore[] = [
	{
		manifest: {
			id: 'active-encore',
			name: 'Active Encore',
			version: '1.0.0',
			description: 'An active encore',
			author: 'Test Author',
			main: 'index.js',
			permissions: ['stats:read', 'process:write'],
		},
		state: 'active',
		path: '/encores/active-encore',
	},
	{
		manifest: {
			id: 'disabled-encore',
			name: 'Disabled Encore',
			version: '0.5.0',
			description: 'A disabled encore',
			author: 'Other Author',
			main: 'index.js',
			permissions: ['settings:read'],
		},
		state: 'disabled',
		path: '/encores/disabled-encore',
	},
	{
		manifest: {
			id: 'error-encore',
			name: 'Error Encore',
			version: '0.1.0',
			description: 'A broken encore',
			author: 'Bug Author',
			main: 'index.js',
			permissions: ['middleware'],
		},
		state: 'error',
		path: '/encores/error-encore',
		error: 'Failed to load: missing dependency',
	},
];

describe('EncoreManager', () => {
	const defaultProps = {
		theme: mockTheme,
		encores: mockEncores,
		loading: false,
		onClose: vi.fn(),
		onEnableEncore: vi.fn().mockResolvedValue(undefined),
		onDisableEncore: vi.fn().mockResolvedValue(undefined),
		onRefresh: vi.fn().mockResolvedValue(undefined),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders encore list with names and versions', () => {
		render(<EncoreManager {...defaultProps} />);

		expect(screen.getByText('Active Encore')).toBeInTheDocument();
		expect(screen.getByText('v1.0.0')).toBeInTheDocument();
		expect(screen.getByText('Disabled Encore')).toBeInTheDocument();
		expect(screen.getByText('Error Encore')).toBeInTheDocument();
	});

	it('shows encore count', () => {
		render(<EncoreManager {...defaultProps} />);

		expect(screen.getByText('3 encores discovered')).toBeInTheDocument();
	});

	it('shows loading state', () => {
		render(<EncoreManager {...defaultProps} loading={true} />);

		expect(screen.getByText('Loading encores...')).toBeInTheDocument();
	});

	it('shows empty state when no encores', () => {
		render(<EncoreManager {...defaultProps} encores={[]} />);

		expect(screen.getByText('No encores installed')).toBeInTheDocument();
	});

	it('shows error message for error-state encores', () => {
		render(<EncoreManager {...defaultProps} />);

		expect(screen.getByText('Failed to load: missing dependency')).toBeInTheDocument();
	});

	it('shows permission badges', () => {
		render(<EncoreManager {...defaultProps} />);

		expect(screen.getByText('stats:read')).toBeInTheDocument();
		expect(screen.getByText('process:write')).toBeInTheDocument();
		expect(screen.getByText('settings:read')).toBeInTheDocument();
		expect(screen.getByText('middleware')).toBeInTheDocument();
	});

	it('shows author names', () => {
		render(<EncoreManager {...defaultProps} />);

		expect(screen.getByText('by Test Author')).toBeInTheDocument();
		expect(screen.getByText('by Other Author')).toBeInTheDocument();
	});

	it('calls onDisableEncore when toggling active encore', async () => {
		render(<EncoreManager {...defaultProps} />);

		const toggleButtons = screen.getAllByTitle('Disable encore');
		fireEvent.click(toggleButtons[0]);

		await waitFor(() => {
			expect(defaultProps.onDisableEncore).toHaveBeenCalledWith('active-encore');
		});
	});

	it('calls onEnableEncore when toggling disabled encore', async () => {
		render(<EncoreManager {...defaultProps} />);

		const toggleButtons = screen.getAllByTitle('Enable encore');
		fireEvent.click(toggleButtons[0]);

		await waitFor(() => {
			expect(defaultProps.onEnableEncore).toHaveBeenCalledWith('disabled-encore');
		});
	});

	it('calls onRefresh when Refresh button is clicked', async () => {
		render(<EncoreManager {...defaultProps} />);

		const refreshButton = screen.getByText('Refresh');
		fireEvent.click(refreshButton);

		await waitFor(() => {
			expect(defaultProps.onRefresh).toHaveBeenCalledOnce();
		});
	});

	it('calls shell.showItemInFolder when Open Folder is clicked', async () => {
		render(<EncoreManager {...defaultProps} />);

		const openFolderButton = screen.getByText('Open Folder');
		fireEvent.click(openFolderButton);

		await waitFor(() => {
			expect(window.maestro.encores.getDir).toHaveBeenCalled();
			expect(window.maestro.shell.showItemInFolder).toHaveBeenCalledWith('/tmp/encores');
		});
	});

	it('singular encore text when only one encore', () => {
		render(<EncoreManager {...defaultProps} encores={[mockEncores[0]]} />);

		expect(screen.getByText('1 encore discovered')).toBeInTheDocument();
	});
});
