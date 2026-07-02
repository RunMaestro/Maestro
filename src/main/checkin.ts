/**
 * Anonymous check-in ping for DAU/MAU measurement.
 *
 * Alongside the GitHub update check, we send a lightweight, best-effort POST to
 * runmaestro.ai so we can count distinct installs per day / per 30 days and see
 * which themes and platforms are in use. The payload is intentionally minimal - a
 * stable, randomly-generated install id, the app version, the active theme id,
 * and the OS platform + CPU arch. Nothing here fingerprints the machine or the
 * user: the id is a UUID we generate once and persist in userData, not a hardware
 * identifier, and platform/arch are coarse build-target buckets.
 *
 * This is gated by the same "check for updates" preference as the update check
 * itself (see the renderer's startup effect). If the user opted out, this is
 * never called.
 *
 * Everything here is fire-and-forget: it must never block the update check and
 * any failure (offline, 5xx, timeout, malformed id file) is swallowed silently.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { App } from 'electron';
import { atomicWriteJson } from './utils/atomic-json-store';
import { logger } from './utils/logger';

const CHECKIN_ENDPOINT = 'https://runmaestro.ai/api/telemetry/checkin';
const CHECKIN_ID_FILE = 'checkin-id.json';
const CHECKIN_TIMEOUT_MS = 5000;

interface CheckinIdFile {
	installId: string;
}

// Cache the resolved id (and the resolution itself) so we only touch disk once
// per process, and concurrent callers share a single read/create.
let installIdPromise: Promise<string> | null = null;

function isValidUuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}

/**
 * Resolve the anonymous install id, generating and persisting a fresh UUID the
 * first time. The id lives in `userData/checkin-id.json`. If the file is missing
 * or corrupt we mint a new one - this is analytics, not a source of truth, so a
 * fresh id on a wiped profile is fine.
 */
async function getOrCreateInstallId(app: App): Promise<string> {
	if (installIdPromise) return installIdPromise;

	installIdPromise = (async () => {
		const filePath = path.join(app.getPath('userData'), CHECKIN_ID_FILE);
		try {
			const raw = await fs.readFile(filePath, 'utf-8');
			const parsed = JSON.parse(raw) as CheckinIdFile;
			if (isValidUuid(parsed?.installId)) {
				return parsed.installId;
			}
		} catch {
			// Missing or unreadable file - fall through to create a new id.
		}

		const installId = randomUUID();
		await atomicWriteJson(filePath, { installId } satisfies CheckinIdFile);
		return installId;
	})();

	return installIdPromise;
}

/**
 * Fire the check-in ping. Best-effort: resolves once the request settles (or the
 * timeout fires) but never throws, so callers can `void sendCheckin(app)` and
 * move on. The caller is responsible for the opt-out gate.
 *
 * `theme` is the active theme id (e.g. `dracula`), resolved by the caller from
 * the settings store. It is optional and best-effort: a missing/empty value is
 * simply omitted from the payload rather than sent as null, and never blocks the
 * ping. `platform`/`arch` come straight from `process` and are always included.
 */
export async function sendCheckin(app: App, theme?: string | null): Promise<void> {
	try {
		const guid = await getOrCreateInstallId(app);
		const version = app.getVersion();

		const body: Record<string, unknown> = {
			guid,
			version,
			platform: process.platform,
			arch: process.arch,
		};
		if (typeof theme === 'string' && theme.length > 0) {
			body.theme = theme;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CHECKIN_TIMEOUT_MS);
		try {
			await fetch(CHECKIN_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
	} catch (err) {
		// Swallow everything - offline, timeout, 5xx, DNS, etc. Never surfaced.
		logger.debug(
			`Check-in ping failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			'Checkin'
		);
	}
}
