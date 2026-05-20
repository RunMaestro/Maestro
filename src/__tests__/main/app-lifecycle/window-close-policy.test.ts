import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppQuit = vi.fn();

vi.mock('electron', () => ({
	app: {
		quit: mockAppQuit,
	},
	BrowserWindow: vi.fn(),
}));

describe('app-lifecycle/window-close-policy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes primary window close through app quit when quit is not confirmed', async () => {
		const { attachPrimaryWindowClosePolicy } =
			await import('../../../main/app-lifecycle/window-close-policy');
		const closeHandlers: Array<(event: { preventDefault: () => void }) => void> = [];
		const preventDefault = vi.fn();
		const primaryWindow = {
			on: vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => {
				if (event === 'close') {
					closeHandlers.push(handler);
				}
			}),
		};

		attachPrimaryWindowClosePolicy({
			getPrimaryWindow: () => primaryWindow as never,
			quitHandler: {
				setup: vi.fn(),
				isQuitConfirmed: () => false,
				confirmQuit: vi.fn(),
			},
		});

		closeHandlers[0]?.({ preventDefault });

		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(mockAppQuit).toHaveBeenCalledTimes(1);
	});

	it('allows primary window close after quit has been confirmed', async () => {
		const { attachPrimaryWindowClosePolicy } =
			await import('../../../main/app-lifecycle/window-close-policy');
		const closeHandlers: Array<(event: { preventDefault: () => void }) => void> = [];
		const preventDefault = vi.fn();
		const primaryWindow = {
			on: vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => {
				if (event === 'close') {
					closeHandlers.push(handler);
				}
			}),
		};

		attachPrimaryWindowClosePolicy({
			getPrimaryWindow: () => primaryWindow as never,
			quitHandler: {
				setup: vi.fn(),
				isQuitConfirmed: () => true,
				confirmQuit: vi.fn(),
			},
		});

		closeHandlers[0]?.({ preventDefault });

		expect(preventDefault).not.toHaveBeenCalled();
		expect(mockAppQuit).not.toHaveBeenCalled();
	});

	it('does nothing when there is no primary window', async () => {
		const { attachPrimaryWindowClosePolicy } =
			await import('../../../main/app-lifecycle/window-close-policy');

		attachPrimaryWindowClosePolicy({
			getPrimaryWindow: () => null,
			quitHandler: {
				setup: vi.fn(),
				isQuitConfirmed: () => false,
				confirmQuit: vi.fn(),
			},
		});

		expect(mockAppQuit).not.toHaveBeenCalled();
	});
});
