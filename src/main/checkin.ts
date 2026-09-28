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
import { fetchWithTimeout } from './utils/fetchWithTimeout';

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
 *
 * Unpackaged runs never ping. `app.getVersion()` reads the version out of the
 * application's package.json, and an unpackaged launch may have none in scope -
 * Electron then returns the version of the Electron binary itself, which lands
 * in the analytics as a bogus app version. The e2e suite launches
 * `dist/main/index.js` directly (a file, so no package.json), and gives each run
 * a throwaway data dir, so every run also minted a fresh install id. That put
 * hundreds of phantom one-shot "installs" on Electron version numbers into the
 * dataset. Developer machines and CI are not the install base; skip them.
 */
export async function sendCheckin(app: App, theme?: string | null): Promise<void> {
	if (!app.isPackaged) return;

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

		const response = await fetchWithTimeout(
			CHECKIN_ENDPOINT,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
			CHECKIN_TIMEOUT_MS
		);
		// A rejected ping used to be indistinguishable from a delivered one:
		// the response was never inspected, so a 500 or a validation 400 read
		// as success. Warn on it - if the endpoint starts turning check-ins
		// away, the install-base numbers quietly flatline and nothing says so.
		if (!response.ok) {
			logger.warn(
				`Check-in ping rejected: HTTP ${response.status} ${response.statusText}`,
				'Checkin'
			);
		}
	} catch (err) {
		// Transport-level failure - offline, DNS, timeout. Expected and routine
		// on a laptop, so it stays at debug. A reachable endpoint that refuses
		// the ping is the interesting case, and that is warned about above.
		logger.debug(
			`Check-in ping failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			'Checkin'
		);
	}
}
