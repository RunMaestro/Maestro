/**
 * Rename a Cue pipeline in place, across every `cue.yaml` that participates.
 *
 * A pipeline is not an object on disk - it is the set of subscriptions sharing
 * a `pipeline_name`. So renaming one means rewriting that field on every
 * member, in every project root the pipeline spans (a cross-agent pipeline is
 * physically N files).
 *
 * Two things this deliberately does NOT touch:
 *
 *   - **Subscription names.** They are stable identities: the layout store keys
 *     each trigger's saved position by subscription name, and downstream
 *     `source_sub` references point at them. Renaming `Foo-chain-2` to
 *     `Bar-chain-2` would strand both. `pipeline_name` is authoritative for
 *     grouping precisely so a sub's own name can stay put - the editor's own
 *     save path preserves them the same way.
 *   - **Prompt files.** `.maestro/prompts/<agent>/<sub>.md` is keyed by
 *     subscription name, which is unchanged, so the paths stay valid.
 *
 * The one piece of bookkeeping a rename DOES owe: the visual pipeline id is
 * derived from the name (`pipeline-${name}` in yamlToPipeline), so the saved
 * layout entry has to be re-keyed or the pipeline reloads with no remembered
 * node positions.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { pipelineKeyForSubscription } from '../../shared/cue/subscription-id';
import { resolveCueConfigPath } from './cue-yaml-loader';
import { extractLeadingCommentBlock, writeCueYamlAtomicSync } from './cue-yaml-write';
import { loadPipelineLayout, savePipelineLayout } from './pipeline-layout-store';

/** Longest a pipeline name may be. Long enough for a sentence-ish label, short
 *  enough that the derived `<name>-chain-N` subscription names stay readable. */
export const MAX_PIPELINE_NAME_LENGTH = 120;

export interface RenamePipelineResult {
	renamed: boolean;
	/** Number of subscriptions whose `pipeline_name` was rewritten. */
	subscriptionsUpdated: number;
	/** Config files actually written. */
	filesWritten: string[];
	/** Why nothing happened, when `renamed` is false. */
	reason?: string;
	/** Non-fatal problems (a root that could not be read), for surfacing. */
	warnings: string[];
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Validate a proposed pipeline name on its own terms (shape only - uniqueness
 * is a question about the current set and is checked by the caller).
 *
 * `::` is rejected because it is the separator in the remote-exposed
 * subscription id (`sessionId::pipeline::name`), and a pipeline containing it
 * would produce ids that cannot be parsed back apart.
 */
export function validatePipelineName(name: string): { ok: true } | { ok: false; reason: string } {
	const trimmed = name.trim();
	if (trimmed.length === 0) return { ok: false, reason: 'a pipeline needs a name' };
	if (trimmed.length > MAX_PIPELINE_NAME_LENGTH) {
		return {
			ok: false,
			reason: `a pipeline name must be ${MAX_PIPELINE_NAME_LENGTH} characters or fewer`,
		};
	}
	if (trimmed.includes('::')) {
		return { ok: false, reason: 'a pipeline name cannot contain "::"' };
	}
	// A newline would corrupt the `# Pipeline: <name>` comment header and make
	// the YAML value ambiguous on re-read.
	if (/[\r\n]/.test(trimmed)) {
		return { ok: false, reason: 'a pipeline name cannot contain line breaks' };
	}
	return { ok: true };
}

/**
 * Rewrite `pipeline_name` on every subscription belonging to `oldName`, in
 * each of `projectRoots`. Roots that have no `cue.yaml`, or whose file holds no
 * member of this pipeline, are skipped without being rewritten - an untouched
 * file should not get its formatting churned.
 */
export function renamePipelineOnDisk(
	projectRoots: string[],
	oldName: string,
	newName: string
): RenamePipelineResult {
	const warnings: string[] = [];
	const filesWritten: string[] = [];
	let subscriptionsUpdated = 0;

	const valid = validatePipelineName(newName);
	if (!valid.ok) {
		return {
			renamed: false,
			subscriptionsUpdated: 0,
			filesWritten,
			reason: valid.reason,
			warnings,
		};
	}
	const trimmedNew = newName.trim();
	if (trimmedNew === oldName) {
		return {
			renamed: false,
			subscriptionsUpdated: 0,
			filesWritten,
			reason: 'the name is unchanged',
			warnings,
		};
	}

	// De-duplicate roots: two agents can share one project root, and rewriting
	// the same file twice would double-count the subscriptions.
	for (const projectRoot of Array.from(new Set(projectRoots))) {
		const configPath = resolveCueConfigPath(projectRoot);
		if (!configPath) continue;

		let raw: string;
		try {
			raw = fs.readFileSync(configPath, 'utf-8');
		} catch (err) {
			warnings.push(`could not read ${configPath}: ${errText(err)}`);
			continue;
		}

		let parsed: unknown;
		try {
			parsed = yaml.load(raw);
		} catch (err) {
			warnings.push(`could not parse ${configPath}: ${errText(err)}`);
			continue;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			warnings.push(`${configPath}: root is not a mapping`);
			continue;
		}

		const root = parsed as Record<string, unknown>;
		const subs = root.subscriptions;
		if (!Array.isArray(subs)) continue;

		let touched = 0;
		for (const entry of subs) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const sub = entry as Record<string, unknown>;
			if (typeof sub.name !== 'string') continue;
			const key = pipelineKeyForSubscription({
				name: sub.name,
				pipeline_name: typeof sub.pipeline_name === 'string' ? sub.pipeline_name : undefined,
			});
			if (key !== oldName) continue;
			// Setting the field explicitly also UPGRADES a legacy member that was
			// only grouped by its name suffix: after this write it is grouped by
			// the authoritative field, which is what keeps it with the pipeline
			// now that the name no longer matches the suffix convention.
			sub.pipeline_name = trimmedNew;
			touched++;
		}

		if (touched === 0) continue;

		// The leading comment block carries the `# Pipeline: Name (color: #hex)`
		// header for hand-authored files. Rewrite the name inside it so the file
		// does not end up documenting a pipeline that no longer exists.
		const header = renamePipelineCommentHeader(
			extractLeadingCommentBlock(raw),
			oldName,
			trimmedNew
		);
		const dumped = yaml.dump(root, { lineWidth: -1, noRefs: true, sortKeys: false });
		try {
			writeCueYamlAtomicSync(configPath, header + dumped);
		} catch (err) {
			warnings.push(`could not write ${configPath}: ${errText(err)}`);
			continue;
		}
		filesWritten.push(configPath);
		subscriptionsUpdated += touched;
	}

