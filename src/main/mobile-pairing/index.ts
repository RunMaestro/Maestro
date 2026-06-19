/**
 * Mobile Pairing Module
 *
 * Implements QR-based device pairing per decision 15B:
 * - Short-lived pairing codes (6-char base32, 5-minute expiry)
 * - Long-lived per-device hashed tokens stored in mobile-pairings.json
 * - Token validation for WebSocket authentication
 *
 * Flow:
 * 1. Desktop generates pairing code via generatePairingCode()
 * 2. Mobile scans QR, posts to /api/mobile-pairing/redeem
 * 3. redeemPairingCode() validates code, persists hashed token, returns plaintext token
 * 4. Mobile stores token in SecureStore
 * 5. On subsequent connections, validateMobileToken() authenticates via hashed token
 */

import crypto from 'crypto';
import path from 'path';
import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'fs/promises';

// Types

export interface PendingPairing {
	code: string;
	pendingToken: string;
	expiresAt: number;
	used: boolean;
}

export interface PairedDevice {
	id: string;
	deviceName: string;
	tokenHash: string;
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
}

export interface GeneratedCode {
	code: string;
	expiresAt: number;
	pendingToken: string;
}

// Constants

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_LENGTH = 6;
const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const PAIRINGS_FILENAME = 'mobile-pairings.json';

// In-memory store for pending pairing codes
const pendingPairings = new Map<string, PendingPairing>();

// Helpers

function generateBase32Code(length: number): string {
	let result = '';
	const bytes = crypto.randomBytes(length);
	for (let i = 0; i < length; i++) {
		result += BASE32_CHARS[bytes[i] % 32];
	}
	return result;
}

function generate256BitToken(): string {
	return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

function generateUUID(): string {
	return crypto.randomUUID();
}

function getPairingsFilePath(): string {
	return path.join(app.getPath('userData'), PAIRINGS_FILENAME);
}

async function readPairings(): Promise<PairedDevice[]> {
	try {
		const filePath = getPairingsFilePath();
		const content = await readFile(filePath, 'utf-8');
		const data = JSON.parse(content);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function writePairings(devices: PairedDevice[]): Promise<void> {
	const filePath = getPairingsFilePath();
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	await writeFile(filePath, JSON.stringify(devices, null, '\t'), 'utf-8');
}

// Cleanup expired pending codes periodically
function cleanupExpiredCodes(): void {
	const now = Date.now();
	pendingPairings.forEach((pairing, code) => {
		if (pairing.expiresAt < now || pairing.used) {
			pendingPairings.delete(code);
		}
	});
}

// Run cleanup every minute
setInterval(cleanupExpiredCodes, 60 * 1000);

// Public API

/** Generate a new pairing code for mobile device enrollment. */
export function generatePairingCode(): GeneratedCode {
	// Clean up old codes first
	cleanupExpiredCodes();

	const code = generateBase32Code(CODE_LENGTH);
	const pendingToken = generate256BitToken();
	const expiresAt = Date.now() + CODE_EXPIRY_MS;

	pendingPairings.set(code, {
		code,
		pendingToken,
		expiresAt,
		used: false,
	});

	return { code, expiresAt, pendingToken };
}

/** Redeem a pairing code. Validates, marks used, persists device, returns token. */
export async function redeemPairingCode(
	code: string,
	deviceName: string
): Promise<{ token: string; deviceId: string } | null> {
	const normalizedCode = code.toUpperCase().trim();
	const pending = pendingPairings.get(normalizedCode);

	// Validate code exists, not expired, not used
	if (!pending) {
		return null;
	}

	if (pending.expiresAt < Date.now()) {
		pendingPairings.delete(normalizedCode);
		return null;
	}

	if (pending.used) {
		return null;
	}

	// Mark as used
	pending.used = true;

	// Create device record
	const now = Date.now();
	const device: PairedDevice = {
		id: generateUUID(),
		deviceName: deviceName || 'Unknown Device',
		tokenHash: hashToken(pending.pendingToken),
		createdAt: now,
		lastUsedAt: now,
		expiresAt: now + TOKEN_EXPIRY_MS,
	};

	// Read-modify-write pairings file
	const devices = await readPairings();
	devices.push(device);
	await writePairings(devices);

	// Clean up the pending code
	pendingPairings.delete(normalizedCode);

	return { token: pending.pendingToken, deviceId: device.id };
}

/** Validate a mobile token. Returns device record if valid, null otherwise. */
export async function validateMobileToken(token: string): Promise<PairedDevice | null> {
	if (!token || typeof token !== 'string') {
		return null;
	}

	const tokenHash = hashToken(token);
	const devices = await readPairings();
	const now = Date.now();

	const device = devices.find((d) => d.tokenHash === tokenHash && d.expiresAt > now);

	return device || null;
}

/** Update lastUsedAt timestamp when a device successfully authenticates. */
export async function updateDeviceLastUsed(deviceId: string): Promise<void> {
	const devices = await readPairings();
	const device = devices.find((d) => d.id === deviceId);

	if (device) {
		device.lastUsedAt = Date.now();
		await writePairings(devices);
	}
}

/** List all paired devices (without exposing token hashes). */
export async function listPairedDevices(): Promise<Omit<PairedDevice, 'tokenHash'>[]> {
	const devices = await readPairings();
	const now = Date.now();

	// Filter expired devices and omit tokenHash
	return devices.filter((d) => d.expiresAt > now).map(({ tokenHash: _, ...rest }) => rest);
}

/** Revoke a paired device by ID. */
export async function revokeDevice(deviceId: string): Promise<boolean> {
	const devices = await readPairings();
	const initialLength = devices.length;
	const filtered = devices.filter((d) => d.id !== deviceId);

	if (filtered.length < initialLength) {
		await writePairings(filtered);
		return true;
	}

	return false;
}
