import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AchievementCard } from '../../renderer/components/AchievementCard';
import type {
	AutoRunStats,
	LeaderboardRegistration,
	MaestroUsageStats,
	Theme,
} from '../../renderer/types';

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function createAutoRunStats(overrides: Partial<AutoRunStats> = {}): AutoRunStats {
	return {
		cumulativeTimeMs: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		lastBadgeUnlockLevel: 0,
		lastAcknowledgedBadgeLevel: 0,
		badgeHistory: [],
		...overrides,
	};
}

const level5Stats = createAutoRunStats({
	cumulativeTimeMs: 7 * 24 * 60 * 60 * 1000,
	longestRunMs: 2 * 60 * 60 * 1000,
	longestRunTimestamp: 1700000000000,
	totalRuns: 15,
	currentBadgeLevel: 5,
	lastBadgeUnlockLevel: 5,
	lastAcknowledgedBadgeLevel: 4,
	badgeHistory: [
		{ level: 1, unlockedAt: Date.UTC(2026, 0, 1) },
		{ level: 2, unlockedAt: Date.UTC(2026, 0, 2) },
		{ level: 3, unlockedAt: Date.UTC(2026, 0, 3) },
		{ level: 4, unlockedAt: Date.UTC(2026, 0, 4) },
		{ level: 5, unlockedAt: Date.UTC(2026, 0, 5) },
	],
});

const maxLevelStats = createAutoRunStats({
	cumulativeTimeMs: 10 * 365 * 24 * 60 * 60 * 1000,
	longestRunMs: 24 * 60 * 60 * 1000,
	longestRunTimestamp: 1700000000000,
	totalRuns: 1000,
	currentBadgeLevel: 11,
	lastBadgeUnlockLevel: 11,
	lastAcknowledgedBadgeLevel: 11,
	badgeHistory: Array.from({ length: 11 }, (_, index) => ({
		level: index + 1,
		unlockedAt: Date.UTC(2026, 0, index + 1),
	})),
});

const globalStats = {
	totalSessions: 150,
	totalMessages: 5000,
	totalInputTokens: 1_000_000,
	totalOutputTokens: 500_000,
	totalCacheReadTokens: 200_000,
	totalCacheCreationTokens: 100_000,
	totalCostUsd: 45.67,
	totalSizeBytes: 10_000_000,
	isComplete: true,
};

const usageStats: MaestroUsageStats = {
	maxAgents: 8,
	maxDefinedAgents: 12,
	maxSimultaneousAutoRuns: 3,
	maxSimultaneousQueries: 11,
	maxQueueDepth: 5,
};

const leaderboardRegistration: LeaderboardRegistration = {
	email: 'ada@example.com',
	displayName: 'Ada Lovelace',
	githubUsername: 'adalovelace',
	twitterHandle: 'ada_ai',
	linkedinHandle: 'ada-lovelace',
	discordUsername: 'ada#1234',
	registeredAt: 1700000000000,
	emailConfirmed: true,
};

class MockClipboardItem {
	constructor(private readonly data: Record<string, Blob>) {}

	get types() {
		return Object.keys(this.data);
	}

	getType(type: string) {
		return Promise.resolve(this.data[type]);
	}
}

function createMockCanvasContext() {
	return {
		createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
		createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 0,
		lineCap: '',
		font: '',
		textAlign: '',
		textBaseline: '',
		imageSmoothingEnabled: false,
		imageSmoothingQuality: '',
		scale: vi.fn(),
		fillRect: vi.fn(),
		roundRect: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		beginPath: vi.fn(),
		closePath: vi.fn(),
		arc: vi.fn(),
		ellipse: vi.fn(),
		clip: vi.fn(),
		save: vi.fn(),
		restore: vi.fn(),
		drawImage: vi.fn(),
		fillText: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
	};
}

