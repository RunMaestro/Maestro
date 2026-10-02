/**
 * Synthetic Cue bundle zips for the validator and the `bundle validate` /
 * `bundle inspect` CLI tests.
 *
 * `writeCueBundle()` builds a small, VALID bundle (one agent, one workspace,
 * a heartbeat with a prompt file, a webhook with a declared secret) and hashes
 * every entry into `manifest.files`. Each hook then breaks exactly one thing,
 * so a test sees only the issue it is about.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { zipSync, strToU8 } from 'fflate';
import type { CueBundleManifest } from '../../shared/cue-bundle-types';

export const FIXTURE_CUE_PATH = 'workspaces/proj/.maestro/cue.yaml';

export interface CueBundleFixtureDoc {
	settings?: Record<string, unknown>;
	subscriptions: Array<Record<string, unknown>>;
}

export interface CueBundleFixtureOptions {
	/** Edit the cue.yaml document before it is serialized and hashed. */
	cue?: (doc: CueBundleFixtureDoc) => void;
	/** Edit the archive's files (path -> content) before they are hashed. */
	files?: (files: Map<string, string>) => void;
	/** Edit the manifest after `files` was computed. */
	manifest?: (manifest: CueBundleManifest) => void;
	/** Overwrite archive entries AFTER hashing, so they disagree with the manifest. */
	tamper?: Record<string, string>;
	/** Entries added to the zip but never listed in `manifest.files`. */
	unlisted?: Record<string, string>;
}

export function writeCueBundle(outPath: string, options: CueBundleFixtureOptions = {}): string {
	const doc: CueBundleFixtureDoc = {
		settings: { owner_agent_id: 'Alpha' },
		subscriptions: [
			{
				name: 'tick',
				event: 'time.heartbeat',
				agent_id: 'agent-a',
				interval_minutes: 5,
				prompt_file: '.maestro/prompts/tick.md',
			},
			{
				name: 'hook',
				event: 'webhook.received',
				agent_id: 'agent-a',
				prompt: 'Handle it',
				webhook: { path: 'hook', secret_env: 'HOOK_SECRET' },
			},
		],
	};
	options.cue?.(doc);

	const files = new Map<string, string>([
		['README.md', '# Fixture\n'],
		[
			'agents/agent-a.json',
			JSON.stringify({
				id: 'agent-a',
				name: 'Alpha',
				toolType: 'claude-code',
				workspace: 'proj',
				env: { values: { REGION: 'eu' }, required: ['API_KEY'] },
			}),
		],
		[FIXTURE_CUE_PATH, yaml.dump(doc)],
		['workspaces/proj/.maestro/prompts/tick.md', 'Tick.'],
	]);
	options.files?.(files);

	const manifest: CueBundleManifest = {
		bundleVersion: 1,
		kind: 'maestro-pipeline',
		producer: { app: 'maestro', version: '0.18.0' },
		minEngineVersion: '0.18.0',
		name: 'Fixture',
		workspaces: [
			{
				key: 'proj',
				name: 'proj',
				cueConfig: FIXTURE_CUE_PATH,
				source: {
					gitRemote: 'https://github.com/acme/proj.git',
					gitBranch: 'main',
					gitRef: 'a'.repeat(40),
				},
			},
		],
		agents: [
			{
				id: 'agent-a',
				name: 'Alpha',
				toolType: 'claude-code',
				workspace: 'proj',
				settings: 'agents/agent-a.json',
			},
		],
		requirements: {
			events: ['time.heartbeat', 'webhook.received'],
			tools: ['git'],
			secrets: ['API_KEY', 'HOOK_SECRET'],
		},
		files: [...files.keys()].sort().map((p) => {
			const buf = Buffer.from(files.get(p)!, 'utf-8');
			return {
				path: p,
				sha256: crypto.createHash('sha256').update(buf).digest('hex'),
				size: buf.length,
			};
		}),
	};
	options.manifest?.(manifest);

	const entries: Record<string, Uint8Array> = {};
	for (const [p, content] of files) entries[p] = strToU8(content);
	for (const [p, content] of Object.entries(options.tamper ?? {})) entries[p] = strToU8(content);
	for (const [p, content] of Object.entries(options.unlisted ?? {})) entries[p] = strToU8(content);
	entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, '\t'));

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, zipSync(entries));
	return outPath;
}
