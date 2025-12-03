/**
 * Modal Priority Constants
 *
 * Defines the priority/z-index values for all modals and overlays in the application.
 * Higher values appear on top. The layer stack system uses these priorities to determine
 * which layer should handle the Escape key and which layer should be visually on top.
 *
 * Priority Ranges:
 * - 1000+: Critical modals (confirmations)
 * - 900-999: High priority modals (rename, create)
 * - 700-899: Standard modals (new instance, quick actions)
 * - 400-699: Settings and informational modals
 * - 100-399: Overlays and previews
 * - 1-99: Search and autocomplete
 */
export const MODAL_PRIORITIES = {
  /** Standing ovation achievement overlay - celebration! */
  STANDING_OVATION: 1100,

  /** Confirmation dialogs - highest priority, always on top */
  CONFIRM: 1000,

  /** Rename instance modal */
  RENAME_INSTANCE: 900,

  /** Rename tab modal */
  RENAME_TAB: 875,

  /** Rename group modal */
  RENAME_GROUP: 850,

  /** Create new group modal */
  CREATE_GROUP: 800,

  /** New instance creation modal */
  NEW_INSTANCE: 750,

  /** Batch runner modal for scratchpad auto mode */
  BATCH_RUNNER: 720,

  /** Tab switcher modal (Opt+Cmd+T) */
  TAB_SWITCHER: 710,

  /** Prompt composer modal for long prompts */
  PROMPT_COMPOSER: 725,

  /** Auto Run setup/folder selection modal */
  AUTORUN_SETUP: 710,

  /** Quick actions command palette (Cmd+K) */
  QUICK_ACTION: 700,

  /** Agent sessions browser (Cmd+Shift+L) */
  AGENT_SESSIONS: 680,

  /** Execution queue browser modal */
  EXECUTION_QUEUE_BROWSER: 670,

  /** Keyboard shortcuts help modal */
  SHORTCUTS_HELP: 650,

  /** About/info modal */
  ABOUT: 600,

  /** Process monitor modal */
  PROCESS_MONITOR: 550,

  /** System log viewer overlay */
  LOG_VIEWER: 500,

  /** Settings modal */
  SETTINGS: 450,

  /** Git diff preview overlay */
  GIT_DIFF: 200,

  /** Git log viewer overlay */
  GIT_LOG: 190,

  /** Image lightbox overlay */
  LIGHTBOX: 150,

  /** File preview overlay */
  FILE_PREVIEW: 100,

  /** Slash command autocomplete */
  SLASH_AUTOCOMPLETE: 50,

  /** File tree filter input */
  FILE_TREE_FILTER: 30,
} as const;

/**
 * Type for modal priority keys
 */
export type ModalPriorityKey = keyof typeof MODAL_PRIORITIES;

/**
 * Type for modal priority values
 */
export type ModalPriorityValue = (typeof MODAL_PRIORITIES)[ModalPriorityKey];
