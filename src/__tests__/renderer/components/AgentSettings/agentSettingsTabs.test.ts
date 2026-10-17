/**
 * @fileoverview Tests for the agent settings tab set: which tab a validation
 * field lives on, and which tab a Save attempt with errors jumps to.
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_FORM_TAB_IDS,
	AGENT_SETTINGS_TABS,
	AUDIT_LOG_TAB_ID,
	EDIT_AGENT_TAB_IDS,
	MODERATOR_TAB_IDS,
	buildAgentSettingsTabs,
	firstTabWithError,
	tabsWithErrors,
} from '../../../../renderer/components/AgentSettings/agentSettingsTabs';
import { AGENT_SETTINGS_TAB_IDS } from '../../../../shared/agentSettingsTabs';
import { AGENT_SETTINGS_SURFACE_TABS } from '../../../../shared/uiSurfaces';

describe('agentSettingsTabs', () => {
	it('lists the seven tabs in strip order, each with a label and an icon', () => {
		expect(AGENT_SETTINGS_TABS.map((tab) => tab.id)).toEqual([
			'general',
			'provider',
			'models',
			'environment',
			'peers',
			'ssh',
			'auditLog',
		]);
		expect(AGENT_SETTINGS_TABS.every((tab) => tab.icon && tab.label)).toBe(true);
	});

	it('gives New Agent and Group Settings the six tabs the CLI can link to', () => {
		expect(AGENT_FORM_TAB_IDS).toEqual([...AGENT_SETTINGS_TAB_IDS]);
		expect(AGENT_FORM_TAB_IDS).not.toContain(AUDIT_LOG_TAB_ID);
	});

	it('adds Audit Log last for Edit Agent', () => {
		expect(EDIT_AGENT_TAB_IDS).toEqual([...AGENT_FORM_TAB_IDS, AUDIT_LOG_TAB_ID]);
		expect(buildAgentSettingsTabs(EDIT_AGENT_TAB_IDS).at(-1)).toMatchObject({
			id: AUDIT_LOG_TAB_ID,
			label: 'Audit Log',
		});
	});

	// The feature behind the tab is hidden from agents, and both lists below are
	// what `maestro-cli open agent-settings --tab` offers and `open --list` prints.
	it('keeps Audit Log out of the shared tab list and out of the surface registry', () => {
		expect(AGENT_SETTINGS_TAB_IDS as readonly string[]).not.toContain(AUDIT_LOG_TAB_ID);
		expect(AGENT_SETTINGS_SURFACE_TABS.map((tab) => tab.id)).not.toContain(AUDIT_LOG_TAB_ID);
		expect(AGENT_SETTINGS_SURFACE_TABS.map((tab) => tab.label.toLowerCase())).not.toContain(
			'audit log'
		);
	});

	it('gives the moderator no Audit Log tab', () => {
		expect(MODERATOR_TAB_IDS).not.toContain(AUDIT_LOG_TAB_ID);
	});

	it('gives the moderator no Models and no Peers tab', () => {
		expect(MODERATOR_TAB_IDS).toEqual(['general', 'provider', 'environment', 'ssh']);
	});

	describe('firstTabWithError', () => {
		it('returns null when there are no errors', () => {
			expect(firstTabWithError([], AGENT_FORM_TAB_IDS)).toBeNull();
		});

		it('returns the earliest tab in strip order, not in field order', () => {
			expect(firstTabWithError(['sshRemote', 'provider', 'name'], AGENT_FORM_TAB_IDS)).toBe(
				'general'
			);
			expect(firstTabWithError(['sshRemote', 'gatewayUrl'], AGENT_FORM_TAB_IDS)).toBe('models');
		});

		it('maps the field ids the session validators report', () => {
			expect(firstTabWithError(['directory'], AGENT_FORM_TAB_IDS)).toBe('general');
			expect(firstTabWithError(['workingDir'], AGENT_FORM_TAB_IDS)).toBe('general');
		});

		it('skips a tab the surface does not show', () => {
			expect(firstTabWithError(['gateway'], MODERATOR_TAB_IDS)).toBeNull();
			expect(firstTabWithError(['gateway', 'sshRemote'], MODERATOR_TAB_IDS)).toBe('ssh');
		});

		it('ignores fields it does not know', () => {
			expect(firstTabWithError(['somethingElse'], AGENT_FORM_TAB_IDS)).toBeNull();
		});
	});

	it('tabsWithErrors collects every tab that holds an error', () => {
		expect([...tabsWithErrors(['name', 'provider', 'directory'], AGENT_FORM_TAB_IDS)]).toEqual([
			'general',
			'provider',
		]);
	});

	it('buildAgentSettingsTabs keeps strip order and marks tabs with errors', () => {
		const tabs = buildAgentSettingsTabs(['ssh', 'general', 'provider'], ['sshRemote']);
		expect(tabs.map((tab) => tab.id)).toEqual(['general', 'provider', 'ssh']);
		expect(tabs.map((tab) => tab.hasError)).toEqual([false, false, true]);
		expect(buildAgentSettingsTabs(MODERATOR_TAB_IDS).every((tab) => !tab.hasError)).toBe(true);
	});
});
