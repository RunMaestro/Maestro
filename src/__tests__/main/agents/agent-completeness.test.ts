/**
 * Agent Completeness Validation Tests
 *
 * Ensures every agent in AGENT_DEFINITIONS has all required pieces:
 * - Capabilities defined in AGENT_CAPABILITIES
 * - Output parser registered (if supportsJsonOutput)
 * - Session storage registered (if supportsSessionStorage)
 * - Error patterns registered (if has output parser)
 *
 * This test catches incomplete agent additions at CI time.
 * When adding a new agent, if this test fails it tells you exactly what's missing.
 *
 * SCOPE: this validates ONLY the built-in (compile-time) agents - the AGENT_IDS
 * tuple and its statically-typed AGENT_DEFINITIONS / AGENT_CAPABILITIES / parser
 * / storage tables. Runtime agents registered by plugins (the AgentRegistry,
 * shared/plugins/agent-registry.ts) deliberately live OUTSIDE these static
 * structures: they are not part of the AgentId union and must not be required to
 * appear in AGENT_DEFINITIONS. A plugin agent's completeness is guaranteed by
 * construction in its contribution validator + the registry, and covered by
 * agent-registry.test.ts. Do NOT make AGENT_IDS dynamic to include plugin agents
 * - that would break the exhaustiveness this test protects.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AGENT_DEFINITIONS, AGENT_CAPABILITIES, getAgentCapabilities } from '../../../main/agents';
import { initializeOutputParsers, getOutputParser, getErrorPatterns } from '../../../main/parsers';
import { getSessionStorage, clearStorageRegistry } from '../../../main/agents/session-storage';
import { initializeSessionStorages } from '../../../main/storage';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	AGENT_AUTOSELECT_ORDER,
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	getAgentDisplayName,
	getAgentLoginCommand,
} from '../../../shared/agentMetadata';
import { createAgentRegistry } from '../../../shared/plugins/agent-registry';

beforeAll(() => {
	initializeOutputParsers();
	clearStorageRegistry();
	initializeSessionStorages();
});

describe('Agent Completeness', () => {
	describe('AGENT_IDS ↔ AGENT_DEFINITIONS consistency', () => {
		it('every agent in AGENT_DEFINITIONS should have an ID in AGENT_IDS', () => {
			for (const def of AGENT_DEFINITIONS) {
				expect(
					AGENT_IDS.includes(def.id as (typeof AGENT_IDS)[number]),
					`Agent "${def.id}" is in AGENT_DEFINITIONS but not in AGENT_IDS (shared/agentIds.ts)`
				).toBe(true);
			}
		});

		it('every ID in AGENT_IDS should have a definition in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const id of AGENT_IDS) {
				expect(
					definedIds.includes(id),
					`Agent ID "${id}" is in AGENT_IDS but not in AGENT_DEFINITIONS (agents/definitions.ts)`
				).toBe(true);
			}
		});
	});

	describe('per-agent completeness', () => {
		for (const def of AGENT_DEFINITIONS) {
			describe(`${def.id}`, () => {
				it('has capabilities defined in AGENT_CAPABILITIES', () => {
					expect(
						AGENT_CAPABILITIES[def.id],
						`Agent "${def.id}" is missing from AGENT_CAPABILITIES (agents/capabilities.ts)`
					).toBeDefined();
				});

				it('has all required capability fields', () => {
					const caps = AGENT_CAPABILITIES[def.id];
					if (!caps) return; // Covered by previous test

					const requiredBooleanFields = [
						'supportsResume',
						'supportsReadOnlyMode',
						'supportsJsonOutput',
						'supportsSessionId',
						'supportsImageInput',
						'supportsImageInputOnResume',
						'supportsSlashCommands',
						'supportsSessionStorage',
						'supportsCostTracking',
						'supportsUsageStats',
						'supportsBatchMode',
						'supportsStreaming',
						'supportsResultMessages',
						'supportsModelSelection',
						'requiresPromptToStart',
						'supportsStreamJsonInput',
						'supportsPromptViaStdin',
						'supportsThinkingDisplay',
						'supportsContextMerge',
						'supportsContextExport',
						'supportsAdditionalDirectories',
					];

					for (const field of requiredBooleanFields) {
						expect(
							typeof (caps as Record<string, unknown>)[field],
							`Agent "${def.id}" is missing capability field "${field}"`
						).toBe('boolean');
					}
				});

				// The capability boolean and the arg builder are two halves of one
				// feature: the boolean drives UI copy ("enforced by the provider" vs
				// "instructions only") while the builder produces the actual flags.
				// Let them drift and the UI promises enforcement that never ships.
				it('declares additionalDirArgs iff supportsAdditionalDirectories', () => {
					const caps = getAgentCapabilities(def.id);

					if (caps.supportsAdditionalDirectories) {
						expect(
							typeof def.additionalDirArgs,
							`Agent "${def.id}" has supportsAdditionalDirectories=true but no additionalDirArgs() in agents/definitions.ts, so its grants would silently never reach the CLI`
						).toBe('function');
					} else {
						expect(
							def.additionalDirArgs,
							`Agent "${def.id}" defines additionalDirArgs() but supportsAdditionalDirectories=false, so the args are built and the UI still tells the user nothing is enforced`
						).toBeUndefined();
					}
				});

				it('emits no directory args when the agent has no grants', () => {
					// Guards the common spawn case: an agent with an empty grant list
					// must not gain a stray flag (a bare `--add-dir` with no value would
					// eat the next arg, which on several paths is the prompt).
					expect(def.additionalDirArgs?.([]) ?? []).toEqual([]);
				});

				it('has output parser if supportsJsonOutput', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsJsonOutput) {
						expect(
							getOutputParser(def.id),
							`Agent "${def.id}" has supportsJsonOutput=true but no output parser registered`
						).not.toBeNull();
					}
				});

				it('has session storage if supportsSessionStorage', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsSessionStorage) {
						expect(
							getSessionStorage(def.id),
							`Agent "${def.id}" has supportsSessionStorage=true but no session storage registered`
						).not.toBeNull();
					}
				});

				it('has error patterns if has output parser', () => {
					const parser = getOutputParser(def.id);
					if (parser) {
						const patterns = getErrorPatterns(def.id);
						expect(
							Object.keys(patterns).length,
							`Agent "${def.id}" has an output parser but no error patterns registered`
						).toBeGreaterThan(0);
					}
				});
			});
		}
	});

	describe('provider picker registration', () => {
		it('every agent id has a picker decision, shown or explicitly withheld', () => {
			for (const agentId of AGENT_IDS) {
				expect(
					Object.prototype.hasOwnProperty.call(AGENT_PICKER_META, agentId),
					`Agent "${agentId}" has no entry in AGENT_PICKER_META. Add presentation ` +
						'metadata to offer it in the pickers, or null to withhold it.'
				).toBe(true);
			}
		});

		it('offers providers alphabetically by display name', () => {
			// One predictable order across the New Agent modal, the wizard tile strip
			// and the Group Chat moderator dropdown, so a provider is where the user
			// expects it no matter which surface they open.
			const names = PICKABLE_AGENT_IDS.map((id) => getAgentDisplayName(id));
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		});

		it('auto-selects a real pickable agent rather than whatever sorts first', () => {
			for (const agentId of AGENT_AUTOSELECT_ORDER) {
				expect(
					PICKABLE_AGENT_IDS.includes(agentId),
					`Auto-select preference "${agentId}" is not a pickable provider`
				).toBe(true);
			}
		});

		it('every pickable agent is a real, non-hidden definition', () => {
			for (const agentId of PICKABLE_AGENT_IDS) {
				const def = AGENT_DEFINITIONS.find((d) => d.id === agentId);
				expect(def, `Pickable agent "${agentId}" has no definition`).toBeDefined();
				expect(def?.hidden, `Pickable agent "${agentId}" is hidden`).toBeFalsy();
			}
		});

		// Providers that hold no credentials of their own, so `null` from
		// getAgentLoginCommand is the correct answer rather than a missing entry.
		// Pi and Oh My Pi are harnesses over a provider the user configures
		// elsewhere; Hermes ships no login flow. Adding an id here is a deliberate
		// claim that the agent cannot be logged in to, not a way to silence a gap.
		const CREDENTIALLESS_AGENTS = new Set(['hermes', 'pi', 'omp']);

		it('every pickable agent can be re-authenticated from the UI', () => {
			// A provider offered in a picker whose auth expires needs a way back in.
			// An earlier version of this test skipped a null command outright, which
			// let a genuinely missing entry pass as if it were credentialless.
			for (const agentId of PICKABLE_AGENT_IDS) {
				const login = getAgentLoginCommand(agentId);

				if (CREDENTIALLESS_AGENTS.has(agentId)) {
					expect(
						login,
						`Agent "${agentId}" is listed as credentialless but declares a login command. ` +
							'Remove it from CREDENTIALLESS_AGENTS.'
					).toBeNull();
					continue;
				}

				expect(
					login,
					`Agent "${agentId}" is pickable but has no login command. Add one to ` +
						'AGENT_LOGIN_COMMANDS, or add the id to CREDENTIALLESS_AGENTS if it ' +
						'genuinely carries no credentials.'
				).not.toBeNull();
				expect(login?.binary?.trim(), `Agent "${agentId}" has an empty login binary`).toBeTruthy();
				expect(
					typeof login?.args,
					`Agent "${agentId}" must declare args (empty string when the bare binary is the flow)`
				).toBe('string');
			}
		});
	});

	describe('no orphaned capabilities', () => {
		it('every agent in AGENT_CAPABILITIES should be in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const agentId of Object.keys(AGENT_CAPABILITIES)) {
				expect(
					definedIds.includes(agentId),
					`Agent "${agentId}" is in AGENT_CAPABILITIES but not in AGENT_DEFINITIONS`
				).toBe(true);
			}
		});
	});

	// Runtime (plugin) agents are intentionally NOT subject to the static
	// completeness checks above. They are known to the registry but absent from
	// the compile-time tables, and that separation is the relaxation that lets
	// plugins add agents without touching first-party type exhaustiveness.
	describe('runtime agents live outside the static core', () => {
		it('a registered runtime agent is known but is not a built-in', () => {
			const reg = createAgentRegistry([
				{
					id: 'com.acme/bot',
					localId: 'bot',
					pluginId: 'com.acme',
					displayName: 'Bot',
					binaryName: 'bot',
					baseArgs: [],
					capabilities: {},
				},
			]);
			expect(reg.isKnown('com.acme/bot')).toBe(true);
			expect(reg.isBuiltIn('com.acme/bot')).toBe(false);
			// It must NOT leak into the static built-in structures.
			expect(AGENT_IDS.includes('com.acme/bot' as (typeof AGENT_IDS)[number])).toBe(false);
			expect(AGENT_DEFINITIONS.map((d) => d.id).includes('com.acme/bot')).toBe(false);
		});

		it('every built-in id is reported as built-in by the registry', () => {
			const reg = createAgentRegistry([]);
			for (const id of AGENT_IDS) {
				expect(reg.isBuiltIn(id), `registry should treat "${id}" as built-in`).toBe(true);
			}
		});
	});
});
