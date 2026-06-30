/**
 * pair.tsx - QR Code Scanner for Maestro desktop pairing
 *
 * Full-screen camera preview that scans for maestro://pair?... QR codes.
 * When a valid code is scanned, exchanges it with the desktop for a long-lived
 * token and stores credentials in SecureStore.
 *
 * Part of M3 Mobile Expo App implementation (decision 6A QR pairing).
 */

import { Icon } from '@/components/icon';
import { storeCredentials } from '@/lib/credentials';
import { useSessions } from '@/lib/SessionsContext';
import { useToast } from '@/lib/ToastContext';
import {
	parseQrPayload,
	type PairCodePayload,
	type QrPairPayload as PairPayload,
} from '@/pairing/parseQrPayload';
import { clearCredentialsCache } from '../../shims/config';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import { Keyboard as KeyboardIcon, Link2, QrCode, X, RefreshCw } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
	ActivityIndicator,
	Keyboard,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from 'react-native';

const IS_IOS = process.env.EXPO_OS === 'ios';

/** Result from the pairing redemption endpoint */
interface RedemptionResult {
	token: string;
	deviceId: string;
	deviceName: string;
}

/** Auto-detected device name sent to the desktop during redemption. */
function getDeviceName(): string {
	return IS_IOS
		? `${Application.applicationName ?? 'Maestro'} (iOS)`
		: `${Application.applicationName ?? 'Maestro'} (Android)`;
}

/**
 * Exchange the short-lived pairing code for a long-lived token.
 * Calls the desktop's /api/mobile-pairing/redeem endpoint.
 */
async function redeemPairingCode(payload: PairCodePayload): Promise<RedemptionResult> {
	const deviceName = getDeviceName();

	const response = await fetch(`http://${payload.host}:${payload.port}/api/mobile-pairing/redeem`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			code: payload.code,
			deviceName,
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(errorBody || `HTTP ${response.status}`);
	}

	const result = await response.json();
	if (!result.token) {
		throw new Error('No token in response');
	}

	return {
		token: result.token,
		deviceId: result.deviceId,
		deviceName,
	};
}

/**
 * Resolve a parsed payload into the final credentials. For pair-codes we hit
 * the desktop's redeem endpoint; for web-link URLs the token in the URL is
 * already a valid credential (`wsRoute.ts` accepts it via securityToken
 * equality), so we just synthesize a credentials object.
 */
async function resolveCredentials(payload: PairPayload): Promise<RedemptionResult> {
	if (payload.kind === 'pair-code') {
		return redeemPairingCode(payload);
	}

	// web-link: token is already usable. We have no real deviceId from the
	// desktop in this flow, so derive a stable-ish one from the token prefix
	// for display / future revoke flows.
	return {
		token: payload.token,
		deviceId: `web-link-${payload.token.slice(0, 8)}`,
		deviceName: getDeviceName(),
	};
}

/** Manual-entry mode: paste a full maestro://pair URL or fill host/port/code separately */
type ManualMode = 'url' | 'fields';