function installShareImageMocks(options: { shouldErrorImage?: (src: string) => boolean } = {}) {
	const ctx = createMockCanvasContext();
	const originalImage = globalThis.Image;
	const originalClipboardItem = globalThis.ClipboardItem;
	const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	const originalGetContext = HTMLCanvasElement.prototype.getContext;
	const originalToBlob = HTMLCanvasElement.prototype.toBlob;
	const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
	const originalFetchImageAsBase64 = window.maestro.fs.fetchImageAsBase64;
	const clipboardWrite = vi.fn().mockResolvedValue(undefined);

	class MockImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		private imageSrc = '';

		set src(value: string) {
			this.imageSrc = value;
			if (options.shouldErrorImage?.(value)) {
				this.onerror?.();
			} else {
				this.onload?.();
			}
		}

		get src() {
			return this.imageSrc;
		}
	}

	globalThis.Image = MockImage as unknown as typeof Image;
	globalThis.ClipboardItem = MockClipboardItem as unknown as typeof ClipboardItem;
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			write: clipboardWrite,
		},
	});
	Object.assign(window.maestro.fs, {
		fetchImageAsBase64: vi.fn().mockResolvedValue('data:image/png;base64,image'),
	});
	HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(ctx);
	HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
		callback(new Blob(['png'], { type: 'image/png' }));
	});
	HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,canvas');

	return {
		ctx,
		clipboardWrite,
		restore: () => {
			globalThis.Image = originalImage;
			globalThis.ClipboardItem = originalClipboardItem;
			if (originalClipboardDescriptor) {
				Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
			} else {
				delete (navigator as Partial<Navigator>).clipboard;
			}
			HTMLCanvasElement.prototype.getContext = originalGetContext;
			HTMLCanvasElement.prototype.toBlob = originalToBlob;
			HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
			window.maestro.fs.fetchImageAsBase64 = originalFetchImageAsBase64;
		},
	};
}

