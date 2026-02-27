# ENCORE-INBOX-02: Add `unifiedInbox` flag to EncoreFeatureFlags

## Objective
Register the Unified Inbox as an Encore Feature with a type flag and default value.

## Context
- `EncoreFeatureFlags` interface is at `src/renderer/types/index.ts:906` — currently only has `directorNotes: boolean`
- `DEFAULT_ENCORE_FEATURES` is at `src/renderer/stores/settingsStore.ts:110` — currently `{ directorNotes: false }`
- The settings store hydration merges saved values with defaults at `settingsStore.ts:1669-1673` using spread: `{ ...DEFAULT_ENCORE_FEATURES, ...(saved) }` — so new fields with defaults are safe
- Both type AND default MUST be updated in the same task to avoid runtime `undefined`

## Tasks

- [x] In `src/renderer/types/index.ts`, find the `EncoreFeatureFlags` interface at line 906. Add `unifiedInbox: boolean` below `directorNotes`. Also in `src/renderer/stores/settingsStore.ts`, find `DEFAULT_ENCORE_FEATURES` at line 110. Add `unifiedInbox: false` to the object. Both changes must happen together:
  ```typescript
  // types/index.ts:906
  export interface EncoreFeatureFlags {
    directorNotes: boolean;
    unifiedInbox: boolean;
  }

  // stores/settingsStore.ts:110
  export const DEFAULT_ENCORE_FEATURES: EncoreFeatureFlags = {
    directorNotes: false,
    unifiedInbox: false,
  };
  ```

- [x] Run `npm run lint` to verify the new field doesn't cause type errors. Existing code spreading `encoreFeatures` will pick up the new field automatically via the default merge at line 1669-1673.

## Gate
- `npm run lint` passes
- `EncoreFeatureFlags` has both `directorNotes` and `unifiedInbox` fields
- `DEFAULT_ENCORE_FEATURES` has `unifiedInbox: false`
