// Rollback command - the CLI half of Check for Updates -> Roll Back.
//
// `maestro-cli rollback` lists the earlier releases this platform can install.
// `maestro-cli rollback <version>` downloads one in the running app, through
// the same function the modal's Roll Back button calls, so an open modal shows
// the progress. The download installs the next time Maestro restarts or quits,
// as a downloaded update does; the restart itself stays in the modal, which
// owns the busy-agent warning.

import { withMaestroClient } from '../services/maestro-client';
import { failCommand } from '../services/session-command';
import { releaseDisplayName, type RollbackRelease } from '../../shared/updateRollback';

interface RollbackOptions {
	prerelease?: boolean;
	json?: boolean;
}

/** A rollback download is a full installer, so it gets far longer than a normal command. */
const ROLLBACK_DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

interface ListResult {
	success: boolean;
	error?: string;
	currentVersion?: string;
	releases?: RollbackRelease[];
}

interface DownloadResult {
	success: boolean;
	error?: string;
	version?: string;
	currentVersion?: string;
}

async function listTargets(options: RollbackOptions): Promise<void> {
	let result: ListResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<ListResult>(
				{
					type: 'list_rollback_targets',
					...(options.prerelease !== undefined ? { includePrerelease: options.prerelease } : {}),
				},
				'list_rollback_targets_result'
			)
		);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	if (!result.success) failCommand(result.error || 'Listing earlier releases failed', options.json);

	const releases = result.releases ?? [];
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				currentVersion: result.currentVersion ?? null,
				releases: releases.map((r) => ({
					tag: r.tag_name,
					name: releaseDisplayName(r.name, r.tag_name),
					publishedAt: r.published_at,
					prerelease: r.prerelease,
					url: r.html_url,
				})),
			})
		);
		return;
	}
	if (releases.length === 0) {
		console.log(`No earlier releases can be installed over v${result.currentVersion ?? '?'}.`);
		return;
	}
	console.log(`Running v${result.currentVersion}. Earlier releases you can roll back to:`);
	for (const r of releases) {
		const name = releaseDisplayName(r.name, r.tag_name);
		const day = r.published_at ? r.published_at.slice(0, 10) : '';
		console.log(`  ${r.tag_name.padEnd(14)} ${day}${name ? `  ${name}` : ''}`);
	}
	console.log('\nRoll back with: maestro-cli rollback <version>');
}

async function downloadTarget(version: string, options: RollbackOptions): Promise<void> {
	let result: DownloadResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<DownloadResult>(
				{ type: 'rollback_update', version },
				'rollback_update_result',
				ROLLBACK_DOWNLOAD_TIMEOUT_MS
			)
		);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	if (!result.success) failCommand(result.error || 'Rollback download failed', options.json);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				downloaded: result.version ?? version,
				currentVersion: result.currentVersion ?? null,
				installsOn: 'restart-or-quit',
			})
		);
		return;
	}
	console.log(
		`Downloaded v${result.version ?? version}. It installs the next time Maestro restarts or quits ` +
			`(Check for Updates or Rollback -> Restart to Roll Back).`
	);
}

export async function rollback(
	version: string | undefined,
	options: RollbackOptions
): Promise<void> {
	if (version && version.trim()) {
		await downloadTarget(version.trim(), options);
		return;
	}
	await listTargets(options);
}
