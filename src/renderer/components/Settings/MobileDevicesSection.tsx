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
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
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
	const [secondsRemaining, setSecondsRemaining] = useState<number>(0);

	// Revoke state
	const [revokingId, setRevokingId] = useState<string | null>(null);

	// Dedupe concurrent listDevices calls (mount + 2s poll can overlap on a slow disk).
	const loadInFlightRef = useRef(false);

	const loadDevices = useCallback(async () => {
		if (loadInFlightRef.current) return;
		loadInFlightRef.current = true;
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
			loadInFlightRef.current = false;
		}
	}, []);

	useEffect(() => {
		loadDevices();
	}, [loadDevices]);

	// Poll the device list while the pairing modal is open so a successful
	// scan from the phone shows up without the user closing/reopening.
	useEffect(() => {
		if (!showPairingModal) return;
		const id = setInterval(loadDevices, 2000);
		return () => clearInterval(id);
	}, [showPairingModal, loadDevices]);

	// Countdown timer. Runs while the modal is open and an active code is in
	// memory; clears the code (and surfaces an error) when it hits 0.
	useEffect(() => {
		if (!pairingExpiresAt || !showPairingModal) return;
		const tick = () => {
			const remaining = Math.max(0, Math.floor((pairingExpiresAt - Date.now()) / 1000));
			setSecondsRemaining(remaining);
			if (remaining === 0) {
				setPairingCode(null);
				setPairingError('Pairing code expired. Generate a new one.');
			}
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
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

			{showPairingModal && (
				<PairingModal
					theme={theme}
					pairingCode={pairingCode}
					qrPayload={qrPayload}
					pairingError={pairingError}
					generatingCode={generatingCode}
					secondsRemaining={secondsRemaining}
					onClose={handleClosePairingModal}
					onRegenerate={handleGenerateCode}
					formatCountdown={formatCountdown}
				/>
			)}
		</div>
	);
}

interface PairingModalProps {
	theme: Theme;
	pairingCode: string | null;
	qrPayload: string;
	pairingError: string | null;
	generatingCode: boolean;
	secondsRemaining: number;
	onClose: () => void;
	onRegenerate: () => void;
	formatCountdown: (seconds: number) => string;
}

function PairingModal({
	theme,
	pairingCode,
	qrPayload,
	pairingError,
	generatingCode,
	secondsRemaining,
	onClose,
	onRegenerate,
	formatCountdown,
}: PairingModalProps) {
	// Register with the layer stack so Escape closes the dialog, focus is
	// trapped, and lower layers stop receiving keyboard events.
	useModalLayer(MODAL_PRIORITIES.MOBILE_PAIRING, 'Pair New Device', onClose);

	return (
		<div
			className="fixed inset-0 flex items-center justify-center modal-overlay select-none"
			onClick={onClose}
		>
			<div
				className="w-[400px] rounded-xl border p-6 shadow-2xl"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Pair New Device"
			>
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<QrCode className="w-5 h-5" />
						<span className="text-lg font-bold">Pair New Device</span>
					</div>
					<button onClick={onClose} className="text-sm opacity-50 hover:opacity-100 cursor-pointer">
						Cancel
					</button>
				</div>

				{pairingError && (
					<div
						className="flex items-center gap-2 p-3 rounded-md text-sm mb-4 select-text"
						style={{ backgroundColor: `${theme.colors.error}20`, color: theme.colors.error }}
					>
						<AlertCircle className="w-4 h-4" />
						<span>{pairingError}</span>
					</div>
				)}

				{generatingCode && !pairingCode && (
					<div className="flex flex-col items-center justify-center py-8">
						<Spinner size={32} color={theme.colors.textMain} />
						<p className="text-sm opacity-50 mt-3">Generating pairing code...</p>
					</div>
				)}

				{pairingCode && qrPayload && (
					<div className="flex flex-col items-center">
						<div className="p-4 rounded-lg mb-4" style={{ backgroundColor: 'white' }}>
							<QRCodeSVG value={qrPayload} size={200} level="M" includeMargin={false} />
						</div>

						<p className="text-sm text-center opacity-70 mb-3">
							Open the Maestro mobile app and scan this QR code to pair your device.
						</p>

						<div
							className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm"
							style={{
								backgroundColor:
									secondsRemaining < 60 ? `${theme.colors.warning}30` : `${theme.colors.accent}20`,
								color: secondsRemaining < 60 ? theme.colors.warning : theme.colors.accent,
							}}
						>
							<Clock className="w-4 h-4" />
							Expires in {formatCountdown(secondsRemaining)}
						</div>

						<button
							onClick={onRegenerate}
							disabled={generatingCode}
							className="mt-4 text-sm opacity-50 hover:opacity-100 cursor-pointer underline"
						>
							Generate new code
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
