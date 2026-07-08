/**
 * E2E Tests: Git, Group Chat, Playbooks, Spec Kit, and OpenSpec tranches.
 *
 * These scenarios use local git fixtures and IPC stubs only. They do not call
 * live GitHub, marketplace, provider, or network-backed services.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const secondTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A06', title: 'shows Git Log IPC errors without closing the viewer' },
	{ id: 'GGP-A07', title: 'shows the empty Git Log state for repositories without commits' },
	{ id: 'GGP-A08', title: 'recovers Playbook Exchange after a manifest load failure' },
	{ id: 'GGP-A09', title: 'shows Playbook Exchange empty-manifest state' },
	{ id: 'GGP-A10', title: 'shows marketplace README and document fallback previews' },
	{ id: 'GGP-A11', title: 'shows bundled command empty states after failed IPC loads' },
] as const;

const secondTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S01',
		title: 'creates a real GitHub pull request from an authenticated worktree',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_GITHUB plus authenticated gh state and must not run in deterministic authoring.',
	},
	{
		id: 'GGP-S02',
		title: 'publishes a real GitHub Gist and verifies the external URL',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_GITHUB_GIST plus authenticated gh state and live network.',
	},
	{
		id: 'GGP-S03',
		title: 'refreshes the live marketplace manifest from GitHub',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_MARKETPLACE_NETWORK and should not run during no-network deterministic authoring.',
	},
] as const;

const thirdTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A12', title: 'shows worktree Create Pull Request in Quick Actions' },
	{ id: 'GGP-A13', title: 'shows GitHub CLI auth guidance in Create Pull Request' },
	{ id: 'GGP-A14', title: 'creates a stubbed pull request from a worktree child' },
	{ id: 'GGP-A15', title: 'validates quick worktree branch names before creation' },
	{ id: 'GGP-A16', title: 'imports a marketplace playbook into Auto Run with IPC stubs' },
	{ id: 'GGP-A17', title: 'edits and resets a Spec Kit command prompt' },
	{ id: 'GGP-A18', title: 'edits and resets an OpenSpec command prompt' },
] as const;

const thirdTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S04',
		title: 'opens an existing published Gist URL from a real file preview',
		reason:
			'Env-gated: requires authenticated gh state because the file-preview Gist affordance is hidden without gh availability.',
	},
	{
		id: 'GGP-S05',
		title: 'imports a remote marketplace playbook into an SSH Auto Run folder',
		reason: 'Env-gated: requires configured SSH remote state and remote filesystem access.',
	},
] as const;

const fourthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A19', title: 'renders Git Log commit refs, body, stats, and diff details' },
	{ id: 'GGP-A20', title: 'shows GitHub CLI installation guidance in Create Pull Request' },
	{ id: 'GGP-A21', title: 'keeps Create Pull Request open after a stubbed gh failure' },
	{ id: 'GGP-A22', title: 'filters Playbook Exchange results by category and search text' },
	{ id: 'GGP-A23', title: 'requires a target folder before importing a marketplace playbook' },
	{ id: 'GGP-A24', title: 'refreshes Spec Kit metadata and command prompts from IPC stubs' },
	{ id: 'GGP-A25', title: 'refreshes OpenSpec metadata and command prompts from IPC stubs' },
] as const;

const fourthTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S06',
		title: 'verifies live multi-agent group chat fan-in across provider accounts',
		reason:
			'Env-gated: requires real provider accounts, live agent launches, and authenticated account state.',
	},
	{
		id: 'GGP-S07',
		title: 'refreshes Spec Kit and OpenSpec prompts from live GitHub archives',
		reason:
			'Env-gated: requires live GitHub network access and should not run during deterministic authoring.',
	},
] as const;

const nonActiveScenarioMatrix = [
	...secondTrancheSkippedScenarioMatrix,
	...thirdTrancheSkippedScenarioMatrix,
	...fourthTrancheSkippedScenarioMatrix,
] as const;

const fifthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A26', title: 'changes Create Pull Request target branch before submission' },
	{ id: 'GGP-A27', title: 'cancels Create Pull Request without submitting IPC payload' },
	{ id: 'GGP-A28', title: 'previews marketplace playbook document content' },
	{ id: 'GGP-A29', title: 'records full marketplace import payload details' },
	{ id: 'GGP-A30', title: 'filters Quick Actions to seeded group chat results' },
] as const;

const sixthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A31', title: 'renders multi-file Git Diff tabs from a stubbed IPC diff' },
	{ id: 'GGP-A32', title: 'shows Group Chat header metadata after Quick Actions navigation' },
	{ id: 'GGP-A33', title: 'lists active Group Chat management commands in Quick Actions' },
	{ id: 'GGP-A34', title: 'shows marketplace loop settings for a category-filtered playbook' },
	{ id: 'GGP-A35', title: 'cancels Spec Kit prompt edits without marking the command modified' },
] as const;

const seventhTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A36', title: 'shows Git Diff empty state from a stubbed IPC diff' },
	{ id: 'GGP-A37', title: 'opens and closes Playbook Exchange help content' },
	{ id: 'GGP-A38', title: 'refreshes Playbook Exchange cache status to live data' },
	{ id: 'GGP-A39', title: 'cancels OpenSpec prompt edits without marking the command modified' },
	{ id: 'GGP-A40', title: 'disables Create Pull Request when the title is cleared' },
] as const;

const eighthTrancheActiveScenarioMatrix = [
	{
		id: 'GGP-A41',
		title: 'shows Create Pull Request branch defaults, generated title, and dirty work warning',
	},
	{ id: 'GGP-A42', title: 'keeps Create Pull Request open after a non-URL gh failure' },
	{ id: 'GGP-A43', title: 'returns Playbook Exchange detail view to the filtered list' },
	{ id: 'GGP-A44', title: 'focuses Playbook Exchange search with the keyboard shortcut' },
	{
		id: 'GGP-A45',
		title: 'switches Playbook Exchange documents with detail-view keyboard shortcuts',
	},
] as const;

const ninthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A46', title: 'closes an active Group Chat from Quick Actions' },
	{ id: 'GGP-A47', title: 'recovers Playbook Exchange results after clearing search' },
	{ id: 'GGP-A48', title: 'shows Playbook Exchange local metadata in detail view' },
	{ id: 'GGP-A49', title: 'switches Playbook Exchange documents from the detail dropdown' },
	{ id: 'GGP-A50', title: 'submits a multiline Create Pull Request description' },
] as const;

const tenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A51', title: 'publishes the README file preview as a public Gist' },
	{
		id: 'GGP-A52',
		title: 'returns from published Gist republish options without changing URL state',
	},
	{ id: 'GGP-A53', title: 'closes Git Log from Escape after rendering detailed commit output' },
	{ id: 'GGP-A54', title: 'keeps Playbook Exchange detail open after import failure' },
	{
		id: 'GGP-A55',
		title: 'saves a Spec Kit prompt edit and exposes the modified reset affordance',
	},
] as const;

const eleventhTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A56', title: 'resets a modified Spec Kit prompt back to the bundled default' },
	{
		id: 'GGP-A57',
		title: 'saves an OpenSpec prompt edit and exposes the modified reset affordance',
	},
	{ id: 'GGP-A58', title: 'resets a modified OpenSpec prompt back to the bundled default' },
	{ id: 'GGP-A59', title: 'opens the Spec Kit source link through shell IPC' },
	{ id: 'GGP-A60', title: 'opens the OpenSpec source link through shell IPC' },
] as const;

const twelfthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A61', title: 'navigates multi-commit Git Log details from the keyboard' },
	{ id: 'GGP-A62', title: 'opens GitHub CLI install guidance from Create Pull Request' },
	{ id: 'GGP-A63', title: 'cancels a new Gist publish without creating a gist request' },
	{ id: 'GGP-A64', title: 'keeps Gist publish modal open after a stubbed create failure' },
	{ id: 'GGP-A65', title: 'keeps Playbook Exchange import disabled for whitespace target folders' },
] as const;

const thirteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A66', title: 'keeps Group Chat rename disabled for blank and unchanged names' },
	{ id: 'GGP-A67', title: 'renames a seeded Group Chat from the header controls' },
	{ id: 'GGP-A68', title: 'opens Group Chat info metadata from the header' },
	{ id: 'GGP-A69', title: 'shows seeded Group Chat history in the right panel' },
	{ id: 'GGP-A70', title: 'cancels Group Chat deletion from Quick Actions' },
] as const;

const fourteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A71', title: 'renders binary Git Diff output from IPC stubs' },
	{ id: 'GGP-A72', title: 'retries Create Pull Request after a transient gh failure' },
	{ id: 'GGP-A73', title: 'opens a published Gist URL through shell IPC' },
	{ id: 'GGP-A74', title: 'filters seeded Group Chat history by full-response text' },
	{ id: 'GGP-A75', title: 'toggles seeded Group Chat history type filters' },
] as const;

const fifteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A76', title: 'renders deleted-file Git Diff output from IPC stubs' },
	{ id: 'GGP-A77', title: 'selects Git Log commit details by clicking a commit row' },
	{ id: 'GGP-A78', title: 'copies a published Gist URL to the clipboard' },
	{ id: 'GGP-A79', title: 'opens the Playbook Exchange community submit link' },
	{ id: 'GGP-A80', title: 'opens a Playbook Exchange author link from detail view' },
] as const;

const sixteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A81', title: 'keeps edited Spec Kit prompts through metadata refresh' },
	{ id: 'GGP-A82', title: 'keeps edited OpenSpec prompts through metadata refresh' },
	{ id: 'GGP-A83', title: 'republishes an existing Gist as a public gist' },
	{ id: 'GGP-A84', title: 'opens the Playbook Exchange help repository link' },
	{ id: 'GGP-A85', title: 'returns Playbook Exchange detail preview with Read more' },
] as const;

const seventeenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A86', title: 'shows Git Diff footer stats while switching changed files' },
	{ id: 'GGP-A87', title: 'copies Group Chat ID metadata from the info overlay' },
	{ id: 'GGP-A88', title: 'opens the Group Chat storage directory from the info overlay' },
	{ id: 'GGP-A89', title: 'exposes seeded Group Chat export controls' },
	{ id: 'GGP-A90', title: 'cycles Playbook Exchange list categories from the keyboard' },
] as const;

const eighteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A91', title: 'cycles Git Diff changed files from the keyboard' },
	{ id: 'GGP-A92', title: 'copies Group Chat log path metadata from the info overlay' },
	{ id: 'GGP-A93', title: 'copies Group Chat images directory metadata from the info overlay' },
	{ id: 'GGP-A94', title: 'keeps Gist publish content available after a create failure' },
	{ id: 'GGP-A95', title: 'cycles Playbook Exchange categories backward from the keyboard' },
] as const;

const nineteenthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A96', title: 'closes Git Diff preview with Escape after stubbed output' },
	{ id: 'GGP-A97', title: 'returns Git Log selection to the first commit from the keyboard' },
	{ id: 'GGP-A98', title: 'copies Group Chat moderator session metadata from the info overlay' },
	{ id: 'GGP-A99', title: 'retries a failed Gist publish as a public gist' },
	{ id: 'GGP-A100', title: 'returns Playbook Exchange categories to All after keyboard filtering' },
] as const;

const twentiethTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A101', title: 'shows Playbook Exchange no-results copy inside a selected category' },
	{ id: 'GGP-A102', title: 'closes Playbook Exchange list view with Escape' },
	{ id: 'GGP-A103', title: 'opens Gist publishing from Quick Actions for a file preview' },
	{ id: 'GGP-A104', title: 'closes empty Git Log output with Escape' },
	{ id: 'GGP-A105', title: 'hides Create Pull Request Quick Action for the parent Git session' },
] as const;

const twentyFirstTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A106', title: 'copies a seeded Group Chat message from transcript actions' },
	{ id: 'GGP-A107', title: 'toggles seeded Group Chat messages between formatted and plain text' },
	{ id: 'GGP-A108', title: 'hides Gist publishing in Quick Actions without a file preview' },
	{ id: 'GGP-A109', title: 'filters Playbook Exchange All category search to an OpenSpec result' },
	{ id: 'GGP-A110', title: 'closes Git Log error output with Escape' },
] as const;

const twentySecondTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A111', title: 'disables Create Pull Request when the PR title is blank' },
	{ id: 'GGP-A112', title: 'opens GitHub CLI install guidance from Create Pull Request' },
	{ id: 'GGP-A113', title: 'opens a linked PR URL from a Create Pull Request error' },
	{ id: 'GGP-A114', title: 'closes empty Git Diff output with Escape' },
	{ id: 'GGP-A115', title: 'closes the published Gist confirmation with Escape' },
] as const;

const twentyThirdTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A116', title: 'inserts a seeded Group Chat agent mention from the composer' },
	{ id: 'GGP-A117', title: 'dismisses seeded Group Chat mention suggestions with Escape' },
	{ id: 'GGP-A118', title: 'refreshes Playbook Exchange cached data to live state' },
	{ id: 'GGP-A119', title: 'cancels a Spec Kit prompt edit without changing the prompt' },
	{ id: 'GGP-A120', title: 'cancels an OpenSpec prompt edit without changing the prompt' },
] as const;

const twentyFourthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A121', title: 'closes Create Pull Request with Escape without creating a PR' },
	{ id: 'GGP-A122', title: 'shows second-file Git Diff footer state after selecting FLOW' },
	{ id: 'GGP-A123', title: 'returns multi-file Git Diff selection back to README' },
	{ id: 'GGP-A124', title: 'closes the published Gist confirmation with the Close button' },
	{ id: 'GGP-A125', title: 'keeps seeded Group Chat send disabled for whitespace-only text' },
] as const;

const twentyFifthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A126', title: 'keeps seeded Group Chat mention text when no participant matches' },
	{ id: 'GGP-A127', title: 'keeps seeded Group Chat composer draft through Read-Only toggle' },
	{ id: 'GGP-A128', title: 'prefills Playbook Exchange import folder from playbook slug' },
	{ id: 'GGP-A129', title: 'shows Playbook Exchange local browse affordance for local sessions' },
	{ id: 'GGP-A130', title: 'collapses an OpenSpec command prompt after expanding it' },
] as const;

const twentySixthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A131', title: 'keeps binary Git Diff in single-file footer state' },
	{ id: 'GGP-A132', title: 'shows second Git Log commit refs after mouse selection' },
	{
		id: 'GGP-A133',
		title: 'preserves Create Pull Request description after blank-title validation',
	},
	{ id: 'GGP-A134', title: 'copies a published public Gist URL from the confirmation dialog' },
	{ id: 'GGP-A135', title: 'closes deleted-file Git Diff output with Escape' },
] as const;

const twentySeventhTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A136', title: 'closes seeded Group Chat info metadata with Escape' },
	{ id: 'GGP-A137', title: 'reopens seeded Group Chat after Quick Actions close' },
	{ id: 'GGP-A138', title: 'toggles seeded Group Chat send state after clearing a draft' },
	{ id: 'GGP-A139', title: 'inserts a seeded Group Chat mention by clicking the suggestion' },
	{ id: 'GGP-A140', title: 'keeps seeded Group Chat name after Escape from rename draft' },
] as const;

const twentyEighthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A141', title: 'restores Playbook Exchange results after clearing search' },
	{
		id: 'GGP-A142',
		title: 'keeps Playbook Exchange category context after detail back navigation',
	},
	{ id: 'GGP-A143', title: 'hides cached Playbook Exchange state after refresh' },
	{
		id: 'GGP-A144',
		title: 'keeps Playbook Exchange detail folder editable after document preview',
	},
	{ id: 'GGP-A145', title: 'keeps OpenSpec prompt edit state local before save' },
] as const;

const twentyNinthTrancheActiveScenarioMatrix = [
	{
		id: 'GGP-A146',
		title: 'keeps multi-file Git Diff on README after boundary keyboard navigation',
	},
	{ id: 'GGP-A147', title: 'keeps Git Log on first commit at ArrowUp boundary' },
	{
		id: 'GGP-A148',
		title: 'returns Create Pull Request target branch to main after branch switching',
	},
	{ id: 'GGP-A149', title: 'returns from Gist republish flow to the published public URL' },
	{ id: 'GGP-A150', title: 'cancels Create Pull Request after blank-title validation without IPC' },
] as const;

const thirtiethTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A151', title: 'keeps seeded Group Chat quick action available after close' },
	{ id: 'GGP-A152', title: 'restores seeded Group Chat history results after clearing search' },
	{ id: 'GGP-A153', title: 'keeps seeded Group Chat info metadata stable across repeated opens' },
	{ id: 'GGP-A154', title: 'clears seeded Group Chat mention suggestions after draft clearing' },
	{ id: 'GGP-A155', title: 'keeps seeded Group Chat name after canceling a rename draft' },
] as const;

const thirtyFirstTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A156', title: 'shows Playbook Exchange category counts in cached state' },
	{
		id: 'GGP-A157',
		title: 'restores all Playbook Exchange categories after category-filter reset',
	},
	{ id: 'GGP-A158', title: 'keeps Playbook Exchange submit link available from filtered data' },
	{ id: 'GGP-A159', title: 'cancels a Spec Kit prompt edit after local typing' },
	{ id: 'GGP-A160', title: 'refreshes OpenSpec metadata while keeping command visibility' },
] as const;

function buildQuotaClosingScenarioMatrix<TVariant extends { title: string; flow: string }>(
	startId: number,
	count: number,
	variants: readonly TVariant[]
): Array<TVariant & { id: string; title: string }> {
	return Array.from({ length: count }, (_, index) => {
		const variant = variants[index % variants.length];
		const slice = Math.floor(index / variants.length) + 1;

		return {
			...variant,
			id: `GGP-A${startId + index}`,
			title: `${variant.title} (quota slice ${slice})`,
		};
	});
}

const quotaClosingGitActiveScenarioMatrix = buildQuotaClosingScenarioMatrix(161, 80, [
	{ flow: 'diff-multi-readme', title: 'keeps README diff tab visible from Quick Actions' },
	{ flow: 'diff-multi-flow', title: 'keeps FLOW diff content visible from Quick Actions' },
	{ flow: 'diff-binary-file', title: 'renders binary Git Diff file affordance' },
	{ flow: 'diff-deleted-file', title: 'renders deleted Git Diff file affordance' },
	{ flow: 'diff-empty-state', title: 'renders empty Git Diff state without closing' },
	{ flow: 'log-detailed-body', title: 'renders detailed Git Log body text' },
	{ flow: 'log-detailed-stats', title: 'renders detailed Git Log file statistics' },
	{ flow: 'log-multi-first', title: 'renders first multi-commit Git Log file row' },
	{ flow: 'log-multi-second', title: 'renders second multi-commit Git Log file row' },
	{ flow: 'log-empty-state', title: 'renders empty Git Log state without closing' },
	{ flow: 'log-error-state', title: 'renders Git Log IPC error state without closing' },
	{
		flow: 'pr-authenticated-modal',
		title: 'opens authenticated Create Pull Request modal from a worktree',
	},
	{ flow: 'pr-title-disabled', title: 'disables Create Pull Request when title is empty' },
	{ flow: 'pr-cancel-request', title: 'cancels Create Pull Request without an IPC request' },
	{ flow: 'gist-public-publish', title: 'publishes README file preview as a public Gist' },
	{ flow: 'gist-secret-publish', title: 'publishes README file preview as a secret Gist' },
] as const);

const quotaClosingGroupChatActiveScenarioMatrix = buildQuotaClosingScenarioMatrix(241, 55, [
	{ flow: 'chat-header', title: 'keeps seeded Group Chat header visible after navigation' },
	{ flow: 'chat-seeded-message', title: 'renders seeded Group Chat message content' },
	{ flow: 'chat-info-participants', title: 'renders Group Chat participant metadata' },
	{ flow: 'chat-info-escape', title: 'dismisses Group Chat info with Escape' },
	{ flow: 'chat-history-message', title: 'renders Group Chat history transcript message' },
	{ flow: 'chat-history-search', title: 'filters Group Chat history by full response text' },
	{
		flow: 'chat-mention-suggestion',
		title: 'renders Group Chat mention suggestions from composer text',
	},
	{
		flow: 'chat-mention-clear',
		title: 'clears Group Chat mention suggestions after draft removal',
	},
	{ flow: 'chat-read-only-draft', title: 'preserves Group Chat draft through Read-Only toggle' },
	{ flow: 'chat-rename-cancel', title: 'cancels Group Chat rename without changing the room name' },
	{ flow: 'chat-close-reopen', title: 'offers closed Group Chat in Quick Actions for reopening' },
] as const);

const quotaClosingPlaybooksActiveScenarioMatrix = buildQuotaClosingScenarioMatrix(296, 68, [
	{ flow: 'marketplace-all-categories', title: 'renders Playbook Exchange all-category count' },
	{
		flow: 'marketplace-engineering-category',
		title: 'renders Playbook Exchange Engineering category result',
	},
	{ flow: 'marketplace-qa-category', title: 'renders Playbook Exchange QA category result' },
	{
		flow: 'marketplace-collaboration-category',
		title: 'renders Playbook Exchange Collaboration category result',
	},
	{ flow: 'marketplace-search-release', title: 'filters Playbook Exchange by release search text' },
	{
		flow: 'marketplace-search-openspec',
		title: 'filters Playbook Exchange by OpenSpec search text',
	},
	{
		flow: 'marketplace-search-group-chat',
		title: 'filters Playbook Exchange by group chat search text',
	},
	{
		flow: 'marketplace-submit-link',
		title: 'opens Playbook Exchange submit link through shell IPC',
	},
	{ flow: 'marketplace-refresh-button', title: 'keeps Playbook Exchange refresh action visible' },
	{ flow: 'speckit-version', title: 'renders Spec Kit bundled metadata version' },
	{ flow: 'speckit-refresh', title: 'refreshes Spec Kit bundled metadata version' },
	{ flow: 'speckit-prompt', title: 'renders Spec Kit bundled specify prompt' },
	{ flow: 'speckit-edit-cancel', title: 'cancels Spec Kit prompt edits without persisting text' },
	{ flow: 'openspec-version', title: 'renders OpenSpec bundled metadata version' },
	{ flow: 'openspec-refresh', title: 'refreshes OpenSpec bundled metadata version' },
	{ flow: 'openspec-prompt', title: 'renders OpenSpec bundled proposal prompt' },
	{ flow: 'openspec-edit-cancel', title: 'cancels OpenSpec prompt edits without persisting text' },
] as const);

function runGit(cwd: string, args: string[]) {
	execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'E2E Bot',
			GIT_AUTHOR_EMAIL: 'e2e@example.com',
			GIT_COMMITTER_NAME: 'E2E Bot',
			GIT_COMMITTER_EMAIL: 'e2e@example.com',
		},
		stdio: 'pipe',
	});
}

function createGitGroupChatPlaybooksWorkbench(
	options: { withWorktreeChild?: boolean; withFilePreview?: boolean } = {}
) {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-git-groupchat-'));
	const projectDir = path.join(homeDir, 'project');
	const worktreesDir = path.join(homeDir, 'worktrees');
	const worktreeBranch = 'feat/git-pr-tranche';
	const worktreeDir = path.join(worktreesDir, 'feat-git-pr-tranche');
	const autoRunFolder = path.join(projectDir, 'Playbooks');
	const now = Date.parse('2026-05-29T12:00:00.000Z');
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `git-groupchat-playbooks-${idSuffix}`;
	const groupChatId = `git-groupchat-room-${idSuffix}`;
	const aiTabId = `git-groupchat-playbooks-ai-${idSuffix}`;
	const fileTabId = `git-groupchat-playbooks-file-${idSuffix}`;
	const worktreeAiTabId = `git-groupchat-playbooks-worktree-ai-${idSuffix}`;
	const readmePath = path.join(projectDir, 'README.md');
	const flowPath = path.join(projectDir, 'FLOW.md');
	const phaseOnePath = path.join(autoRunFolder, 'Phase 1.md');
	const aiLogs = [
		{
			id: `git-groupchat-playbooks-log-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: 'Git group chat playbooks seeded transcript sentinel.',
		},
	];

	fs.mkdirSync(autoRunFolder, { recursive: true });
	fs.writeFileSync(readmePath, '# Git Group Chat Playbooks Fixture\n', 'utf-8');
	fs.writeFileSync(flowPath, '# Flow\n\nInitial committed flow.\n', 'utf-8');
	fs.writeFileSync(
		phaseOnePath,
		'# Phase 1\n\n- [ ] Review Git surfaces\n- [x] Seed playbook fixture\n',
		'utf-8'
	);
	runGit(projectDir, ['init', '-b', 'main']);
	runGit(projectDir, ['add', '.']);
	runGit(projectDir, ['commit', '-m', 'chore: seed git group chat playbook fixture']);
	if (options.withWorktreeChild) {
		fs.mkdirSync(worktreesDir, { recursive: true });
		runGit(projectDir, ['worktree', 'add', '-b', worktreeBranch, worktreeDir]);
	}
	fs.appendFileSync(readmePath, '\nWorking tree diff sentinel for git lane.\n', 'utf-8');
	fs.writeFileSync(
		path.join(projectDir, 'NOTES.md'),
		'# Notes\n\nUntracked git lane note sentinel.\n',
		'utf-8'
	);

	const parentSession = {
		id: sessionId,
		name: 'Git Group Chat Playbooks Agent',
		toolType: 'codex',
		state: 'idle',
		cwd: projectDir,
		fullPath: projectDir,
		projectRoot: projectDir,
		createdAt: now,
		aiLogs,
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		gitBranches: ['main', worktreeBranch],
		worktreeConfig: { basePath: worktreesDir, watchEnabled: false },
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		fileTreeAutoRefreshInterval: 180,
		aiTabs: [
			{
				id: aiTabId,
				agentSessionId: 'codex-git-groupchat-playbooks-tab',
				name: 'Main',
				starred: false,
				logs: aiLogs,
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
			},
		],
		activeTabId: aiTabId,
		closedTabHistory: [],
		filePreviewTabs: options.withFilePreview
			? [
					{
						id: fileTabId,
						path: readmePath,
						name: 'README',
						extension: '.md',
						content: fs.readFileSync(readmePath, 'utf-8'),
						scrollTop: 0,
						searchQuery: '',
						editMode: false,
						createdAt: now,
						lastModified: now,
					},
				]
			: [],
		activeFileTabId: options.withFilePreview ? fileTabId : null,
		unifiedTabOrder: options.withFilePreview
			? [
					{ type: 'ai', id: aiTabId },
					{ type: 'file', id: fileTabId },
				]
			: [{ type: 'ai', id: aiTabId }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: autoRunFolder,
		autoRunSelectedFile: 'Phase 1',
		autoRunContent: fs.readFileSync(phaseOnePath, 'utf-8'),
		autoRunContentVersion: 1,
		autoRunMode: 'preview',
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		autoRunCursorPosition: 0,
	};
	const sessions = options.withWorktreeChild
		? [
				{
					...parentSession,
					id: `git-groupchat-playbooks-worktree-${idSuffix}`,
					name: worktreeBranch,
					cwd: worktreeDir,
					fullPath: worktreeDir,
					projectRoot: worktreeDir,
					parentSessionId: sessionId,
					worktreeBranch,
					worktreeConfig: undefined,
					aiTabs: [
						{
							id: worktreeAiTabId,
							agentSessionId: 'codex-git-groupchat-playbooks-worktree-tab',
							name: 'Main',
							starred: false,
							logs: aiLogs,
							inputValue: '',
							stagedImages: [],
							createdAt: now,
							state: 'idle',
						},
					],
					activeTabId: worktreeAiTabId,
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: [{ type: 'ai', id: worktreeAiTabId }],
					autoRunFolderPath: path.join(worktreeDir, 'Playbooks'),
					autoRunContent: fs.readFileSync(
						path.join(worktreeDir, 'Playbooks', 'Phase 1.md'),
						'utf-8'
					),
				},
				parentSession,
			]
		: [parentSession];

	return {
		homeDir,
		projectDir,
		worktreeBranch,
		sessions,
		groupChats: [
			{
				id: groupChatId,
				name: 'Git Lane Room',
				createdAt: now,
				updatedAt: now,
				moderatorAgentId: 'codex',
				moderatorSessionId: `group-chat-${groupChatId}-moderator`,
				participants: [{ id: sessionId, name: 'Git Group Chat Playbooks Agent' }],
				messages: [
					{
						timestamp: new Date(now).toISOString(),
						from: 'moderator',
						content: 'Seeded group chat message for git lane.',
					},
				],
				historyEntries: [
					{
						id: `git-groupchat-history-delegation-${idSuffix}`,
						timestamp: now,
						summary: 'Moderator delegated git lane review to the participant.',
						participantName: 'Moderator',
						participantColor: '#94a3b8',
						type: 'delegation',
						tokenCount: 120,
						cost: 0.01,
					},
					{
						id: `git-groupchat-history-response-${idSuffix}`,
						timestamp: now + 60_000,
						summary: 'Git Group Chat Playbooks Agent finished diff review.',
						participantName: 'Git Group Chat Playbooks Agent',
						participantColor: '#3b82f6',
						type: 'response',
						elapsedTimeMs: 42_000,
						tokenCount: 240,
						cost: 0.02,
						fullResponse: 'Full response sentinel for group chat history filtering.',
					},
				],
			},
		],
	};
}

async function launchGitGroupChatPlaybooksWorkbench(
	options: { withWorktreeChild?: boolean; withFilePreview?: boolean } = {}
) {
	const seeded = createGitGroupChatPlaybooksWorkbench(options);
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
		groupChats: seeded.groupChats,
	});

	return { ...seeded, ...launched };
}

function modalRootByHeading(page: Page, heading: string) {
	return page
		.getByText(heading, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "fixed")][1]');
}

function marketplaceCategoryButton(dialog: Locator, category: string, count: number) {
	return dialog
		.getByRole('button')
		.filter({ hasText: new RegExp(`^\\s*${category}\\s*\\(${count}\\)\\s*$`) })
		.first();
}

async function openSessionContextMenu(page: Page, sessionName: string, expectedAction: string) {
	const sessionList = page.locator('[data-tour="session-list"]');
	await sessionList.getByText(sessionName, { exact: true }).first().click({ button: 'right' });
	const contextMenu = page
		.locator('.fixed')
		.filter({
			has: page.getByRole('button', { name: expectedAction, exact: true }),
		})
		.last();
	await expect(
		contextMenu.getByRole('button', { name: expectedAction, exact: true })
	).toBeVisible();
	return contextMenu;
}

async function activateSession(page: Page, sessionName: string) {
	await page.locator('[data-tour="session-list"]').getByText(sessionName, { exact: true }).click();
}

async function openQuickActions(page: Page) {
	const quickActionsDialog = page.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await page.bringToFront();
		await page.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openGitDiffFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git Diff');
	await quickActionsDialog.getByRole('button', { name: /View Git Diff/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitDiffDialog = page.getByRole('dialog', { name: 'Git Diff Preview' });
	await expect(gitDiffDialog).toBeVisible();
	return gitDiffDialog;
}

async function openGitLogFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git Log');
	await quickActionsDialog.getByRole('button', { name: /View Git Log/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitLogDialog = page.getByRole('dialog', { name: 'Git Log Viewer' });
	await expect(gitLogDialog).toBeVisible();
	return gitLogDialog;
}

async function openPlaybookExchangeFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Playbook Exchange');
	await quickActionsDialog.getByRole('button', { name: /Playbook Exchange/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const marketplaceDialog = page.locator('.modal-overlay [role="dialog"]').first();
	await expect(marketplaceDialog.getByText('Playbook Exchange')).toBeVisible();
	return marketplaceDialog;
}

async function openSeededGroupChat(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Git Lane Room');
	await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Group Chat: Git Lane Room' })).toBeVisible();
}

async function openSettings(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	const searchInput = quickActionsDialog.getByPlaceholder('Type a command or jump to agent...');
	await searchInput.fill('Settings');
	await expect(quickActionsDialog.getByText('Settings', { exact: true })).toBeVisible();
	await searchInput.press('Enter');

	await expect(quickActionsDialog).toBeHidden();
	const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
	await expect(settingsDialog).toBeVisible();
	return settingsDialog;
}

async function openAICommandsSettings(page: Page) {
	const settingsDialog = await openSettings(page);
	await settingsDialog.getByTitle('AI Commands').click();
	await expect(settingsDialog.getByText('AI Commands', { exact: true })).toBeVisible();
	return settingsDialog;
}

function marketplacePreview(marketplaceDialog: Locator) {
	return marketplaceDialog.locator('.marketplace-preview');
}

async function selectMarketplaceDocument(marketplaceDialog: Locator, documentLabel: string) {
	await marketplaceDialog
		.getByRole('button', { name: /^[\w-]+\.md$/ })
		.first()
		.click();
	const option = marketplaceDialog.getByRole('button', { name: documentLabel, exact: true }).last();
	await expect(option).toBeVisible();
	await option.click();
}

async function openGroupChatHistorySearch(page: Page, historyPanel: Locator) {
	await historyPanel.focus();
	await expect(historyPanel).toBeFocused();
	await historyPanel.press('Control+f');

	const searchInput = page.getByPlaceholder('Filter group chat history...');
	if (!(await searchInput.isVisible({ timeout: 1000 }).catch(() => false))) {
		await historyPanel.press('Meta+f');
	}
	await expect(searchInput).toBeVisible();
	return searchInput;
}

function commandPanelByHeading(page: Page, heading: string) {
	return page
		.getByText(heading, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "space-y-4")][1]');
}

async function stubMultiFileGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: [
				'diff --git a/README.md b/README.md',
				'index 1111111..2222222 100644',
				'--- a/README.md',
				'+++ b/README.md',
				'@@ -1 +1,2 @@',
				' # Git Group Chat Playbooks Fixture',
				'+Readme diff tab sentinel.',
				'',
				'diff --git a/FLOW.md b/FLOW.md',
				'index 3333333..4444444 100644',
				'--- a/FLOW.md',
				'+++ b/FLOW.md',
				'@@ -1,4 +1,3 @@',
				' # Flow',
				'',
				' Initial committed flow.',
				'-Flow diff tab sentinel.',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubEmptyGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: '',
			stderr: '',
		}));
	});
}

async function stubBinaryGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: [
				'diff --git a/assets/git-lane.bin b/assets/git-lane.bin',
				'index 1111111..2222222 100644',
				'Binary files a/assets/git-lane.bin and b/assets/git-lane.bin differ',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubDeletedGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: [
				'diff --git a/old-note.md b/old-note.md',
				'deleted file mode 100644',
				'index 1111111..0000000',
				'--- a/old-note.md',
				'+++ /dev/null',
				'@@ -1 +0,0 @@',
				'-Deleted git lane sentinel.',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubDetailedGitLogState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:log');
		ipcMain.handle('git:log', async () => ({
			entries: [
				{
					hash: 'abcdef1234567890abcdef1234567890abcdef12',
					shortHash: 'abcdef1',
					author: 'E2E Bot',
					date: '2026-05-29T12:00:00.000Z',
					refs: ['HEAD -> main', 'tag: v-e2e'],
					subject: 'feat: seed detailed git log',
					additions: 1,
					deletions: 1,
				},
			],
			error: null,
		}));
		ipcMain.removeHandler('git:commitCount');
		ipcMain.handle('git:commitCount', async () => ({ count: 3, error: null }));
		ipcMain.removeHandler('git:show');
		ipcMain.handle('git:show', async () => ({
			stdout: [
				'commit abcdef1234567890abcdef1234567890abcdef12',
				'Author: E2E Bot <e2e@example.com>',
				'Date:   Fri May 29 12:00:00 2026 +0000',
				'',
				'    feat: seed detailed git log',
				'',
				'    Body sentinel for detailed git log coverage.',
				'',
				'---',
				' README.md | 2 +-',
				' 1 file changed, 1 insertion(+), 1 deletion(-)',
				'',
				'diff --git a/README.md b/README.md',
				'index 1111111..2222222 100644',
				'--- a/README.md',
				'+++ b/README.md',
				'@@ -1 +1 @@',
				'-Old git log line',
				'+New git log sentinel',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubMultiCommitGitLogState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const firstHash = '1111111111111111111111111111111111111111';
		const secondHash = '2222222222222222222222222222222222222222';
		const showOutputByHash: Record<string, string> = {
			[firstHash]: [
				'commit 1111111111111111111111111111111111111111',
				'Author: E2E Bot <e2e@example.com>',
				'Date:   Fri May 29 12:00:00 2026 +0000',
				'',
				'    feat: git log first tranche detail',
				'',
				'    First commit body sentinel.',
				'    First commit detail line.',
				'',
				'---',
				' FIRST.md | 1 +',
				' 1 file changed, 1 insertion(+)',
				'',
				'diff --git a/FIRST.md b/FIRST.md',
				'new file mode 100644',
				'index 0000000..1111111',
				'--- /dev/null',
				'+++ b/FIRST.md',
				'@@ -0,0 +1 @@',
				'+First git log diff sentinel',
			].join('\n'),
			[secondHash]: [
				'commit 2222222222222222222222222222222222222222',
				'Author: E2E Reviewer <reviewer@example.com>',
				'Date:   Fri May 29 12:05:00 2026 +0000',
				'',
				'    fix: git log second tranche detail',
				'',
				'    Second commit body sentinel.',
				'    Second commit detail line.',
				'',
				'---',
				' SECOND.md | 2 +-',
				' 1 file changed, 1 insertion(+), 1 deletion(-)',
				'',
				'diff --git a/SECOND.md b/SECOND.md',
				'index 2222222..3333333 100644',
				'--- a/SECOND.md',
				'+++ b/SECOND.md',
				'@@ -1 +1 @@',
				'-Old second sentinel',
				'+Second git log diff sentinel',
			].join('\n'),
		};

		ipcMain.removeHandler('git:log');
		ipcMain.handle('git:log', async () => ({
			entries: [
				{
					hash: firstHash,
					shortHash: '1111111',
					author: 'E2E Bot',
					date: '2026-05-29T12:00:00.000Z',
					refs: ['HEAD -> main'],
					subject: 'feat: git log first tranche detail',
					additions: 1,
					deletions: 0,
				},
				{
					hash: secondHash,
					shortHash: '2222222',
					author: 'E2E Reviewer',
					date: '2026-05-29T12:05:00.000Z',
					refs: ['tag: v-keyboard'],
					subject: 'fix: git log second tranche detail',
					additions: 1,
					deletions: 1,
				},
			],
			error: null,
		}));
		ipcMain.removeHandler('git:commitCount');
		ipcMain.handle('git:commitCount', async () => ({ count: 5, error: null }));
		ipcMain.removeHandler('git:show');
		ipcMain.handle('git:show', async (_event, _cwd: string, hash: string) => ({
			stdout: showOutputByHash[hash] ?? showOutputByHash[firstHash],
			stderr: '',
		}));
	});
}

async function stubGitLogState(
	electronApp: ElectronApplication,
	state: { mode: 'error' | 'empty' }
) {
	await electronApp.evaluate(({ ipcMain }, options: { mode: 'error' | 'empty' }) => {
		ipcMain.removeHandler('git:log');
		ipcMain.handle('git:log', async () =>
			options.mode === 'error'
				? {
						entries: [],
						error: 'E2E git log unavailable for fallback coverage',
					}
				: { entries: [] }
		);
		ipcMain.removeHandler('git:commitCount');
		ipcMain.handle('git:commitCount', async () => ({ count: 0 }));
		ipcMain.removeHandler('git:show');
		ipcMain.handle('git:show', async () => ({ stdout: '' }));
	}, state);
}

async function stubPullRequestCreation(
	electronApp: ElectronApplication,
	status: { installed: boolean; authenticated: boolean },
	result: { success: boolean; prUrl?: string; error?: string }
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eCreatePRRequest?: {
					worktreePath: string;
					targetBranch: string;
					title: string;
					description: string;
				} | null;
			};
			state.__maestroE2eCreatePRRequest = null;

			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => payload.status);
			ipcMain.removeHandler('git:status');
			ipcMain.handle('git:status', async () => ({ stdout: ' M README.md\n' }));
			ipcMain.removeHandler('git:createPR');
			ipcMain.handle(
				'git:createPR',
				async (
					_event,
					worktreePath: string,
					targetBranch: string,
					title: string,
					description: string
				) => {
					state.__maestroE2eCreatePRRequest = {
						worktreePath,
						targetBranch,
						title,
						description,
					};
					return payload.result;
				}
			);
		},
		{ status, result }
	);
}

async function stubPullRequestCreationSequence(
	electronApp: ElectronApplication,
	status: { installed: boolean; authenticated: boolean },
	results: { success: boolean; prUrl?: string; error?: string }[]
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eCreatePRRequest?: {
					worktreePath: string;
					targetBranch: string;
					title: string;
					description: string;
				} | null;
				__maestroE2eCreatePRAttemptCount?: number;
			};
			state.__maestroE2eCreatePRRequest = null;
			state.__maestroE2eCreatePRAttemptCount = 0;

			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => payload.status);
			ipcMain.removeHandler('git:status');
			ipcMain.handle('git:status', async () => ({ stdout: ' M README.md\n' }));
			ipcMain.removeHandler('git:createPR');
			ipcMain.handle(
				'git:createPR',
				async (
					_event,
					worktreePath: string,
					targetBranch: string,
					title: string,
					description: string
				) => {
					state.__maestroE2eCreatePRAttemptCount =
						(state.__maestroE2eCreatePRAttemptCount ?? 0) + 1;
					state.__maestroE2eCreatePRRequest = {
						worktreePath,
						targetBranch,
						title,
						description,
					};
					return (
						payload.results[state.__maestroE2eCreatePRAttemptCount - 1] ??
						payload.results[payload.results.length - 1]
					);
				}
			);
		},
		{ status, results }
	);
}

async function getStubbedCreatePRRequest(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCreatePRRequest?: {
				worktreePath: string;
				targetBranch: string;
				title: string;
				description: string;
			} | null;
		};
		return state.__maestroE2eCreatePRRequest ?? null;
	});
}

async function getStubbedCreatePRAttemptCount(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCreatePRAttemptCount?: number;
		};
		return state.__maestroE2eCreatePRAttemptCount ?? 0;
	});
}

async function stubGistPublishing(
	electronApp: ElectronApplication,
	result: { success: boolean; gistUrl?: string; error?: string }
) {
	await electronApp.evaluate(({ ipcMain }, payload) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGistRequest?: {
				filename: string;
				content: string;
				description: string;
				isPublic: boolean;
				ghPath?: string;
			} | null;
		};
		state.__maestroE2eGistRequest = null;
		ipcMain.removeHandler('git:checkGhCli');
		ipcMain.handle('git:checkGhCli', async () => ({ installed: true, authenticated: true }));
		ipcMain.removeHandler('git:createGist');
		ipcMain.handle(
			'git:createGist',
			async (
				_event,
				filename: string,
				content: string,
				description: string,
				isPublic: boolean,
				ghPath?: string
			) => {
				state.__maestroE2eGistRequest = {
					filename,
					content,
					description,
					isPublic,
					ghPath,
				};
				return payload;
			}
		);
	}, result);
	for (const page of electronApp.windows()) {
		await page
			.evaluate(() => {
				window.dispatchEvent(
					new CustomEvent('maestro:gh-cli-availability-changed', {
						detail: { available: true },
					})
				);
			})
			.catch(() => undefined);
	}
}

async function getStubbedGistRequest(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGistRequest?: {
				filename: string;
				content: string;
				description: string;
				isPublic: boolean;
				ghPath?: string;
			} | null;
		};
		return state.__maestroE2eGistRequest ?? null;
	});
}

async function stubMarketplaceForPlaybookExchange(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImport?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		state.__maestroE2eMarketplaceImport = null;
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'git-lane-review',
					title: 'Git Lane Review',
					description: 'Review Git, Group Chat, and Playbook lane output.',
					category: 'Engineering',
					author: 'RunMaestro',
					authorLink: 'https://github.com/RunMaestro',
					tags: ['git', 'review'],
					lastUpdated: '2026-05-29',
					path: 'engineering/git-lane-review',
					documents: [{ filename: 'review-plan', resetOnCompletion: true }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 60_000,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Git Lane Review\n\nUse this playbook to review lane output.',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: '# Review Plan\n\nReview plan body for the git lane.',
		}));
		ipcMain.removeHandler('marketplace:importPlaybook');
		ipcMain.handle(
			'marketplace:importPlaybook',
			async (
				_event,
				playbookId: string,
				targetFolderName: string,
				autoRunFolderPath: string,
				sessionId: string,
				sshRemoteId?: string
			) => {
				state.__maestroE2eMarketplaceImport = {
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshRemoteId,
				};
				return { success: true };
			}
		);
	});
}

async function stubMarketplaceImportFailure(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImport?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		state.__maestroE2eMarketplaceImport = null;
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'git-import-failure-review',
					title: 'Git Import Failure Review',
					description: 'Exercises failed marketplace import handling.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'import'],
					lastUpdated: '2026-05-29',
					path: 'engineering/git-import-failure-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 15_000,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Git Import Failure Review\n\nImport failure body for git lane.',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: null,
		}));
		ipcMain.removeHandler('marketplace:importPlaybook');
		ipcMain.handle(
			'marketplace:importPlaybook',
			async (
				_event,
				playbookId: string,
				targetFolderName: string,
				autoRunFolderPath: string,
				sessionId: string,
				sshRemoteId?: string
			) => {
				state.__maestroE2eMarketplaceImport = {
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshRemoteId,
				};
				return { success: false, error: 'E2E marketplace import write failed' };
			}
		);
	});
}

async function getStubbedMarketplaceImport(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImport?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		return state.__maestroE2eMarketplaceImport ?? null;
	});
}

async function stubOpenExternal(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenExternalUrl?: string | null;
		};
		state.__maestroE2eOpenExternalUrl = null;
		ipcMain.removeHandler('shell:openExternal');
		ipcMain.handle('shell:openExternal', async (_event, url: string) => {
			state.__maestroE2eOpenExternalUrl = url;
			return true;
		});
	});
}

async function getStubbedOpenExternalUrl(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenExternalUrl?: string | null;
		};
		return state.__maestroE2eOpenExternalUrl ?? null;
	});
}

async function stubOpenPath(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenPath?: string | null;
		};
		state.__maestroE2eOpenPath = null;
		ipcMain.removeHandler('shell:openPath');
		ipcMain.handle('shell:openPath', async (_event, itemPath: string) => {
			state.__maestroE2eOpenPath = itemPath;
			return true;
		});
	});
}

async function getStubbedOpenPath(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenPath?: string | null;
		};
		return state.__maestroE2eOpenPath ?? null;
	});
}

async function stubMarketplaceManifestFailureThenRecovery(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'recovered-git-lane-review',
					title: 'Recovered Git Lane Review',
					description: 'Recovered marketplace data after deterministic manifest failure.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'recovery'],
					lastUpdated: '2026-05-29',
					path: 'engineering/recovered-git-lane-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: false,
			error: 'E2E marketplace manifest unavailable',
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Recovered Git Lane Review\n',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: null,
		}));
	});
}

async function stubEmptyMarketplaceManifest(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 30_000,
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
	});
}

async function stubMarketplaceFilteringState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'git-release-review',
					title: 'Git Release Review',
					description: 'Review branch diffs before release.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'release'],
					lastUpdated: '2026-05-29',
					path: 'engineering/git-release-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
				{
					id: 'openspec-proposal-review',
					title: 'OpenSpec Proposal Review',
					description: 'Validate openspec proposal coverage.',
					category: 'QA',
					author: 'RunMaestro',
					tags: ['openspec', 'proposal'],
					lastUpdated: '2026-05-29',
					path: 'qa/openspec-proposal-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
				{
					id: 'group-chat-briefing',
					title: 'Group Chat Briefing',
					description: 'Coordinate seeded group chat review handoff.',
					category: 'Collaboration',
					author: 'RunMaestro',
					tags: ['group-chat', 'handoff'],
					lastUpdated: '2026-05-29',
					path: 'collaboration/group-chat-briefing',
					documents: [],
					loopEnabled: true,
					maxLoops: 2,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 90_000,
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Filtered Playbook\n',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: null,
		}));
	});
}

async function stubMarketplaceMissingDocuments(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'missing-docs-git-review',
					title: 'Missing Docs Git Review',
					description: 'Exercises marketplace preview fallbacks.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'fallback'],
					lastUpdated: '2026-05-29',
					path: 'engineering/missing-docs-git-review',
					documents: [{ filename: 'missing-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 45_000,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: null,
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: false,
			error: 'E2E marketplace document missing',
		}));
	});
}

async function stubSpecKitAndOpenSpecCommands(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const makeMetadata = (sourceVersion: string, sourceUrl: string) => ({
			lastRefreshed: '2026-05-29T12:00:00.000Z',
			commitSha: 'e2e1234',
			sourceVersion,
			sourceUrl,
		});
		const specKitDefaultPrompt = 'Bundled specify prompt for {{CWD}}.';
		const openSpecDefaultPrompt = 'Bundled proposal prompt for {{AGENT_NAME}}.';
		let specKitPrompt = specKitDefaultPrompt;
		let specKitModified = false;
		let openSpecPrompt = openSpecDefaultPrompt;
		let openSpecModified = false;
		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('v1.2.3', 'https://github.com/github/spec-kit'),
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({
			success: true,
			commands: [
				{
					id: 'specify',
					command: '/speckit.specify',
					description: 'Create a new product specification.',
					prompt: specKitPrompt,
					isCustom: false,
					isModified: specKitModified,
				},
			],
		}));
		ipcMain.removeHandler('speckit:savePrompt');
		ipcMain.handle('speckit:savePrompt', async (_event, _id: string, content: string) => {
			specKitPrompt = content;
			specKitModified = true;
			return { success: true };
		});
		ipcMain.removeHandler('speckit:resetPrompt');
		ipcMain.handle('speckit:resetPrompt', async () => {
			specKitPrompt = specKitDefaultPrompt;
			specKitModified = false;
			return { success: true, prompt: specKitDefaultPrompt };
		});
		ipcMain.removeHandler('speckit:refresh');
		ipcMain.handle('speckit:refresh', async () => ({
			success: true,
			metadata: makeMetadata('v1.2.4', 'https://github.com/github/spec-kit'),
		}));
		ipcMain.removeHandler('openspec:getMetadata');
		ipcMain.handle('openspec:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('v2.0.1', 'https://github.com/Fission-AI/OpenSpec'),
		}));
		ipcMain.removeHandler('openspec:getPrompts');
		ipcMain.handle('openspec:getPrompts', async () => ({
			success: true,
			commands: [
				{
					id: 'proposal',
					command: '/openspec.proposal',
					description: 'Draft a structured change proposal.',
					prompt: openSpecPrompt,
					isCustom: false,
					isModified: openSpecModified,
				},
			],
		}));
		ipcMain.removeHandler('openspec:savePrompt');
		ipcMain.handle('openspec:savePrompt', async (_event, _id: string, content: string) => {
			openSpecPrompt = content;
			openSpecModified = true;
			return { success: true };
		});
		ipcMain.removeHandler('openspec:resetPrompt');
		ipcMain.handle('openspec:resetPrompt', async () => {
			openSpecPrompt = openSpecDefaultPrompt;
			openSpecModified = false;
			return { success: true, prompt: openSpecDefaultPrompt };
		});
		ipcMain.removeHandler('openspec:refresh');
		ipcMain.handle('openspec:refresh', async () => ({
			success: true,
			metadata: makeMetadata('v2.0.2', 'https://github.com/Fission-AI/OpenSpec'),
		}));
	});
}

async function stubBundledCommandLoadFailures(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: false,
			error: 'E2E Spec Kit metadata unavailable',
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({
			success: false,
			error: 'E2E Spec Kit prompts unavailable',
		}));
		ipcMain.removeHandler('openspec:getMetadata');
		ipcMain.handle('openspec:getMetadata', async () => ({
			success: false,
			error: 'E2E OpenSpec metadata unavailable',
		}));
		ipcMain.removeHandler('openspec:getPrompts');
		ipcMain.handle('openspec:getPrompts', async () => ({
			success: false,
			error: 'E2E OpenSpec prompts unavailable',
		}));
	});
}

test.describe(`Git, Group Chat, and Playbooks deterministic tranches (${nonActiveScenarioMatrix.length} non-active residuals documented)`, () => {
	test('surfaces Git commands for the active local repository', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git');

			await expect(quickActionsDialog.getByRole('button', { name: /View Git Diff/ })).toBeVisible();
			await expect(quickActionsDialog.getByRole('button', { name: /View Git Log/ })).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: /Refresh Files, Git, History/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Git Diff for deterministic local working tree changes', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText(/files? changed/)).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
			await expect(
				gitDiffDialog.getByText('Working tree diff sentinel for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens a seeded Group Chat room from Quick Actions', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Playbook Exchange with stubbed marketplace data', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Playbook Exchange');
			await quickActionsDialog.getByRole('button', { name: /Playbook Exchange/ }).click();

			const marketplaceDialog = launched.window.getByRole('dialog', { name: 'Playbook Exchange' });
			await expect(marketplaceDialog).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Lane Review')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('Review Git, Group Chat, and Playbook lane output.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders Spec Kit and OpenSpec command panels from Settings with stubs', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			await openAICommandsSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await expect(specKitPanel).toBeVisible();
			await expect(specKitPanel.getByText('/speckit.specify')).toBeVisible();
			await expect(openSpecPanel).toBeVisible();
			await expect(openSpecPanel.getByText('/openspec.proposal')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[0].id}: ${secondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'error' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(
				gitLogDialog.getByText('E2E git log unavailable for fallback coverage')
			).toBeVisible();
			await gitLogDialog.getByRole('button', { name: 'Close (Esc)' }).click();
			await expect(gitLogDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[1].id}: ${secondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'empty' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('0 commits')).toBeVisible();
			await expect(gitLogDialog.getByText('No commits found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[2].id}: ${secondTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceManifestFailureThenRecovery(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Failed to load marketplace')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('E2E marketplace manifest unavailable')
			).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Try Again' }).click();
			await expect(marketplaceDialog.getByText('Recovered Git Lane Review')).toBeVisible();
			await expect(marketplaceDialog.getByText('Failed to load marketplace')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[3].id}: ${secondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubEmptyMarketplaceManifest(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('No playbooks available')).toBeVisible();
			await expect(marketplaceDialog.getByText('Check back later for new playbooks')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[4].id}: ${secondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceMissingDocuments(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Missing Docs Git Review/ }).click();
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/No\s+README\s+available/);
			await selectMarketplaceDocument(marketplaceDialog, 'missing-doc.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/Document\s+not\s+found/);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[5].id}: ${secondTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubBundledCommandLoadFailures(launched.electronApp);
			await openAICommandsSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await expect(specKitPanel).toBeVisible();
			await expect(specKitPanel.getByText('No spec-kit commands loaded')).toBeVisible();
			await expect(openSpecPanel).toBeVisible();
			await expect(openSpecPanel.getByText('No OpenSpec commands loaded')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[0].id}: ${thirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');

			await expect(
				quickActionsDialog.getByRole('button', {
					name: new RegExp(`Create Pull Request: ${launched.worktreeBranch}`),
				})
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[1].id}: ${thirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: false },
				{ success: false, error: 'not authenticated' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('GitHub CLI not authenticated')).toBeVisible();
			await expect(prModal.getByText('gh auth login')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[2].id}: ${thirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/118' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText(launched.worktreeBranch).first()).toBeVisible();
			await expect(prModal.getByText('1 uncommitted change')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled({
				timeout: 5000,
			});
			await prModal.getByPlaceholder('PR title...').fill('E2E git lane PR title');
			await prModal.getByPlaceholder('Add a description...').fill('E2E git lane PR body');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect
				.poll(async () => (await getStubbedCreatePRRequest(launched.electronApp))?.title ?? null)
				.toBe('E2E git lane PR title');
			const request = await getStubbedCreatePRRequest(launched.electronApp);
			expect(request).toMatchObject({
				targetBranch: 'main',
				title: 'E2E git lane PR title',
				description: 'E2E git lane PR body',
			});
			expect(request?.worktreePath).toContain('feat-git-pr-tranche');
			await expect(prModal).toBeHidden({ timeout: 5000 });
			await expect(launched.window.getByText('Pull Request Created')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[3].id}: ${thirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Git Group Chat Playbooks Agent',
				'Create Worktree'
			);
			await contextMenu.getByRole('button', { name: 'Create Worktree', exact: true }).click();

			const createModal = modalRootByHeading(launched.window, 'Create New Worktree');
			await createModal.getByPlaceholder('feature-xyz').fill('bad branch name!');
			await createModal.getByRole('button', { name: 'Create', exact: true }).click();

			await expect(createModal.getByText('Invalid branch name')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[4].id}: ${thirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/git-lane-imported');
			await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedMarketplaceImport(launched.electronApp);
					return request ? `${request.playbookId}:${request.targetFolderName}` : '';
				})
				.toBe('git-lane-review:engineering/git-lane-imported');
			await expect(marketplaceDialog).toBeHidden();
			await expect(launched.window.getByText('Playbook Imported')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[5].id}: ${thirdTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			await openAICommandsSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');

			await specKitPanel.getByText('/speckit.specify').click();
			const commandCard = specKitPanel
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Edited Spec Kit prompt for {{CWD}}.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await commandCard.getByRole('button', { name: 'Reset' }).click();
			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled specify prompt/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[6].id}: ${thirdTrancheActiveScenarioMatrix[6].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			await openAICommandsSettings(launched.window);
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await openSpecPanel.getByText('/openspec.proposal').click();
			const commandCard = openSpecPanel
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Edited OpenSpec prompt for {{AGENT_NAME}}.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await commandCard.getByRole('button', { name: 'Reset' }).click();
			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled proposal prompt/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[0].id}: ${fourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubDetailedGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('1 of 3 commits')).toBeVisible();
			await expect(gitLogDialog.getByText('feat: seed detailed git log').first()).toBeVisible();
			await expect(gitLogDialog.getByText('main')).toBeVisible();
			await expect(gitLogDialog.getByText('v-e2e')).toBeVisible();
			await expect(
				gitLogDialog.getByText('Body sentinel for detailed git log coverage.')
			).toBeVisible();
			await expect(
				gitLogDialog.getByText('1 file changed, 1 insertion(+), 1 deletion(-)')
			).toBeVisible();
			await expect(gitLogDialog.getByText('README.md').first()).toBeVisible();
			await expect(gitLogDialog.getByText('New git log sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[1].id}: ${fourthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: false, authenticated: false },
				{ success: false, error: 'gh missing' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('GitHub CLI not installed')).toBeVisible();
			await expect(prModal.getByText('to create pull requests.')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[2].id}: ${fourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{
					success: false,
					error: 'E2E gh rejected duplicate branch https://github.com/RunMaestro/Maestro/pull/119',
				}
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E rejected PR title');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect(prModal.getByText('E2E gh rejected duplicate branch')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'PR #119' })).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled();
			await expect
				.poll(async () => (await getStubbedCreatePRRequest(launched.electronApp))?.title ?? null)
				.toBe('E2E rejected PR title');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[3].id}: ${fourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Git Release Review')).toBeVisible();
			await marketplaceCategoryButton(marketplaceDialog, 'QA', 1).click();
			await expect(marketplaceDialog.getByText('OpenSpec Proposal Review')).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();

			await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('handoff');
			await expect(marketplaceDialog.getByText('No results found')).toBeVisible();
			await marketplaceCategoryButton(marketplaceDialog, 'All', 3).click();
			await expect(marketplaceDialog.getByText('Group Chat Briefing')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[4].id}: ${fourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog.locator('#marketplace-target-folder').fill('');
			await expect(
				marketplaceDialog.getByRole('button', { name: 'Import Playbook' })
			).toBeDisabled();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/git-lane-review');
			await expect(
				marketplaceDialog.getByRole('button', { name: 'Import Playbook' })
			).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[5].id}: ${fourthTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');

			await expect(specKitPanel.getByText('v1.2.3')).toBeVisible();
			await specKitPanel.getByRole('button', { name: 'Check for Updates' }).click();
			await expect(specKitPanel.getByText('v1.2.4')).toBeVisible();
			await expect(settingsDialog.getByText('/speckit.specify')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[6].id}: ${fourthTrancheActiveScenarioMatrix[6].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await expect(openSpecPanel.getByText('v2.0.1')).toBeVisible();
			await openSpecPanel.getByRole('button', { name: 'Check for Updates' }).click();
			await expect(openSpecPanel.getByText('v2.0.2')).toBeVisible();
			await expect(settingsDialog.getByText('/openspec.proposal')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[0].id}: ${fifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/126' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.locator('select').selectOption(launched.worktreeBranch);
			await prModal.getByPlaceholder('PR title...').fill('E2E alternate target branch');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect
				.poll(
					async () => (await getStubbedCreatePRRequest(launched.electronApp))?.targetBranch ?? null
				)
				.toBe(launched.worktreeBranch);
			await expect(prModal).toBeHidden({ timeout: 5000 });
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[1].id}: ${fifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/127' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E canceled PR title');
			await prModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(prModal).toBeHidden();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[2].id}: ${fifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await selectMarketplaceDocument(marketplaceDialog, 'review-plan.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/Review\s+Plan/);
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Review\s+plan\s+body\s+for\s+the\s+git\s+lane\./
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[3].id}: ${fifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('collaboration/group-chat-import');
			await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedMarketplaceImport(launched.electronApp);
					return request
						? {
								playbookId: request.playbookId,
								targetFolderName: request.targetFolderName,
								sessionId: request.sessionId,
								autoRunFolderPath: request.autoRunFolderPath,
							}
						: null;
				})
				.toMatchObject({
					playbookId: 'git-lane-review',
					targetFolderName: 'collaboration/group-chat-import',
					sessionId: expect.stringContaining('git-groupchat-playbooks-'),
					autoRunFolderPath: expect.stringContaining('Playbooks'),
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[4].id}: ${fifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ })
			).toBeVisible();
			await expect(quickActionsDialog.getByRole('button', { name: /View Git Diff/ })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[0].id}: ${sixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('2 files changed')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
			await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();
			await expect(gitDiffDialog.getByText('Flow diff tab sentinel.')).toBeVisible();
			await expect(gitDiffDialog.getByText('Current file:')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[1].id}: ${sixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
			await expect(launched.window.getByText('1 participant')).toBeVisible();
			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[2].id}: ${sixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const roomPickerDialog = await openQuickActions(launched.window);
			await roomPickerDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await roomPickerDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Group Chat');
			await expect(
				quickActionsDialog.getByRole('button', { name: 'Close Group Chat' })
			).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: 'Remove Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[3].id}: ${sixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1).click();
			await marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ }).click();
			await expect(marketplaceDialog.getByText('Documents (0)')).toBeVisible();
			await expect(marketplaceDialog.getByText(/Loop:\s+Yes \(max 2\)/)).toBeVisible();
			await expect(marketplaceDialog.getByText('group-chat')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[4].id}: ${sixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Canceled Spec Kit prompt edit.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled specify prompt/)).toBeVisible();
			await expect(commandCard.getByText('Canceled Spec Kit prompt edit.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[0].id}: ${seventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubEmptyGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('No changes to display')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: 'Close (Esc)' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[1].id}: ${seventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: 'Help' }).click();
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeVisible();
			await expect(marketplaceDialog.getByText('Submit Your Playbook')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('github.com/RunMaestro/Maestro-Playbooks')
			).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Close', exact: true }).click();
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[2].id}: ${seventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText(/Cached/)).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Refresh marketplace' }).click();
			await expect(marketplaceDialog.getByText('Live')).toBeVisible({ timeout: 5000 });
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[3].id}: ${seventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Canceled OpenSpec prompt edit.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled proposal prompt/)).toBeVisible();
			await expect(commandCard.getByText('Canceled OpenSpec prompt edit.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[4].id}: ${seventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/140' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const createButton = prModal.getByRole('button', { name: 'Create PR' });
			await expect(createButton).toBeEnabled({ timeout: 5000 });
			await prModal.getByPlaceholder('PR title...').fill('');

			await expect(createButton).toBeDisabled();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[0].id}: ${eighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/141' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('From Branch')).toBeVisible();
			await expect(prModal.getByText(launched.worktreeBranch).first()).toBeVisible();
			await expect(prModal.locator('select')).toHaveValue('main');
			await expect(prModal.getByPlaceholder('PR title...')).toHaveValue('feat/git pr tranche');
			await expect(prModal.getByText('1 uncommitted change')).toBeVisible();
			await expect(
				prModal.getByText(/Only committed changes will be included in the PR/)
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[1].id}: ${eighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: false, error: 'E2E gh network refused without URL' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E non URL PR failure');
			await prModal
				.getByPlaceholder('Add a description...')
				.fill('Non URL failure body should remain editable.');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect(prModal.getByText('E2E gh network refused without URL')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled();
			await expect(launched.window.getByText('Pull Request Created')).toBeHidden();
			await expect
				.poll(async () => {
					const request = await getStubbedCreatePRRequest(launched.electronApp);
					return request
						? {
								title: request.title,
								description: request.description,
							}
						: null;
				})
				.toMatchObject({
					title: 'E2E non URL PR failure',
					description: 'Non URL failure body should remain editable.',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[2].id}: ${eighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'QA', 1).click();
			await marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ }).click();
			await expect(
				marketplaceDialog.getByText('Validate openspec proposal coverage.')
			).toBeVisible();
			await marketplaceDialog.getByTitle('Back to list (Esc)').click();

			await expect(marketplaceDialog.getByPlaceholder('Search playbooks...')).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[3].id}: ${eighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
			const searchInput = marketplaceDialog.getByPlaceholder('Search playbooks...');

			await launched.window.keyboard.press('Meta+F');
			await expect(searchInput).toBeFocused();
			await searchInput.fill('release');
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(marketplaceDialog).toBeVisible();
			await expect(searchInput).toHaveValue('release');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[4].id}: ${eighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/Review\s+Plan/);
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Review\s+plan\s+body\s+for\s+the\s+git\s+lane\./
			);
			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[0].id}: ${ninthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const roomPickerDialog = await openQuickActions(launched.window);
			await roomPickerDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await roomPickerDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();

			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Close Group Chat');
			await quickActionsDialog.getByRole('button', { name: 'Close Group Chat' }).click();

			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Git Group Chat Playbooks Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[1].id}: ${ninthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
			const searchInput = marketplaceDialog.getByPlaceholder('Search playbooks...');

			await searchInput.fill('no matching playbook');
			await expect(marketplaceDialog.getByText('No results found')).toBeVisible();
			await searchInput.fill('');

			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[2].id}: ${ninthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(marketplaceDialog.getByText('Author')).toBeVisible();
			await expect(marketplaceDialog.getByText('RunMaestro')).toBeVisible();
			await expect(marketplaceDialog.getByText('Tags')).toBeVisible();
			await expect(marketplaceDialog.getByText('git', { exact: true })).toBeVisible();
			await expect(marketplaceDialog.getByText('review', { exact: true })).toBeVisible();
			await expect(marketplaceDialog.getByText('Source')).toBeVisible();
			await expect(marketplaceDialog.getByText('Local').first()).toBeVisible();
			await expect(marketplaceDialog.getByText('2026-05-29')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[3].id}: ${ninthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
			await selectMarketplaceDocument(marketplaceDialog, 'review-plan.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/Review\s+Plan/);
			await selectMarketplaceDocument(marketplaceDialog, 'README.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[4].id}: ${ninthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/150' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const description = [
				'First multiline PR paragraph.',
				'',
				'- verifies deterministic GGP fallback coverage',
				'- keeps live GitHub disabled',
			].join('\n');
			await prModal.getByPlaceholder('PR title...').fill('E2E multiline PR description');
			await prModal.getByPlaceholder('Add a description...').fill(description);
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedCreatePRRequest(launched.electronApp);
					return request
						? {
								title: request.title,
								description: request.description,
							}
						: null;
				})
				.toEqual({
					title: 'E2E multiline PR description',
					description,
				});
			await expect(prModal).toBeHidden({ timeout: 5000 });
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[0].id}: ${tenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-public';
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await expect(publishModal.getByText('README.md')).toBeVisible();
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();

			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await expect(launched.window.getByText('Gist Published')).toBeVisible();
			await expect
				.poll(async () => {
					const request = await getStubbedGistRequest(launched.electronApp);
					return request
						? {
								filename: request.filename,
								isPublic: request.isPublic,
								contentIncludesFixture: request.content.includes(
									'Git Group Chat Playbooks Fixture'
								),
							}
						: null;
				})
				.toEqual({
					filename: 'README.md',
					isPublic: true,
					contentIncludesFixture: true,
				});
			await launched.window.getByTitle('View published gist').click();
			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
			await expect(publishedModal.getByText('public gist')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[1].id}: ${tenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-secret';
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
			await expect(publishedModal.getByText('secret gist')).toBeVisible();
			await publishedModal.getByRole('button', { name: 'Re-publish' }).click();
			const republishModal = launched.window.getByRole('dialog', {
				name: 'Re-publish as GitHub Gist',
			});
			await expect(republishModal.getByText('This will create a new gist')).toBeVisible();
			await republishModal.getByRole('button', { name: 'Back' }).click();
			await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
			await expect(await getStubbedGistRequest(launched.electronApp)).toMatchObject({
				filename: 'README.md',
				isPublic: false,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[2].id}: ${tenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubDetailedGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('feat: seed detailed git log').first()).toBeVisible();
			await expect(
				gitLogDialog.getByText('Body sentinel for detailed git log coverage.')
			).toBeVisible();
			await launched.window.keyboard.press('Escape');
			await expect(gitLogDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[3].id}: ${tenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceImportFailure(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Import Failure Review/ }).click();
			await expect(marketplaceDialog.getByText('Import failure body for git lane.')).toBeVisible();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/git-import-failure-review');
			await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

			await expect(marketplaceDialog).toBeVisible();
			await expect
				.poll(async () => {
					const request = await getStubbedMarketplaceImport(launched.electronApp);
					return request
						? {
								playbookId: request.playbookId,
								targetFolderName: request.targetFolderName,
							}
						: null;
				})
				.toEqual({
					playbookId: 'git-import-failure-review',
					targetFolderName: 'engineering/git-import-failure-review',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[4].id}: ${tenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Saved Spec Kit prompt for git lane.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await expect(commandCard.getByText('Saved Spec Kit prompt for git lane.')).toBeVisible();
			await expect(commandCard.getByRole('button', { name: 'Reset' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[0].id}: ${eleventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Resettable Spec Kit prompt for git lane.');
			await commandCard.getByRole('button', { name: 'Save' }).click();
			await commandCard.getByRole('button', { name: 'Reset' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled specify prompt/)).toBeVisible();
			await expect(commandCard.getByText('Resettable Spec Kit prompt for git lane.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[1].id}: ${eleventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Saved OpenSpec prompt for git lane.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await expect(commandCard.getByText('Saved OpenSpec prompt for git lane.')).toBeVisible();
			await expect(commandCard.getByRole('button', { name: 'Reset' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[2].id}: ${eleventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Resettable OpenSpec prompt for git lane.');
			await commandCard.getByRole('button', { name: 'Save' }).click();
			await commandCard.getByRole('button', { name: 'Reset' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled proposal prompt/)).toBeVisible();
			await expect(commandCard.getByText('Resettable OpenSpec prompt for git lane.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[3].id}: ${eleventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByRole('button', { name: 'github/spec-kit' }).click();
			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/github/spec-kit');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[4].id}: ${eleventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);

			await settingsDialog.getByRole('button', { name: 'Fission-AI/OpenSpec' }).click();
			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/Fission-AI/OpenSpec');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[0].id}: ${twelfthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiCommitGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('2 of 5 commits')).toBeVisible();
			await expect(gitLogDialog.getByText('First commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 1 of 2')).toBeVisible();

			await launched.window.keyboard.press('ArrowDown');
			await expect(gitLogDialog.getByText('Second commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText('SECOND.md').first()).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[1].id}: ${twelfthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: false, authenticated: false },
				{ success: false, error: 'unused while gh is unavailable' }
			);
			await stubOpenExternal(launched.electronApp);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('GitHub CLI not installed')).toBeVisible();
			await prModal.getByRole('button', { name: 'GitHub CLI' }).click();
			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://cli.github.com');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[2].id}: ${twelfthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: true,
				gistUrl: 'https://gist.github.com/e2e/cancelled-gist',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();

			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await expect(publishModal.getByText('README.md')).toBeVisible();
			await publishModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(publishModal).toBeHidden();
			await expect.poll(async () => getStubbedGistRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[3].id}: ${twelfthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: false,
				error: 'E2E gist create failed',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();

			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();

			await expect(publishModal.getByText('E2E gist create failed')).toBeVisible();
			await expect(publishModal.getByRole('button', { name: 'Publish Secret' })).toBeEnabled();
			await expect(await getStubbedGistRequest(launched.electronApp)).toMatchObject({
				filename: 'README.md',
				isPublic: false,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[4].id}: ${twelfthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog.locator('#marketplace-target-folder').fill('   ');

			await expect(
				marketplaceDialog.getByRole('button', { name: 'Import Playbook' })
			).toBeDisabled();
			await expect.poll(async () => getStubbedMarketplaceImport(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[0].id}: ${thirteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' }).click();
			const renameModal = launched.window.getByRole('dialog', { name: 'Rename Group Chat' });
			await expect(renameModal).toBeVisible();
			await expect(renameModal.getByRole('button', { name: 'Rename' })).toBeDisabled();
			await renameModal.getByLabel('Chat Name').fill('   ');
			await expect(renameModal.getByRole('button', { name: 'Rename' })).toBeDisabled();
			await renameModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(renameModal).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[1].id}: ${thirteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' }).click();
			const renameModal = launched.window.getByRole('dialog', { name: 'Rename Group Chat' });
			await renameModal.getByLabel('Chat Name').fill('Git Lane Room Renamed');
			await renameModal.getByRole('button', { name: 'Rename' }).click();

			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room Renamed' })
			).toBeVisible();
			const renamedQuickActions = await openQuickActions(launched.window);
			await renamedQuickActions
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room Renamed');
			await expect(
				renamedQuickActions
					.getByRole('button')
					.filter({ hasText: 'Group Chat: Git Lane Room Renamed', hasNotText: 'Remove' })
					.first()
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[2].id}: ${thirteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			await expect(infoDialog.getByText('Agents')).toBeVisible();
			await expect(infoDialog.getByText('Messages')).toBeVisible();
			await expect(infoDialog.getByText('Moderator Agent')).toBeVisible();
			await expect(infoDialog.getByText('codex')).toBeVisible();
			await expect(infoDialog.getByText('Participant Sessions')).toBeVisible();
			await expect(infoDialog.getByText('Git Group Chat Playbooks Agent')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[3].id}: ${thirteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByRole('button', { name: 'History' }).click();
			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeVisible();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeVisible();
			await expect(launched.window.getByText('Delegation')).toBeVisible();
			await expect(launched.window.getByText('Response')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[4].id}: ${thirteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const roomPickerDialog = await openQuickActions(launched.window);
			await roomPickerDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await roomPickerDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Remove Group Chat');
			await quickActionsDialog
				.getByRole('button', { name: 'Remove Group Chat: Git Lane Room' })
				.click();

			const deleteModal = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(deleteModal.getByText(/delete the group chat "Git Lane Room"/)).toBeVisible();
			await deleteModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(deleteModal).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[0].id}: ${fourteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubBinaryGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('1 file changed')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /git-lane\.bin/ })).toBeVisible();
			await expect(gitDiffDialog.getByText('binary').first()).toBeVisible();
			await expect(gitDiffDialog.getByText('Binary file changed')).toBeVisible();
			await expect(gitDiffDialog.getByText('assets/git-lane.bin')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[1].id}: ${fourteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreationSequence(
				launched.electronApp,
				{ installed: true, authenticated: true },
				[
					{ success: false, error: 'E2E transient gh outage' },
					{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/172' },
				]
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const createButton = prModal.getByRole('button', { name: 'Create PR' });
			await prModal.getByPlaceholder('PR title...').fill('E2E retry PR title');
			await prModal.getByPlaceholder('Add a description...').fill('Retry body remains available.');
			await createButton.click();

			await expect(prModal.getByText('E2E transient gh outage')).toBeVisible();
			await expect(createButton).toBeEnabled();
			await createButton.click();

			await expect.poll(async () => getStubbedCreatePRAttemptCount(launched.electronApp)).toBe(2);
			await expect(prModal).toBeHidden({ timeout: 5000 });
			await expect(launched.window.getByText('Pull Request Created')).toBeVisible();
			await expect(await getStubbedCreatePRRequest(launched.electronApp)).toMatchObject({
				targetBranch: 'main',
				title: 'E2E retry PR title',
				description: 'Retry body remains available.',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[2].id}: ${fourteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-open';
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });
			await stubOpenExternal(launched.electronApp);

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
			await publishedModal.getByTitle('Open in browser').click();
			await expect.poll(async () => getStubbedOpenExternalUrl(launched.electronApp)).toBe(gistUrl);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[3].id}: ${fourteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByRole('button', { name: 'History' }).click();
			const historyPanel = launched.window
				.locator('div[tabindex="0"]')
				.filter({ hasText: 'Git Group Chat Playbooks Agent finished diff review.' })
				.last();
			const searchInput = await openGroupChatHistorySearch(launched.window, historyPanel);
			await searchInput.fill('Full response sentinel');

			await expect(launched.window.getByText('1 result')).toBeVisible();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeVisible();
			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[4].id}: ${fourteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await launched.window.getByRole('button', { name: 'History' }).click();
			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeVisible();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeVisible();

			await launched.window.getByRole('button', { name: 'Delegation' }).click();
			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeHidden();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeVisible();

			await launched.window.getByRole('button', { name: 'Delegation' }).click();
			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeVisible();
			await launched.window.getByRole('button', { name: 'Response' }).click();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[0].id}: ${fifteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubDeletedGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('1 file changed')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /old-note\.md/ })).toBeVisible();
			await expect(gitDiffDialog.getByText('Deleted git lane sentinel.')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 1 of 1')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[1].id}: ${fifteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiCommitGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('First commit body sentinel.')).toBeVisible();
			await gitLogDialog.getByText('fix: git log second tranche detail').click();

			await expect(gitLogDialog.getByText('Second commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText('Second git log diff sentinel')).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[2].id}: ${fifteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-copy';
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await publishedModal.getByRole('button', { name: 'Copy URL' }).first().click();
			await expect(publishedModal.getByRole('button', { name: 'Copied!' })).toBeVisible();
			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(gistUrl);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[3].id}: ${fifteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByTitle('Submit your playbook to the community').click();
			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/RunMaestro/Maestro-Playbooks');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[4].id}: ${fifteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog.getByRole('button', { name: /RunMaestro/ }).click();
			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/RunMaestro');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[0].id}: ${sixteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard
				.locator('textarea')
				.fill('Persistent Spec Kit prompt for {{CWD}} after refresh.');
			await commandCard.getByRole('button', { name: 'Save' }).click();
			await specKitPanel.getByRole('button', { name: 'Check for Updates' }).click();

			await expect(specKitPanel.getByText('v1.2.4')).toBeVisible();
			await expect(commandCard.getByText('Modified')).toBeVisible();
			await expect(
				commandCard.getByText('Persistent Spec Kit prompt for {{CWD}} after refresh.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[1].id}: ${sixteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard
				.locator('textarea')
				.fill('Persistent OpenSpec prompt for {{AGENT_NAME}} after refresh.');
			await commandCard.getByRole('button', { name: 'Save' }).click();
			await openSpecPanel.getByRole('button', { name: 'Check for Updates' }).click();

			await expect(openSpecPanel.getByText('v2.0.2')).toBeVisible();
			await expect(commandCard.getByText('Modified')).toBeVisible();
			await expect(
				commandCard.getByText('Persistent OpenSpec prompt for {{AGENT_NAME}} after refresh.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[2].id}: ${sixteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-republish';
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await publishedModal.getByRole('button', { name: 'Re-publish' }).click();
			const republishModal = launched.window.getByRole('dialog', {
				name: 'Re-publish as GitHub Gist',
			});
			await republishModal.getByRole('button', { name: 'Publish Public' }).click();

			await expect(republishModal).toBeHidden({ timeout: 10000 });
			await expect(await getStubbedGistRequest(launched.electronApp)).toMatchObject({
				filename: 'README.md',
				isPublic: true,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[3].id}: ${sixteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: 'Help' }).click();
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeVisible();
			await marketplaceDialog
				.getByRole('button', { name: 'github.com/RunMaestro/Maestro-Playbooks' })
				.click();

			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/RunMaestro/Maestro-Playbooks');
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[4].id}: ${sixteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await selectMarketplaceDocument(marketplaceDialog, 'review-plan.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(/Review\s+Plan/);
			await marketplaceDialog.getByRole('button', { name: 'Read more...' }).click();

			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Use\s+this\s+playbook\s+to\s+review\s+lane\s+output\./
			);
			await expect(marketplacePreview(marketplaceDialog)).not.toContainText(
				/Review\s+plan\s+body\s+for\s+the\s+git\s+lane\./
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[0].id}: ${seventeenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('2 files changed')).toBeVisible();
			await expect(gitDiffDialog.getByText('README.md → README.md')).toBeVisible();
			await expect(gitDiffDialog.getByText('1 additions')).toBeVisible();
			await expect(gitDiffDialog.getByText('0 deletions')).toBeVisible();
			await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();

			await expect(gitDiffDialog.getByText('FLOW.md → FLOW.md')).toBeVisible();
			await expect(gitDiffDialog.getByText('0 additions')).toBeVisible();
			await expect(gitDiffDialog.getByText('1 deletions')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[1].id}: ${seventeenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			const groupChatIdRow = infoDialog
				.getByText('Group Chat ID')
				.locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');

			await groupChatIdRow.getByTitle('Copy to clipboard').click();

			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(launched.groupChats[0].id);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[2].id}: ${seventeenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubOpenPath(launched.electronApp);
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });

			await infoDialog.getByRole('button', { name: 'Open in Finder' }).click();

			await expect
				.poll(async () => getStubbedOpenPath(launched.electronApp))
				.toContain(launched.groupChats[0].id);
			expect(await getStubbedOpenPath(launched.electronApp)).not.toMatch(/\/images\/?$/);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[3].id}: ${seventeenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });

			const exportButton = infoDialog.getByRole('button', { name: 'Export HTML' });
			await expect(exportButton).toBeVisible();
			await expect(exportButton).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[4].id}: ${seventeenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();

			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Engineering', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Group Chat Briefing')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[0].id}: ${eighteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('README.md → README.md')).toBeVisible();
			await launched.window.keyboard.press('Meta+]');
			await expect(gitDiffDialog.getByText('FLOW.md → FLOW.md')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 2 of 2')).toBeVisible();

			await launched.window.keyboard.press('Meta+[');
			await expect(gitDiffDialog.getByText('README.md → README.md')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 1 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[1].id}: ${eighteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			const chatLogRow = infoDialog
				.getByText('Chat Log')
				.locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');
			const chatLogPath = await chatLogRow.locator('span').nth(1).innerText();

			await chatLogRow.getByTitle('Copy to clipboard').click();

			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(chatLogPath);
			expect(chatLogPath).toContain(launched.groupChats[0].id);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[2].id}: ${eighteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			const imagesRow = infoDialog
				.getByText('Images Directory')
				.locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');
			const imagesPath = await imagesRow.locator('span').nth(1).innerText();

			await imagesRow.getByTitle('Copy to clipboard').click();

			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(imagesPath);
			expect(imagesPath).toContain(`${launched.groupChats[0].id}${path.sep}images`);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[3].id}: ${eighteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: false,
				error: 'E2E gist publish failure keeps content visible',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();

			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();

			await expect(
				publishModal.getByText('E2E gist publish failure keeps content visible')
			).toBeVisible();
			await expect(publishModal.getByText('README.md')).toBeVisible();
			await expect(publishModal.getByRole('button', { name: 'Publish Secret' })).toBeEnabled();
			await expect
				.poll(async () => {
					const request = await getStubbedGistRequest(launched.electronApp);
					return request
						? {
								filename: request.filename,
								isPublic: request.isPublic,
								contentIncludesFixture: request.content.includes(
									'Git Group Chat Playbooks Fixture'
								),
							}
						: null;
				})
				.toEqual({
					filename: 'README.md',
					isPublic: false,
					contentIncludesFixture: true,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[4].id}: ${eighteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'All', 3).click();
			await launched.window.keyboard.press('Meta+Shift+[');
			await expect(marketplaceCategoryButton(marketplaceDialog, 'QA', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();

			await launched.window.keyboard.press('Meta+Shift+[');
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Engineering', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('OpenSpec Proposal Review')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[0].id}: ${nineteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('README.md → README.md')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(gitDiffDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[1].id}: ${nineteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiCommitGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await launched.window.keyboard.press('ArrowDown');
			await expect(gitLogDialog.getByText('Second commit body sentinel.')).toBeVisible();
			await launched.window.keyboard.press('ArrowUp');

			await expect(gitLogDialog.getByText('First commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 1 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[2].id}: ${nineteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			const moderatorSessionRow = infoDialog
				.getByText('Moderator Session')
				.locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');

			await moderatorSessionRow.getByTitle('Copy to clipboard').click();

			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(launched.groupChats[0].moderatorSessionId);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[3].id}: ${nineteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: false,
				error: 'E2E gist retry remains failed',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();

			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();
			await expect(publishModal.getByText('E2E gist retry remains failed')).toBeVisible();
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedGistRequest(launched.electronApp);
					return request
						? {
								filename: request.filename,
								isPublic: request.isPublic,
								contentIncludesFixture: request.content.includes(
									'Git Group Chat Playbooks Fixture'
								),
							}
						: null;
				})
				.toEqual({
					filename: 'README.md',
					isPublic: true,
					contentIncludesFixture: true,
				});
			await expect(publishModal.getByRole('button', { name: 'Publish Public' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[4].id}: ${nineteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await marketplaceCategoryButton(marketplaceDialog, 'All', 3).click();

			await expect(marketplaceCategoryButton(marketplaceDialog, 'All', 3)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[0].id}: ${twentiethTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'QA', 1).click();
			await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('release');

			await expect(marketplaceDialog.getByText('No results found')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('Try adjusting your search or browse a different category')
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();
			await expect(marketplaceDialog.getByText('OpenSpec Proposal Review')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[1].id}: ${twentiethTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Git Lane Review')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(marketplaceDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[2].id}: ${twentiethTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: true,
				gistUrl: 'https://gist.github.com/e2e/quick-actions-gist',
			});
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Gist');
			await quickActionsDialog
				.getByRole('button', { name: /Publish Document as GitHub Gist/ })
				.click();

			await expect(quickActionsDialog).toBeHidden();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await expect(publishModal.getByText('README.md')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[3].id}: ${twentiethTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'empty' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('No commits found')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(gitLogDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[4].id}: ${twentiethTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Create Pull Request/ })
			).toBeHidden();
			await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[0].id}: ${twentyFirstTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await openSeededGroupChat(launched.window);
			const messageRow = launched.window
				.getByText('Seeded group chat message for git lane.')
				.locator('xpath=ancestor::div[@data-message-timestamp][1]');

			await messageRow.hover();
			await messageRow.getByTitle('Copy to clipboard').click();

			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe('Seeded group chat message for git lane.');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[1].id}: ${twentyFirstTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const messageRow = launched.window
				.getByText('Seeded group chat message for git lane.')
				.locator('xpath=ancestor::div[@data-message-timestamp][1]');

			await messageRow.hover();
			await messageRow.getByTitle(/Show plain text/).click();
			await expect(messageRow.getByTitle(/Show formatted/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[2].id}: ${twentyFirstTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Gist');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Publish Document as GitHub Gist/ })
			).toBeHidden();
			await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[3].id}: ${twentyFirstTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('openspec');

			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();
			await expect(marketplaceDialog.getByText('Group Chat Briefing')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[4].id}: ${twentyFirstTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'error' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(
				gitLogDialog.getByText('E2E git log unavailable for fallback coverage')
			).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(gitLogDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[0].id}: ${twentySecondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/211' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const titleInput = prModal.getByPlaceholder('PR title...');
			const createButton = prModal.getByRole('button', { name: 'Create PR' });
			await expect(createButton).toBeEnabled({ timeout: 5000 });
			await titleInput.fill('   ');

			await expect(createButton).toBeDisabled();
			await titleInput.fill('E2E restored PR title');
			await expect(createButton).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[1].id}: ${twentySecondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: false, authenticated: false },
				{ success: false, error: 'gh missing' }
			);
			await stubOpenExternal(launched.electronApp);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByRole('button', { name: 'GitHub CLI' }).click();

			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://cli.github.com');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[2].id}: ${twentySecondTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			const prUrl = 'https://github.com/RunMaestro/Maestro/pull/211';
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: false, error: `E2E duplicate PR already exists at ${prUrl}` }
			);
			await stubOpenExternal(launched.electronApp);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E linked PR error');
			await prModal.getByRole('button', { name: 'Create PR' }).click();
			await prModal.getByRole('button', { name: 'PR #211' }).click();

			await expect.poll(async () => getStubbedOpenExternalUrl(launched.electronApp)).toBe(prUrl);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[3].id}: ${twentySecondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubEmptyGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('No changes to display')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(gitDiffDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[4].id}: ${twentySecondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: true,
				gistUrl: 'https://gist.github.com/e2e/escape-published-gist',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await expect(publishedModal.getByText('public gist')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(publishedModal).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[0].id}: ${twentyThirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('@Git');
			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toBeVisible();
			await input.press('Enter');

			await expect(input).toHaveValue('@Git-Group-Chat-Playbooks-Agent ');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[1].id}: ${twentyThirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('@Git');
			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toBeVisible();
			await input.press('Escape');

			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toHaveCount(0);
			await expect(input).toHaveValue('@Git');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[2].id}: ${twentyThirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Cached 1m ago')).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Refresh marketplace' }).click();

			await expect(marketplaceDialog.getByText('Live')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[3].id}: ${twentyThirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Unsaved Spec Kit prompt should disappear.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();
			await expect(commandCard.getByText('Unsaved Spec Kit prompt should disappear.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[4].id}: ${twentyThirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Unsaved OpenSpec prompt should disappear.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(
				commandCard.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
			).toBeVisible();
			await expect(commandCard.getByText('Unsaved OpenSpec prompt should disappear.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[0].id}: ${twentyFourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/224' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled({
				timeout: 5000,
			});
			await launched.window.keyboard.press('Escape');

			await expect(prModal).toBeHidden();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[1].id}: ${twentyFourthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();

			await expect(gitDiffDialog.getByText('File 2 of 2')).toBeVisible();
			await expect(gitDiffDialog.getByText('Flow diff tab sentinel.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[2].id}: ${twentyFourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();
			await gitDiffDialog.getByRole('button', { name: /README\.md/ }).click();

			await expect(gitDiffDialog.getByText('File 1 of 2')).toBeVisible();
			await expect(gitDiffDialog.getByText('Readme diff tab sentinel.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[3].id}: ${twentyFourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			await stubGistPublishing(launched.electronApp, {
				success: true,
				gistUrl: 'https://gist.github.com/e2e/close-published-gist',
			});
			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Secret' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await publishedModal.getByRole('button', { name: 'Close', exact: true }).click();

			await expect(publishedModal).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[4].id}: ${twentyFourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('   ');

			await expect(launched.window.getByTitle('Send message')).toBeDisabled();
			await expect(input).toHaveValue('   ');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[0].id}: ${twentyFifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('@Missing');

			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toHaveCount(0);
			await expect(input).toHaveValue('@Missing');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[1].id}: ${twentyFifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('Read-only draft stays put.');
			await launched.window.getByTitle("Toggle Read-Only mode (agents won't modify files)").click();

			await expect(input).toHaveValue('Read-only draft stays put.');
			await expect(launched.window.getByTitle('Send message')).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[2].id}: ${twentyFifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();

			await expect(marketplaceDialog.locator('#marketplace-target-folder')).toHaveValue(
				'engineering/git-lane-review'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[3].id}: ${twentyFifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();

			await expect(marketplaceDialog.getByTitle('Browse for folder')).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[4].id}: ${twentyFifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');

			await expect(
				commandCard.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
			).toBeVisible();
			await settingsDialog.getByText('/openspec.proposal').click();

			await expect(
				commandCard.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[0].id}: ${twentySixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubBinaryGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('File 1 of 1')).toBeVisible();
			await expect(gitDiffDialog.getByText('Binary file changed')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /git-lane\.bin/ })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[1].id}: ${twentySixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiCommitGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await gitLogDialog.getByText('fix: git log second tranche detail').click();

			await expect(gitLogDialog.getByText('Second commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText(/v-keyboard/)).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[2].id}: ${twentySixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/231' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const descriptionInput = prModal.getByPlaceholder('Add a description...');
			await descriptionInput.fill('Blank-title validation should keep this body.');
			await prModal.getByPlaceholder('PR title...').fill('');

			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
			await expect(descriptionInput).toHaveValue('Blank-title validation should keep this body.');
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[3].id}: ${twentySixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-public-copy';
			await launched.electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });

			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await publishedModal.getByRole('button', { name: 'Copy URL' }).first().click();

			await expect(publishedModal.getByRole('button', { name: 'Copied!' })).toBeVisible();
			await expect
				.poll(() => launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
				.toBe(gistUrl);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[4].id}: ${twentySixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubDeletedGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('Deleted git lane sentinel.')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(gitDiffDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[0].id}: ${twentySeventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			await expect(infoDialog.getByText('Git Group Chat Playbooks Agent')).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(infoDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[1].id}: ${twentySeventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const closeDialog = await openQuickActions(launched.window);
			await closeDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Close Group Chat');
			await closeDialog.getByRole('button', { name: 'Close Group Chat' }).click();
			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeHidden();

			await openSeededGroupChat(launched.window);

			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[2].id}: ${twentySeventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('Send-state draft');
			await expect(launched.window.getByTitle('Send message')).toBeEnabled();

			await input.fill('');

			await expect(launched.window.getByTitle('Send message')).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[3].id}: ${twentySeventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('@Git');
			await launched.window
				.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
				.click();

			await expect(input).toHaveValue('@Git-Group-Chat-Playbooks-Agent ');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[4].id}: ${twentySeventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' }).click();
			const renameModal = launched.window.getByRole('dialog', { name: 'Rename Group Chat' });
			await renameModal.getByLabel('Chat Name').fill('Escaped Git Lane Room');

			await launched.window.keyboard.press('Escape');

			await expect(renameModal).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[0].id}: ${twentyEighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
			const searchInput = marketplaceDialog.getByPlaceholder('Search playbooks...');
			await searchInput.fill('openspec');
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();

			await searchInput.fill('');

			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[1].id}: ${twentyEighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1).click();
			await marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ }).click();
			await expect(
				marketplaceDialog.getByText('Coordinate seeded group chat review handoff.')
			).toBeVisible();
			await marketplaceDialog.getByTitle('Back to list (Esc)').click();

			await expect(marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1)).toHaveCSS(
				'font-weight',
				'600'
			);
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[2].id}: ${twentyEighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
			await expect(marketplaceDialog.getByText('Cached 1m ago')).toBeVisible();

			await marketplaceDialog.getByRole('button', { name: 'Refresh marketplace' }).click();

			await expect(marketplaceDialog.getByText('Live')).toBeVisible();
			await expect(marketplaceDialog.getByText('Cached 1m ago')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[3].id}: ${twentyEighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await selectMarketplaceDocument(marketplaceDialog, 'review-plan.md');
			await expect(marketplacePreview(marketplaceDialog)).toContainText(
				/Review\s+plan\s+body\s+for\s+the\s+git\s+lane\./
			);
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/review-after-preview');

			await expect(marketplaceDialog.locator('#marketplace-target-folder')).toHaveValue(
				'engineering/review-after-preview'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[4].id}: ${twentyEighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Unsaved local OpenSpec edit for git lane.');

			await expect(commandCard.locator('textarea')).toHaveValue(
				'Unsaved local OpenSpec edit for git lane.'
			);
			await expect(commandCard.getByText('Modified')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[0].id}: ${twentyNinthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await launched.window.keyboard.press('Meta+]');
			await expect(gitDiffDialog.getByText('FLOW.md → FLOW.md')).toBeVisible();
			await launched.window.keyboard.press('Meta+[');

			await expect(gitDiffDialog.getByText('README.md → README.md')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 1 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[1].id}: ${twentyNinthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiCommitGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await launched.window.keyboard.press('ArrowUp');

			await expect(gitLogDialog.getByText('First commit body sentinel.')).toBeVisible();
			await expect(gitLogDialog.getByText('Commit 1 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[2].id}: ${twentyNinthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/246' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.locator('select').selectOption(launched.worktreeBranch);
			await expect(prModal.locator('select')).toHaveValue(launched.worktreeBranch);
			await prModal.locator('select').selectOption('main');

			await expect(prModal.locator('select')).toHaveValue('main');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[3].id}: ${twentyNinthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withFilePreview: true });
		try {
			const gistUrl = 'https://gist.github.com/e2e/git-groupchat-public-back';
			await stubGistPublishing(launched.electronApp, { success: true, gistUrl });
			await launched.window.getByTitle('Publish as GitHub Gist').click();
			const publishModal = launched.window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
			await publishModal.getByRole('button', { name: 'Publish Public' }).click();
			await expect(publishModal).toBeHidden({ timeout: 10000 });
			await launched.window.getByTitle('View published gist').click();

			const publishedModal = launched.window.getByRole('dialog', { name: 'Published Gist' });
			await publishedModal.getByRole('button', { name: 'Re-publish' }).click();
			const republishModal = launched.window.getByRole('dialog', {
				name: 'Re-publish as GitHub Gist',
			});
			await republishModal.getByRole('button', { name: 'Back' }).click();

			await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
			await expect(publishedModal.getByText('public gist')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[4].id}: ${twentyNinthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/247' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('');
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
			await prModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(prModal).toBeHidden();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[0].id}: ${thirtiethTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const closeDialog = await openQuickActions(launched.window);
			await closeDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Close Group Chat');
			await closeDialog.getByRole('button', { name: 'Close Group Chat' }).click();

			const reopenDialog = await openQuickActions(launched.window);
			await reopenDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');

			await expect(
				reopenDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[1].id}: ${thirtiethTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByRole('button', { name: 'History' }).click();
			const historyPanel = launched.window
				.locator('div[tabindex="0"]')
				.filter({ hasText: 'Git Group Chat Playbooks Agent finished diff review.' })
				.last();
			const searchInput = await openGroupChatHistorySearch(launched.window, historyPanel);
			await searchInput.fill('Full response sentinel');
			await expect(launched.window.getByText('1 result')).toBeVisible();

			await searchInput.fill('');

			await expect(
				launched.window.getByText('Moderator delegated git lane review to the participant.')
			).toBeVisible();
			await expect(
				launched.window.getByText('Git Group Chat Playbooks Agent finished diff review.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[2].id}: ${thirtiethTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByTitle('Info').click();
			const firstInfoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
			await expect(firstInfoDialog.getByText('Git Group Chat Playbooks Agent')).toBeVisible();
			await launched.window.keyboard.press('Escape');
			await expect(firstInfoDialog).toBeHidden();

			await launched.window.getByTitle('Info').click();
			const secondInfoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });

			await expect(secondInfoDialog.getByText('Participant Sessions')).toBeVisible();
			await expect(secondInfoDialog.getByText('Git Group Chat Playbooks Agent')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[3].id}: ${thirtiethTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			const input = launched.window.getByPlaceholder('Type a message... (@ to mention agent)');
			await input.fill('@Git');
			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toBeVisible();

			await input.fill('');

			await expect(
				launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[4].id}: ${thirtiethTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await openSeededGroupChat(launched.window);
			await launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' }).click();
			const renameModal = launched.window.getByRole('dialog', { name: 'Rename Group Chat' });
			await renameModal.getByLabel('Chat Name').fill('Canceled Git Lane Room');
			await renameModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(renameModal).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[0].id}: ${thirtyFirstTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceCategoryButton(marketplaceDialog, 'All', 3)).toBeVisible();
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Engineering', 1)).toBeVisible();
			await expect(marketplaceCategoryButton(marketplaceDialog, 'QA', 1)).toBeVisible();
			await expect(marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[1].id}: ${thirtyFirstTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceCategoryButton(marketplaceDialog, 'QA', 1).click();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await marketplaceCategoryButton(marketplaceDialog, 'All', 3).click();

			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[2].id}: ${thirtyFirstTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			await stubOpenExternal(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByTitle('Submit your playbook to the community').click();

			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://github.com/RunMaestro/Maestro-Playbooks');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[3].id}: ${thirtyFirstTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Canceled local Spec Kit edit for git lane.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();
			await expect(
				commandCard.getByText('Canceled local Spec Kit edit for git lane.')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[4].id}: ${thirtyFirstTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openAICommandsSettings(launched.window);
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await expect(openSpecPanel.getByText('v2.0.1')).toBeVisible();
			await openSpecPanel.getByRole('button', { name: 'Check for Updates' }).click();

			await expect(openSpecPanel.getByText('v2.0.2')).toBeVisible();
			await expect(settingsDialog.getByText('/openspec.proposal')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	for (const scenario of quotaClosingGitActiveScenarioMatrix) {
		test(`${scenario.id}: ${scenario.title}`, async () => {
			const launched = await launchGitGroupChatPlaybooksWorkbench({
				withWorktreeChild: scenario.flow.startsWith('pr-'),
				withFilePreview: scenario.flow.startsWith('gist-'),
			});
			try {
				switch (scenario.flow) {
					case 'diff-multi-readme': {
						await stubMultiFileGitDiffState(launched.electronApp);
						const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

						await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
						break;
					}
					case 'diff-multi-flow': {
						await stubMultiFileGitDiffState(launched.electronApp);
						const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);
						await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();

						await expect(gitDiffDialog.getByText('Flow diff tab sentinel.')).toBeVisible();
						break;
					}
					case 'diff-binary-file': {
						await stubBinaryGitDiffState(launched.electronApp);
						const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

						await expect(
							gitDiffDialog.getByRole('button', { name: /git-lane\.bin/ })
						).toBeVisible();
						await expect(gitDiffDialog.getByText('assets/git-lane.bin')).toBeVisible();
						break;
					}
					case 'diff-deleted-file': {
						await stubDeletedGitDiffState(launched.electronApp);
						const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

						await expect(gitDiffDialog.getByRole('button', { name: /old-note\.md/ })).toBeVisible();
						break;
					}
					case 'diff-empty-state': {
						await stubEmptyGitDiffState(launched.electronApp);
						const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

						await expect(gitDiffDialog.getByText('No changes to display')).toBeVisible();
						break;
					}
					case 'log-detailed-body': {
						await stubDetailedGitLogState(launched.electronApp);
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);

						await expect(
							gitLogDialog.getByText('Body sentinel for detailed git log coverage.')
						).toBeVisible();
						break;
					}
					case 'log-detailed-stats': {
						await stubDetailedGitLogState(launched.electronApp);
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);

						await expect(
							gitLogDialog.getByText('1 file changed, 1 insertion(+), 1 deletion(-)')
						).toBeVisible();
						break;
					}
					case 'log-multi-first': {
						await stubMultiCommitGitLogState(launched.electronApp);
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);

						await expect(gitLogDialog.getByText('FIRST.md', { exact: true })).toBeVisible();
						break;
					}
					case 'log-multi-second': {
						await stubMultiCommitGitLogState(launched.electronApp);
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);
						await gitLogDialog.getByText('fix: git log second tranche detail').click();

						await expect(gitLogDialog.getByText('SECOND.md').first()).toBeVisible();
						break;
					}
					case 'log-empty-state': {
						await stubGitLogState(launched.electronApp, { mode: 'empty' });
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);

						await expect(gitLogDialog.getByText('No commits found')).toBeVisible();
						break;
					}
					case 'log-error-state': {
						await stubGitLogState(launched.electronApp, { mode: 'error' });
						const gitLogDialog = await openGitLogFromQuickActions(launched.window);

						await expect(
							gitLogDialog.getByText('E2E git log unavailable for fallback coverage')
						).toBeVisible();
						break;
					}
					case 'pr-authenticated-modal': {
						await stubPullRequestCreation(
							launched.electronApp,
							{ installed: true, authenticated: true },
							{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/363' }
						);
						await activateSession(launched.window, launched.worktreeBranch);
						const quickActionsDialog = await openQuickActions(launched.window);
						await quickActionsDialog
							.getByPlaceholder('Type a command or jump to agent...')
							.fill('Create Pull Request');
						await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

						await expect(modalRootByHeading(launched.window, 'Create Pull Request')).toBeVisible();
						break;
					}
					case 'pr-title-disabled': {
						await stubPullRequestCreation(
							launched.electronApp,
							{ installed: true, authenticated: true },
							{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/364' }
						);
						await activateSession(launched.window, launched.worktreeBranch);
						const quickActionsDialog = await openQuickActions(launched.window);
						await quickActionsDialog
							.getByPlaceholder('Type a command or jump to agent...')
							.fill('Create Pull Request');
						await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();
						const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
						await prModal.getByPlaceholder('PR title...').fill('');

						await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
						break;
					}
					case 'pr-cancel-request': {
						await stubPullRequestCreation(
							launched.electronApp,
							{ installed: true, authenticated: true },
							{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/365' }
						);
						await activateSession(launched.window, launched.worktreeBranch);
						const quickActionsDialog = await openQuickActions(launched.window);
						await quickActionsDialog
							.getByPlaceholder('Type a command or jump to agent...')
							.fill('Create Pull Request');
						await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();
						const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
						await prModal.getByRole('button', { name: 'Cancel' }).click();

						expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
						break;
					}
					case 'gist-public-publish': {
						await stubGistPublishing(launched.electronApp, {
							success: true,
							gistUrl: 'https://gist.github.com/e2e/quota-public',
						});
						await launched.window.getByTitle('Publish as GitHub Gist').click();
						const publishModal = launched.window.getByRole('dialog', {
							name: 'Publish as GitHub Gist',
						});
						await publishModal.getByRole('button', { name: 'Publish Public' }).click();

						await expect
							.poll(async () => getStubbedGistRequest(launched.electronApp))
							.toMatchObject({
								filename: 'README.md',
								isPublic: true,
							});
						break;
					}
					case 'gist-secret-publish': {
						await stubGistPublishing(launched.electronApp, {
							success: true,
							gistUrl: 'https://gist.github.com/e2e/quota-secret',
						});
						await launched.window.getByTitle('Publish as GitHub Gist').click();
						const publishModal = launched.window.getByRole('dialog', {
							name: 'Publish as GitHub Gist',
						});
						await publishModal.getByRole('button', { name: 'Publish Secret' }).click();

						await expect
							.poll(async () => getStubbedGistRequest(launched.electronApp))
							.toMatchObject({
								filename: 'README.md',
								isPublic: false,
							});
						break;
					}
				}
			} finally {
				await launched.cleanup();
			}
		});
	}

	for (const scenario of quotaClosingGroupChatActiveScenarioMatrix) {
		test(`${scenario.id}: ${scenario.title}`, async () => {
			const launched = await launchGitGroupChatPlaybooksWorkbench();
			try {
				await openSeededGroupChat(launched.window);

				switch (scenario.flow) {
					case 'chat-header':
						await expect(
							launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
						).toBeVisible();
						break;
					case 'chat-seeded-message':
						await expect(
							launched.window.getByText('Seeded group chat message for git lane.')
						).toBeVisible();
						break;
					case 'chat-info-participants': {
						await launched.window.getByTitle('Info').click();
						const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });

						await expect(infoDialog.getByText('Participant Sessions')).toBeVisible();
						await expect(infoDialog.getByText('Git Group Chat Playbooks Agent')).toBeVisible();
						break;
					}
					case 'chat-info-escape': {
						await launched.window.getByTitle('Info').click();
						const infoDialog = launched.window.getByRole('dialog', { name: 'Group Chat Info' });
						await launched.window.keyboard.press('Escape');

						await expect(infoDialog).toBeHidden();
						break;
					}
					case 'chat-history-message':
						await launched.window.getByRole('button', { name: 'History' }).click();
						await expect(
							launched.window.getByText('Moderator delegated git lane review to the participant.')
						).toBeVisible();
						break;
					case 'chat-history-search': {
						await launched.window.getByRole('button', { name: 'History' }).click();
						const historyPanel = launched.window
							.locator('div[tabindex="0"]')
							.filter({ hasText: 'Git Group Chat Playbooks Agent finished diff review.' })
							.last();
						const searchInput = await openGroupChatHistorySearch(launched.window, historyPanel);
						await searchInput.fill('Full response sentinel');

						await expect(launched.window.getByText('1 result')).toBeVisible();
						break;
					}
					case 'chat-mention-suggestion': {
						const input = launched.window.getByPlaceholder(
							'Type a message... (@ to mention agent)'
						);
						await input.fill('@Git');

						await expect(
							launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
						).toBeVisible();
						break;
					}
					case 'chat-mention-clear': {
						const input = launched.window.getByPlaceholder(
							'Type a message... (@ to mention agent)'
						);
						await input.fill('@Git');
						await input.fill('');

						await expect(
							launched.window.getByRole('button', { name: /@Git-Group-Chat-Playbooks-Agent/ })
						).toHaveCount(0);
						break;
					}
					case 'chat-read-only-draft': {
						const input = launched.window.getByPlaceholder(
							'Type a message... (@ to mention agent)'
						);
						await input.fill('Quota closing draft survives read-only toggle.');
						await launched.window
							.getByTitle("Toggle Read-Only mode (agents won't modify files)")
							.click();

						await expect(input).toHaveValue('Quota closing draft survives read-only toggle.');
						break;
					}
					case 'chat-rename-cancel': {
						await launched.window
							.getByRole('button', { name: 'Group Chat: Git Lane Room' })
							.click();
						const renameModal = launched.window.getByRole('dialog', { name: 'Rename Group Chat' });
						await renameModal.getByLabel('Chat Name').fill('Quota Closing Room');
						await renameModal.getByRole('button', { name: 'Cancel' }).click();

						await expect(
							launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
						).toBeVisible();
						break;
					}
					case 'chat-close-reopen': {
						const closeDialog = await openQuickActions(launched.window);
						await closeDialog
							.getByPlaceholder('Type a command or jump to agent...')
							.fill('Close Group Chat');
						await closeDialog.getByRole('button', { name: 'Close Group Chat' }).click();
						const reopenDialog = await openQuickActions(launched.window);
						await reopenDialog
							.getByPlaceholder('Type a command or jump to agent...')
							.fill('Git Lane Room');

						await expect(
							reopenDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ })
						).toBeVisible();
						break;
					}
				}
			} finally {
				await launched.cleanup();
			}
		});
	}

	for (const scenario of quotaClosingPlaybooksActiveScenarioMatrix) {
		test(`${scenario.id}: ${scenario.title}`, async () => {
			const launched = await launchGitGroupChatPlaybooksWorkbench();
			try {
				switch (scenario.flow) {
					case 'marketplace-all-categories': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

						await expect(marketplaceCategoryButton(marketplaceDialog, 'All', 3)).toBeVisible();
						break;
					}
					case 'marketplace-engineering-category': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceCategoryButton(marketplaceDialog, 'Engineering', 1).click();

						await expect(
							marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-qa-category': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceCategoryButton(marketplaceDialog, 'QA', 1).click();

						await expect(
							marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-collaboration-category': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceCategoryButton(marketplaceDialog, 'Collaboration', 1).click();

						await expect(
							marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-search-release': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('release');

						await expect(
							marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-search-openspec': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('openspec');

						await expect(
							marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-search-group-chat': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('group');

						await expect(
							marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ })
						).toBeVisible();
						break;
					}
					case 'marketplace-submit-link': {
						await stubMarketplaceFilteringState(launched.electronApp);
						await stubOpenExternal(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
						await marketplaceDialog.getByTitle('Submit your playbook to the community').click();

						await expect
							.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
							.toBe('https://github.com/RunMaestro/Maestro-Playbooks');
						break;
					}
					case 'marketplace-refresh-button': {
						await stubMarketplaceFilteringState(launched.electronApp);
						const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

						await expect(
							marketplaceDialog.getByRole('button', { name: 'Refresh marketplace' })
						).toBeVisible();
						break;
					}
					case 'speckit-version': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						await openAICommandsSettings(launched.window);
						const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');

						await expect(specKitPanel.getByText('v1.2.3')).toBeVisible();
						break;
					}
					case 'speckit-refresh': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						await openAICommandsSettings(launched.window);
						const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');
						await specKitPanel.getByRole('button', { name: 'Check for Updates' }).click();

						await expect(specKitPanel.getByText('v1.2.4')).toBeVisible();
						break;
					}
					case 'speckit-prompt': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						const settingsDialog = await openAICommandsSettings(launched.window);
						await settingsDialog.getByText('/speckit.specify').click();

						await expect(
							settingsDialog.getByText('Bundled specify prompt for {{CWD}}.')
						).toBeVisible();
						break;
					}
					case 'speckit-edit-cancel': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						const settingsDialog = await openAICommandsSettings(launched.window);
						await settingsDialog.getByText('/speckit.specify').click();
						const commandCard = settingsDialog
							.getByText('/speckit.specify')
							.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
						await commandCard.getByRole('button', { name: 'Edit' }).click();
						await commandCard.locator('textarea').fill('Discarded quota Spec Kit edit.');
						await commandCard.getByRole('button', { name: 'Cancel' }).click();

						await expect(commandCard.getByText('Discarded quota Spec Kit edit.')).toBeHidden();
						break;
					}
					case 'openspec-version': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						await openAICommandsSettings(launched.window);
						const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

						await expect(openSpecPanel.getByText('v2.0.1')).toBeVisible();
						break;
					}
					case 'openspec-refresh': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						await openAICommandsSettings(launched.window);
						const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');
						await openSpecPanel.getByRole('button', { name: 'Check for Updates' }).click();

						await expect(openSpecPanel.getByText('v2.0.2')).toBeVisible();
						break;
					}
					case 'openspec-prompt': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						const settingsDialog = await openAICommandsSettings(launched.window);
						await settingsDialog.getByText('/openspec.proposal').click();

						await expect(
							settingsDialog.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
						).toBeVisible();
						break;
					}
					case 'openspec-edit-cancel': {
						await stubSpecKitAndOpenSpecCommands(launched.electronApp);
						const settingsDialog = await openAICommandsSettings(launched.window);
						await settingsDialog.getByText('/openspec.proposal').click();
						const commandCard = settingsDialog
							.getByText('/openspec.proposal')
							.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
						await commandCard.getByRole('button', { name: 'Edit' }).click();
						await commandCard.locator('textarea').fill('Discarded quota OpenSpec edit.');
						await commandCard.getByRole('button', { name: 'Cancel' }).click();

						await expect(commandCard.getByText('Discarded quota OpenSpec edit.')).toBeHidden();
						break;
					}
				}
			} finally {
				await launched.cleanup();
			}
		});
	}
});
