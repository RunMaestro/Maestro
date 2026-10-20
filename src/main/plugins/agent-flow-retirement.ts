/** Retirement policy for the exact public 0.3.0 bundle removed in #1740.
 * No publisher/user-key trust expansion: the digest pins the upstream bytes.
 * Changed copies are preserved, including their state, for explicit uninstall.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pluginsDir, isSafePluginFolderName } from './plugin-store-main';
import { computePluginContentHash } from './plugin-signature';

export const RETIRED_AGENT_FLOW_ID = 'agent-flow';

// examples/plugins/agent-flow at fef3c70ec^, using computePluginContentHash.
const BUNDLE_CONTENT_HASH = '05d8754981cb73c3546aa6783ac9781b0615dad6078c87cc93caf4484536710f';
const BUNDLE_FILES = ['README.md', 'main.js', 'panel.html', 'plugin.json'];

/** Absent is eligible for orphan-state cleanup. Anything ambiguous fails closed.
 * lstat also catches dangling symlinks (existsSync would call them absent). */
export function inspectRetiredAgentFlow():
	| { kind: 'absent' }
	| { kind: 'bundle'; path: string }
	| { kind: 'preserved'; reason: string } {
	const root = pluginsDir();
	const source = path.join(root, RETIRED_AGENT_FLOW_ID);
	try {
		if (!fs.lstatSync(root).isDirectory()) throw new Error('plugin root is not a directory');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
		throw error;
	}
	// Discovery accepts manifests in differently named folders. Such a copy is
	// user-managed, not an orphan: do not purge its shared id's state or grants.
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			entry.name === RETIRED_AGENT_FLOW_ID ||
			!isSafePluginFolderName(entry.name)
		)
			continue;
		let manifest: unknown;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'plugin.json'), 'utf8'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
				continue;
			throw error;
		}
		if (
			manifest &&
			typeof manifest === 'object' &&
			'id' in manifest &&
			manifest.id === RETIRED_AGENT_FLOW_ID
		) {
			return { kind: 'preserved', reason: 'installed in a user-managed folder' };
		}
	}
	try {
		if (!fs.lstatSync(source).isDirectory()) throw new Error('Agent Flow is not a directory');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
		throw error;
	}
	const entries = fs.readdirSync(source, { withFileTypes: true });
	if (
		entries.some(
			(entry) =>
				!entry.isFile() || (!BUNDLE_FILES.includes(entry.name) && entry.name !== 'signature.json')
		) ||
		computePluginContentHash(source) !== BUNDLE_CONTENT_HASH
	) {
		return { kind: 'preserved', reason: 'not the unchanged retired 0.3.0 bundle' };
	}
	return { kind: 'bundle', path: source };
}

/** Move the package verified by the caller's post-drain inspection to recovery.
 * Unique directories never overwrite an earlier backup. Rename failure leaves
 * the installed package intact; the host reports failure and retries later. */
export function archiveRetiredAgentFlow(source: string): string {
	const recoveryRoot = path.join(path.dirname(pluginsDir()), 'retired-plugins');
	fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
	if (!fs.lstatSync(recoveryRoot).isDirectory()) {
		throw new Error('retired plugin recovery root is not a directory');
	}
	const recovery = fs.mkdtempSync(path.join(recoveryRoot, 'agent-flow-0.3.0-'));
	fs.renameSync(source, path.join(recovery, RETIRED_AGENT_FLOW_ID));
	return recovery;
}
