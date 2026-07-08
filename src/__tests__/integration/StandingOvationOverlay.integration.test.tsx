import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import StandingOvationOverlay from '../../renderer/components/StandingOvationOverlay';
import { CONDUCTOR_BADGES } from '../../renderer/constants/conductorBadges';
import { logger } from '../../renderer/utils/logger';
import type { Theme } from '../../renderer/types';

const confettiMock = vi.hoisted(() => vi.fn());

vi.mock('canvas-confetti', () => ({
	default: confettiMock,
}));

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1f1f1f',
		bgActivity: '#2b2b2b',
		textMain: '#f5f5f5',
		textDim: '#a3a3a3',
		accent: '#38bdf8',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		syntaxComment: '#737373',
		syntaxKeyword: '#c084fc',
	},
};

class TestClipboardItem {
	types: string[];

	constructor(items: Record<string, Blob>) {
		this.types = Object.keys(items);
	}
}

function createCanvasContext() {
	const gradient = { addColorStop: vi.fn() };
	return {
		arc: vi.fn(),
		beginPath: vi.fn(),
		createLinearGradient: vi.fn(() => gradient),
		createRadialGradient: vi.fn(() => gradient),
		fill: vi.fn(),
		fillRect: vi.fn(),
		fillText: vi.fn(),
		measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
		roundRect: vi.fn(),
		stroke: vi.fn(),
		set fillStyle(_value: unknown) {},
		set font(_value: unknown) {},
		set lineWidth(_value: unknown) {},
		set strokeStyle(_value: unknown) {},
		set textAlign(_value: unknown) {},
	} as unknown as CanvasRenderingContext2D;
}

