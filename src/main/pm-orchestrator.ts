/**
 * PM Orchestrator — `/PM` slash-command backend
 *
 * Registers the `pm:*` IPC channels consumed by the renderer when the user
 * types `/PM ...` in the chat input.
 *
 * Architecture
 * ------------
 * All commands live under the `pm:` IPC namespace.  The renderer dispatches the
 * right channel based on the slash command verb (see src/renderer/hooks/input/useInputProcessing.ts).
 *
 * Channels registered
 * -------------------
 *   pm:orchestrate   — `/PM <idea>`  open the PM planning prompt in the active session
 *   pm:prd-new       — `/PM prd-new <name>`  seed a new planning conversation
 *   pm:prd-list      — `/PM prd-list`  stub (returns actionable message)
 *   pm:next          — `/PM next`  stub (returns actionable message)
 *   pm:status        — `/PM status`  stub (returns actionable message)
 *   pm:standup       — `/PM standup`  stub (returns actionable message)
 *
 * Feature gate
 * ------------
 * All channels are gated by the `pmSuite` encore feature flag.
 *
 * Delivery Planner / Work Graph note
 * -----------------------------------
 * This worktree branch does not yet include the Delivery Planner or Work Graph
 * subsystems.  The prd-list, next, status, and standup verbs return instructive
 * stub messages pointing users to enable those features once available.
 * The orchestrate and prd-new verbs are fully functional: they push a
 * 'pm:openPlanningPrompt' event to the renderer so it can seed the active chat.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[PMOrchestrator]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PmOrchestratorDependencies {
	/** Getter for the main BrowserWindow (may be null before window creation) */
	getMainWindow: () => BrowserWindow | null;
	/** Settings store (electron-store instance) — used to gate pmSuite feature */
	settingsStore: { get(key: string, defaultValue?: unknown): unknown };
}

export interface PmCommandRequest {
	/** Arguments after the command verb, e.g. the idea text or PRD name */
	args?: string;
	/** Project path for the current session */
	projectPath?: string;
	/** Git path for the current session */
	gitPath?: string;
	actor?: { sessionId?: string; name?: string };
}

export interface PmCommandResponse {
	success: boolean;
	/** Human-readable markdown body echoed into the session chat window */
	message?: string;
	/** Structured data for richer renderer rendering */
	data?: unknown;
	error?: string;
	code?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(message: string, data?: unknown): PmCommandResponse {
	return { success: true, message, data };
}

function err(message: string, code = 'PM_ERROR'): PmCommandResponse {
	return { success: false, error: message, code };
}

/** Returns a structured gate-disabled response when pmSuite feature is off. */
function checkGate(
	settingsStore: PmOrchestratorDependencies['settingsStore']
): PmCommandResponse | null {
	const encoreFeatures = settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
	if (!encoreFeatures.pmSuite) {
		return { success: false, code: 'FEATURE_DISABLED', error: 'pmSuite feature is disabled' };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPmOrchestratorHandlers(deps: PmOrchestratorDependencies): void {
	// -----------------------------------------------------------------------
	// pm:orchestrate  (/PM <idea>)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:orchestrate', (_event, req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		const idea = req.args?.trim();
		if (!idea) {
			return err('Please provide an idea: `/PM <your idea>`');
		}

		logger.info('PM orchestrate: seeding planning prompt', LOG_CONTEXT, {
			idea: idea.substring(0, 80),
		});

		// Push an event to the renderer to seed the active chat with the PM planning prompt.
		const mainWindow = deps.getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('pm:openPlanningPrompt', {
				mode: 'orchestrate',
				idea,
				projectPath: req.projectPath,
				gitPath: req.gitPath,
			});
		}

		return ok(
			[
				`**Starting PM planning for: ${idea}**`,
				'',
				'The PM orchestrator will guide you through:',
				'1. Defining the problem and user need',
				'2. Clarifying scope and success criteria',
				'3. Breaking the idea into an epic and tasks',
				'',
				'_Tip: When the draft looks complete, type `/PM prd-new <name>` to save it as a PRD._',
			].join('\n'),
			{ idea }
		);
	});

	// -----------------------------------------------------------------------
	// pm:prd-new  (/PM prd-new <name>)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:prd-new', (_event, req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		const name = req.args?.trim();
		if (!name) {
			return err('Please provide a PRD name: `/PM prd-new <name>`');
		}

		const mainWindow = deps.getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('pm:openPlanningPrompt', {
				mode: 'prd-new',
				name,
				projectPath: req.projectPath,
				gitPath: req.gitPath,
			});
		}

		return ok(
			`**Opening PRD planner for: ${name}**\n\nDescribe the feature in the chat above. I'll ask clarifying questions to fill in the spec.`
		);
	});

	// -----------------------------------------------------------------------
	// pm:prd-list  (/PM prd-list)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:prd-list', (_event, _req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		// TODO(#428): Connect to Delivery Planner Work Graph when available.
		return ok(
			[
				'**PRD list** — Delivery Planner not yet connected on this branch.',
				'',
				'To list PRDs, enable the **Delivery Planner** Encore feature (available on `humpf-dev`).',
				'',
				'In the meantime, use `/PM prd-new <name>` to start planning a new feature.',
			].join('\n')
		);
	});

	// -----------------------------------------------------------------------
	// pm:next  (/PM next)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:next', (_event, _req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		// TODO(#428): Connect to Work Graph status query when available.
		return ok(
			[
				'**Next eligible item** — Work Graph not yet connected on this branch.',
				'',
				'Enable the **Delivery Planner** Encore feature (available on `humpf-dev`) to query work items.',
			].join('\n')
		);
	});

	// -----------------------------------------------------------------------
	// pm:status  (/PM status)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:status', (_event, _req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		// TODO(#428): Connect to Work Graph dashboard when available.
		return ok(
			[
				'**Project status** — Work Graph not yet connected on this branch.',
				'',
				'Enable the **Delivery Planner** Encore feature (available on `humpf-dev`) for a full board snapshot.',
			].join('\n')
		);
	});

	// -----------------------------------------------------------------------
	// pm:standup  (/PM standup)
	// -----------------------------------------------------------------------
	ipcMain.handle('pm:standup', (_event, _req: PmCommandRequest): PmCommandResponse => {
		const gateError = checkGate(deps.settingsStore);
		if (gateError) return gateError;

		// TODO(#428): Connect to Work Graph activity when available.
		return ok(
			[
				'**Standup summary** — Work Graph not yet connected on this branch.',
				'',
				'Enable the **Delivery Planner** Encore feature (available on `humpf-dev`) for standup data.',
			].join('\n')
		);
	});

	logger.info('PM orchestrator IPC handlers registered', LOG_CONTEXT);
}
