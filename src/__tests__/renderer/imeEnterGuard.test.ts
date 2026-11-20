/**
 * Regression guard: every renderer handler where Enter or Cmd/Ctrl+Enter can
 * arrive from a text input, textarea, contenteditable, or form/modal submission
 * must guard against active input method (IME) composition via isImeComposing().
 *
 * This stops premature submission or action on Enter during IME composition,
 * including Safari's keyCode 229 confirmation.
 *
 * Scope and boundary:
 * The scan operates per-file: it verifies that every renderer file handling Enter
 * either checks isImeComposing() (or canonical delegate handleComposerSendKey) on
 * comment-stripped source, or is documented in ALLOWLIST. Intra-file early-return
 * patterns (such as early-returning on isImeComposing at the top of a keydown
 * handler) are recognized across the enclosing file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const RENDERER_ROOT = resolve(__dirname, '../../renderer');

/**
 * Explicit, commented allowlist of renderer files that handle Enter without
 * isImeComposing(). Each entry documents why IME composition cannot occur there.
 */
export const ALLOWLIST: Record<string, string> = {
	// Terminal raw PTY byte translation: converts physical Enter to carriage return
	'hooks/keyboard/useMainKeyboardHandler.ts':
		'Terminal raw keystroke translation to PTY carriage return byte (\\r)',

	// File explorer tree navigation: Enter on a file row opens the file
	'hooks/git/useFileExplorerEffects.ts':
		'File tree navigation: Enter opens the selected file or directory item',

	// Controls that explicitly guard against text input targets
	'components/GitDiffViewer.tsx':
		'Diff viewer shortcut: explicitly skips text inputs via !isTextInputTarget(e.target)',

	// List navigation wrappers: delegate Enter to useListNavigation which guards isImeComposing()
	'components/CrossTabSearchModal.tsx':
		'Search list navigation: Enter delegates to useListNavigation',
	'components/TabSwitcherModal.tsx':
		'Tab switcher list navigation: Enter delegates to useListNavigation',

	// Execution queue: Enter on list item opens item action menu (ignores button targets)
	'components/ExecutionQueueBrowser.tsx':
		'Queue list navigation: Enter opens action menu on selected list item',

	// Image canvas crop tool: Enter applies crop when crop tool is active (no text input active)
	'components/ImageAnnotator/ImageAnnotator.tsx':
		'Crop tool: Enter applies crop rectangle when tool === "crop"',

	// Document graph canvas: Enter previews document node (no text inputs)
	'components/DocumentGraph/MindMap.tsx':
		'Document graph canvas: Enter previews document node (no text inputs)',

	// Modals and dialogs where Enter activates buttons or confirms actions (no text inputs)
	'components/ConfirmModal.tsx':
		'Confirm dialog: Enter on the Cancel button only stops propagation; no text input',
	'components/DeleteAgentConfirmModal.tsx':
		'Confirmation dialog buttons: Enter activates Cancel or Delete button',
	'components/DeleteWorktreeModal.tsx':
		'Confirmation dialog buttons: Enter activates Cancel, Keep, or Delete button',
	'components/ProcessMonitor/KillConfirmDialog.tsx':
		'Confirmation dialog button: Enter confirms kill process',
	'components/InlineWizard/WizardExitConfirmDialog.tsx':
		'Confirmation dialog button: Enter confirms wizard exit',
	'components/Wizard/ExistingAutoRunDocsModal.tsx':
		'Modal confirmation button: Enter confirms auto run docs choice',
	'components/Wizard/WizardResumeModal.tsx':
		'Modal resume button: Enter confirms wizard resume choice',
	'components/Wizard/screens/PhaseReviewScreen/hooks/usePhaseReviewKeyboard.ts':
		'Wizard phase review navigation: Enter advances review step (no text input)',
	'components/FirstRunCelebration.tsx':
		'Celebration overlay: Enter or Escape dismisses celebration',
	'components/KeyboardMasteryCelebration.tsx':
		'Celebration overlay: Enter or Escape dismisses celebration',
	'components/ContextWarningSash.tsx':
		'Warning banner buttons: Enter activates summarize or dismiss button',
	'components/HistoryDetailModal.tsx':
		'Historical session viewer: Enter activates dialog buttons or resumes session',
	'components/ui/Modal.tsx': 'Base modal frame: handles backdrop click and modal container events',

	// Engine helper: receives raw key string from callers that guard isImeComposing
	'hooks/input/useTemplateAutocompleteEngine.ts':
		'Engine helper: receives raw key string from useTemplateAutocomplete and useEditorTemplateAutocomplete which both guard isImeComposing',
};

