/**
 * `maestro-cli open <surface> [--tab <tab> [--sub-tab <sub-tab>]] [--group <id>] [--agent <id>]` -
 * open one of Maestro's modals or dashboards in the running desktop app, optionally on a specific
 * tab, on one agent group for a surface that takes one (the Delegation Graph), or for one agent
 * when the surface is that agent's (Edit Agent).
 *
 * The point is teaching, not just navigating: an agent answering "where do I
 * see my scheduled tasks?" can open the surface AND relay the manual paths
 * (hotkey, command palette, click target) printed alongside the confirmation.
 * Surfaces, their tabs, and those hints all come from `shared/uiSurfaces.ts`.
 */

import { withMaestroClient } from '../services/maestro-client';
import { getSessionById, readGroups, resolveAgentId, resolveGroupId } from '../services/storage';
import { groupSettingsBlocker } from '../services/group-settings';
import { isMacOS } from '../../shared/platformDetection';
import { formatShortcutKeysFor } from '../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';
import type { Shortcut } from '../../shared/shortcut-types';
import {
	UI_SURFACES,
	describeSurfaceAccess,
	resolveUiSurface,
	resolveUiSurfaceTarget,
	surfaceSubTabIds,
	surfaceTabIds,
	type UiSurface,
} from '../../shared/uiSurfaces';
import { ExitCode, exitWith } from '../exit-codes';
import { failCommand, failFromError } from '../services/session-command';

interface OpenModalOptions {
	tab?: string;
	subTab?: string;
	group?: string;
	agent?: string;
	list?: boolean;
	json?: boolean;
}

/** Formatted hotkey for a surface, or `undefined` when it has none. */
function shortcutFor(surface: UiSurface): string | undefined {
	if (!surface.shortcutId) return undefined;
	// `shortcutId` is a plain string off the surface table, while
	// DEFAULT_SHORTCUTS is a literal object (its keys are the source of
	// `ShortcutId`). Widen only at this dynamic lookup rather than annotating the
	// constant, which would collapse ShortcutId to `string` everywhere.
	const byId = DEFAULT_SHORTCUTS as Record<string, Shortcut | undefined>;
	const shortcut = byId[surface.shortcutId] ?? FIXED_SHORTCUTS[surface.shortcutId];
	// An action can be registered with no default binding, in which case there is
	// no hotkey to print - same answer as a surface that names no shortcut at all.
	if (!shortcut?.keys?.length) return undefined;
	return formatShortcutKeysFor(shortcut.keys, isMacOS(), '+');
}

function printSurfaceList(options: OpenModalOptions): void {
	if (options.json) {
		console.log(
			JSON.stringify(
				UI_SURFACES.map((surface) => ({
					id: surface.id,
					label: surface.label,
					aliases: surface.aliases ?? [],
					description: surface.description,
					tabs: surfaceTabIds(surface),
					sub_tabs: Object.fromEntries(
						(surface.tabs ?? [])
							.filter((tab) => surfaceSubTabIds(tab).length > 0)
							.map((tab) => [tab.id, surfaceSubTabIds(tab)])
					),
					shortcut: shortcutFor(surface) ?? '',
					command_palette: surface.commandPalette ?? '',
					encore: surface.encore ?? '',
					group_scoped: !!surface.groupClick,
					agent_scoped: !!surface.agentClick,
				}))
			)
		);
		return;
	}
	const width = Math.max(...UI_SURFACES.map((surface) => surface.id.length));
	for (const surface of UI_SURFACES) {
		const shortcut = shortcutFor(surface);
		const tabs = surfaceTabIds(surface);
		const subTabs = (surface.tabs ?? [])
			.filter((tab) => surfaceSubTabIds(tab).length > 0)
			.map((tab) => `${tab.id}: ${surfaceSubTabIds(tab).join(', ')}`);
		const extras = [
			shortcut ? `key: ${shortcut}` : null,
			tabs.length > 0 ? `tabs: ${tabs.join(', ')}` : null,
			subTabs.length > 0 ? `sub-tabs (--sub-tab), ${subTabs.join('; ')}` : null,
			surface.groupClick ? 'one group: --group <id>' : null,
			surface.agentClick ? 'one agent: --agent <id>' : null,
		]
			.filter(Boolean)
			.join('  |  ');
		console.log(
			`${surface.id.padEnd(width)}  ${surface.description}${extras ? `\n${' '.repeat(width + 2)}${extras}` : ''}`
		);
	}
}

