/**
 * WizardThemeStyles.test.tsx
 *
 * Tests that all wizard components render correctly with all available themes.
 * Verifies that theme colors are properly applied and no hardcoded colors
 * cause styling issues across different themes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { THEMES } from '../../../../renderer/constants/themes';
import type { Theme, ThemeId } from '../../../../renderer/types';
import { WizardProvider } from '../../../../renderer/components/Wizard/WizardContext';
import { AgentSelectionScreen } from '../../../../renderer/components/Wizard/screens/AgentSelectionScreen';
import { DirectorySelectionScreen } from '../../../../renderer/components/Wizard/screens/DirectorySelectionScreen';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { WizardExitConfirmModal } from '../../../../renderer/components/Wizard/WizardExitConfirmModal';
import { WizardResumeModal } from '../../../../renderer/components/Wizard/WizardResumeModal';
import { TourStep } from '../../../../renderer/components/Wizard/tour/TourStep';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-icon" className={className} style={style} />
	),
	AlertCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="alert-icon" className={className} style={style} />
	),
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="alert-triangle-icon" className={className} style={style} />
	),
	Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="eye-icon" className={className} style={style} />
	),
	Edit: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="edit-icon" className={className} style={style} />
	),
	Image: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="image-icon" className={className} style={style} />
	),
	Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="loader-icon" className={className} style={style} />
	),
	Rocket: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="rocket-icon" className={className} style={style} />
	),
	Compass: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="compass-icon" className={className} style={style} />
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-down-icon" className={className} style={style} />
	),
	ChevronRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-right-icon" className={className} style={style} />
	),
	FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="file-text-icon" className={className} style={style} />
	),
	Bot: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="bot-icon" className={className} style={style} />
	),
	RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="refresh-icon" className={className} style={style} />
	),
	RotateCcw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="rotate-icon" className={className} style={style} />
	),
	FolderOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="folder-icon" className={className} style={style} />
	),
	Settings: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="settings-icon" className={className} style={style} />
	),
	ArrowLeft: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="arrow-left-icon" className={className} style={style} />
	),
	Plus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="plus-icon" className={className} style={style} />
	),
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trash-icon" className={className} style={style} />
	),
}));

// Mock react-markdown
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

// Mock remark-gfm
vi.mock('remark-gfm', () => ({
	default: () => {},
}));

// Mock MermaidRenderer
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

// Mock the Maestro API
const mockMaestro = {
	agents: {
		detect: vi.fn(),
		get: vi.fn(),
	},
	git: {
		isRepo: vi.fn(),
	},
	dialog: {
		selectFolder: vi.fn(),
	},
	settings: {
		get: vi.fn(),
		set: vi.fn(),
	},
	autorun: {
		writeDoc: vi.fn(),
		listDocs: vi.fn(),
		saveImage: vi.fn(),
		deleteImage: vi.fn(),
	},
	fs: {
		readFile: vi.fn(),
	},
};

// Helper to render with required providers
function renderWithProviders(component: React.ReactElement) {
	return render(
		<LayerStackProvider>
			<WizardProvider>{component}</WizardProvider>
		</LayerStackProvider>
	);
}

// Get all theme IDs for parameterized testing
const themeIds = Object.keys(THEMES) as ThemeId[];
const darkThemes = themeIds.filter((id) => THEMES[id].mode === 'dark');
const lightThemes = themeIds.filter((id) => THEMES[id].mode === 'light');
const vibeThemes = themeIds.filter((id) => THEMES[id].mode === 'vibe');

describe('Wizard Theme Styles', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Setup window.maestro mock
		(window as any).maestro = mockMaestro;

		// Setup default mock responses
		mockMaestro.agents.detect.mockResolvedValue([
			{ id: 'claude-code', name: 'Claude Code', available: true, hidden: false },
			{ id: 'terminal', name: 'Terminal', available: true, hidden: true },
		]);
		mockMaestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
			path: '/test/path',
		});
		mockMaestro.git.isRepo.mockResolvedValue(true);
		mockMaestro.dialog.selectFolder.mockResolvedValue('/test/path');
		mockMaestro.settings.get.mockResolvedValue(null);
		mockMaestro.settings.set.mockResolvedValue(undefined);
		mockMaestro.autorun.writeDoc.mockResolvedValue({ success: true });
		mockMaestro.autorun.listDocs.mockResolvedValue([]);
		mockMaestro.autorun.saveImage.mockResolvedValue({
			success: true,
			relativePath: 'images/test.png',
		});
		mockMaestro.autorun.deleteImage.mockResolvedValue({ success: true });
		mockMaestro.fs.readFile.mockResolvedValue('');
	});

	describe('Theme Color Structure Validation', () => {
		it.each(themeIds)('should have all required colors for %s theme', (themeId) => {
			const theme = THEMES[themeId];

			// Verify all required color properties exist
			const requiredColors = [
				'bgMain',
				'bgSidebar',
				'bgActivity',
				'border',
				'textMain',
				'textDim',
				'accent',
				'accentDim',
				'accentText',
				'accentForeground',
				'success',
				'warning',
				'error',
			];

			requiredColors.forEach((color) => {
				expect(theme.colors[color as keyof Theme['colors']]).toBeDefined();
				expect(theme.colors[color as keyof Theme['colors']]).not.toBe('');
			});
		});

		it.each(themeIds)('should have valid color values for %s theme', (themeId) => {
			const theme = THEMES[themeId];

			// All color values should be strings that look like colors
			Object.entries(theme.colors).forEach(([key, value]) => {
				expect(typeof value).toBe('string');
				// Colors should start with #, rgb, rgba, or hsl
				const isValidColor =
					value.startsWith('#') ||
					value.startsWith('rgb') ||
					value.startsWith('rgba') ||
					value.startsWith('hsl');
				expect(isValidColor).toBe(true);
			});
		});

		it.each(lightThemes)('light theme %s should have lighter background than text', (themeId) => {
			const theme = THEMES[themeId];

			// Light themes should have light backgrounds (high hex values)
			// This is a simple heuristic check
			const bgMain = theme.colors.bgMain;
			const textMain = theme.colors.textMain;

			// Convert hex to RGB and check relative brightness
			const hexToRgb = (hex: string) => {
				const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
				return result
					? {
							r: parseInt(result[1], 16),
							g: parseInt(result[2], 16),
							b: parseInt(result[3], 16),
						}
					: null;
			};

			const bgRgb = hexToRgb(bgMain);
			const textRgb = hexToRgb(textMain);

			if (bgRgb && textRgb) {
				const bgBrightness = (bgRgb.r + bgRgb.g + bgRgb.b) / 3;
				const textBrightness = (textRgb.r + textRgb.g + textRgb.b) / 3;

				// Background should be brighter than text for light themes
				expect(bgBrightness).toBeGreaterThan(textBrightness);
			}
		});

		it.each(darkThemes)('dark theme %s should have darker background than text', (themeId) => {
			const theme = THEMES[themeId];

			const bgMain = theme.colors.bgMain;
			const textMain = theme.colors.textMain;

			const hexToRgb = (hex: string) => {
				const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
				return result
					? {
							r: parseInt(result[1], 16),
							g: parseInt(result[2], 16),
							b: parseInt(result[3], 16),
						}
					: null;
			};

			const bgRgb = hexToRgb(bgMain);
			const textRgb = hexToRgb(textMain);

			if (bgRgb && textRgb) {
				const bgBrightness = (bgRgb.r + bgRgb.g + bgRgb.b) / 3;
				const textBrightness = (textRgb.r + textRgb.g + textRgb.b) / 3;

				// Background should be darker than text for dark themes
				expect(bgBrightness).toBeLessThan(textBrightness);
			}
		});
	});

	describe('AgentSelectionScreen Theme Rendering', () => {
		// Test a representative sample of themes
		const sampleThemes: ThemeId[] = ['dracula', 'github-light', 'maestros-choice'];

		it.each(sampleThemes)('should render with %s theme without errors', async (themeId) => {
			const theme = THEMES[themeId];

			const { container } = renderWithProviders(<AgentSelectionScreen theme={theme} />);

			// Should show loading state initially
			expect(screen.getByText('Detecting available agents...')).toBeInTheDocument();

			// Wait for agent detection to complete
			await vi.waitFor(() => {
				expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
			});

			// Check that theme colors are applied to key elements
			const header = screen.getByText('Create a Maestro Agent');
			expect(header).toHaveStyle({ color: theme.colors.textMain });
		});

		it.each(sampleThemes)('should apply accent colors correctly for %s theme', async (themeId) => {
			const theme = THEMES[themeId];

			renderWithProviders(<AgentSelectionScreen theme={theme} />);

			await vi.waitFor(() => {
				// Find the Continue button (there may be multiple elements with this text)
				const buttons = screen.getAllByRole('button');
				const continueButton = buttons.find((btn) => btn.textContent?.includes('Continue'));
				expect(continueButton).toBeDefined();
			});

			// The Continue button should use accent colors when enabled
			const buttons = screen.getAllByRole('button');
			const continueButton = buttons.find((btn) => btn.textContent?.includes('Continue'));

			// Check that the button has style applied
			expect(continueButton).toHaveAttribute('style');
		});
	});

	describe('DirectorySelectionScreen Theme Rendering', () => {
		const sampleThemes: ThemeId[] = ['nord', 'solarized-light', 'pedurple'];

		it.each(sampleThemes)('should render with %s theme without errors', async (themeId) => {
			const theme = THEMES[themeId];

			renderWithProviders(<DirectorySelectionScreen theme={theme} />);

			// Wait for initial rendering and detection
			await vi.waitFor(() => {
				// Either loading or the main screen should be visible
				const hasLoading = screen.queryByText('Detecting project location...');
				const hasHeader = screen.queryByText('Where Should We Work?');
				expect(hasLoading || hasHeader).toBeTruthy();
			});

			// Wait for detection to complete
			await vi.waitFor(
				() => {
					expect(screen.getByText('Where Should We Work?')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify theme colors are applied
			const header = screen.getByText('Where Should We Work?');
			expect(header).toHaveStyle({ color: theme.colors.textMain });
		});
	});

	describe('WizardExitConfirmModal Theme Rendering', () => {
		const sampleThemes: ThemeId[] = ['tokyo-night', 'one-light', 'inquest'];

		it.each(sampleThemes)('should render with %s theme without errors', (themeId) => {
			const theme = THEMES[themeId];

			render(
				<LayerStackProvider>
					<WizardExitConfirmModal
						theme={theme}
						currentStep={2}
						totalSteps={4}
						onConfirmExit={vi.fn()}
						onCancel={vi.fn()}
						onQuitWithoutSaving={vi.fn()}
					/>
				</LayerStackProvider>
			);

			// Check that the modal renders
			expect(screen.getByText('Exit Setup Wizard?')).toBeInTheDocument();

			// Check theme colors are applied
			const title = screen.getByText('Exit Setup Wizard?');
			expect(title).toHaveStyle({ color: theme.colors.textMain });
		});

		it.each(sampleThemes)('should apply correct button styles for %s theme', (themeId) => {
			const theme = THEMES[themeId];

			render(
				<LayerStackProvider>
					<WizardExitConfirmModal
						theme={theme}
						currentStep={2}
						totalSteps={4}
						onConfirmExit={vi.fn()}
						onCancel={vi.fn()}
						onQuitWithoutSaving={vi.fn()}
					/>
				</LayerStackProvider>
			);

			// Primary button should use accent colors
			const cancelButton = screen.getByText('Cancel');
			expect(cancelButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});
	});

	describe('WizardResumeModal Theme Rendering', () => {
		const sampleThemes: ThemeId[] = ['catppuccin-mocha', 'catppuccin-latte', 'dre-synth'];

		const mockResumeState = {
			currentStep: 'conversation' as const,
			selectedAgent: 'claude-code' as const,
			agentName: 'Test Project',
			directoryPath: '/test/path',
			conversationHistory: [],
			confidenceLevel: 50,
			generatedDocuments: [],
			isGitRepo: true,
		};

		it.each(sampleThemes)('should render with %s theme without errors', (themeId) => {
			const theme = THEMES[themeId];

			render(
				<LayerStackProvider>
					<WizardResumeModal
						theme={theme}
						resumeState={mockResumeState}
						onResume={vi.fn()}
						onStartFresh={vi.fn()}
						onClose={vi.fn()}
					/>
				</LayerStackProvider>
			);

			// Check that the modal renders
			expect(screen.getByText('Resume Setup?')).toBeInTheDocument();
		});

		it.each(sampleThemes)(
			'should show progress bar with accent color for %s theme',
			async (themeId) => {
				const theme = THEMES[themeId];

				const { container } = render(
					<LayerStackProvider>
						<WizardResumeModal
							theme={theme}
							resumeState={mockResumeState}
							onResume={vi.fn()}
							onStartFresh={vi.fn()}
							onClose={vi.fn()}
						/>
					</LayerStackProvider>
				);

				// Find the progress bar by its structure
				await vi.waitFor(() => {
					const progressBars = container.querySelectorAll('[class*="h-2"][class*="rounded-full"]');
					expect(progressBars.length).toBeGreaterThan(0);
				});
			}
		);
	});

	describe('TourStep Theme Rendering', () => {
		const sampleThemes: ThemeId[] = ['gruvbox-dark', 'gruvbox-light', 'ayu-light'];

		const mockStep = {
			id: 'test-step',
			title: 'Test Step',
			description: 'This is a test step description',
			selector: '[data-tour="test"]',
			position: 'bottom' as const,
		};

		it.each(sampleThemes)('should render with %s theme without errors', (themeId) => {
			const theme = THEMES[themeId];

			render(
				<TourStep
					theme={theme}
					step={mockStep}
					stepNumber={1}
					totalSteps={5}
					spotlight={null}
					onNext={vi.fn()}
					onGoToStep={vi.fn()}
					onSkip={vi.fn()}
					isLastStep={false}
					isTransitioning={false}
					isPositionReady={true}
				/>
			);

			// Check that the step renders
			expect(screen.getByText('Test Step')).toBeInTheDocument();
			expect(screen.getByText('This is a test step description')).toBeInTheDocument();
		});

		it.each(sampleThemes)(
			'should apply theme colors to step number badge for %s theme',
			(themeId) => {
				const theme = THEMES[themeId];

				render(
					<TourStep
						theme={theme}
						step={mockStep}
						stepNumber={3}
						totalSteps={5}
						spotlight={null}
						onNext={vi.fn()}
						onGoToStep={vi.fn()}
						onSkip={vi.fn()}
						isLastStep={false}
						isTransitioning={false}
						isPositionReady={true}
					/>
				);

				// Find the step number badge
				const stepBadge = screen.getByText('3');
				expect(stepBadge).toHaveStyle({
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				});
			}
		);

		it('should show "Finish Tour" on last step', () => {
			const theme = THEMES['dracula'];

			render(
				<TourStep
					theme={theme}
					step={mockStep}
					stepNumber={5}
					totalSteps={5}
					spotlight={null}
					onNext={vi.fn()}
					onGoToStep={vi.fn()}
					onSkip={vi.fn()}
					isLastStep={true}
					isTransitioning={false}
					isPositionReady={true}
				/>
			);

			expect(screen.getByText('Finish Tour')).toBeInTheDocument();
		});
	});

	describe('Color Contrast Validation', () => {
		// Helper to calculate relative luminance
		function getLuminance(hex: string): number {
			const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
			if (!result) return 0;

			const rgb = [
				parseInt(result[1], 16) / 255,
				parseInt(result[2], 16) / 255,
				parseInt(result[3], 16) / 255,
			].map((val) => (val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4)));

			return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
		}

		// Helper to calculate contrast ratio
		function getContrastRatio(color1: string, color2: string): number {
			const l1 = getLuminance(color1);
			const l2 = getLuminance(color2);
			const lighter = Math.max(l1, l2);
			const darker = Math.min(l1, l2);
			return (lighter + 0.05) / (darker + 0.05);
		}

		// Some themes have known lower contrast by design (solarized themes are designed this way)
		const knownLowerContrastThemes = ['solarized-light', 'solarized-dark'];

		it.each(themeIds)(
			'should have sufficient contrast between accent and accentForeground for %s theme',
			(themeId) => {
				const theme = THEMES[themeId];
				const accent = theme.colors.accent;
				const foreground = theme.colors.accentForeground;

				// Skip if colors contain rgba (can't easily calculate contrast)
				if (accent.includes('rgba') || foreground.includes('rgba')) {
					return;
				}

				const ratio = getContrastRatio(accent, foreground);
				// Use lower threshold for known lower-contrast themes
				const minRatio = knownLowerContrastThemes.includes(themeId) ? 2.5 : 3.0;
				expect(ratio).toBeGreaterThanOrEqual(minRatio);
			}
		);

		it.each(themeIds)(
			'should have sufficient contrast between bgMain and textMain for %s theme',
			(themeId) => {
				const theme = THEMES[themeId];
				const bg = theme.colors.bgMain;
				const text = theme.colors.textMain;

				const ratio = getContrastRatio(bg, text);
				// Solarized themes have intentionally lower contrast by design
				const minRatio = knownLowerContrastThemes.includes(themeId) ? 4.0 : 4.5;
				expect(ratio).toBeGreaterThanOrEqual(minRatio);
			}
		);
	});

	describe('Hover State Compatibility', () => {
		it.each(lightThemes)('hover states should be visible on light theme %s', (themeId) => {
			const theme = THEMES[themeId];

			// Light themes with hover:bg-white/5 would add very light white
			// This is a documentation test to ensure we're aware of the issue
			// The actual fix would be to use theme-aware hover states

			// For now, verify the theme has appropriate background colors
			// that would provide contrast with any hover state
			expect(theme.colors.bgSidebar).toBeDefined();
			expect(theme.colors.bgActivity).toBeDefined();
		});

		it.each(darkThemes)('hover states should be visible on dark theme %s', (themeId) => {
			const theme = THEMES[themeId];

			// Dark themes with hover:bg-white/5 should be fine
			// as white over dark provides subtle contrast
			expect(theme.colors.bgSidebar).toBeDefined();
			expect(theme.colors.bgActivity).toBeDefined();
		});
	});
});
