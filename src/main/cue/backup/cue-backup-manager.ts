/**
 * Cue backup manager - owns creation, listing, inspection, and restore of
 * Cue config snapshots. A snapshot bundles every distinct workspace's
 * `.maestro/cue.yaml` plus its `.maestro/prompts/*.md` into a single zip
 * under `userData/cue-backups/`. A `manifest.json` at the zip root records
 * the source cwd for each workspace so restore can map files back.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { CUE_CONFIG_PATH, CUE_PROMPTS_DIR, MAESTRO_DIR } from '../../../shared/maestro-paths';
import {
	CUE_BACKUP_MANIFEST_VERSION,
	cueBackupStatusKey,
	type CueBackupAgentRef,
	type CueBackupDiffStatusMap,
	type CueBackupFileEntry,
	type CueBackupManifest,
	type CueBackupRestoreResult,
	type CueBackupSummary,
	type CueBackupWorkspaceEntry,
} from '../../../shared/cue-backup-types';
import type { StoredSession } from '../../stores/types';
import { resolveCueConfigPath } from '../config/cue-config-repository';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

const LOG_CONTEXT = '[CueBackup]';
const BACKUP_DIR_NAME = 'cue-backups';
const MANIFEST_NAME = 'manifest.json';

function backupsDir(): string {
	const dir = path.join(app.getPath('userData'), BACKUP_DIR_NAME);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function workspaceIdFor(cwd: string): string {
	return 'ws_' + crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

function timestampForFilename(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/**
 * Group sessions by their workspace cwd. A single workspace may be shared by
 * multiple agents - the backup deduplicates so each cwd is captured once.
 */
function groupSessionsByWorkspace(
	sessions: ReadonlyArray<StoredSession>
): Map<string, { cwd: string; agents: CueBackupAgentRef[] }> {
	const byCwd = new Map<string, { cwd: string; agents: CueBackupAgentRef[] }>();
	for (const s of sessions) {
		const cwd = s.projectRoot || s.cwd;
		if (!cwd) continue;
		const existing = byCwd.get(cwd);
		const ref: CueBackupAgentRef = {
			id: s.id,
			name: s.name,
			toolType: s.toolType,
		};
		if (existing) {
			existing.agents.push(ref);
		} else {
			byCwd.set(cwd, { cwd, agents: [ref] });
		}
	}
	return byCwd;
}

/**
 * Collect the relative paths under `.maestro/` that are eligible for backup
 * for a given workspace. Returns absolute file paths paired with their
 * in-zip relative paths.
 */
function collectWorkspaceFiles(
	cwd: string
): Array<{ absolutePath: string; relativePath: string; size: number }> {
	const out: Array<{ absolutePath: string; relativePath: string; size: number }> = [];

	const cuePath = resolveCueConfigPath(cwd);
	if (cuePath) {
		try {
			const stat = fs.statSync(cuePath);
			out.push({
				absolutePath: cuePath,
				// Always normalize to canonical name inside the zip even if the
				// live file is the legacy `maestro-cue.yaml` - restore will use
				// the canonical path.
				relativePath: 'cue.yaml',
				size: stat.size,
			});
		} catch (err) {
			captureException(err, { extra: { context: 'collectWorkspaceFiles', cwd, cuePath } });
		}
	}

	const promptsDir = path.join(cwd, CUE_PROMPTS_DIR);
	if (fs.existsSync(promptsDir)) {
		try {
			const entries = fs.readdirSync(promptsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (!entry.name.endsWith('.md')) continue;
				const abs = path.join(promptsDir, entry.name);
				const stat = fs.statSync(abs);
				out.push({
					absolutePath: abs,
					relativePath: `prompts/${entry.name}`,
					size: stat.size,
				});
			}
		} catch (err) {
			captureException(err, { extra: { context: 'collectWorkspaceFiles.prompts', cwd } });
		}
	}

	return out;
}

/**
 * Create a new backup containing every workspace's Cue config and prompts.
 * Workspaces with no Cue files at all are omitted from the zip. If no
 * workspace has any Cue files, the backup is still created but its manifest
 * will list zero workspaces - the UI surfaces this so the user knows.
 */