	if (subscriptionsUpdated === 0) {
		return {
			renamed: false,
			subscriptionsUpdated: 0,
			filesWritten,
			reason: `no subscriptions found for pipeline "${oldName}"`,
			warnings,
		};
	}

	const layoutWarning = renamePipelineInLayout(oldName, trimmedNew);
	if (layoutWarning) warnings.push(layoutWarning);

	return { renamed: true, subscriptionsUpdated, filesWritten, warnings };
}

/**
 * Rewrite the pipeline name inside a `# Pipeline: <name> (color: #hex)` comment
 * header. Only an exact name match is replaced, so a comment that merely
 * mentions the word is left alone.
 */
export function renamePipelineCommentHeader(
	header: string,
	oldName: string,
	newName: string
): string {
	if (!header) return header;
	return header
		.split('\n')
		.map((line) => {
			const match = line.match(/^(\s*#\s*Pipeline:\s*)(.*?)(\s*\(color:.*)?$/i);
			if (!match) return line;
			if (match[2].trim() !== oldName) return line;
			return `${match[1]}${newName}${match[3] ?? ''}`;
		})
		.join('\n');
}

/**
 * Re-key the saved layout entry, because the visual pipeline id is derived from
 * the name. Without this the renamed pipeline reloads as a brand-new pipeline
 * with no remembered node positions, and the old entry lingers forever as an
 * orphan pointing at a pipeline that no longer exists.
 *
 * Returns a warning string on failure rather than throwing: the YAML rename has
 * already succeeded at this point, and losing node positions is a far smaller
 * problem than reporting the whole rename as failed when it did happen.
 */
function renamePipelineInLayout(oldName: string, newName: string): string | null {
	try {
		const layout = loadPipelineLayout();
		if (!layout) return null;
		const entry = layout.pipelines.find(
			(p) => p.name === oldName || p.id === `pipeline-${oldName}`
		);
		if (!entry) return null;
		savePipelineLayout({
			...layout,
			pipelines: layout.pipelines.map((p) =>
				p === entry ? { ...p, id: `pipeline-${newName}`, name: newName } : p
			),
		});
		return null;
	} catch (err) {
		return `pipeline renamed, but saved node positions could not be moved: ${errText(err)}`;
	}
}