describe('AchievementCard integration', () => {
	let restoreShareImageMocks: (() => void) | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		restoreShareImageMocks = null;
	});

	afterEach(() => {
		restoreShareImageMocks?.();
		vi.useRealTimers();
	});

	it('renders earned badge progress and routes badge detail actions through the shell bridge', () => {
		let escapeHandler: (() => boolean) | null = null;
		const onEscapeWithBadgeOpen = vi.fn((handler: (() => boolean) | null) => {
			escapeHandler = handler;
		});

		const { container } = render(
			<AchievementCard
				theme={theme}
				autoRunStats={level5Stats}
				onEscapeWithBadgeOpen={onEscapeWithBadgeOpen}
			/>
		);

		expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		expect(screen.getByText('Principal Guest Conductor')).toBeInTheDocument();
		expect(screen.getByText('Level 5 of 11')).toBeInTheDocument();
		expect(screen.getByText('5/11 unlocked')).toBeInTheDocument();
		expect(screen.getByText('Path to the Podium: Timeline')).toBeInTheDocument();

		const badgeSegments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
		fireEvent.click(badgeSegments[4]);

		expect(screen.getByText('Level 5')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Esa-Pekka Salonen/i })).toBeInTheDocument();
		expect(onEscapeWithBadgeOpen).toHaveBeenCalledWith(expect.any(Function));

		fireEvent.click(screen.getByRole('button', { name: /Esa-Pekka Salonen/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://en.wikipedia.org/wiki/Esa-Pekka_Salonen'
		);

		let handled = false;
		act(() => {
			handled = escapeHandler?.() ?? false;
		});

		expect(handled).toBe(true);
		expect(screen.queryByRole('button', { name: /Esa-Pekka Salonen/i })).not.toBeInTheDocument();
	});

	it('expands badge history and renders the maximum-level celebration state', async () => {
		render(
			<AchievementCard
				theme={theme}
				autoRunStats={{
					...maxLevelStats,
					badgeHistory: [
						...maxLevelStats.badgeHistory,
						{ level: 99, unlockedAt: Date.UTC(2026, 0, 12) },
					],
				}}
			/>
		);

		expect(screen.getByText('Titan of the Baton')).toBeInTheDocument();
		expect(screen.getByText('11/11 unlocked')).toBeInTheDocument();
		expect(screen.getByText('Maximum Level Achieved!')).toBeInTheDocument();
		expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Path to the Podium: Timeline'));

		expect(await screen.findByText('Titan')).toBeInTheDocument();
		expect(screen.getByText('Grand')).toBeInTheDocument();
		expect(screen.getByText('Apprentice')).toBeInTheDocument();
	});

	it('positions badge tooltips at the edges and dismisses them from outside clicks', async () => {
		const { container } = render(<AchievementCard theme={theme} autoRunStats={maxLevelStats} />);
		const badgeSegments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

		fireEvent.click(badgeSegments[0]);
		expect(screen.getByText('Level 1')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Apprentice Conductor'));
		expect(screen.getByText('Level 1')).toBeInTheDocument();

		act(() => {
			vi.runOnlyPendingTimers();
		});
		fireEvent.click(document.body);
		await waitFor(() => expect(screen.queryByText('Level 1')).not.toBeInTheDocument());

		fireEvent.click(badgeSegments[10]);
		expect(screen.getByText('Level 11')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Leonard Bernstein/i })).toBeInTheDocument();
	});

	it('closes the share menu from outside clicks', async () => {
		render(<AchievementCard theme={theme} autoRunStats={level5Stats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

		act(() => {
			vi.runOnlyPendingTimers();
		});
		fireEvent.click(document.body);
		await waitFor(() => expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument());
	});

	it('generates a personalized share image and writes it to the clipboard', async () => {
		const { ctx, clipboardWrite, restore } = installShareImageMocks();
		restoreShareImageMocks = restore;

		render(
			<AchievementCard
				theme={theme}
				autoRunStats={level5Stats}
				globalStats={globalStats}
				usageStats={usageStats}
				handsOnTimeMs={2 * 60 * 60 * 1000 + 5 * 60 * 1000}
				leaderboardRegistration={leaderboardRegistration}
			/>
		);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
		expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
			expect.any(Function),
			'image/png'
		);
		expect(window.maestro.fs.fetchImageAsBase64).toHaveBeenCalledWith(
			'https://github.com/adalovelace.png?size=200'
		);
		expect(ctx.fillText).toHaveBeenCalledWith('ADA LOVELACE', 300, expect.any(Number));
		expect(ctx.fillText).toHaveBeenCalledWith('ada#1234', expect.any(Number), expect.any(Number));
	});

	it('falls back when share images cannot load and closes copy feedback on timers', async () => {
		const { ctx, clipboardWrite, restore } = installShareImageMocks({
			shouldErrorImage: () => true,
		});
		restoreShareImageMocks = restore;
		vi.mocked(window.maestro.fs.fetchImageAsBase64).mockImplementation(async (url: string) => {
			if (url.includes('adalovelace.png')) {
				throw new Error('avatar failed');
			}
			return 'data:image/png;base64,image';
		});

		render(
			<AchievementCard
				theme={theme}
				autoRunStats={level5Stats}
				globalStats={globalStats}
				usageStats={usageStats}
				handsOnTimeMs={5 * 60 * 1000}
				leaderboardRegistration={{
					...leaderboardRegistration,
					twitterHandle: undefined,
					linkedinHandle: undefined,
					discordUsername: undefined,
				}}
			/>
		);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
		expect(ctx.fillText).toHaveBeenCalledWith('GH', expect.any(Number), expect.any(Number));
		expect(ctx.fillText).toHaveBeenCalledWith('5m', expect.any(Number), expect.any(Number));
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to load image:',
			undefined,
			expect.any(Error)
		);
		expect(screen.getByText('Copied!')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		await waitFor(() => expect(screen.queryByText('Copied!')).not.toBeInTheDocument());
		act(() => {
			vi.advanceTimersByTime(1000);
		});
	});

	it('logs copy generation failures without throwing', async () => {
		const { restore } = installShareImageMocks();
		restoreShareImageMocks = restore;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
			throw new Error('canvas failed');
		});

		render(<AchievementCard theme={theme} autoRunStats={level5Stats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to generate share image:',
				undefined,
				expect.any(Error)
			);
		});
	});

	it('downloads a beginning-journey share image when no badge is unlocked', async () => {
		const { ctx, restore } = installShareImageMocks();
		restoreShareImageMocks = restore;
		const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		vi.mocked(window.maestro.fs.fetchImageAsBase64).mockResolvedValueOnce(null);

		render(
			<AchievementCard
				theme={theme}
				autoRunStats={createAutoRunStats()}
				globalStats={null}
				usageStats={null}
				handsOnTimeMs={500}
			/>
		);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Save as Image'));

		await waitFor(() => expect(clickSpy).toHaveBeenCalledOnce());
		expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/png');
		expect(ctx.fillText).toHaveBeenCalledWith('MAESTRO ACHIEVEMENTS', 300, expect.any(Number));
		expect(ctx.fillText).toHaveBeenCalledWith('Journey Just Beginning...', 300, expect.any(Number));
		expect(ctx.fillText).toHaveBeenCalledWith('0m', expect.any(Number), expect.any(Number));

		clickSpy.mockRestore();
	});

	it('logs share-image download generation failures without closing the test run', async () => {
		const { restore } = installShareImageMocks();
		restoreShareImageMocks = restore;
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
			throw new Error('download failed');
		});

		render(<AchievementCard theme={theme} autoRunStats={level5Stats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Save as Image'));

		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to download image:',
				undefined,
				expect.any(Error)
			);
		});
	});
});
