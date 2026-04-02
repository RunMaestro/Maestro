# Phase 10-B: Consolidate Group Chat Spawn Boilerplate and Store resolve()

## Objective

1. Extract shared `spawnGroupChatAgent()` helper to replace 5 spawn sites with ~150 lines of repeated SSH wrapping + Windows config each
2. Extract shared `resolve<T>()` store utility (1 confirmed copy)

**Evidence:** `docs/agent-guides/scans/SCAN-PATTERNS.md`, "Group chat spawn sites" and "resolve() definitions in stores"
**Risk:** Medium - group chat spawn touches SSH and process management. Test thoroughly.
**Estimated savings:** ~128 lines

---

## Pre-flight Checks

- [ ] Phase 10-A (modal layer migration) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Part 1: Group Chat Spawn Helper

### Task 1: Read the 5 spawn sites

Read each spawn call site to understand the common pattern:

1. `main/group-chat/group-chat-agent.ts:226`
2. `main/group-chat/group-chat-router.ts:583`
3. `main/group-chat/group-chat-router.ts:976`
4. `main/group-chat/group-chat-router.ts:1352`
5. `main/group-chat/group-chat-router.ts:1553`

Document:
- What parameters vary between sites (agent type, session config, working dir)
- What's identical (SSH wrapping, Windows config, process manager call)

### Task 2: Design the helper

Create `src/main/group-chat/spawnGroupChatAgent.ts`:

```typescript
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

interface GroupChatSpawnConfig {
	agentType: string;
	sessionId: string;
	workingDir: string;
	systemPrompt?: string;
	sshRemoteConfig?: SshRemoteConfig;
	customPath?: string;
	customArgs?: string[];
	customEnvVars?: Record<string, string>;
}

export async function spawnGroupChatAgent(
	config: GroupChatSpawnConfig,
	processManager: ProcessManager,
	settingsStore: SettingsStore,
): Promise<SpawnResult> {
	let spawnConfig = buildBaseSpawnConfig(config);
	
	// SSH wrapping
	if (config.sshRemoteConfig?.enabled) {
		const sshStore = createSshRemoteStoreAdapter(settingsStore);
		spawnConfig = await wrapSpawnWithSsh(spawnConfig, config.sshRemoteConfig, sshStore);
	}
	
	// Windows-specific adjustments
	if (process.platform === 'win32') {
		// ... Windows shell wrapping
	}
	
	return processManager.spawn(spawnConfig);
}
```

### Task 3: Write tests

Create `src/__tests__/main/group-chat/spawnGroupChatAgent.test.ts`:
- Spawns with basic config
- Wraps with SSH when sshRemoteConfig is enabled
- Applies Windows adjustments on win32
- Passes through custom path, args, and env vars
- Uses correct agent binary name

### Task 4: Replace the 5 spawn sites

For each site:
1. Replace the inline spawn logic with a call to `spawnGroupChatAgent()`
2. Pass the site-specific config
3. Verify the behavior is identical

### Task 5: Verify

```
rtk npm run lint
rtk vitest run
```

---

## Part 2: Store resolve() Utility

### Task 6: Check if resolve() is still duplicated

```
rtk grep -rn "function resolve\|const resolve" src/renderer/stores/ --include="*.ts"
```

Per 2026-04-01 re-validation, only `batchStore.ts:86` is confirmed. If only 1 copy exists, this may not be worth extracting. However, if the pattern is useful, create a shared utility.

### Task 7: Extract if multiple copies exist

If there are 2+ copies, create `src/renderer/stores/utils.ts`:

```typescript
/**
 * Create a promise that can be resolved externally.
 * Used for async store operations that complete via callback.
 */
export function createDeferredPromise<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
```

If only 1 copy, skip this task.

### Task 8: Final verification

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

---

## Success Criteria

- `spawnGroupChatAgent()` helper created with tests
- 5 spawn sites consolidated
- SSH and Windows patterns handled correctly
- Store `resolve()` extracted if warranted
- Lint and tests pass
