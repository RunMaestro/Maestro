/**
 * Cue bundle export, inspection and import for the RUNNING desktop app.
 *
 * The Cue modal's Bundles tab reaches these through IPC
 * (`ipc/handlers/cue-bundle.ts`), and `maestro-cli bundle export|import`
 * reaches the same functions through the WebSocket bridge while the app runs,
 * so the two paths cannot drift. With the app closed the CLI calls the
 * exporter and importer directly.
 *
 * What differs from a closed-app import is where agents live: the app holds
 * them in memory and would overwrite `maestro-sessions.json`, so the agents
 * come from {@link CueBundleAppContext.getSessions} and new or updated ones
 * go back through {@link CueBundleAppContext.applyAgents}. See
 * `CueBundleImportHost` in the importer.
 *
 * Electron-free: the app's stores and paths are passed in.
 *
 * Every function returns an outcome instead of throwing, so an error's code
 * and details (a conflict list, say) survive IPC and the WebSocket, which
 * keep only an Error's message.
 */

import * as path from 'path';
import type { SessionInfo } from '../shared/types';
import type { CueBundleClaudeAssetSelection, CueBundleManifest } from '../shared/cue-bundle-types';
import { CUE_BUNDLE_MANIFEST_PATH, CUE_BUNDLE_README_PATH } from '../shared/cue-bundle-types';
import { exportCueBundle } from './cue/bundle/cue-bundle-exporter';
import {
	CueBundleImportError,
	importCueBundle,
	planCueBundleImport,
	type CueBundleImportOptions,
	type CueBundleImportPlan,
} from './cue/bundle/cue-bundle-importer';
import {
	readCueBundleArchive,
	validateCueBundleArchive,
	type CueBundleValidationIssue,
} from './cue/bundle/cue-bundle-validator';

/** The running app, as the bundle functions need it. */
export interface CueBundleAppContext {
	/** The app's data directory (`playbooks/`, pipeline layout, out-of-workspace Auto Run). */
	dataDir: string;
	/** Folder of `maestro-agent-configs.json`. */
	agentConfigsDir: string;
	/** The app's version, recorded in exports and checked against a bundle's minimum. */
	version: string;
	/** The app's agents right now. */
	getSessions(): SessionInfo[];
	/** Write pending agent changes to disk before an export reads them. */
	flushSessions?(): void;
	/** Add and update agents in the app (the renderer owns them). */
	applyAgents(change: { created: SessionInfo[]; updated: SessionInfo[] }): Promise<void>;
}