function renderOverlay(props: Partial<React.ComponentProps<typeof StandingOvationOverlay>> = {}) {
	return render(
		<LayerStackProvider>
			<StandingOvationOverlay
				theme={theme}
				themeMode="dark"
				badge={CONDUCTOR_BADGES[1]}
				cumulativeTimeMs={2 * 60 * 60 * 1000}
				onClose={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

describe('StandingOvationOverlay integration', () => {
	let originalClipboard: Clipboard | undefined;
	let originalClipboardItem: typeof ClipboardItem | undefined;
	let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
	let originalToBlob: typeof HTMLCanvasElement.prototype.toBlob;
	let originalToDataUrl: typeof HTMLCanvasElement.prototype.toDataURL;
	let anchorClickSpy: ReturnType<typeof vi.fn>;
	let clipboardWriteSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		confettiMock.mockClear();
		anchorClickSpy = vi.fn();
		clipboardWriteSpy = vi.fn().mockResolvedValue(undefined);
		originalClipboard = navigator.clipboard;
		originalClipboardItem = globalThis.ClipboardItem;
		originalGetContext = HTMLCanvasElement.prototype.getContext;
		originalToBlob = HTMLCanvasElement.prototype.toBlob;
		originalToDataUrl = HTMLCanvasElement.prototype.toDataURL;

		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { write: clipboardWriteSpy },
		});
		Object.defineProperty(globalThis, 'ClipboardItem', {
			configurable: true,
			value: TestClipboardItem,
		});
		HTMLCanvasElement.prototype.getContext = vi.fn(() =>
			createCanvasContext()
		) as typeof HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
			callback(new Blob(['achievement'], { type: 'image/png' }));
		}) as typeof HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClickSpy);
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
	});

	afterEach(() => {
		act(() => {
			vi.runOnlyPendingTimers();
		});
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		HTMLCanvasElement.prototype.getContext = originalGetContext;
		HTMLCanvasElement.prototype.toBlob = originalToBlob;
		HTMLCanvasElement.prototype.toDataURL = originalToDataUrl;
		if (originalClipboard) {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: originalClipboard,
			});
		} else {
			delete (navigator as Partial<Navigator>).clipboard;
		}
		if (originalClipboardItem) {
			Object.defineProperty(globalThis, 'ClipboardItem', {
				configurable: true,
				value: originalClipboardItem,
			});
		} else {
			delete (globalThis as Partial<typeof globalThis>).ClipboardItem;
		}
	});

	it('renders badge, record, next-level, conductor, and leaderboard actions', () => {
		const onClose = vi.fn();
		const onOpenLeaderboardRegistration = vi.fn();
		renderOverlay({
			isNewRecord: true,
			recordTimeMs: 90 * 60 * 1000,
			onClose,
			onOpenLeaderboardRegistration,
			isLeaderboardRegistered: false,
		});

		expect(
			screen.getByRole('dialog', { name: 'Standing Ovation Achievement' })
		).toBeInTheDocument();
		expect(screen.getByText('STANDING OVATION')).toBeInTheDocument();
		expect(screen.getByText('New Personal Record!')).toBeInTheDocument();
		expect(screen.getByText(CONDUCTOR_BADGES[1].name)).toBeInTheDocument();
		expect(screen.getByText(CONDUCTOR_BADGES[1].exampleConductor.name)).toBeInTheDocument();
		expect(screen.getByText(/Next:/)).toBeInTheDocument();
		expect(confettiMock).toHaveBeenCalledTimes(3);

		fireEvent.click(screen.getByRole('button', { name: /learn more on wikipedia/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			CONDUCTOR_BADGES[1].exampleConductor.wikipediaUrl
		);

		fireEvent.click(screen.getByRole('button', { name: /join global leaderboard/i }));
		expect(onClose).toHaveBeenCalled();
		expect(onOpenLeaderboardRegistration).toHaveBeenCalled();
	});

	it('copies and downloads a generated achievement image from the share menu', async () => {
		renderOverlay({ disableConfetti: true });

		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
		});
		expect(clipboardWriteSpy).toHaveBeenCalledWith([
			expect.objectContaining({ types: ['image/png'] }),
		]);
		expect(screen.getByText('Copied!')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /save as image/i }));
			await Promise.resolve();
		});
		expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/png');
		expect(anchorClickSpy).toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: /save as image/i })).not.toBeInTheDocument();
		expect(confettiMock).not.toHaveBeenCalled();
	});

	it('uses the take-a-bow close animation and renders the max-level state', () => {
		const onClose = vi.fn();
		renderOverlay({
			badge: CONDUCTOR_BADGES[CONDUCTOR_BADGES.length - 1],
			cumulativeTimeMs: 365 * 24 * 60 * 60 * 1000,
			onClose,
		});

		expect(screen.getByText(/highest rank/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Take a Bow' }));
		expect(screen.getByRole('button', { name: /Bravo/ })).toBeDisabled();
		expect(confettiMock).toHaveBeenCalledTimes(6);

		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(onClose).toHaveBeenCalled();
	});

	it('ignores repeated close attempts while closing and supports Escape through the layer stack', () => {
		const onClose = vi.fn();
		renderOverlay({ onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Take a Bow' }));
		fireEvent.click(screen.getByRole('button', { name: /Bravo/ }));
		fireEvent.keyDown(window, { key: 'Escape' });

		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('normalizes transparent and rgba theme colors while drawing record stats', async () => {
		const alphaTheme: Theme = {
			...theme,
			colors: {
				...theme.colors,
				bgSidebar: 'transparent',
				bgActivity: 'rgba(1, 2, 3, 0.5)',
				textMain: 'rgba(not-a-color)',
				textDim: 'transparent',
				accent: 'rgba(not-a-color)',
			},
		};
		renderOverlay({
			theme: alphaTheme,
			themeMode: 'light',
			isNewRecord: true,
			recordTimeMs: 45 * 60 * 1000,
			disableConfetti: true,
		});

		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
		});

		expect(clipboardWriteSpy).toHaveBeenCalledWith([
			expect.objectContaining({ types: ['image/png'] }),
		]);
	});

	it('skips copy success when image blob creation or clipboard write fails', async () => {
		HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
			callback(null);
		}) as typeof HTMLCanvasElement.prototype.toBlob;
		const firstRender = renderOverlay({
			disableConfetti: true,
			isNewRecord: false,
			recordTimeMs: 30 * 60 * 1000,
		});
		expect(screen.getByText('Longest Run')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
		});
		expect(clipboardWriteSpy).not.toHaveBeenCalled();
		expect(screen.queryByText('Copied!')).not.toBeInTheDocument();

		firstRender.unmount();
		HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
			callback(new Blob(['achievement'], { type: 'image/png' }));
		}) as typeof HTMLCanvasElement.prototype.toBlob;
		clipboardWriteSpy.mockRejectedValueOnce(new Error('clipboard denied'));
		renderOverlay({ disableConfetti: true });

		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
		});

		expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
	});

	it('logs share image generation errors for copy and download actions', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		HTMLCanvasElement.prototype.getContext = vi.fn(() => {
			throw new Error('canvas unavailable');
		}) as typeof HTMLCanvasElement.prototype.getContext;
		renderOverlay({ disableConfetti: true });

		fireEvent.click(screen.getByRole('button', { name: /share achievement/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /save as image/i }));
		});

		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to generate share image:',
			undefined,
			expect.any(Error)
		);
		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to download image:',
			undefined,
			expect.any(Error)
		);
	});
});
