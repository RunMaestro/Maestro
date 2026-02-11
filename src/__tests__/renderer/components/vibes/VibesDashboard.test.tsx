/**
 * Tests for VibesDashboard component
 *
 * Validates error handling, loading states, and status banners:
 * - "Initializing..." state during first data load
 * - "vibescheck binary not found" warning with installation guidance
 * - VIBES disabled state
 * - Not-initialized state with project name input
 * - Error banner display
 * - Stats cards with loading indicators
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VibesDashboard } from '../../../../renderer/components/vibes/VibesDashboard';
import type { Theme } from '../../../../shared/theme-types';
import type { UseVibesDataReturn } from '../../../../renderer/hooks/useVibesData';
import type { VibesAssuranceLevel } from '../../../../shared/vibes-types';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('lucide-react', () => ({
	FileText: () => <svg data-testid="file-text-icon" />,
	FolderOpen: () => <svg data-testid="folder-open-icon" />,
	Activity: () => <svg data-testid="activity-icon" />,
	Cpu: () => <svg data-testid="cpu-icon" />,
	Database: () => <svg data-testid="database-icon" />,
	FileBarChart: () => <svg data-testid="file-bar-chart-icon" />,
	RefreshCw: () => <svg data-testid="refresh-icon" />,
	AlertCircle: () => <svg data-testid="alert-circle-icon" />,
	CheckCircle2: () => <svg data-testid="check-circle-icon" />,
	Shield: () => <svg data-testid="shield-icon" />,
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
}));

vi.mock('../../../../renderer/components/vibes/VibesLiveMonitor', () => ({
	VibesLiveMonitor: () => <div data-testid="vibes-live-monitor">LiveMonitor</div>,
}));

// ============================================================================
// Test Theme & Helpers
// ============================================================================

const testTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f940',
		accentText: '#bd93f9',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

function createMockVibesData(
	overrides: Partial<UseVibesDataReturn> = {},
): UseVibesDataReturn {
	return {
		isInitialized: true,
		stats: {
			totalAnnotations: 42,
			filesCovered: 10,
			totalTrackedFiles: 20,
			coveragePercent: 50,
			activeSessions: 2,
			contributingModels: 3,
			assuranceLevel: 'medium',
		},
		annotations: [],
		sessions: [],
		models: [],
		isLoading: false,
		error: null,
		refresh: vi.fn(),
		initialize: vi.fn(),
		...overrides,
	};
}

// Mock window.maestro.vibes
const mockFindBinary = vi.fn();
const mockBuild = vi.fn();
const mockGetReport = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	mockFindBinary.mockResolvedValue('/usr/local/bin/vibescheck');

	(window as any).maestro = {
		vibes: {
			findBinary: mockFindBinary,
			build: mockBuild,
			getReport: mockGetReport,
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('VibesDashboard', () => {
	it('shows disabled state when VIBES is not enabled', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={false}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES is disabled')).toBeTruthy();
		expect(screen.getByText(/Enable VIBES in Settings/)).toBeTruthy();
	});

	it('shows initializing state during first data load', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					isLoading: true,
					isInitialized: false,
					stats: null,
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Initializing...')).toBeTruthy();
		expect(screen.getByText('Loading VIBES data for this project.')).toBeTruthy();
		expect(screen.getByTestId('loader-icon')).toBeTruthy();
	});

	it('shows not-initialized state with initialization controls', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					isInitialized: false,
					stats: null,
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES not initialized')).toBeTruthy();
		expect(screen.getByPlaceholderText('Project name')).toBeTruthy();
		expect(screen.getByText('Initialize')).toBeTruthy();
	});

	it('shows vibescheck binary not found warning when binary is missing', async () => {
		mockFindBinary.mockResolvedValue(null);

		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('vibescheck binary not found')).toBeTruthy();
		});

		expect(screen.getByText(/cargo install vibescheck/)).toBeTruthy();
	});

	it('does not show binary warning when binary is found', async () => {
		mockFindBinary.mockResolvedValue('/usr/local/bin/vibescheck');

		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		await waitFor(() => {
			// Binary found, so no warning should appear
			expect(screen.queryByText('vibescheck binary not found')).toBeNull();
		});
	});

	it('shows error banner when vibesData has an error', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ error: 'Connection failed' })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Connection failed')).toBeTruthy();
	});

	it('shows stats cards with loading dashes when loading', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ isLoading: true })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Stats cards show "—" when loading
		const dashes = screen.getAllByText('—');
		expect(dashes.length).toBeGreaterThanOrEqual(4);
	});

	it('shows active status banner with assurance level', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES is active')).toBeTruthy();
		expect(screen.getByText('Medium')).toBeTruthy();
	});

	it('shows quick action buttons', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Build Database')).toBeTruthy();
		expect(screen.getByText('Generate Report')).toBeTruthy();
		expect(screen.getByText('Refresh')).toBeTruthy();
	});

	it('renders live monitor when initialized', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('vibes-live-monitor')).toBeTruthy();
	});
});