export default function PairScreen() {
	const router = useRouter();
	const { showToast } = useToast();
	const { connect: connectSessions } = useSessions();
	const [permission, requestPermission] = useCameraPermissions();
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [manualOpen, setManualOpen] = useState(false);
	const [manualMode, setManualMode] = useState<ManualMode>('url');
	const [manualUrl, setManualUrl] = useState('');
	const [manualHost, setManualHost] = useState('');
	const [manualPort, setManualPort] = useState('17170');
	const [manualCode, setManualCode] = useState('');
	const [manualError, setManualError] = useState<string | null>(null);
	const processingRef = useRef(false);

	/**
	 * Shared pairing flow used by both QR scanning and manual entry.
	 * Routes everything through the same redeem + storeCredentials path so the
	 * two input modes behave identically once a payload is validated.
	 */
	const runPairing = useCallback(
		async (payload: PairPayload) => {
			processingRef.current = true;
			setIsProcessing(true);
			setError(null);

			try {
				const result = await resolveCredentials(payload);

				await storeCredentials({
					host: payload.host,
					port: payload.port,
					token: result.token,
					pairingId: result.deviceId,
					deviceName: result.deviceName,
				});

				clearCredentialsCache();

				// SessionsProvider mounted before credentials existed, so its one-shot
				// mount effect bailed with "No credentials". Kick off a fresh connect
				// now that credentials are persisted so the user lands on home with
				// an active socket instead of a stuck disconnected state.
				connectSessions();

				showToast({
					message: 'Successfully paired with Maestro desktop',
					color: 'green',
				});

				router.replace('/');
				return true;
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Failed to pair';
				setError(message);
				showToast({
					message: `Pairing failed: ${message}`,
					color: 'red',
				});
				processingRef.current = false;
				return false;
			} finally {
				setIsProcessing(false);
			}
		},
		[router, showToast, connectSessions]
	);

	const handleBarCodeScanned = useCallback(
		async (result: BarcodeScanningResult) => {
			// Prevent duplicate processing
			if (processingRef.current) return;

			const payload = parseQrPayload(result.data);
			if (!payload) {
				// Not a Maestro QR code, ignore silently
				return;
			}

			await runPairing(payload);
		},
		[runPairing]
	);

	const handleOpenManual = useCallback(() => {
		setManualError(null);
		setManualOpen(true);
	}, []);

	const handleCloseManual = useCallback(() => {
		setManualOpen(false);
		setManualError(null);
	}, []);

	const handleSubmitManual = useCallback(async () => {
		setManualError(null);

		// Build a payload string that the existing parser can validate, so QR
		// and manual entry share one source of truth for what counts as valid.
		let payloadString: string;
		if (manualMode === 'url') {
			payloadString = manualUrl.trim();
			if (!payloadString) {
				setManualError(
					'Paste either the maestro://pair URL or the desktop web link (http://host:port/<token>)'
				);
				return;
			}
		} else {
			const host = manualHost.trim();
			const port = manualPort.trim();
			const code = manualCode.trim();
			if (!host || !port || !code) {
				setManualError('Host, port, and code are all required');
				return;
			}
			payloadString = `maestro://pair?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&code=${encodeURIComponent(code)}`;
		}

		const payload = parseQrPayload(payloadString);
		if (!payload) {
			setManualError(
				manualMode === 'url'
					? 'URL not recognised. Use maestro://pair?... or the desktop web link http://host:port/<token>.'
					: 'Check the host, port (1-65535), and code'
			);
			return;
		}

		Keyboard.dismiss();
		const ok = await runPairing(payload);
		if (ok) {
			setManualOpen(false);
		} else {
			// Surface the same error inside the modal so the user can edit and retry.
			setManualError('Pairing failed. Verify the values and try again.');
			processingRef.current = false;
		}
	}, [manualMode, manualUrl, manualHost, manualPort, manualCode, runPairing]);

	const handleRetry = useCallback(() => {
		setError(null);
		processingRef.current = false;
	}, []);

	const handleClose = useCallback(() => {
		router.back();
	}, [router]);

	// Permission not determined yet
	if (!permission) {
		return (
			<View className="flex-1 bg-black items-center justify-center">
				<ActivityIndicator size="large" color="#ffffff" />
			</View>
		);
	}

	// Permission denied (also the de-facto path on iOS Simulator, which has no camera)
	if (!permission.granted) {
		return (
			<View className="flex-1 bg-black items-center justify-center px-8">
				<Icon icon={QrCode} className="w-16 h-16 text-white opacity-50 mb-6" />
				<Text className="text-white text-xl font-semibold text-center mb-3">
					Camera Access Required
				</Text>
				<Text className="text-white/70 text-base text-center mb-8">
					Maestro needs camera access to scan the QR code displayed in your desktop app.
				</Text>
				<Pressable
					onPress={requestPermission}
					className="bg-white px-6 py-3 rounded-full active:opacity-80 mb-4"
				>
					<Text className="text-black text-base font-semibold">Grant Camera Access</Text>
				</Pressable>
				<Pressable
					onPress={handleOpenManual}
					className="flex-row items-center gap-2 px-6 py-3 rounded-full active:opacity-70"
				>
					<Icon icon={KeyboardIcon} className="w-4 h-4 text-white/80" />
					<Text className="text-white/80 text-base font-medium">
						Enter pairing details manually
					</Text>
				</Pressable>
				<Pressable onPress={handleClose} className="mt-6 px-4 py-2 active:opacity-70">
					<Text className="text-white/60 text-sm">Cancel</Text>
				</Pressable>
				{renderManualModal({
					open: manualOpen,
					mode: manualMode,
					url: manualUrl,
					host: manualHost,
					port: manualPort,
					code: manualCode,
					error: manualError,
					isProcessing,
					onModeChange: setManualMode,
					onUrlChange: setManualUrl,
					onHostChange: setManualHost,
					onPortChange: setManualPort,
					onCodeChange: setManualCode,
					onSubmit: handleSubmitManual,
					onClose: handleCloseManual,
				})}
			</View>
		);
	}

	return (
		<View className="flex-1 bg-black">
			{/* Camera preview */}
			<CameraView
				style={{ flex: 1 }}
				facing="back"
				barcodeScannerSettings={{
					barcodeTypes: ['qr'],
				}}
				onBarcodeScanned={isProcessing || error ? undefined : handleBarCodeScanned}
			/>

			{/*
			  Overlay UI. We use React Native's `pointerEvents` prop on the wrapper
			  (instead of the Tailwind class) because that's the canonical RN API
			  and is guaranteed to be honored regardless of how Uniwind translates
			  utility classes. Interactive children opt back in with `pointerEvents="auto"`.
			*/}
			<View className="absolute inset-0" pointerEvents="box-none">
				{/* Top bar with close button */}
				<View className="flex-row justify-end pt-safe px-4 pb-4" pointerEvents="box-none">
					<Pressable
						onPress={handleClose}
						className="w-10 h-10 rounded-full bg-black/50 items-center justify-center active:bg-black/70"
					>
						<Icon icon={X} className="w-6 h-6 text-white" />
					</Pressable>
				</View>

				{/* Center viewfinder frame - non-interactive */}
				<View className="flex-1 items-center justify-center" pointerEvents="none">
					<View className="w-64 h-64 border-2 border-white/50 rounded-3xl" />
				</View>

				{/* Bottom instructions */}
				<View className="pb-safe px-8 pt-4 items-center" pointerEvents="box-none">
					{isProcessing ? (
						<View className="flex-row items-center gap-3 bg-black/70 px-6 py-4 rounded-2xl mb-4">
							<ActivityIndicator size="small" color="#ffffff" />
							<Text className="text-white text-base">Pairing with desktop...</Text>
						</View>
					) : error ? (
						<View className="items-center bg-black/70 px-6 py-4 rounded-2xl mb-4">
							<Text className="text-red-400 text-base mb-3">{error}</Text>
							<Pressable
								onPress={handleRetry}
								className="flex-row items-center gap-2 bg-white/20 px-4 py-2 rounded-full active:bg-white/30"
							>
								<Icon icon={RefreshCw} className="w-4 h-4 text-white" />
								<Text className="text-white text-sm font-medium">Try Again</Text>
							</Pressable>
						</View>
					) : (
						<View className="items-center bg-black/70 px-6 py-4 rounded-2xl mb-4">
							<Text className="text-white text-lg font-semibold mb-1">Scan QR Code</Text>
							<Text className="text-white/70 text-sm text-center">
								Open Maestro desktop → Settings → Mobile Devices → Pair New Device
							</Text>
						</View>
					)}
					<Pressable
						onPress={handleOpenManual}
						className="flex-row items-center gap-2 bg-white/15 px-5 py-3 rounded-full active:bg-white/25 mb-6"
						hitSlop={12}
					>
						<Icon icon={KeyboardIcon} className="w-4 h-4 text-white" />
						<Text className="text-white text-sm font-medium">Enter pairing details manually</Text>
					</Pressable>
				</View>
			</View>

			{renderManualModal({
				open: manualOpen,
				mode: manualMode,
				url: manualUrl,
				host: manualHost,
				port: manualPort,
				code: manualCode,
				error: manualError,
				isProcessing,
				onModeChange: setManualMode,
				onUrlChange: setManualUrl,
				onHostChange: setManualHost,
				onPortChange: setManualPort,
				onCodeChange: setManualCode,
				onSubmit: handleSubmitManual,
				onClose: handleCloseManual,
			})}
		</View>
	);
}

