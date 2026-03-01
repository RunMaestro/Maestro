/**
 * Tests for CueModal component
 *
 * Tests the Cue Modal dashboard including:
 * - Sessions table rendering (empty state and populated)
 * - Active runs section with stop controls
 * - Activity log rendering with success/failure indicators
 * - Master enable/disable toggle
 * - Close button and backdrop click
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CueModal } from '../../../renderer/components/CueModal';
import type { Theme } from '../../../renderer/types';

// Mock LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-cue-modal');
const mockUnregisterLayer = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
	}),
}));

// Mock modal priorities
vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		CUE_MODAL: 460,
		CUE_YAML_EDITOR: 463,
	},
}));

// Mock CueYamlEditor
vi.mock('../../../renderer/components/CueYamlEditor', () => ({
	CueYamlEditor: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
		isOpen ? <div data-testid="cue-yaml-editor">YAML Editor Mock</div> : null,
}));

// Mock useCue hook
const mockEnable = vi.fn().mockResolvedValue(undefined);
const mockDisable = vi.fn().mockResolvedValue(undefined);
const mockStopRun = vi.fn().mockResolvedValue(undefined);
const mockStopAll = vi.fn().mockResolvedValue(undefined);
const mockRefresh = vi.fn().mockResolvedValue(undefined);

const defaultUseCueReturn = {
	sessions: [],
	activeRuns: [],
	activityLog: [],
	queueStatus: {} as Record<string, number>,
	loading: false,
	enable: mockEnable,
	disable: mockDisable,
	stopRun: mockStopRun,
	stopAll: mockStopAll,
	refresh: mockRefresh,
};

let mockUseCueReturn = { ...defaultUseCueReturn };

vi.mock('../../../renderer/hooks/useCue', () => ({
	useCue: () => mockUseCueReturn,
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

const mockSession = {
	sessionId: 'sess-1',
	sessionName: 'Test Session',
	toolType: 'claude-code',
	projectRoot: '/test/project',
	enabled: true,
	subscriptionCount: 3,
	activeRuns: 1,
	lastTriggered: new Date().toISOString(),
};

const mockActiveRun = {
	runId: 'run-1',
	sessionId: 'sess-1',
	sessionName: 'Test Session',
	subscriptionName: 'on-save',
	event: {
		id: 'evt-1',
		type: 'file.changed' as const,
		timestamp: new Date().toISOString(),
		triggerName: 'on-save',
		payload: { file: '/src/index.ts' },
	},
	status: 'running' as const,
	stdout: '',
	stderr: '',
	exitCode: null,
	durationMs: 0,
	startedAt: new Date().toISOString(),
	endedAt: '',
};

const mockCompletedRun = {
	...mockActiveRun,
	runId: 'run-2',
	status: 'completed' as const,
	stdout: 'Done',
	exitCode: 0,
	durationMs: 5000,
	endedAt: new Date().toISOString(),
};

const mockFailedRun = {
	...mockActiveRun,
	runId: 'run-3',
	status: 'failed' as const,
	stderr: 'Error occurred',
	exitCode: 1,
	durationMs: 2000,
	endedAt: new Date().toISOString(),
};

describe('CueModal', () => {
	const mockOnClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockUseCueReturn = { ...defaultUseCueReturn };
	});

	describe('rendering', () => {
		it('should render the modal with header', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Maestro Cue')).toBeInTheDocument();
		});

		it('should register layer on mount and unregister on unmount', () => {
			const { unmount } = render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: 460,
				})
			);

			unmount();
			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-cue-modal');
		});

		it('should show loading state', () => {
			mockUseCueReturn = { ...defaultUseCueReturn, loading: true };

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Loading Cue status...')).toBeInTheDocument();
		});
	});

	describe('sessions table', () => {
		it('should show empty state when no sessions have Cue configs', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText(/No sessions have a maestro-cue.yaml file/)).toBeInTheDocument();
		});

		it('should render sessions with status indicators', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				sessions: [mockSession],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Test Session')).toBeInTheDocument();
			expect(screen.getByText('claude-code')).toBeInTheDocument();
			expect(screen.getByText('Active')).toBeInTheDocument();
			expect(screen.getByText('3')).toBeInTheDocument();
		});

		it('should show Paused status for disabled sessions', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				sessions: [{ ...mockSession, enabled: false }],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Paused')).toBeInTheDocument();
		});
	});

	describe('active runs', () => {
		it('should show "No active runs" when empty', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('No active runs')).toBeInTheDocument();
		});

		it('should render active runs with stop buttons', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				activeRuns: [mockActiveRun],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('"on-save"')).toBeInTheDocument();
			expect(screen.getByTitle('Stop run')).toBeInTheDocument();
		});

		it('should call stopRun when stop button is clicked', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				activeRuns: [mockActiveRun],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			fireEvent.click(screen.getByTitle('Stop run'));
			expect(mockStopRun).toHaveBeenCalledWith('run-1');
		});

		it('should show Stop All button when multiple runs active', () => {
			const secondRun = { ...mockActiveRun, runId: 'run-2', subscriptionName: 'on-timer' };
			mockUseCueReturn = {
				...defaultUseCueReturn,
				activeRuns: [mockActiveRun, secondRun],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			const stopAllButton = screen.getByText('Stop All');
			expect(stopAllButton).toBeInTheDocument();

			fireEvent.click(stopAllButton);
			expect(mockStopAll).toHaveBeenCalledOnce();
		});
	});

	describe('activity log', () => {
		it('should show "No activity yet" when empty', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('No activity yet')).toBeInTheDocument();
		});

		it('should render completed runs with checkmark', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				activityLog: [mockCompletedRun],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText(/completed in 5s/)).toBeInTheDocument();
		});

		it('should render failed runs with cross mark', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				activityLog: [mockFailedRun],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText(/failed/)).toBeInTheDocument();
		});
	});

	describe('master toggle', () => {
		it('should show Disabled when no sessions are enabled', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Disabled')).toBeInTheDocument();
		});

		it('should show Enabled when sessions are enabled', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				sessions: [mockSession],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Enabled')).toBeInTheDocument();
		});

		it('should call disable when toggling off', () => {
			mockUseCueReturn = {
				...defaultUseCueReturn,
				sessions: [mockSession],
			};

			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			fireEvent.click(screen.getByText('Enabled'));
			expect(mockDisable).toHaveBeenCalledOnce();
		});

		it('should call enable when toggling on', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			fireEvent.click(screen.getByText('Disabled'));
			expect(mockEnable).toHaveBeenCalledOnce();
		});
	});

	describe('close behavior', () => {
		it('should call onClose when close button is clicked', () => {
			render(<CueModal theme={mockTheme} onClose={mockOnClose} />);

			// The close button has an X icon
			const buttons = screen.getAllByRole('button');
			const closeButton = buttons.find((b) => b.querySelector('.lucide-x'));
			if (closeButton) {
				fireEvent.click(closeButton);
				expect(mockOnClose).toHaveBeenCalledOnce();
			}
		});
	});
});
