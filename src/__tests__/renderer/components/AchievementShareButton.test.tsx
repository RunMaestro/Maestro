import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AchievementShareButton } from '../../../renderer/components/AchievementShareButton';
import { firstBadgeStats, mockTheme } from './AchievementCard/_fixtures';

const { safeClipboardWriteImageMock, flashCopiedMock, saveImageMock, notifyToastMock } = vi.hoisted(
	() => ({
		safeClipboardWriteImageMock: vi.fn(),
		flashCopiedMock: vi.fn(),
		saveImageMock: vi.fn(),
		notifyToastMock: vi.fn(),
	})
);

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWriteImage: safeClipboardWriteImageMock,
}));
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: flashCopiedMock,
}));
vi.mock('../../../renderer/utils/imageExport', () => ({
	saveImageDataUrlToDisk: saveImageMock,
}));
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: notifyToastMock,
}));

const GITHUB_LOGO_URL = 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';

class MockImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;

	set src(_value: string) {
		queueMicrotask(() => {
			this.onerror?.();
		});
	}
}

function installCanvasMocks() {
	const mockContext = {
		createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
		createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 0,
		lineCap: '',
		font: '',
		textAlign: '',
		textBaseline: '',
		letterSpacing: '',
		imageSmoothingEnabled: false,
		imageSmoothingQuality: '',
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
		scale: vi.fn(),
		measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
	};

	HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext);
	HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');

	return mockContext;
}

describe('AchievementShareButton', () => {
	const originalImage = global.Image;
	const fetchImageAsBase64 = vi.fn();
	let originalFetchImageAsBase64: unknown;

	beforeEach(() => {
		vi.clearAllMocks();
		safeClipboardWriteImageMock.mockResolvedValue(true);
		saveImageMock.mockResolvedValue({ saved: true, path: '/tmp/share.png' });
		fetchImageAsBase64.mockResolvedValue(null);
		const fs = window.maestro.fs as unknown as Record<string, unknown>;
		originalFetchImageAsBase64 = fs.fetchImageAsBase64;
		fs.fetchImageAsBase64 = fetchImageAsBase64;
		(global as typeof globalThis & { Image: typeof MockImage }).Image = MockImage;
		installCanvasMocks();
	});

	afterEach(() => {
		(window.maestro.fs as unknown as Record<string, unknown>).fetchImageAsBase64 =
			originalFetchImageAsBase64;
		global.Image = originalImage;
	});

	it('opens and closes the default popover from the icon button', () => {
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		const button = screen.getByTitle('Share achievements');
		fireEvent.click(button);
		expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
		expect(screen.getByText('Save as Image')).toBeInTheDocument();

		fireEvent.click(button);
		expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
	});

	it('closes on an outside press even inside a container that stops click propagation', () => {
		// The Usage Dashboard dialog stops click propagation, so a document click
		// listener never fired there and the menu could not be dismissed.
		render(
			<div onClick={(event) => event.stopPropagation()}>
				<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />
				<button type="button">elsewhere</button>
			</div>
		);

		fireEvent.click(screen.getByTitle('Share achievements'));
		expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

		fireEvent.mouseDown(screen.getByText('elsewhere'));
		expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
	});

	it('renders the header variant with text', () => {
		render(
			<AchievementShareButton
				theme={mockTheme}
				autoRunStats={firstBadgeStats}
				variant="header"
				title="Share from header"
			/>
		);

		expect(screen.getByRole('button', { name: /Share/ })).toBeInTheDocument();
		expect(screen.getByTitle('Share from header')).toBeInTheDocument();
	});

	it('starts the remote image fetches as soon as the menu opens', async () => {
		render(
			<AchievementShareButton
				theme={mockTheme}
				autoRunStats={firstBadgeStats}
				leaderboardRegistration={{ githubUsername: 'octocat' } as never}
			/>
		);

		fireEvent.click(screen.getByTitle('Share achievements'));

		await waitFor(() => {
			expect(fetchImageAsBase64).toHaveBeenCalledWith(GITHUB_LOGO_URL);
			expect(fetchImageAsBase64).toHaveBeenCalledWith('https://github.com/octocat.png?size=200');
		});
	});

	it('copies through the native clipboard and confirms it', async () => {
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => {
			expect(safeClipboardWriteImageMock).toHaveBeenCalledWith('data:image/png;base64,test');
		});
		expect(await screen.findByText('Copied!')).toBeInTheDocument();
		expect(flashCopiedMock).toHaveBeenCalledTimes(1);
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('reports a rejected copy and keeps the menu open', async () => {
		safeClipboardWriteImageMock.mockResolvedValue(false);
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => {
			expect(notifyToastMock).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', title: 'Could Not Copy Image' })
			);
		});
		expect(flashCopiedMock).not.toHaveBeenCalled();
		expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
	});

	it('saves through the native dialog, confirms where, and closes the popover', async () => {
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Save as Image'));

		await waitFor(() => {
			expect(saveImageMock).toHaveBeenCalledWith(
				'data:image/png;base64,test',
				expect.stringMatching(/^maestro-achievement-level-\d+\.png$/)
			);
		});
		await waitFor(() => {
			expect(notifyToastMock).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'green', message: '/tmp/share.png' })
			);
		});
		expect(screen.queryByText('Save as Image')).not.toBeInTheDocument();
	});

	it('reports a failed save and keeps the menu open', async () => {
		saveImageMock.mockResolvedValue({ saved: false, error: 'EACCES' });
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Save as Image'));

		await waitFor(() => {
			expect(notifyToastMock).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', message: 'EACCES' })
			);
		});
		expect(screen.getByText('Save as Image')).toBeInTheDocument();
	});
});