/** Props for the manual-entry modal renderer */
interface ManualModalProps {
	open: boolean;
	mode: ManualMode;
	url: string;
	host: string;
	port: string;
	code: string;
	error: string | null;
	isProcessing: boolean;
	onModeChange: (mode: ManualMode) => void;
	onUrlChange: (value: string) => void;
	onHostChange: (value: string) => void;
	onPortChange: (value: string) => void;
	onCodeChange: (value: string) => void;
	onSubmit: () => void;
	onClose: () => void;
}

/**
 * Renders the manual pairing modal. Extracted to a function so both the
 * camera-denied state and the live-scanner state can reuse the same UI.
 */
function renderManualModal(props: ManualModalProps) {
	const {
		open,
		mode,
		url,
		host,
		port,
		code,
		error,
		isProcessing,
		onModeChange,
		onUrlChange,
		onHostChange,
		onPortChange,
		onCodeChange,
		onSubmit,
		onClose,
	} = props;

	return (
		<Modal
			visible={open}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : undefined}
				className="flex-1 bg-background"
			>
				{/* Header */}
				<View className="flex-row items-center justify-between px-5 pt-4 pb-3 border-b border-border">
					<Text className="text-[17px] font-semibold text-foreground">Manual Pairing</Text>
					<Pressable
						onPress={onClose}
						className="w-9 h-9 rounded-full items-center justify-center active:bg-muted"
					>
						<Icon icon={X} className="w-5 h-5 text-foreground" />
					</Pressable>
				</View>

				<ScrollView
					className="flex-1"
					contentContainerClassName="px-5 pb-10"
					keyboardDismissMode="interactive"
					keyboardShouldPersistTaps="handled"
				>
					<Text className="text-[13px] text-muted-foreground mt-4 leading-relaxed">
						{
							'No camera (e.g. iOS Simulator)? Paste either the pairing URL (maestro://pair...) or the desktop web link (http://host:port/<token>). The Fields tab below covers the pairing-code flow.'
						}
					</Text>

					{/* Mode toggle */}
					<View className="flex-row bg-muted rounded-xl p-1 mt-5">
						<Pressable
							onPress={() => onModeChange('url')}
							className={`flex-1 flex-row items-center justify-center gap-2 py-2 rounded-lg ${mode === 'url' ? 'bg-background' : ''}`}
						>
							<Icon
								icon={Link2}
								className={`w-4 h-4 ${mode === 'url' ? 'text-foreground' : 'text-muted-foreground'}`}
							/>
							<Text
								className={`text-[14px] font-medium ${mode === 'url' ? 'text-foreground' : 'text-muted-foreground'}`}
							>
								Paste URL
							</Text>
						</Pressable>
						<Pressable
							onPress={() => onModeChange('fields')}
							className={`flex-1 flex-row items-center justify-center gap-2 py-2 rounded-lg ${mode === 'fields' ? 'bg-background' : ''}`}
						>
							<Icon
								icon={KeyboardIcon}
								className={`w-4 h-4 ${mode === 'fields' ? 'text-foreground' : 'text-muted-foreground'}`}
							/>
							<Text
								className={`text-[14px] font-medium ${mode === 'fields' ? 'text-foreground' : 'text-muted-foreground'}`}
							>
								Fields
							</Text>
						</Pressable>
					</View>

					{mode === 'url' ? (
						<>
							<Text className="text-[13px] font-medium text-muted-foreground mt-5 mb-2">
								Pairing URL
							</Text>
							<TextInput
								value={url}
								onChangeText={onUrlChange}
								placeholder={
									'maestro://pair?host=...&port=...&code=...\nor http://192.168.x.x:PORT/<token>'
								}
								autoCapitalize="none"
								autoCorrect={false}
								spellCheck={false}
								keyboardType="url"
								multiline
								className="bg-muted rounded-xl px-4 py-3 text-[15px] text-foreground border-continuous min-h-[88px]"
								style={{ textAlignVertical: 'top' }}
								placeholderTextColor="#999"
							/>
						</>
					) : (
						<>
							<Text className="text-[13px] font-medium text-muted-foreground mt-5 mb-2">Host</Text>
							<TextInput
								value={host}
								onChangeText={onHostChange}
								placeholder="192.168.1.100"
								autoCapitalize="none"
								autoCorrect={false}
								spellCheck={false}
								keyboardType="url"
								className="bg-muted rounded-xl px-4 py-3 text-[17px] text-foreground border-continuous"
								placeholderTextColor="#999"
							/>

							<Text className="text-[13px] font-medium text-muted-foreground mt-4 mb-2">Port</Text>
							<TextInput
								value={port}
								onChangeText={onPortChange}
								placeholder="17170"
								keyboardType="number-pad"
								className="bg-muted rounded-xl px-4 py-3 text-[17px] text-foreground border-continuous"
								placeholderTextColor="#999"
							/>

							<Text className="text-[13px] font-medium text-muted-foreground mt-4 mb-2">
								Pairing Code
							</Text>
							<TextInput
								value={code}
								onChangeText={onCodeChange}
								placeholder="ABC123"
								autoCapitalize="characters"
								autoCorrect={false}
								spellCheck={false}
								className="bg-muted rounded-xl px-4 py-3 text-[17px] text-foreground border-continuous tracking-widest"
								placeholderTextColor="#999"
							/>
						</>
					)}

					{error ? (
						<Text className="text-red-500 text-[13px] mt-4 leading-relaxed">{error}</Text>
					) : null}

					<Pressable
						onPress={onSubmit}
						disabled={isProcessing}
						className={`rounded-xl mt-6 py-3.5 items-center border-continuous ${isProcessing ? 'bg-muted opacity-60' : 'bg-foreground active:opacity-80'}`}
					>
						{isProcessing ? (
							<View className="flex-row items-center gap-2">
								<ActivityIndicator size="small" color="#888" />
								<Text className="text-[17px] font-semibold text-muted-foreground">Pairing...</Text>
							</View>
						) : (
							<Text className="text-[17px] font-semibold text-background">Pair Device</Text>
						)}
					</Pressable>
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	);
}