export async function openModal(
	surfaceName: string | undefined,
	options: OpenModalOptions
): Promise<void> {
	if (options.list || !surfaceName) {
		printSurfaceList(options);
		if (!surfaceName && !options.list) {
			console.error('\nError: missing <surface>. Pick one of the ids above.');
			exitWith(ExitCode.GeneralError);
		}
		return;
	}

	const surface = resolveUiSurface(surfaceName);
	if (!surface) {
		const valid = UI_SURFACES.map((entry) => entry.id).join(', ');
		failCommand(`Unknown surface "${surfaceName}". Valid surfaces: ${valid}`, options.json);
	}

	// Whether the surface takes a group or an agent is checked before either is
	// looked up, so `--group` on the wrong surface says that and not "Group not
	// found".
	const accepted = resolveUiSurfaceTarget(surface, {
		tab: options.tab,
		subTab: options.subTab,
		group: options.group,
		agent: options.agent,
	});
	if ('error' in accepted) failCommand(accepted.error, options.json);
	let groupId: string | undefined;
	let agentId: string | undefined;
	try {
		if (options.group !== undefined) groupId = resolveGroupId(options.group);
		if (options.agent !== undefined) agentId = resolveAgentId(options.agent);
	} catch (error) {
		failFromError(error, options.json);
	}
	// Group Settings is refused for a worktree group, in the words the Group
	// Settings verbs use, before the app is asked to open a dialog with nothing
	// in it.
	if (surface.groupRequired && groupId) {
		const group = readGroups().find((candidate) => candidate.id === groupId);
		const blocker = group ? groupSettingsBlocker(group) : undefined;
		if (blocker) failCommand(blocker, options.json);
	}
	const target = { ...accepted, group: groupId, agent: agentId };
	const tabId = target.tab?.id;
	const subTabId = target.subTab?.id;
	const groupName = groupId ? readGroups().find((group) => group.id === groupId)?.name : undefined;
	const agentName = agentId ? getSessionById(agentId)?.name : undefined;

	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_modal',
					surface: surface.id,
					tab: tabId,
					subTab: subTabId,
					group: groupId,
					agent: agentId,
				},
				'open_modal_result'
			)
		);

		if (!result.success) {
			failCommand(result.error || `Failed to open ${surface.label}`, options.json);
		}

		const hint = describeSurfaceAccess(surface, shortcutFor(surface), target);
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					surface: surface.id,
					label: surface.label,
					tab: tabId ?? '',
					sub_tab: subTabId ?? '',
					group: groupId ?? '',
					agent: agentId ?? '',
					shortcut: shortcutFor(surface) ?? '',
					command_palette: surface.commandPalette ?? '',
					click: surface.click ?? '',
					hint,
				})
			);
			return;
		}
		const tabSuffix = tabId ? ` (${[tabId, subTabId].filter(Boolean).join(' > ')} tab)` : '';
		const groupSuffix = groupId ? ` on the group ${groupName ?? groupId}` : '';
		const agentSuffix = agentId ? ` for the agent ${agentName ?? agentId}` : '';
		console.log(`Opened ${surface.label}${tabSuffix}${groupSuffix}${agentSuffix} in Maestro.`);
		if (hint) console.log(hint);
	} catch (error) {
		failFromError(error, options.json);
	}
}
