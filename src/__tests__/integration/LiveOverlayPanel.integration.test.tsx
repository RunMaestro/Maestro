import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { LiveOverlayPanel } from '../../renderer/components/SessionList/LiveOverlayPanel';
import type { Theme } from '../../renderer/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('qrcode.react', () => ({
	QRCodeSVG: (props: any) => <div data-testid="qr-code" data-value={props.value} />,
}));

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

// Mock window.maestro
(window as any).maestro = {
	shell: {
		openExternal: vi.fn(),
	},
	tunnel: {
		getStatus: vi.fn().mockResolvedValue({ isRunning: false, url: null, error: null }),
	},
};

const mockTheme: Theme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		bgActivity: '#1e1e3a',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#e94560',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as Theme;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDefaultProps(overrides: Partial<Parameters<typeof LiveOverlayPanel>[0]> = {}) {
	return {
		theme: mockTheme,
		webInterfaceUrl: 'http://192.168.1.10:3456',
		tunnelStatus: 'off' as const,
		tunnelUrl: null,
		tunnelError: null,
		cloudflaredInstalled: true,
		activeUrlTab: 'local' as const,
		setActiveUrlTab: vi.fn(),
		copyFlash: null,
		setCopyFlash: vi.fn(),
		handleTunnelToggle: vi.fn(),
		persistentWebLink: false,
		setPersistentWebLink: vi.fn().mockResolvedValue(undefined),
		webInterfaceUseCustomPort: false,
		webInterfaceCustomPort: 8080,
		setWebInterfaceUseCustomPort: vi.fn(),
		setWebInterfaceCustomPort: vi.fn(),
		isLiveMode: true,
		toggleGlobalLive: vi.fn(),
		setLiveOverlayOpen: vi.fn(),
		restartWebServer: vi.fn(),
		restartTunnel: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveOverlayPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro.tunnel.getStatus.mockResolvedValue({
			isRunning: false,
			url: null,
			error: null,
		});
	});

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------
	describe('rendering', () => {
		it('renders the description text', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			expect(screen.getByText(/Control your agents from your phone or tablet/)).toBeTruthy();
		});

		it('shows local network text when tunnel is not connected', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'off' })} />);
			expect(screen.getByText(/Scan the QR code on your local network/)).toBeTruthy();
		});

		it('shows remote tunnel text when tunnel is connected', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'connected' })} />);
			expect(screen.getByText(/Remote tunnel active/)).toBeTruthy();
		});

		it('renders QR code with local URL by default', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			const qr = screen.getByTestId('qr-code');
			expect(qr.dataset.value).toBe('http://192.168.1.10:3456');
		});

		it('renders QR code with tunnel URL when on remote tab', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						tunnelUrl: 'https://tunnel.example.com',
						tunnelStatus: 'connected',
					})}
				/>
			);
			const qr = screen.getByTestId('qr-code');
			expect(qr.dataset.value).toBe('https://tunnel.example.com');
		});

		it('displays URL without protocol prefix', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			expect(screen.getByText('192.168.1.10:3456')).toBeTruthy();
		});
	});

	// -----------------------------------------------------------------------
	// Remote Access
	// -----------------------------------------------------------------------
	describe('remote control', () => {
		it('renders Remote Control section', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			expect(screen.getByText('Remote Control')).toBeTruthy();
		});

		it('calls handleTunnelToggle when toggle button is clicked', () => {
			const handleTunnelToggle = vi.fn();
			render(<LiveOverlayPanel {...createDefaultProps({ handleTunnelToggle })} />);

			const toggleBtn = screen.getByTitle('Enable remote control');
			fireEvent.click(toggleBtn);
			expect(handleTunnelToggle).toHaveBeenCalledOnce();
		});

		it('disables toggle when cloudflared is not installed', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ cloudflaredInstalled: false })} />);
			const toggleBtn = screen.getByTitle('cloudflared not installed');
			expect(toggleBtn).toBeDisabled();
		});

		it('shows install instructions when cloudflared is not installed', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ cloudflaredInstalled: false })} />);
			expect(screen.getByText('Install cloudflared to enable')).toBeTruthy();
			expect(screen.getByText('brew install cloudflared')).toBeTruthy();
			expect(screen.getByText('Other platforms →')).toBeTruthy();
		});

		it('opens cloudflared install docs from the install instructions', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ cloudflaredInstalled: false })} />);

			fireEvent.click(screen.getByText('Other platforms →'));

			expect((window as any).maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
			);
		});

		it('disables toggle when tunnel is starting', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'starting' })} />);
			const toggleBtn = screen.getByRole('button', { name: /Starting tunnel/ });
			expect(toggleBtn).toBeDisabled();
		});

		it('shows loading spinner when tunnel is starting', () => {
			const { container } = render(
				<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'starting' })} />
			);
			expect(container.querySelector('.animate-spin')).toBeTruthy();
		});

		it('displays tunnel error message', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'error',
						tunnelError: 'Connection refused',
					})}
				/>
			);
			expect(screen.getByText('Connection refused')).toBeTruthy();
		});

		it('shows disconnect title when tunnel is connected', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'connected' })} />);
			expect(screen.getByTitle('Disable remote control')).toBeTruthy();
		});

		it('keeps connected state when tunnel status confirms process is running', () => {
			(window as any).maestro.tunnel.getStatus.mockResolvedValue({
				isRunning: true,
				url: 'https://tunnel.example.com',
				error: null,
			});

			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						tunnelUrl: 'https://tunnel.example.com',
					})}
				/>
			);

			expect(screen.getByText(/Remote tunnel active/)).toBeTruthy();
		});
	});

	describe('persistent web link', () => {
		it('toggles persistent link and shows pending state until persistence completes', async () => {
			let resolvePersist!: () => void;
			const persistPromise = new Promise<void>((resolve) => {
				resolvePersist = resolve;
			});
			const setPersistentWebLink = vi.fn(() => persistPromise);
			render(<LiveOverlayPanel {...createDefaultProps({ setPersistentWebLink })} />);

			const toggle = screen.getByRole('switch', { name: 'Persistent Web Link' });
			fireEvent.click(toggle);

			expect(setPersistentWebLink).toHaveBeenCalledWith(true);
			expect(toggle).toHaveAttribute('aria-busy', 'true');
			expect(toggle).toBeDisabled();

			await act(async () => {
				resolvePersist();
				await persistPromise;
			});

			expect(toggle).toHaveAttribute('aria-busy', 'false');
			expect(toggle).not.toBeDisabled();
		});

		it('passes false when disabling an already persistent link', async () => {
			const setPersistentWebLink = vi.fn().mockResolvedValue(undefined);
			render(
				<LiveOverlayPanel
					{...createDefaultProps({ persistentWebLink: true, setPersistentWebLink })}
				/>
			);

			await act(async () => {
				fireEvent.click(screen.getByRole('switch', { name: 'Persistent Web Link' }));
				await Promise.resolve();
			});

			expect(setPersistentWebLink).toHaveBeenCalledWith(false);
		});
	});

	// -----------------------------------------------------------------------
	// Custom Port
	// -----------------------------------------------------------------------
	describe('custom port', () => {
		it('renders Custom Port section', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			expect(screen.getByText('Custom Port')).toBeTruthy();
		});

		it('shows port input when custom port is enabled', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ webInterfaceUseCustomPort: true })} />);
			expect(screen.getByPlaceholderText('8080')).toBeTruthy();
		});

		it('does not show port input when custom port is disabled', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ webInterfaceUseCustomPort: false })} />);
			expect(screen.queryByPlaceholderText('8080')).toBeNull();
		});

		it('calls setWebInterfaceCustomPort on port input change', () => {
			const setWebInterfaceCustomPort = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						setWebInterfaceCustomPort,
					})}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('8080'), {
				target: { value: '9090' },
			});
			expect(setWebInterfaceCustomPort).toHaveBeenCalledWith(9090);
		});

		it('strips non-numeric characters from port input', () => {
			const setWebInterfaceCustomPort = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						setWebInterfaceCustomPort,
					})}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('8080'), {
				target: { value: 'abc' },
			});
			expect(setWebInterfaceCustomPort).toHaveBeenCalledWith(0);
		});

		it('clamps port to 1024-65535 on blur', () => {
			const setWebInterfaceCustomPort = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						webInterfaceCustomPort: 80,
						setWebInterfaceCustomPort,
					})}
				/>
			);

			fireEvent.blur(screen.getByPlaceholderText('8080'));
			expect(setWebInterfaceCustomPort).toHaveBeenCalledWith(1024);
		});

		it('restarts web server on blur when live mode is active', () => {
			const restartWebServer = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						isLiveMode: true,
						restartWebServer,
					})}
				/>
			);

			fireEvent.blur(screen.getByPlaceholderText('8080'));
			expect(restartWebServer).toHaveBeenCalled();
		});

		it('clamps and restarts on Enter key', () => {
			const setWebInterfaceCustomPort = vi.fn();
			const restartWebServer = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						webInterfaceCustomPort: 999,
						setWebInterfaceCustomPort,
						isLiveMode: true,
						restartWebServer,
					})}
				/>
			);

			fireEvent.keyDown(screen.getByPlaceholderText('8080'), { key: 'Enter' });
			expect(setWebInterfaceCustomPort).toHaveBeenCalledWith(1024);
			expect(restartWebServer).toHaveBeenCalled();
		});

		it('ignores non-Enter keys in the port input', () => {
			const setWebInterfaceCustomPort = vi.fn();
			const restartWebServer = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						setWebInterfaceCustomPort,
						restartWebServer,
					})}
				/>
			);

			fireEvent.keyDown(screen.getByPlaceholderText('8080'), { key: 'Tab' });
			expect(setWebInterfaceCustomPort).not.toHaveBeenCalled();
			expect(restartWebServer).not.toHaveBeenCalled();
		});

		it('leaves an in-range port unchanged on blur when live mode is inactive', () => {
			const setWebInterfaceCustomPort = vi.fn();
			const restartWebServer = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						webInterfaceCustomPort: 8080,
						isLiveMode: false,
						setWebInterfaceCustomPort,
						restartWebServer,
					})}
				/>
			);

			fireEvent.blur(screen.getByPlaceholderText('8080'));
			expect(setWebInterfaceCustomPort).not.toHaveBeenCalled();
			expect(restartWebServer).not.toHaveBeenCalled();
		});

		it('leaves an in-range port unchanged on Enter when live mode is inactive', () => {
			const setWebInterfaceCustomPort = vi.fn();
			const restartWebServer = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						webInterfaceCustomPort: 8080,
						isLiveMode: false,
						setWebInterfaceCustomPort,
						restartWebServer,
					})}
				/>
			);

			fireEvent.keyDown(screen.getByPlaceholderText('8080'), { key: 'Enter' });
			expect(setWebInterfaceCustomPort).not.toHaveBeenCalled();
			expect(restartWebServer).not.toHaveBeenCalled();
		});

		it('shows apply hint when in live mode', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						isLiveMode: true,
					})}
				/>
			);
			expect(screen.getByText('Press Enter or click away to apply')).toBeTruthy();
		});

		it('shows port range hint when not in live mode', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						webInterfaceUseCustomPort: true,
						isLiveMode: false,
					})}
				/>
			);
			expect(screen.getByText('Port range: 1024-65535')).toBeTruthy();
		});

		it('restarts the web server after toggling custom port while live', () => {
			vi.useFakeTimers();
			const restartWebServer = vi.fn().mockResolvedValue(null);
			const setWebInterfaceUseCustomPort = vi.fn();

			try {
				render(
					<LiveOverlayPanel
						{...createDefaultProps({
							webInterfaceUseCustomPort: false,
							isLiveMode: true,
							restartWebServer,
							setWebInterfaceUseCustomPort,
						})}
					/>
				);

				fireEvent.click(screen.getByTitle('Use custom port'));

				expect(setWebInterfaceUseCustomPort).toHaveBeenCalledWith(true);
				expect(restartWebServer).not.toHaveBeenCalled();

				act(() => {
					vi.advanceTimersByTime(100);
				});

				expect(restartWebServer).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not restart the web server after toggling custom port while live mode is off', () => {
			vi.useFakeTimers();
			const restartWebServer = vi.fn().mockResolvedValue(null);
			const setWebInterfaceUseCustomPort = vi.fn();

			try {
				render(
					<LiveOverlayPanel
						{...createDefaultProps({
							webInterfaceUseCustomPort: false,
							isLiveMode: false,
							restartWebServer,
							setWebInterfaceUseCustomPort,
						})}
					/>
				);

				fireEvent.click(screen.getByTitle('Use custom port'));

				expect(setWebInterfaceUseCustomPort).toHaveBeenCalledWith(true);
				act(() => {
					vi.advanceTimersByTime(100);
				});
				expect(restartWebServer).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// -----------------------------------------------------------------------
	// URL Tab Selector
	// -----------------------------------------------------------------------
	describe('URL tab selector', () => {
		it('shows Local/Remote tabs when tunnel is connected', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'connected' })} />);
			expect(screen.getByText('Local')).toBeTruthy();
			expect(screen.getByText('Remote')).toBeTruthy();
		});

		it('does not show tabs when tunnel is not connected', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'off' })} />);
			expect(screen.queryByText('Local')).toBeNull();
			expect(screen.queryByText('Remote')).toBeNull();
		});

		it('calls setActiveUrlTab when Local tab is clicked', () => {
			const setActiveUrlTab = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						setActiveUrlTab,
					})}
				/>
			);

			fireEvent.click(screen.getByText('Local'));
			expect(setActiveUrlTab).toHaveBeenCalledWith('local');
		});

		it('calls setActiveUrlTab when Remote tab is clicked', () => {
			const setActiveUrlTab = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						setActiveUrlTab,
					})}
				/>
			);

			fireEvent.click(screen.getByText('Remote'));
			expect(setActiveUrlTab).toHaveBeenCalledWith('remote');
		});

		it('calls setActiveUrlTab from connected dot indicators', () => {
			const setActiveUrlTab = vi.fn();
			const { container } = render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						setActiveUrlTab,
					})}
				/>
			);

			const dots = Array.from(container.querySelectorAll('div[class*="cursor-pointer"]'));
			const localDot = dots.at(-2);
			const remoteDot = dots.at(-1);

			expect(localDot).toBeTruthy();
			expect(remoteDot).toBeTruthy();

			fireEvent.click(localDot!);
			fireEvent.click(remoteDot!);

			expect(setActiveUrlTab).toHaveBeenCalledWith('local');
			expect(setActiveUrlTab).toHaveBeenCalledWith('remote');
		});

		it('supports arrow key navigation when tunnel is connected', () => {
			const setActiveUrlTab = vi.fn();
			const { container } = render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						setActiveUrlTab,
					})}
				/>
			);

			const panel = container.firstElementChild!;
			fireEvent.keyDown(panel, { key: 'ArrowLeft' });
			expect(setActiveUrlTab).toHaveBeenCalledWith('local');

			fireEvent.keyDown(panel, { key: 'ArrowRight' });
			expect(setActiveUrlTab).toHaveBeenCalledWith('remote');
		});

		it('ignores unrelated keys when tunnel is connected', () => {
			const setActiveUrlTab = vi.fn();
			const { container } = render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'connected',
						setActiveUrlTab,
					})}
				/>
			);

			fireEvent.keyDown(container.firstElementChild!, { key: 'Home' });
			expect(setActiveUrlTab).not.toHaveBeenCalled();
		});

		it('ignores arrow keys when tunnel is not connected', () => {
			const setActiveUrlTab = vi.fn();
			const { container } = render(
				<LiveOverlayPanel
					{...createDefaultProps({
						tunnelStatus: 'off',
						setActiveUrlTab,
					})}
				/>
			);

			const panel = container.firstElementChild!;
			fireEvent.keyDown(panel, { key: 'ArrowLeft' });
			fireEvent.keyDown(panel, { key: 'ArrowRight' });
			expect(setActiveUrlTab).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Copy & Open
	// -----------------------------------------------------------------------
	describe('copy and open actions', () => {
		it('copies local URL and sets flash on copy button click', async () => {
			const { safeClipboardWrite } = await import('../../renderer/utils/clipboard');
			const setCopyFlash = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'local',
						setCopyFlash,
					})}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy URL'));
			expect(safeClipboardWrite).toHaveBeenCalledWith('http://192.168.1.10:3456');
			expect(setCopyFlash).toHaveBeenCalledWith('Local URL copied!');
		});

		it('copies tunnel URL when on remote tab', async () => {
			const { safeClipboardWrite } = await import('../../renderer/utils/clipboard');
			const setCopyFlash = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						tunnelUrl: 'https://tunnel.example.com',
						tunnelStatus: 'connected',
						setCopyFlash,
					})}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy URL'));
			expect(safeClipboardWrite).toHaveBeenCalledWith('https://tunnel.example.com');
			expect(setCopyFlash).toHaveBeenCalledWith('Remote URL copied!');
		});

		it('opens local URL in browser on Open button click', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ activeUrlTab: 'local' })} />);

			fireEvent.click(screen.getByTitle('Open in Browser'));
			expect((window as any).maestro.shell.openExternal).toHaveBeenCalledWith(
				'http://192.168.1.10:3456'
			);
		});

		it('opens remote URL in browser on Open button click', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						tunnelStatus: 'connected',
						tunnelUrl: 'https://tunnel.example.com',
					})}
				/>
			);

			fireEvent.click(screen.getByTitle('Open in Browser'));
			expect((window as any).maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://tunnel.example.com'
			);
		});

		it('does not copy or open when the remote tab has no tunnel URL', async () => {
			const { safeClipboardWrite } = await import('../../renderer/utils/clipboard');
			const setCopyFlash = vi.fn();
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						tunnelStatus: 'connected',
						tunnelUrl: null,
						setCopyFlash,
					})}
				/>
			);

			expect(screen.getByTestId('qr-code').dataset.value).toBe('http://192.168.1.10:3456');
			fireEvent.click(screen.getByTitle('Copy URL'));
			fireEvent.click(screen.getByTitle('Open in Browser'));

			expect(safeClipboardWrite).not.toHaveBeenCalled();
			expect(setCopyFlash).not.toHaveBeenCalled();
			expect((window as any).maestro.shell.openExternal).not.toHaveBeenCalled();
		});

		it('shows copy flash overlay when copyFlash is set', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ copyFlash: 'Local URL copied!' })} />);
			expect(screen.getByText('Local URL copied!')).toBeTruthy();
		});

		it('shows remote copy flash overlay styling', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						copyFlash: 'Remote URL copied!',
					})}
				/>
			);

			expect(screen.getByText('Remote URL copied!')).toHaveStyle({
				backgroundColor: '#3b82f6',
			});
		});

		it('shows loading overlay when tunnel is starting', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ tunnelStatus: 'starting' })} />);
			expect(screen.getByText('Starting tunnel...')).toBeTruthy();
		});
	});

	// -----------------------------------------------------------------------
	// Action Buttons
	// -----------------------------------------------------------------------
	describe('action buttons', () => {
		it('renders Open in Browser and Turn Off buttons', () => {
			render(<LiveOverlayPanel {...createDefaultProps()} />);
			const buttons = screen.getAllByText('Open in Browser');
			expect(buttons.length).toBeGreaterThan(0);
			expect(screen.getByText('Turn Off Web Interface')).toBeTruthy();
		});

		it('opens the selected URL from the footer Open in Browser action', () => {
			render(<LiveOverlayPanel {...createDefaultProps({ activeUrlTab: 'local' })} />);

			const openButtons = screen.getAllByRole('button', { name: 'Open in Browser' });
			fireEvent.click(openButtons.at(-1)!);

			expect((window as any).maestro.shell.openExternal).toHaveBeenCalledWith(
				'http://192.168.1.10:3456'
			);
		});

		it('does not open the footer browser action without a remote URL', () => {
			render(
				<LiveOverlayPanel
					{...createDefaultProps({
						activeUrlTab: 'remote',
						tunnelStatus: 'connected',
						tunnelUrl: null,
					})}
				/>
			);

			const openButtons = screen.getAllByRole('button', { name: 'Open in Browser' });
			fireEvent.click(openButtons.at(-1)!);

			expect((window as any).maestro.shell.openExternal).not.toHaveBeenCalled();
		});

		it('calls toggleGlobalLive and closes overlay on Turn Off click', () => {
			const toggleGlobalLive = vi.fn();
			const setLiveOverlayOpen = vi.fn();
			render(
				<LiveOverlayPanel {...createDefaultProps({ toggleGlobalLive, setLiveOverlayOpen })} />
			);

			fireEvent.click(screen.getByText('Turn Off Web Interface'));
			expect(toggleGlobalLive).toHaveBeenCalledOnce();
			expect(setLiveOverlayOpen).toHaveBeenCalledWith(false);
		});
	});
});
