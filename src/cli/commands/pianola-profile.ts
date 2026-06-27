/**
 * Pianola profile CLI commands.
 *
 * `pianola profile` reads, and `pianola set-profile` saves, a learned decision
 * profile (per-project with --project, else global). The profile is how the
 * watcher and Pianola fetch "how the user decides here" at decision time, and how
 * Pianola persists what it synthesized from `pianola learn`. Split out of
 * pianola.ts (the watcher shell) so each command file stays focused; the Encore
 * gate is shared via `ensurePianolaEnabled`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ensurePianolaEnabled } from './pianola';
import { getPianolaProfile, setPianolaProfile } from '../services/pianola-store';

export interface PianolaProfileReadOptions {
	project?: string;
	json?: boolean;
}

/**
 * Read a learned decision profile. With --project, returns that project's profile
 * (falling back to the global one); without it, returns the global profile. This
 * is how the watcher and Pianola fetch "how the user decides here" at decision time.
 */
export function pianolaProfile(options: PianolaProfileReadOptions): void {
	ensurePianolaEnabled(options.json);
	const { source, entry } = getPianolaProfile(options.project);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				source,
				projectPath: options.project ?? null,
				profile: entry?.profile ?? null,
				updatedAt: entry?.updatedAt ?? null,
				pairCount: entry?.pairCount ?? null,
			})
		);
		return;
	}

	if (!entry) {
		console.log(
			options.project
				? `No profile for ${options.project} (and no global profile set).`
				: 'No global Pianola profile set.'
		);
		return;
	}
	const scope = source === 'project' ? `project ${options.project}` : 'global';
	console.log(`Pianola profile (${scope}), updated ${new Date(entry.updatedAt).toISOString()}:`);
	console.log(entry.profile);
}

export interface PianolaSetProfileOptions {
	project?: string;
	file?: string;
	pairCount?: string;
	json?: boolean;
}

/**
 * Save a learned decision profile (per-project with --project, else global). This
 * is how Pianola persists what it synthesized from `pianola learn`. The profile
 * text comes from --file or piped stdin (preferred for multi-line markdown).
 */
export function pianolaSetProfile(options: PianolaSetProfileOptions): void {
	ensurePianolaEnabled(options.json);

	const fail = (message: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	};

	let profileText: string;
	if (options.file) {
		try {
			profileText = fs.readFileSync(path.resolve(options.file), 'utf-8');
		} catch (error) {
			return fail(
				`Could not read --file: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	} else if (process.stdin.isTTY) {
		return fail('Provide the profile via --file <path> or piped stdin');
	} else {
		try {
			profileText = fs.readFileSync(0, 'utf-8');
		} catch {
			return fail('Could not read the profile from stdin; use --file <path> instead');
		}
	}

	if (!profileText.trim()) return fail('Profile content is empty');

	let pairCount: number | undefined;
	if (options.pairCount !== undefined) {
		const parsed = parseInt(options.pairCount, 10);
		if (!isNaN(parsed)) pairCount = parsed;
	}

	const entry = {
		profile: profileText,
		updatedAt: Date.now(),
		...(pairCount !== undefined ? { pairCount } : {}),
	};
	setPianolaProfile(entry, options.project);

	const scope = options.project ? `project ${options.project}` : 'global';
	if (options.json) {
		console.log(JSON.stringify({ success: true, scope, chars: profileText.length }));
	} else {
		console.log(`Saved ${scope} Pianola profile (${profileText.length} chars).`);
	}
}
