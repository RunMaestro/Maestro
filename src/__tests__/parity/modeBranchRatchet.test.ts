/**
 * @fileoverview No component decides what to draw from an agent's mode.
 *
 * The rule (docs/parity/agent-ux-parity.md): a local agent, an SSH agent, and a hosted agent look
 * and behave the same. The one visible difference is `AgentModePill`. Where a file, git, or
 * terminal operation runs may differ; what the user sees, and which controls exist, may not.
 *
 * The differences this rule removed were all one shape: a component read the agent's SSH or
 * hosted fields in a condition (`!sshRemoteId && <Button />`, `isRemote ? 'Download' : 'Open'`)
 * and hid, disabled, or relabeled a control. This test reads every component and fails when such
 * a condition appears that is not on the list below, so a new one is a decision someone makes,
 * with a reason, and not something that slips in. It also fails when a listed line is gone, so
 * the list never carries dead entries.
 *
 * If this test fails on your change:
 * - A control must exist in every mode. Pass the remote id to the SERVICE that acts
 *   (`services/fileActions.ts`, `services/pathPicker.ts`, a `sshRemoteId` argument on an IPC call)
 *   and let it choose the transport. Do not branch in the component.
 * - If the line only chooses a transport or a cache key and changes nothing on screen, add it to
 *   `ALLOWED` with the reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_ROOT = join(__dirname, '..', '..', 'renderer', 'components');

/** A condition on the agent's mode: a negation, a ternary, or an `&&` on one of the mode fields. */
const MODE_FIELD = String.raw`(?:sshRemoteId|isRemoteSession|isRemote|sshRemote)`;
const OWNER = String.raw`(?:\w+\??\.)*`;
const MODE_CONDITION = new RegExp(
	[
		String.raw`!\s*${OWNER}${MODE_FIELD}\b`,
		String.raw`\b${OWNER}${MODE_FIELD}\s*(?:\?(?![.?:])|&&)`,
		String.raw`!\s*isSessionRemote\(`,
		String.raw`isSessionRemote\([^)]*\)\s*(?:\?|&&)`,
		String.raw`!\s*hostedTargetOf\(`,
		String.raw`hostedTargetOf\([^)]*\)\s*(?:\?|&&)`,
	].join('|')
);

/**
 * The conditions that stay, by file (relative to `src/renderer/components`), each with the text
 * the line contains and why it draws nothing different.
 */
const ALLOWED: Record<string, Array<{ line: string; why: string }>> = {
	'SshUnreachableModal.tsx': [
		{
			line: 'isSessionRemote(active) ? getSessionSshRemoteId(active) : undefined',
			why: 'Reads which remote the active agent is on, to pick the outage to show. Connection loss exists only where a connection exists (matrix row B2.12).',
		},
	],
	'NewInstanceModal/NewInstanceModal.tsx': [
		{
			line: 'source?.sshRemoteId ? { enabled: true, remoteId: source.sshRemoteId } : undefined',
			why: 'Creation flow: a duplicated agent starts on its source remote. Choosing the remote is the setting here.',
		},
		{
			line: 'sshRemoteId ? workingDir.trim() : expandTilde(workingDir.trim())',
			why: 'Transport: `~` is expanded with this machine home only for a path on this machine.',
		},
	],
	'DocumentGraph/DocumentGraphView.tsx': [
		{ line: 'sshRemoteId: !!sshRemoteId,', why: 'A field in a log entry.' },
	],
	'AutoRun/AutoRun.tsx': [
		{
			line: 'const posix = !!sshRemoteId;',
			why: 'Transport: a path on a remote always uses POSIX separators.',
		},
	],
	'Wizard/WizardResumeModal.tsx': [
		{
			line: 'sshRemoteId ? resumeState.directoryPath : undefined',
			why: 'Transport: the directory argument of a remote existence check.',
		},
	],
	'FilePreview/MarkdownImage.tsx': [
		{
			line: 'const prefix = sshRemoteId ? `ssh:${sshRemoteId}:` : ' + "''" + ';',
			why: 'A cache key, so one path on two machines is two images.',
		},
	],
	'FilePreview/MediaViewer.tsx': [
		{
			line: "{isRemote ? 'Cannot Play This Stream' : 'Cannot Play This File'}",
			why: 'Not the agent mode: `isRemote` here is a web (http) stream against a file.',
		},
		{
			line: "{isRemote ? 'Open in Browser' : 'Open in Default App'}",
			why: 'Not the agent mode: a web stream opens in a browser.',
		},
		{
			line: "title={isRemote ? 'Open in browser' : 'Open in default app'}",
			why: 'Not the agent mode: a web stream opens in a browser.',
		},
		{
			line: "ariaLabel={isRemote ? 'Open in browser' : 'Open in default app'}",
			why: 'Not the agent mode: a web stream opens in a browser.',
		},
	],
};

function componentFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === '__tests__' ? [] : componentFiles(path);
		return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
	});
}

function isComment(line: string): boolean {
	const text = line.trim();
	return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
}

/** Every line of every component that holds a condition on the agent's mode. */
function modeConditions(): Array<{ file: string; lineNumber: number; text: string }> {
	return componentFiles(COMPONENTS_ROOT).flatMap((path) => {
		const file = relative(COMPONENTS_ROOT, path).split(sep).join('/');
		return readFileSync(path, 'utf8')
			.split('\n')
			.map((text, index) => ({ file, lineNumber: index + 1, text }))
			.filter(({ text }) => !isComment(text) && MODE_CONDITION.test(text));
	});
}

describe('components do not branch on the agent mode', () => {
	const found = modeConditions();

	it('finds the components to read', () => {
		expect(componentFiles(COMPONENTS_ROOT).length).toBeGreaterThan(100);
	});

	it('holds no condition on the SSH or hosted fields outside the allowed list', () => {
		const unexpected = found
			.filter(({ file, text }) => !(ALLOWED[file] ?? []).some(({ line }) => text.includes(line)))
			.map(({ file, lineNumber, text }) => `${file}:${lineNumber}  ${text.trim()}`);

		expect(
			unexpected,
			'A component reads the agent mode in a condition. A control must exist, with the same ' +
				'label, in every mode: pass the remote id to the service that acts and let it choose ' +
				'the transport (see the header of this test and docs/parity/agent-ux-parity.md).'
		).toEqual([]);
	});

	it('lists no allowed line that is gone', () => {
		const stale = Object.entries(ALLOWED).flatMap(([file, entries]) =>
			entries
				.filter(({ line }) => !found.some((hit) => hit.file === file && hit.text.includes(line)))
				.map(({ line }) => `${file}  ${line}`)
		);

		expect(stale, 'Remove these entries from ALLOWED: the lines no longer exist.').toEqual([]);
	});
});
