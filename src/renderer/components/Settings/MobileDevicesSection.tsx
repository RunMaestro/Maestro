/**
 * MobileDevicesSection - Settings section for mobile device pairing
 *
 * This component provides a UI for:
 * - Generating pairing codes with QR display
 * - Listing paired mobile devices
 * - Revoking paired devices
 *
 * Part of M3 Mobile Expo App implementation (decision 6A QR pairing).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Smartphone, Plus, Trash2, QrCode, Clock, AlertCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { Spinner } from '../ui/Spinner';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';

interface PairedDevice {
	id: string;
	deviceName: string;
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
}

export interface MobileDevicesSectionProps {
	theme: Theme;
}

export function MobileDevicesSection({ theme }: MobileDevicesSectionProps) {
	// Paired devices state
	const [devices, setDevices] = useState<PairedDevice[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Pairing modal state
	const [showPairingModal, setShowPairingModal] = useState(false);
	const [pairingCode, setPairingCode] = useState<string | null>(null);
	const [pairingHost, setPairingHost] = useState<string | null>(null);
	const [pairingPort, setPairingPort] = useState<number | null>(null);
	const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
	const [pairingError, setPairingError] = useState<string | null>(null);
	const [generatingCode, setGeneratingCode] = useState(false);

	// Countdown state
	const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
	const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Polling state for device list refresh while modal is open
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Revoke state
	const [revokingId, setRevokingId] = useState<string | null>(null);

	// Load devices on mount
	const loadDevices = useCallback(async () => {
		try {
			const result = await window.maestro.mobilePairing.listDevices();
			if (result.success && result.devices) {
				setDevices(result.devices);
				setError(null);
			} else {
				setError(result.error || 'Failed to load devices');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load devices');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadDevices();
	}, [loadDevices]);

	// Start polling when modal is open
	useEffect(() => {
		if (showPairingModal) {
			pollRef.current = setInterval(loadDevices, 2000);
		} else if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
			}
		};
	}, [showPairingModal, loadDevices]);

	// Countdown timer
	useEffect(() => {
		if (pairingExpiresAt && showPairingModal) {
			const updateCountdown = () => {
				const remaining = Math.max(0, Math.floor((pairingExpiresAt - Date.now()) / 1000));
				setSecondsRemaining(remaining);
				if (remaining === 0) {
					// Code expired
					setPairingCode(null);
					setPairingError('Pairing code expired. Generate a new one.');
					if (countdownRef.current) {
						clearInterval(countdownRef.current);
						countdownRef.current = null;
					}
				}
			};
			updateCountdown();
			countdownRef.current = setInterval(updateCountdown, 1000);
		}
		return () => {
			if (countdownRef.current) {
				clearInterval(countdownRef.current);
				countdownRef.current = null;
			}
		};
	}, [pairingExpiresAt, showPairingModal]);

	// Generate pairing code
	const handleGenerateCode = async () => {
		setGeneratingCode(true);
		setPairingError(null);
		try {
			const result = await window.maestro.mobilePairing.generateCode();
			if (result.success && result.code && result.host && result.port && result.expiresAt) {
				setPairingCode(result.code);
				setPairingHost(result.host);
				setPairingPort(result.port);
				setPairingExpiresAt(result.expiresAt);
			} else {
				setPairingError(result.error || 'Failed to generate pairing code');
			}
		} catch (err) {
			setPairingError(err instanceof Error ? err.message : 'Failed to generate pairing code');
		} finally {
			setGeneratingCode(false);
		}
	};

	// Open pairing modal and generate code
	const handleOpenPairingModal = async () => {
		setShowPairingModal(true);
		await handleGenerateCode();
	};

	// Close pairing modal
	const handleClosePairingModal = () => {
		setShowPairingModal(false);
		setPairingCode(null);
		setPairingHost(null);
		setPairingPort(null);
		setPairingExpiresAt(null);
		setPairingError(null);
		setSecondsRemaining(0);
	};

	// Revoke device
	const handleRevoke = async (id: string) => {
		setRevokingId(id);
		try {
			const result = await window.maestro.mobilePairing.revokeDevice(id);
			if (result.success) {
				setDevices((prev) => prev.filter((d) => d.id !== id));
			}
		} catch {
			// Silently fail, device may have already been revoked
		} finally {
			setRevokingId(null);
		}
	};

	// Format countdown as mm:ss
	const formatCountdown = (seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	};

	// Build QR code payload
	const qrPayload =
		pairingCode && pairingHost && pairingPort
			? `maestro://pair?host=${encodeURIComponent(pairingHost)}&port=${pairingPort}&code=${pairingCode}`
			: '';

	return (
		<div className="space-y-4">
			{/* Section Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Smartphone className="w-5 h-5 opacity-70" />
					<span className="text-sm font-bold uppercase opacity-70">Mobile Devices</span>
				</div>
				<button
					onClick={handleOpenPairingModal}
					className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md cursor-pointer transition-colors"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.bgMain,
					}}
				>
					<Plus className="w-4 h-4" />
					Pair New Device
				</button>
			</div>

			{/* Description */}
			<p className="text-sm opacity-70">
				Pair your mobile device with Maestro using QR code scanning. Paired devices can access your
				agents via the Maestro mobile app over your local network.
			</p>

			{/* Loading State */}
			{loading && (
				<div className="flex items-center justify-center py-8">
					<Spinner size={24} color={theme.colors.textMain} />
				</div>
			)}

			{/* Error State */}
			{error && !loading && (
				<div
					className="flex items-center gap-2 p-3 rounded-md text-sm"
					style={{ backgroundColor: `${theme.colors.error}20`, color: theme.colors.error }}
				>
					<AlertCircle className="w-4 h-4" />
					{error}
				</div>
			)}

			{/* Empty State */}
			{!loading && !error && devices.length === 0 && (
				<div
					className="text-center py-8 rounded-md border border-dashed"
					style={{ borderColor: theme.colors.border }}
				>
					<Smartphone className="w-8 h-8 mx-auto mb-2 opacity-30" />
					<p className="text-sm opacity-50">No paired devices</p>
					<p className="text-xs opacity-40 mt-1">Click "Pair New Device" to connect your mobile</p>
				</div>
			)}

			{/* Devices List */}
			{!loading && !error && devices.length > 0 && (
				<div className="space-y-2">
					{devices.map((device) => (
						<div
							key={device.id}
							className="flex items-center justify-between p-3 rounded-md border"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							<div className="flex items-center gap-3">
								<Smartphone className="w-5 h-5 opacity-50" />
								<div>
									<div className="text-sm font-medium">{device.deviceName}</div>
									<div className="text-xs opacity-50 flex items-center gap-2">
										<Clock className="w-3 h-3" />
										Last used {formatRelativeTime(device.lastUsedAt)}
									</div>
								</div>
							</div>
							<GhostIconButton
								title="Revoke device"
								onClick={() => handleRevoke(device.id)}
								disabled={revokingId === device.id}
							>
								{revokingId === device.id ? (
									<Spinner size={16} color={theme.colors.textMain} />
								) : (
									<Trash2 className="w-4 h-4" />
								)}
							</GhostIconButton>
						</div>
					))}
				</div>
			)}

			{/* Pairing Modal */}
			{showPairingModal && (
				<div
					className="fixed inset-0 flex items-center justify-center z-[10000]"
					style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
					onClick={handleClosePairingModal}
				>
					<div
						className="w-[400px] rounded-xl border p-6 shadow-2xl"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
						}}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between mb-4">
							<div className="flex items-center gap-2">
								<QrCode className="w-5 h-5" />
								<span className="text-lg font-bold">Pair New Device</span>
							</div>
							<button
								onClick={handleClosePairingModal}
								className="text-sm opacity-50 hover:opacity-100 cursor-pointer"
							>
								Cancel
							</button>
						</div>

						{/* Error */}
						{pairingError && (
							<div
								className="flex items-center gap-2 p-3 rounded-md text-sm mb-4"
								style={{ backgroundColor: `${theme.colors.error}20`, color: theme.colors.error }}
							>
								<AlertCircle className="w-4 h-4" />
								{pairingError}
							</div>
						)}

						{/* Generating */}
						{generatingCode && !pairingCode && (
							<div className="flex flex-col items-center justify-center py-8">
								<Spinner size={32} color={theme.colors.textMain} />
								<p className="text-sm opacity-50 mt-3">Generating pairing code...</p>
							</div>
						)}

						{/* QR Code Display */}
						{pairingCode && qrPayload && (
							<div className="flex flex-col items-center">
								<div className="p-4 rounded-lg mb-4" style={{ backgroundColor: 'white' }}>
									<QRCodeSVG value={qrPayload} size={200} level="M" includeMargin={false} />
								</div>

								<p className="text-sm text-center opacity-70 mb-3">
									Open the Maestro mobile app and scan this QR code to pair your device.
								</p>

								{/* Countdown */}
								<div
									className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm"
									style={{
										backgroundColor:
											secondsRemaining < 60
												? `${theme.colors.warning}30`
												: `${theme.colors.accent}20`,
										color: secondsRemaining < 60 ? theme.colors.warning : theme.colors.accent,
									}}
								>
									<Clock className="w-4 h-4" />
									Expires in {formatCountdown(secondsRemaining)}
								</div>

								{/* Regenerate button */}
								<button
									onClick={handleGenerateCode}
									disabled={generatingCode}
									className="mt-4 text-sm opacity-50 hover:opacity-100 cursor-pointer underline"
								>
									Generate new code
								</button>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