export async function createCueBackup(
	sessions: ReadonlyArray<StoredSession>
): Promise<CueBackupSummary> {
	const grouped = groupSessionsByWorkspace(sessions);

	const workspaces: CueBackupWorkspaceEntry[] = [];
	const filesToZip: Array<{
		workspaceId: string;
		absolutePath: string;
		relativePath: string;
	}> = [];

	for (const { cwd, agents } of grouped.values()) {
		const files = collectWorkspaceFiles(cwd);
		if (files.length === 0) continue;

		const id = workspaceIdFor(cwd);
		const fileEntries: CueBackupFileEntry[] = files.map((f) => ({
			relativePath: f.relativePath,
			size: f.size,
		}));
		workspaces.push({ id, cwd, agents, files: fileEntries });
		for (const f of files) {
			filesToZip.push({
				workspaceId: id,
				absolutePath: f.absolutePath,
				relativePath: f.relativePath,
			});
		}
	}

	const manifest: CueBackupManifest = {
		version: CUE_BACKUP_MANIFEST_VERSION,
		createdAt: new Date().toISOString(),
		appVersion: app.getVersion(),
		workspaces,
	};

	const fileName = `cue-backup-${timestampForFilename()}.zip`;
	const filePath = path.join(backupsDir(), fileName);

	await new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(filePath);
		const archive = archiver('zip', { zlib: { level: 9 } });
		output.on('close', () => resolve());
		output.on('error', reject);
		archive.on('error', reject);
		archive.pipe(output);

		archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME });
		for (const f of filesToZip) {
			archive.file(f.absolutePath, {
				name: `workspaces/${f.workspaceId}/${f.relativePath}`,
			});
		}
		archive.finalize().catch(reject);
	});

	const stat = fs.statSync(filePath);
	logger.info('createCueBackup success', LOG_CONTEXT, {
		filePath,
		size: stat.size,
		workspaces: manifest.workspaces.length,
	});

	return {
		filePath,
		fileName,
		size: stat.size,
		manifest,
	};
}

function readManifestFromZip(zip: AdmZip): CueBackupManifest | null {
	const entry = zip.getEntry(MANIFEST_NAME);
	if (!entry) return null;
	try {
		const raw = entry.getData().toString('utf-8');
		const parsed = JSON.parse(raw) as CueBackupManifest;
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) {
			return null;
		}
		return parsed;
	} catch (err) {
		captureException(err, { extra: { context: 'readManifestFromZip' } });
		return null;
	}
}

/** List every backup zip in the user-data backup directory, newest first. */
export function listCueBackups(): CueBackupSummary[] {
	const dir = backupsDir();
	const entries = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith('.zip'));

	const summaries: CueBackupSummary[] = [];
	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		try {
			const stat = fs.statSync(filePath);
			const zip = new AdmZip(filePath);
			const manifest = readManifestFromZip(zip);
			if (!manifest) continue;
			summaries.push({
				filePath,
				fileName: entry.name,
				size: stat.size,
				manifest,
			});
		} catch (err) {
			captureException(err, { extra: { context: 'listCueBackups', filePath } });
		}
	}

	summaries.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
	return summaries;
}

function assertBackupPath(filePath: string): void {
	const dir = backupsDir();
	const resolved = path.resolve(filePath);
	if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
		throw new Error('Backup path must be inside the cue-backups directory');
	}
}

/** Read the manifest of a specific backup zip. */
export function inspectCueBackup(filePath: string): CueBackupManifest {
	assertBackupPath(filePath);
	const zip = new AdmZip(filePath);
	const manifest = readManifestFromZip(zip);
	if (!manifest) {
		throw new Error('Backup is missing or has an invalid manifest');
	}
	return manifest;
}

/**
 * Read a single file's contents from inside a backup zip. Returns null when
 * the file does not exist in the zip (so callers can distinguish "no entry"
 * from "empty file").
 */
export function readCueBackupFile(
	filePath: string,
	workspaceId: string,
	relativePath: string
): string | null {
	assertBackupPath(filePath);
	const zip = new AdmZip(filePath);
	const entry = zip.getEntry(`workspaces/${workspaceId}/${relativePath}`);
	if (!entry) return null;
	return entry.getData().toString('utf-8');
}

/**
 * Read the live counterpart of a backup file from disk. Returns null when
 * the live file does not exist (e.g., the workspace was deleted, or the
 * prompt was removed since the backup was taken).
 */
export function readLiveCueFile(cwd: string, relativePath: string): string | null {
	const abs = liveAbsolutePath(cwd, relativePath);
	if (!fs.existsSync(abs)) return null;
	return fs.readFileSync(abs, 'utf-8');
}