/** A refusal, as data. */
export interface CueBundleFailure {
	ok: false;
	/** Importer error code, or `EXPORT_FAILED` / `BUNDLE_UNREADABLE` / `INVALID_OPTIONS`. */
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface CueBundleExportRequest {
	/** Pipeline name or id. Exclusive with `agentId`. */
	pipeline?: string;
	agentId?: string;
	/** Absolute path of the zip to write. */
	outputPath: string;
	claudeAssets?: CueBundleClaudeAssetSelection;
	allowInlineSecrets?: boolean;
	/** Pin `manifest.createdAt` (ISO-8601). */
	createdAt?: string;
}

export type CueBundleExportOutcome =
	| { ok: true; outputPath: string; size: number; sha256: string; manifest: CueBundleManifest }
	| CueBundleFailure;

export type CueBundleInspectOutcome =
	| {
			ok: true;
			bundlePath: string;
			/** Absent when the zip has no readable manifest; `errors` says why. */
			manifest?: CueBundleManifest;
			readme?: string;
			valid: boolean;
			errors: CueBundleValidationIssue[];
			warnings: CueBundleValidationIssue[];
	  }
	| CueBundleFailure;

export interface CueBundleImportRequest {
	/** Absolute path of the bundle zip. */
	bundlePath: string;
	/** Bundle workspace key -> absolute local folder. */
	workspaces: Record<string, string>;
	force?: boolean;
	refuseShellCommands?: boolean;
	/** Plan only. */
	dryRun?: boolean;
}

export type CueBundleImportOutcome =
	| { ok: true; plan: CueBundleImportPlan; applied: boolean }
	| CueBundleFailure;

function failure(error: unknown, fallbackCode: string): CueBundleFailure {
	if (error instanceof CueBundleImportError) {
		return { ok: false, code: error.code, message: error.message, details: error.details };
	}
	return {
		ok: false,
		code: fallbackCode,
		message: error instanceof Error ? error.message : String(error),
	};
}

function requireAbsolute(value: string | undefined, what: string): CueBundleFailure | undefined {
	if (!value || !path.isAbsolute(value)) {
		return { ok: false, code: 'INVALID_OPTIONS', message: `${what} must be an absolute path` };
	}
	return undefined;
}

/** Export a pipeline or an agent from the app's live agents. */
export async function exportBundleFromApp(
	ctx: CueBundleAppContext,
	request: CueBundleExportRequest
): Promise<CueBundleExportOutcome> {
	const invalid = requireAbsolute(request.outputPath, 'The output path');
	if (invalid) return invalid;
	try {
		ctx.flushSessions?.();
		const result = await exportCueBundle({
			dataDir: ctx.dataDir,
			agentConfigsDir: ctx.agentConfigsDir,
			sessions: ctx.getSessions(),
			pipeline: request.pipeline,
			agentId: request.agentId,
			outputPath: request.outputPath,
			claudeAssets: request.claudeAssets,
			allowInlineSecrets: request.allowInlineSecrets,
			createdAt: request.createdAt,
			producerVersion: ctx.version,
		});
		return { ok: true, ...result };
	} catch (error) {
		return failure(error, 'EXPORT_FAILED');
	}
}

/** Read a bundle's manifest and README and validate it, without importing anything. */
export function inspectBundle(bundlePath: string, runningVersion: string): CueBundleInspectOutcome {
	const invalid = requireAbsolute(bundlePath, 'The bundle path');
	if (invalid) return invalid;
	try {
		const archive = readCueBundleArchive(bundlePath);
		const result = validateCueBundleArchive(archive, { runningVersion, checkEnv: false });
		const readme = archive.entries.get(CUE_BUNDLE_README_PATH)?.toString('utf-8');
		let manifest = result.manifest;
		if (!manifest) {
			// Show what the manifest says even when validation rejects it.
			try {
				const raw = archive.entries.get(CUE_BUNDLE_MANIFEST_PATH);
				if (raw) manifest = JSON.parse(raw.toString('utf-8')) as CueBundleManifest;
			} catch {
				// Unparseable; `errors` already says so.
			}
		}
		return {
			ok: true,
			bundlePath,
			...(manifest ? { manifest } : {}),
			...(readme !== undefined ? { readme } : {}),
			valid: result.valid,
			errors: result.errors,
			warnings: result.warnings,
		};
	} catch (error) {
		return failure(error, 'BUNDLE_UNREADABLE');
	}
}

function importOptions(
	ctx: CueBundleAppContext,
	request: CueBundleImportRequest
): CueBundleImportOptions {
	return {
		bundlePath: request.bundlePath,
		dataDir: ctx.dataDir,
		workspaces: request.workspaces,
		runningVersion: ctx.version,
		force: request.force,
		refuseShellCommands: request.refuseShellCommands,
		host: {
			sessions: ctx.getSessions(),
			applyAgents: (change) => ctx.applyAgents(change),
		},
	};
}

/**
 * Import a bundle into the app, or with `dryRun` only plan it. A plan lists
 * conflicts; an import refuses them unless `force` is set.
 */
export async function importBundleIntoApp(
	ctx: CueBundleAppContext,
	request: CueBundleImportRequest
): Promise<CueBundleImportOutcome> {
	const invalid = requireAbsolute(request.bundlePath, 'The bundle path');
	if (invalid) return invalid;
	for (const [key, folder] of Object.entries(request.workspaces ?? {})) {
		const bad = requireAbsolute(folder, `The folder for workspace "${key}"`);
		if (bad) return bad;
	}
	try {
		const options = importOptions(ctx, request);
		if (request.dryRun) {
			return { ok: true, plan: await planCueBundleImport(options), applied: false };
		}
		const result = await importCueBundle(options);
		return { ok: true, ...result };
	} catch (error) {
		return failure(error, 'WRITE_FAILED');
	}
}
