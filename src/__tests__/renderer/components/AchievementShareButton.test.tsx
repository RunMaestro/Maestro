import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AchievementShareButton } from '../../../renderer/components/AchievementShareButton';
import { firstBadgeStats, mockTheme } from './AchievementCard/_fixtures';

const safeClipboardWriteBlobMock = vi.hoisted(() => vi.fn());

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWriteBlob: safeClipboardWriteBlobMock,
}));

class MockClipboardItem {
	private data: Record<string, Blob>;

	constructor(data: Record<string, Blob>) {
		this.data = data;
	}

	get types() {
		return Object.keys(this.data);
	}

	getType(type: string) {
		return Promise.resolve(this.data[type]);
	}
}

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
	HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
		callback(new Blob(['png'], { type: 'image/png' }));
	});
	HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');

	return mockContext;
}

describe('AchievementShareButton', () => {
	const originalImage = global.Image;
	const originalClipboardItem = global.ClipboardItem;
	let anchorClickSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		safeClipboardWriteBlobMock.mockResolvedValue(true);
		(global as typeof globalThis & { ClipboardItem: typeof MockClipboardItem }).ClipboardItem =
			MockClipboardItem;
		(global as typeof globalThis & { Image: typeof MockImage }).Image = MockImage;
		anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		installCanvasMocks();
	});

	afterEach(() => {
		anchorClickSpy.mockRestore();
		global.Image = originalImage;
		global.ClipboardItem = originalClipboardItem;
		vi.useRealTimers();
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

	it('uses delayed outside click to close the popover', () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(document.body);
		expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		fireEvent.click(document.body);

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

	it('copies a generated image to the clipboard', async () => {
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Copy to Clipboard'));

		await waitFor(() => {
			expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d');
			expect(safeClipboardWriteBlobMock).toHaveBeenCalledTimes(1);
		});
		expect(await screen.findByText('Copied!')).toBeInTheDocument();
	});

	it('downloads a generated image and closes the popover', async () => {
		render(<AchievementShareButton theme={mockTheme} autoRunStats={firstBadgeStats} />);

		fireEvent.click(screen.getByTitle('Share achievements'));
		fireEvent.click(screen.getByText('Save as Image'));

		await waitFor(() => {
			expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/png');
			expect(anchorClickSpy).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByText('Save as Image')).not.toBeInTheDocument();
	});
});
