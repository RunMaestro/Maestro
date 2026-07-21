/**
 * Self-destruct rewriter for `time.once` Cue subscriptions.
 *
 * Reads the project's canonical `cue.yaml`, removes the subscription with the
 * given name from the top-level `subscriptions` array, and writes the result
 * atomically. The engine's YAML file watcher picks up the change and reloads
 * the config naturally - callers should NOT trigger a reload themselves.
 *
 * Preserves the original file's leading comment block (the `# Pipeline: …`
 * header most cue.yaml files carry) so the rewrite doesn't strip pipeline
 * metadata that lives only in YAML comments.
 *
 * Returns a structured result so the completion path can log a clear reason
 * when a self-destruct fails (the YAML is gone, the sub is already absent,
 * etc.) without crashing the run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { resolveCueConfigPath } from './cue-yaml-loader';
import { extractLeadingCommentBlock } from './cue-yaml-write';

export interface SelfDestructResult {
	removed: boolean;
	reason?: string;
}

export async function removeSubscriptionFromYaml(
	projectRoot: string,
	subscriptionName: string
): Promise<SelfDestructResult> {
	const configPath = resolveCueConfigPath(projectRoot);
	if (!configPath) {
		return { removed: false, reason: 'cue.yaml not found' };
	}

	let raw: string;
	try {
		raw = await fs.promises.readFile(configPath, 'utf-8');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { removed: false, reason: `read failed: ${message}` };
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { removed: false, reason: `yaml parse failed: ${message}` };
	}

	if (!parsed || typeof parsed !== 'object') {
		return { removed: false, reason: 'cue.yaml root is not a mapping' };
	}

	const root = parsed as Record<string, unknown>;
	const subs = root.subscriptions;
	if (!Array.isArray(subs)) {
		return { removed: false, reason: 'subscriptions array missing' };
	}

	const filtered = subs.filter(
		(entry) =>
			!(
				entry &&
				typeof entry === 'object' &&
				(entry as { name?: unknown }).name === subscriptionName
			)
	);

	if (filtered.length === subs.length) {
		return { removed: false, reason: `subscription "${subscriptionName}" not present` };
	}

	root.subscriptions = filtered;

	let dumped: string;
	try {
		dumped = yaml.dump(root, { lineWidth: -1, noRefs: true, sortKeys: false });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { removed: false, reason: `yaml dump failed: ${message}` };
	}

	const header = extractLeadingCommentBlock(raw);
	const output = header + dumped;

	const tmpPath = configPath + '.tmp';
	try {
		await fs.promises.writeFile(tmpPath, output, 'utf-8');
		await fs.promises.rename(tmpPath, configPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Best-effort cleanup of a half-written temp file.
		try {
			await fs.promises.unlink(tmpPath);
		} catch {
			// ignore - original file is still intact
		}
		return { removed: false, reason: `write failed: ${message}` };
	}

	console.log(
		`[CUE] self-destruct removed "${subscriptionName}" from ${path.relative(projectRoot, configPath)}`
	);
	return { removed: true };
}
