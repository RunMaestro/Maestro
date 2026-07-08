import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../../../web/mobile/SettingsPanel';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		triggerHaptic: vi.fn(),
		HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
	};
});

const baseSettings = {
	theme: 'dracula',
	fontSize: 14,
	enterToSendAI: true,
	autoScroll: true,
	defaultSaveToHistory: false,
	defaultShowThinking: 'off',
	notificationsEnabled: true,
	audioFeedbackEnabled: false,
	colorBlindMode: 'none',
	conductorProfile: 'Existing profile',
	maxOutputLines: 25,
};

function renderSettingsPanel(overrides: Record<string, unknown> = {}) {
	const settingsHook = {
		settings: { ...baseSettings, ...overrides },
		setSetting: vi.fn().mockResolvedValue(true),
		setTheme: vi.fn().mockResolvedValue(true),
		setFontSize: vi.fn().mockResolvedValue(true),
		setMaxOutputLines: vi.fn().mockResolvedValue(true),
	};
	const props = {
		onClose: vi.fn(),
		settingsHook,
	};

	render(<SettingsPanel {...(props as any)} />);

	return props;
}

describe('SettingsPanel', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('updates appearance controls and shows saved feedback', async () => {
		const { settingsHook } = renderSettingsPanel();

		fireEvent.click(screen.getByLabelText('Increase font size'));
		await waitFor(() => expect(settingsHook.setFontSize).toHaveBeenCalledWith(15));

		fireEvent.click(screen.getByLabelText('Decrease font size'));
		await waitFor(() => expect(settingsHook.setFontSize).toHaveBeenCalledWith(13));

		fireEvent.click(screen.getByRole('button', { name: 'Deuteranopia' }));
		await waitFor(() =>
			expect(settingsHook.setSetting).toHaveBeenCalledWith('colorBlindMode', 'deuteranopia')
		);
	});

	it('updates behavior and profile settings', async () => {
		const { settingsHook } = renderSettingsPanel();

		const enterRow = screen.getByText('Enter to send (AI mode)').closest('div');
		const enterToggle = enterRow?.parentElement?.querySelector('button');
		expect(enterToggle).toBeTruthy();
		fireEvent.click(enterToggle!);
		await waitFor(() =>
			expect(settingsHook.setSetting).toHaveBeenCalledWith('enterToSendAI', false)
		);

		fireEvent.click(screen.getByRole('button', { name: 'Sticky' }));
		await waitFor(() =>
			expect(settingsHook.setSetting).toHaveBeenCalledWith('defaultShowThinking', 'sticky')
		);

		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		await waitFor(() => expect(settingsHook.setMaxOutputLines).toHaveBeenCalledWith(Infinity));

		fireEvent.change(screen.getByPlaceholderText('Tell your agents about yourself...'), {
			target: { value: 'Prefer concise updates' },
		});
		await waitFor(() =>
			expect(settingsHook.setSetting).toHaveBeenCalledWith(
				'conductorProfile',
				'Prefer concise updates'
			)
		);
	});

	it('renders loading state', () => {
		const props = {
			onClose: vi.fn(),
			settingsHook: {
				settings: null,
				setSetting: vi.fn(),
				setTheme: vi.fn(),
				setFontSize: vi.fn(),
				setMaxOutputLines: vi.fn(),
			},
		};

		render(<SettingsPanel {...(props as any)} />);

		expect(screen.getByText('Loading settings...')).toBeInTheDocument();
	});

	it('closes from the close button', () => {
		const { onClose } = renderSettingsPanel();

		fireEvent.click(screen.getByLabelText('Close settings'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
