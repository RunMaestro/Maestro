/**
 * Filesystem half of switching an agent's provider account
 * (`src/shared/providerAccountSwitch.ts` owns the decisions).
 *
 * Two jobs:
 *
 *   - Read WHO is signed into each account directory, so the switcher can show
 *     an email instead of a directory name nobody keeps honest.
 *   - Carry an open conversation across the switch. A tab resumes its provider
 *     session with `--resume <id>`, and the CLI looks that id up under the NEW
 *     config dir. Directories that share their transcript folder (a symlinked
 *     `projects/`, which is how most multi-account setups are built) need
 *     nothing; for the rest the transcript is copied across, or the next turn
 *     fails with "No conversation found" and the switch reads as having broken
 *     the agent.
 *
 * Local only: an SSH agent's directories live on the remote host and the
 * switcher refuses those agents before reaching here.
 */

import * as fs from 'fs';
import path from 'path';

import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import type {
	CarryProviderSessionRequest,
	CarryProviderSessionResult,
	ProviderAccountIdentity,
} from '../../shared/providerAccountSwitch';
import { getProviderProfileConfig } from '../../shared/providerProfiles';
import { readClaudeAccountIdentity } from './claude-account-identity';
import { extractEmailFromJwt } from './codex-usage-sampler';

async function readable(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** Whether `accountKey` is the provider's implicit `~/<defaultSubdir>` account. */
function isDefaultAccount(toolType: string, accountKey: string, homeDir: string): boolean {
	const config = getProviderProfileConfig(toolType);
	return !!config && path.resolve(accountKey) === path.resolve(homeDir, config.defaultSubdir);
}

async function readClaudeIdentity(
	accountKey: string,
	homeDir: string
): Promise<ProviderAccountIdentity> {
	// With CLAUDE_CONFIG_DIR unset, Claude keeps `.claude.json` in $HOME rather
	// than inside `~/.claude`, so the default account is read from there.
	const configDir = isDefaultAccount('claude-code', accountKey, homeDir) ? homeDir : accountKey;
	const identity = await readClaudeAccountIdentity(configDir);
	return { accountKey, email: identity?.email, signedIn: identity !== null };
}

async function readCodexIdentity(accountKey: string): Promise<ProviderAccountIdentity> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(path.join(accountKey, 'auth.json'), 'utf8');
	} catch {
		return { accountKey, signedIn: false };
	}
	try {
		const auth = JSON.parse(raw) as { tokens?: { id_token?: string } };
		return { accountKey, email: extractEmailFromJwt(auth.tokens?.id_token), signedIn: true };
	} catch {
		// A file is there, so a login was attempted; the email is cosmetic.
		return { accountKey, signedIn: true };
	}
}

/** Identity of each account directory. Never throws: an unreadable dir is "not signed in". */
export async function readProviderAccountIdentities(
	toolType: string,
	accountKeys: string[],
	homeDir: string
): Promise<ProviderAccountIdentity[]> {
	return Promise.all(
		accountKeys.map((accountKey) => {
			if (toolType === 'claude-code') return readClaudeIdentity(accountKey, homeDir);
			if (toolType === 'codex') return readCodexIdentity(accountKey);
			return Promise.resolve({ accountKey, signedIn: false });
		})
	);
}

/** The folder the provider keeps transcripts in, under one account dir. */
function transcriptRoot(toolType: string, accountKey: string): string {
	return path.join(accountKey, toolType === 'codex' ? 'sessions' : 'projects');
}

async function realpathOrSelf(dir: string): Promise<string> {
	try {
		return await fs.promises.realpath(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** Codex nests transcripts by date; find the one whose file name ends with the id. */
async function findCodexTranscript(root: string, sessionId: string): Promise<string | null> {
	const suffix = `${sessionId}.jsonl`;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(suffix)) return full;
		}
	}
	return null;
}

/**
 * Make `sessionId` resumable from `toAccountKey`.
 *
 * Copies rather than moves: the source account keeps its history, and a user
 * who switches back resumes the same conversation from either side. A copy that
 * already exists is never overwritten.
 */
export async function carryProviderSession(
	req: CarryProviderSessionRequest
): Promise<CarryProviderSessionResult> {
	if (req.toolType !== 'claude-code' && req.toolType !== 'codex') {
		throw new Error(`${req.toolType} has no per-account transcripts`);
	}
	const fromRoot = transcriptRoot(req.toolType, req.fromAccountKey);
	const toRoot = transcriptRoot(req.toolType, req.toAccountKey);
	if ((await realpathOrSelf(fromRoot)) === (await realpathOrSelf(toRoot))) return 'shared';

	let source: string | null;
	let target: string;
	if (req.toolType === 'claude-code') {
		const relative = path.join(encodeClaudeProjectPath(req.cwd), `${req.sessionId}.jsonl`);
		source = path.join(fromRoot, relative);
		target = path.join(toRoot, relative);
		if (!(await readable(source))) source = null;
	} else {
		source = await findCodexTranscript(fromRoot, req.sessionId);
		target = source ? path.join(toRoot, path.relative(fromRoot, source)) : '';
	}

	if (!source) return 'missing';
	if (await readable(target)) return 'present';
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
	return 'copied';
}
