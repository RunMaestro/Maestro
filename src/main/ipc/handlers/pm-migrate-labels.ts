/**
 * pm:migrateLegacyLabels IPC Handler
 *
 * Implements the `/PM migrate-labels` slash command: for each open GitHub Issue
 * in the repo that carries a legacy Symphony-runner `agent:*` label, this
 * handler:
 *
 *   1. Adds the issue to the Projects v2 board (if not already present).
 *   2. Maps the label to the corresponding AI Status field option:
 *        agent:ready              → Tasks Ready
 *        agent:running            → In Progress
 *        agent:review             → In Review
 *        agent:failed-validation  → Blocked
 *   3. Sets the AI Status field via `gh project item-edit`.
 *   4. Removes the legacy label from the issue via `gh issue edit --remove-label`.
 *
 * Channel:
 *   pm:migrateLegacyLabels  ({ projectPath: string })  →  MigrateLegacyLabelsResult
 *
 * Gated by the `deliveryPlanner` encore feature flag.
 *
 * All `gh` calls are made via execFileNoThrow so a single failure does not
 * abort the whole batch — errors are collected and returned to the caller.
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import type { GithubProjectMapping } from '../../delivery-planner/github-project-discovery';

const LOG_CONTEXT = '[PmMigrateLabels]';

/** Map of legacy label name → AI Status field option. */
const LABEL_TO_AI_STATUS: Record<string, string> = {
	'agent:ready': 'Tasks Ready',
	'agent:running': 'In Progress',
	'agent:review': 'In Review',
	'agent:failed-validation': 'Blocked',
};

const LEGACY_LABELS = Object.keys(LABEL_TO_AI_STATUS);

export interface MigrateLegacyLabelsInput {
	/** Absolute path to the local git checkout — used to look up the project mapping. */
	projectPath: string;
}

export interface MigrateLegacyLabelsResult {
	success: boolean;
	/** Number of issues successfully migrated. */
	migrated?: number;
	/** Per-issue errors (issue not migrated). */
	errors?: Array<{ issueNumber: number; label: string; message: string }>;
	error?: string;
}