function liveAbsolutePath(cwd: string, relativePath: string): string {
	if (relativePath === 'cue.yaml') {
		return path.join(cwd, CUE_CONFIG_PATH);
	}
	if (relativePath.startsWith('prompts/')) {
		return path.join(cwd, MAESTRO_DIR, relativePath);
	}
	throw new Error(`Unsupported backup relative path: ${relativePath}`);
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write the contents of a single backup file to disk at its original
 * location. Overwrites any existing file. Throws if the workspace cwd
 * does not exist on disk anymore (caller should handle gracefully).
 */
export function restoreCueBackupFile(
	filePath: string,
	workspaceId: string,
	relativePath: string
): void {
	assertBackupPath(filePath);
	const manifest = inspectCueBackup(filePath);
	const ws = manifest.workspaces.find((w) => w.id === workspaceId);
	if (!ws) {
		throw new Error(`Workspace ${workspaceId} not found in backup`);
	}
	if (!fs.existsSync(ws.cwd)) {
		throw new Error(`Workspace path no longer exists: ${ws.cwd}`);
	}
	const contents = readCueBackupFile(filePath, workspaceId, relativePath);
	if (contents === null) {
		throw new Error(`File not found in backup: ${relativePath}`);
	}
	const abs = liveAbsolutePath(ws.cwd, relativePath);
	ensureDir(path.dirname(abs));
	fs.writeFileSync(abs, contents, 'utf-8');
	logger.info('restoreCueBackupFile success', LOG_CONTEXT, {
		workspaceId,
		relativePath,
		cwd: ws.cwd,
	});
}

/**
 * Restore every file in a backup to its original workspace path. Files in
 * a workspace whose cwd no longer exists on disk are skipped; the result
 * lists each skip with a reason so the UI can surface them. This is
 * additive - it does NOT delete files that exist live but were not in the
 * backup, since destructive deletion is much harder to recover from than
 * an extra orphaned prompt.
 */
export function restoreCueBackupAll(filePath: string): CueBackupRestoreResult {
	assertBackupPath(filePath);
	const manifest = inspectCueBackup(filePath);
	const result: CueBackupRestoreResult = { written: 0, skipped: [] };

	for (const ws of manifest.workspaces) {
		if (!fs.existsSync(ws.cwd)) {
			for (const f of ws.files) {
				result.skipped.push({
					workspaceId: ws.id,
					relativePath: f.relativePath,
					reason: 'Workspace path no longer exists',
				});
			}
			continue;
		}
		for (const f of ws.files) {
			try {
				const contents = readCueBackupFile(filePath, ws.id, f.relativePath);
				if (contents === null) {
					result.skipped.push({
						workspaceId: ws.id,
						relativePath: f.relativePath,
						reason: 'File missing from backup zip',
					});
					continue;
				}
				const abs = liveAbsolutePath(ws.cwd, f.relativePath);
				ensureDir(path.dirname(abs));
				fs.writeFileSync(abs, contents, 'utf-8');
				result.written += 1;
			} catch (err) {
				captureException(err, {
					extra: {
						context: 'restoreCueBackupAll',
						workspaceId: ws.id,
						relativePath: f.relativePath,
					},
				});
				result.skipped.push({
					workspaceId: ws.id,
					relativePath: f.relativePath,
					reason: err instanceof Error ? err.message : 'Unknown error',
				});
			}
		}
	}

	logger.info('restoreCueBackupAll success', LOG_CONTEXT, {
		filePath,
		written: result.written,
		skipped: result.skipped.length,
	});
	return result;
}

/**
 * Compute per-file diff status for every entry in a backup. Used by the
 * Backup tab to suppress Diff/Restore actions on files that already match
 * the live state, so users only see actionable rows.
 */
export function getCueBackupDiffStatus(filePath: string): CueBackupDiffStatusMap {
	assertBackupPath(filePath);
	const zip = new AdmZip(filePath);
	const manifest = readManifestFromZip(zip);
	if (!manifest) {
		throw new Error('Backup is missing or has an invalid manifest');
	}

	const result: CueBackupDiffStatusMap = {};
	for (const ws of manifest.workspaces) {
		for (const f of ws.files) {
			const key = cueBackupStatusKey(ws.id, f.relativePath);
			try {
				const entry = zip.getEntry(`workspaces/${ws.id}/${f.relativePath}`);
				if (!entry) {
					// No content in zip - treat as missing so the user can still
					// notice; Diff/Restore will both fail loudly with a clear error.
					result[key] = 'missing-live';
					continue;
				}
				const liveAbs = liveAbsolutePath(ws.cwd, f.relativePath);
				if (!fs.existsSync(liveAbs)) {
					result[key] = 'missing-live';
					continue;
				}
				const liveStat = fs.statSync(liveAbs);
				if (liveStat.size !== entry.header.size) {
					result[key] = 'changed';
					continue;
				}
				// Sizes match - compare content. For Cue files this is KB-scale
				// so a direct equality check is cheap and avoids hash overhead.
				const backupContent = entry.getData().toString('utf-8');
				const liveContent = fs.readFileSync(liveAbs, 'utf-8');
				result[key] = backupContent === liveContent ? 'unchanged' : 'changed';
			} catch (err) {
				// On any read failure, assume changed so the user can still act.
				captureException(err, {
					extra: {
						context: 'getCueBackupDiffStatus',
						workspaceId: ws.id,
						relativePath: f.relativePath,
					},
				});
				result[key] = 'changed';
			}
		}
	}
	return result;
}

/** Delete a backup zip from the user-data backup directory. */
export function deleteCueBackup(filePath: string): void {
	assertBackupPath(filePath);
	if (!fs.existsSync(filePath)) return;
	fs.unlinkSync(filePath);
	logger.info('deleteCueBackup success', LOG_CONTEXT, { filePath });
}
