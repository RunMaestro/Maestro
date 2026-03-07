import { memo, useRef, useEffect } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';

import type { TunnelStatus } from '../../hooks/remote/useLiveOverlay';

interface LiveOverlayPanelProps {
	theme: Theme;
	webInterfaceUrl: string;
	tunnelStatus: TunnelStatus;
	tunnelUrl: string | null;
	tunnelError: string | null;
	cloudflaredInstalled: boolean | null;
	activeUrlTab: 'local' | 'remote';
	setActiveUrlTab: (tab: 'local' | 'remote') => void;
	copyFlash: string | null;
	setCopyFlash: (msg: string | null) => void;
	handleTunnelToggle: () => void;
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	setWebInterfaceUseCustomPort: (v: boolean) => void;
	setWebInterfaceCustomPort: (v: number) => void;
	isLiveMode: boolean;
	toggleGlobalLive: () => Promise<void>;
	setLiveOverlayOpen: (open: boolean) => void;
	restartWebServer: () => Promise<string | null>;
}

export const LiveOverlayPanel = memo(function LiveOverlayPanel({
	theme,
	webInterfaceUrl,
	tunnelStatus,
	tunnelUrl,
	tunnelError,
	cloudflaredInstalled,
	activeUrlTab,
	setActiveUrlTab,
	copyFlash,
	setCopyFlash,
	handleTunnelToggle,
	webInterfaceUseCustomPort,
	webInterfaceCustomPort,
	setWebInterfaceUseCustomPort,
	setWebInterfaceCustomPort,
	isLiveMode,
	toggleGlobalLive,
	setLiveOverlayOpen,
	restartWebServer,
}: LiveOverlayPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	return (
		<div
			ref={containerRef}
			className="absolute top-full left-0 pt-2 z-50 outline-none"
			style={{ width: '280px', maxHeight: 'calc(100vh - 120px)' }}
			tabIndex={-1}
			onKeyDown={(e) => {
				if (tunnelStatus === 'connected') {
					if (e.key === 'ArrowLeft') {
						setActiveUrlTab('local');
					} else if (e.key === 'ArrowRight') {
						setActiveUrlTab('remote');
					}
				}
			}}
		>
			<div
				className="rounded-lg shadow-2xl overflow-y-auto scrollbar-thin"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Description Header */}
				<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
					<div className="text-[11px] leading-relaxed" style={{ color: theme.colors.textDim }}>
						Control your agents from your phone or tablet.
						{tunnelStatus === 'connected' ? (
							<span className="text-blue-400">
								{' '}
								Remote tunnel active — access Maestro from anywhere, even outside your network.
							</span>
						) : (
							<span>
								{' '}
								Scan the QR code on your local network, or enable remote control to control Maestro
								from anywhere.
							</span>
						)}
					</div>
				</div>

				{/* Remote Access Toggle Section */}
				<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
					<div className="flex items-center justify-between">
						<div>
							<div
								className="text-[10px] uppercase font-bold"
								style={{ color: theme.colors.textDim }}
							>
								Remote Control
							</div>
							{cloudflaredInstalled === false && (
								<div className="text-[9px] text-yellow-500 mt-1">Install cloudflared to enable</div>
							)}
						</div>

						{/* Toggle Switch */}
						<button
							type="button"
							onClick={handleTunnelToggle}
							disabled={!cloudflaredInstalled || tunnelStatus === 'starting'}
							className={`relative w-10 h-5 rounded-full transition-colors ${
								tunnelStatus === 'connected'
									? 'bg-green-500'
									: cloudflaredInstalled
										? 'bg-gray-600 hover:bg-gray-500'
										: 'bg-gray-700 opacity-50 cursor-not-allowed'
							}`}
							title={
								!cloudflaredInstalled
									? 'cloudflared not installed'
									: tunnelStatus === 'connected'
										? 'Disable remote control'
										: 'Enable remote control'
							}
						>
							<div
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									tunnelStatus === 'connected' ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
							{tunnelStatus === 'starting' && (
								<div className="absolute inset-0 flex items-center justify-center">
									<div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
								</div>
							)}
						</button>
					</div>

					{/* Error Message */}
					{tunnelStatus === 'error' && tunnelError && (
						<div className="mt-2 text-[10px] text-red-400">{tunnelError}</div>
					)}

					{/* Install Instructions (when cloudflared not found) */}
					{cloudflaredInstalled === false && (
						<div
							className="mt-2 p-2 rounded text-[10px]"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<div className="font-medium mb-1">To enable remote control:</div>
							<div className="opacity-70 font-mono">brew install cloudflared</div>
							<button
								type="button"
								onClick={() =>
									window.maestro.shell.openExternal(
										'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
									)
								}
								className="text-blue-400 hover:underline mt-1 block"
							>
								Other platforms →
							</button>
						</div>
					)}
				</div>

				{/* Custom Port Toggle Section */}
				<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
					<div className="flex items-center justify-between">
						<div>
							<div
								className="text-[10px] uppercase font-bold"
								style={{ color: theme.colors.textDim }}
							>
								Custom Port
							</div>
							<div
								className="text-[9px] mt-0.5"
								style={{ color: theme.colors.textDim, opacity: 0.7 }}
							>
								For static proxy routes
							</div>
						</div>

						{/* Toggle Switch */}
						<button
							type="button"
							onClick={() => {
								setWebInterfaceUseCustomPort(!webInterfaceUseCustomPort);
								if (isLiveMode) {
									setTimeout(() => void restartWebServer(), 100);
								}
							}}
							className={`relative w-10 h-5 rounded-full transition-colors ${
								webInterfaceUseCustomPort ? 'bg-green-500' : 'bg-gray-600 hover:bg-gray-500'
							}`}
							title={webInterfaceUseCustomPort ? 'Use random port' : 'Use custom port'}
						>
							<div
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									webInterfaceUseCustomPort ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Port Input (shown when custom port is enabled) */}
					{webInterfaceUseCustomPort && (
						<div className="mt-2">
							<div className="flex items-center gap-2">
								<input
									type="text"
									inputMode="numeric"
									pattern="[0-9]*"
									value={webInterfaceCustomPort}
									onChange={(e) => {
										const raw = e.target.value.replace(/[^0-9]/g, '');
										if (raw === '') {
											setWebInterfaceCustomPort(0);
										} else {
											const value = parseInt(raw, 10);
											if (!isNaN(value)) {
												setWebInterfaceCustomPort(value);
											}
										}
									}}
									onBlur={() => {
										const clampedPort = Math.max(1024, Math.min(65535, webInterfaceCustomPort));
										if (clampedPort !== webInterfaceCustomPort) {
											setWebInterfaceCustomPort(clampedPort);
										}
										if (isLiveMode) {
											void restartWebServer();
										}
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											const clampedPort = Math.max(1024, Math.min(65535, webInterfaceCustomPort));
											if (clampedPort !== webInterfaceCustomPort) {
												setWebInterfaceCustomPort(clampedPort);
											}
											if (isLiveMode) {
												void restartWebServer();
											}
											(e.target as HTMLInputElement).blur();
										}
									}}
									className="flex-1 px-2 py-1 text-[11px] font-mono rounded border outline-none"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									placeholder="8080"
								/>
							</div>
							<div
								className="text-[9px] mt-1"
								style={{ color: theme.colors.textDim, opacity: 0.7 }}
							>
								{isLiveMode ? 'Press Enter or click away to apply' : 'Port range: 1024-65535'}
							</div>
						</div>
					)}
				</div>

				{/* URL and QR Code Section */}
				<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
					{/* URL Display */}
					<div className="flex items-center gap-2 mb-3">
						<div
							className={`flex-1 text-[11px] font-mono truncate select-all ${
								activeUrlTab === 'local' ? 'text-green-400' : 'text-blue-400'
							}`}
							title={activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl || ''}
						>
							{(activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl || '').replace(
								/^https?:\/\//,
								''
							)}
						</div>
						<button
							type="button"
							onClick={() => {
								const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
								if (url) {
									safeClipboardWrite(url);
									setCopyFlash(
										activeUrlTab === 'local' ? 'Local URL copied!' : 'Remote URL copied!'
									);
								}
							}}
							className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
							title="Copy URL"
						>
							<Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						</button>
						<button
							type="button"
							onClick={() => {
								const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
								if (url) window.maestro.shell.openExternal(url);
							}}
							className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
							title="Open in Browser"
						>
							<ExternalLink className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						</button>
					</div>

					{/* QR Code with optional loading overlay */}
					<div className="relative">
						<div className="p-2 rounded" style={{ backgroundColor: 'white' }}>
							<QRCodeSVG
								value={activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl || webInterfaceUrl}
								size={220}
								bgColor="#FFFFFF"
								fgColor="#000000"
								style={{ width: '100%', height: 'auto' }}
							/>
						</div>

						{/* Loading overlay when tunnel is starting */}
						{tunnelStatus === 'starting' && (
							<div
								className="absolute inset-0 flex flex-col items-center justify-center rounded"
								style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
							>
								<div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mb-3" />
								<div className="text-white text-[11px] font-medium">Starting tunnel...</div>
							</div>
						)}

						{/* Copy flash notice */}
						{copyFlash && (
							<div
								className="absolute inset-0 flex items-center justify-center rounded pointer-events-none animate-pulse"
								style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
							>
								<div
									className="px-4 py-2 rounded-full text-[12px] font-bold"
									style={{
										backgroundColor: activeUrlTab === 'local' ? '#22c55e' : '#3b82f6',
										color: 'white',
									}}
								>
									{copyFlash}
								</div>
							</div>
						)}
					</div>

					{/* Local/Remote Pill Selector - Only shown when tunnel is connected */}
					{tunnelStatus === 'connected' && (
						<div className="mt-3 flex flex-col items-center gap-2">
							<div
								className="inline-flex rounded-full p-0.5"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								<button
									type="button"
									onClick={() => setActiveUrlTab('local')}
									className={`px-4 py-1 text-[10px] font-bold uppercase rounded-full transition-all ${
										activeUrlTab === 'local'
											? 'bg-green-500 text-white shadow-sm'
											: 'hover:bg-white/10'
									}`}
									style={activeUrlTab !== 'local' ? { color: theme.colors.textDim } : {}}
								>
									Local
								</button>
								<button
									type="button"
									onClick={() => setActiveUrlTab('remote')}
									className={`px-4 py-1 text-[10px] font-bold uppercase rounded-full transition-all ${
										activeUrlTab === 'remote'
											? 'bg-blue-500 text-white shadow-sm'
											: 'hover:bg-white/10'
									}`}
									style={activeUrlTab !== 'remote' ? { color: theme.colors.textDim } : {}}
								>
									Remote
								</button>
							</div>
							{/* Dot indicators */}
							<div className="flex gap-1.5">
								<div
									className={`w-1.5 h-1.5 rounded-full transition-colors cursor-pointer ${
										activeUrlTab === 'local' ? 'bg-green-500' : 'bg-gray-600'
									}`}
									onClick={() => setActiveUrlTab('local')}
								/>
								<div
									className={`w-1.5 h-1.5 rounded-full transition-colors cursor-pointer ${
										activeUrlTab === 'remote' ? 'bg-blue-500' : 'bg-gray-600'
									}`}
									onClick={() => setActiveUrlTab('remote')}
								/>
							</div>
						</div>
					)}
				</div>

				{/* Action Buttons */}
				<div className="p-3 space-y-2">
					<button
						type="button"
						onClick={() => {
							const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
							if (url) window.maestro.shell.openExternal(url);
						}}
						className="w-full py-1.5 rounded text-[10px] font-medium transition-colors hover:bg-white/10 border"
						style={{
							color: activeUrlTab === 'local' ? '#4ade80' : '#60a5fa',
							borderColor:
								activeUrlTab === 'local' ? 'rgba(74, 222, 128, 0.3)' : 'rgba(96, 165, 250, 0.3)',
						}}
					>
						Open in Browser
					</button>
					<button
						type="button"
						onClick={() => {
							void toggleGlobalLive();
							setLiveOverlayOpen(false);
						}}
						className="w-full py-1.5 rounded text-[10px] font-medium transition-colors hover:bg-red-500/20 text-red-400 border border-red-500/30"
					>
						Turn Off Web Interface
					</button>
				</div>
			</div>
		</div>
	);
});