export interface PmMigrateLabelsHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmMigrateLabelsHandlers(deps: PmMigrateLabelsHandlerDependencies): void {
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	ipcMain.handle(
		'pm:migrateLegacyLabels',
		async (_event, input: MigrateLegacyLabelsInput): Promise<MigrateLegacyLabelsResult> => {
			const gateError = gate();
			if (gateError) return { success: false, error: 'Feature not enabled (deliveryPlanner)' };

			const { projectPath } = input ?? {};
			if (!projectPath) {
				return { success: false, error: 'projectPath is required' };
			}

			// ── 1. Resolve repo owner/repo from projectGithubMap ─────────────────
			const map = deps.settingsStore.get<Record<string, GithubProjectMapping>>(
				'projectGithubMap',
				{}
			);
			const mapping = map[projectPath];
			if (!mapping) {
				return {
					success: false,
					error:
						`No GitHub project mapping found for "${projectPath}". ` +
						`Run /PM-init or /PM resolve-github-project first.`,
				};
			}

			const { owner, repo, projectNumber } = mapping;
			const repoSlug = `${owner}/${repo}`;

			// ── 2. Pre-flight: verify gh auth ─────────────────────────────────────
			const authCheck = await execFileNoThrow('gh', ['auth', 'status']);
			if (authCheck.exitCode !== 0) {
				return {
					success: false,
					error: `gh auth check failed — run "gh auth login". ${(authCheck.stderr || authCheck.stdout).trim()}`,
				};
			}

			// ── 3. List all open issues that have at least one agent:* label ──────
			// We query each label separately and union the results to avoid
			// hitting label-filter limitations in gh CLI.
			const issuesByNumber = new Map<number, { labels: string[] }>();

			for (const label of LEGACY_LABELS) {
				const result = await execFileNoThrow('gh', [
					'issue',
					'list',
					'-R',
					repoSlug,
					'--label',
					label,
					'--state',
					'open',
					'--json',
					'number,labels',
					'--limit',
					'500',
				]);

				if (result.exitCode !== 0) {
					logger.warn(
						`${LOG_CONTEXT} Failed to list issues for label "${label}": ${result.stderr.trim()}`
					);
					continue;
				}

				let items: Array<{ number: number; labels: Array<{ name: string }> }> = [];
				try {
					items = JSON.parse(result.stdout) as typeof items;
				} catch {
					logger.warn(`${LOG_CONTEXT} Invalid JSON listing issues for label "${label}"`);
					continue;
				}

				for (const item of items) {
					const existing = issuesByNumber.get(item.number);
					const labelNames = item.labels.map((l) => l.name);
					if (existing) {
						// Merge label sets (gh may return different subsets per call)
						for (const ln of labelNames) {
							if (!existing.labels.includes(ln)) {
								existing.labels.push(ln);
							}
						}
					} else {
						issuesByNumber.set(item.number, { labels: labelNames });
					}
				}
			}

			if (issuesByNumber.size === 0) {
				logger.info(
					`${LOG_CONTEXT} No open issues with legacy agent:* labels found in ${repoSlug}`
				);
				return { success: true, migrated: 0, errors: [] };
			}

			logger.info(
				`${LOG_CONTEXT} Found ${issuesByNumber.size} issue(s) with legacy labels in ${repoSlug}`
			);

			// ── 4. Resolve project node ID ────────────────────────────────────────
			const projectViewResult = await execFileNoThrow('gh', [
				'project',
				'view',
				String(projectNumber),
				'--owner',
				owner,
				'--format',
				'json',
			]);

			if (projectViewResult.exitCode !== 0) {
				return {
					success: false,
					error: `Could not read project #${projectNumber}: ${projectViewResult.stderr.trim()}`,
				};
			}

			let projectId: string;
			try {
				const parsed = JSON.parse(projectViewResult.stdout) as { id?: string };
				if (!parsed.id) throw new Error('no id');
				projectId = parsed.id;
			} catch {
				return {
					success: false,
					error: `Could not parse project ID from gh output: ${projectViewResult.stdout.slice(0, 200)}`,
				};
			}

			// ── 5. Resolve AI Status field and option IDs ─────────────────────────
			const fieldListResult = await execFileNoThrow('gh', [
				'project',
				'field-list',
				String(projectNumber),
				'--owner',
				owner,
				'--format',
				'json',
			]);

			if (fieldListResult.exitCode !== 0) {
				return {
					success: false,
					error: `Could not list project fields: ${fieldListResult.stderr.trim()}`,
				};
			}

			type RawField = {
				id: string;
				name: string;
				options?: Array<{ id: string; name: string }>;
			};
			let fields: RawField[] = [];
			try {
				const parsed = JSON.parse(fieldListResult.stdout) as { fields?: RawField[] } | RawField[];
				fields = Array.isArray(parsed) ? parsed : (parsed.fields ?? []);
			} catch {
				return {
					success: false,
					error: `Could not parse field list from gh output`,
				};
			}

			const aiStatusField = fields.find((f) => f.name === 'AI Status');
			if (!aiStatusField) {
				return {
					success: false,
					error:
						`"AI Status" field not found on project #${projectNumber}. ` +
						`Run /PM-init to create the required fields first.`,
				};
			}

			// Build option-name → option-id map for quick lookup
			const optionIdByName = new Map<string, string>(
				(aiStatusField.options ?? []).map((o) => [o.name, o.id])
			);

			// ── 6. Process each issue ─────────────────────────────────────────────
			let migrated = 0;
			const errors: Array<{ issueNumber: number; label: string; message: string }> = [];

			for (const [issueNumber, { labels }] of issuesByNumber.entries()) {
				// Find the first matching legacy label (issues rarely have more than one)
				const legacyLabel = labels.find((l) => LEGACY_LABELS.includes(l));
				if (!legacyLabel) continue;

				const targetStatus = LABEL_TO_AI_STATUS[legacyLabel];
				if (!targetStatus) continue;

				const optionId = optionIdByName.get(targetStatus);
				if (!optionId) {
					errors.push({
						issueNumber,
						label: legacyLabel,
						message:
							`AI Status option "${targetStatus}" not found on project. ` +
							`Run /PM-init to ensure all options are present.`,
					});
					continue;
				}

				// 6a. Add issue to project (idempotent — gh returns the existing item if already added)
				const addResult = await execFileNoThrow('gh', [
					'project',
					'item-add',
					String(projectNumber),
					'--owner',
					owner,
					'--url',
					`https://github.com/${repoSlug}/issues/${issueNumber}`,
					'--format',
					'json',
				]);

				let projectItemId: string | undefined;
				if (addResult.exitCode === 0) {
					try {
						const parsed = JSON.parse(addResult.stdout) as { id?: string };
						projectItemId = parsed.id;
					} catch {
						// ignore parse error; fall through to listing
					}
				}

				// If add failed or returned no ID, try to find the item via item-list
				if (!projectItemId) {
					const listResult = await execFileNoThrow('gh', [
						'project',
						'item-list',
						String(projectNumber),
						'--owner',
						owner,
						'--format',
						'json',
						'--limit',
						'500',
					]);

					if (listResult.exitCode === 0) {
						try {
							type RawItem = {
								id: string;
								content?: { number?: number };
							};
							const parsed = JSON.parse(listResult.stdout) as { items?: RawItem[] } | RawItem[];
							const items: RawItem[] = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
							const match = items.find((i) => i.content?.number === issueNumber);
							projectItemId = match?.id;
						} catch {
							// ignore
						}
					}
				}

				if (!projectItemId) {
					errors.push({
						issueNumber,
						label: legacyLabel,
						message: `Could not add issue #${issueNumber} to project or find its project item ID.`,
					});
					continue;
				}

				// 6b. Set AI Status field
				const editResult = await execFileNoThrow('gh', [
					'project',
					'item-edit',
					'--project-id',
					projectId,
					'--id',
					projectItemId,
					'--field-id',
					aiStatusField.id,
					'--single-select-option-id',
					optionId,
				]);

				if (editResult.exitCode !== 0) {
					errors.push({
						issueNumber,
						label: legacyLabel,
						message: `gh project item-edit failed: ${editResult.stderr.trim()}`,
					});
					continue;
				}

				// 6c. Remove the legacy label from the issue
				const removeLabelResult = await execFileNoThrow('gh', [
					'issue',
					'edit',
					String(issueNumber),
					'-R',
					repoSlug,
					'--remove-label',
					legacyLabel,
				]);

				if (removeLabelResult.exitCode !== 0) {
					// Partial success: field was set but label removal failed.
					// Still count as migrated but record a warning.
					logger.warn(
						`${LOG_CONTEXT} issue #${issueNumber}: label removal failed: ${removeLabelResult.stderr.trim()}`
					);
				}

				migrated++;
				logger.info(
					`${LOG_CONTEXT} Migrated issue #${issueNumber}: label="${legacyLabel}" → AI Status="${targetStatus}"`
				);
			}

			logger.info(
				`${LOG_CONTEXT} Migration complete for ${repoSlug}: migrated=${migrated} errors=${errors.length}`
			);

			return { success: true, migrated, errors };
		}
	);

	logger.debug(`${LOG_CONTEXT} pm:migrateLegacyLabels IPC handler registered`);
}