/** Recursively collect every .ts/.tsx file under `dir`. */
function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
			out.push(full);
		}
	}
	return out;
}

/** Strip block + line comments so prose mentions cannot trip the scan. */
export function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Strip standard button accessibility space-or-enter checks. */
export function stripButtonPatterns(src: string): string {
	return src
		.replace(
			/(?:\b\w+\.key\s*===\s*['"]Enter['"]\s*\|\|\s*\b\w+\.key\s*===\s*['"] ['"]|\b\w+\.key\s*===\s*['"] ['"]\s*\|\|\s*\b\w+\.key\s*===\s*['"]Enter['"])/g,
			''
		)
		.replace(
			/(?:\b\w+\.key\s*!==\s*['"]Enter['"]\s*&&\s*\b\w+\.key\s*!==\s*['"] ['"]|\b\w+\.key\s*!==\s*['"] ['"]\s*&&\s*\b\w+\.key\s*!==\s*['"]Enter['"])/g,
			''
		)
		.replace(/case\s+['"]Enter['"]:\s*case\s+['"] ['"]:/g, '')
		.replace(/case\s+['"] ['"]:\s*case\s+['"]Enter['"]:/g, '');
}

/** Detect whether code handles Enter (property access, destructured key, or switch case). */
export function handlesEnter(src: string): boolean {
	return /(?:(?:\b\w+\.key|\bkey)\s*(?:===|!==)\s*['"]Enter['"]|case\s+['"]Enter['"])/.test(src);
}

describe('IME Enter regression guard', () => {
	const sourceFiles = collectSourceFiles(RENDERER_ROOT);

	it('finds renderer source files', () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it('ensures all Enter handlers on text fields guard active IME composition', () => {
		const offenders: string[] = [];

		for (const file of sourceFiles) {
			const rel = relative(RENDERER_ROOT, file).replace(/\\/g, '/');
			const raw = readFileSync(file, 'utf8');
			const commentStripped = stripComments(raw);
			const stripped = stripButtonPatterns(commentStripped);

			if (handlesEnter(stripped)) {
				const hasImeGuard =
					commentStripped.includes('isImeComposing') ||
					commentStripped.includes('handleComposerSendKey');

				if (!hasImeGuard && !ALLOWLIST[rel]) {
					offenders.push(rel);
				}
			}
		}

		expect(
			offenders,
			`The following files handle Enter without checking isImeComposing() and are not in ALLOWLIST:\n` +
				offenders.map((f) => `  ${f}`).join('\n') +
				`\n\nAll text fields, textareas, and modal submit handlers must guard active IME compositions ` +
				`via isImeComposing(e) so candidate confirmation is left to the input method.`
		).toEqual([]);
	});

	it('fails on stale allowlist entries', () => {
		const stale: string[] = [];

		for (const [rel] of Object.entries(ALLOWLIST)) {
			const full = join(RENDERER_ROOT, rel);
			if (!existsSync(full)) {
				stale.push(`${rel} (file does not exist on disk)`);
				continue;
			}

			const raw = readFileSync(full, 'utf8');
			const commentStripped = stripComments(raw);
			const stripped = stripButtonPatterns(commentStripped);

			if (!handlesEnter(stripped)) {
				stale.push(`${rel} (no longer handles Enter)`);
			}

			if (
				commentStripped.includes('isImeComposing') ||
				commentStripped.includes('handleComposerSendKey')
			) {
				stale.push(`${rel} (now guards Enter with isImeComposing())`);
			}
		}

		expect(
			stale,
			`The following ALLOWLIST entries are stale and should be removed:\n` +
				stale.map((s) => `  ${s}`).join('\n')
		).toEqual([]);
	});
});
