/**
 * Settings Components
 *
 * Components for the Settings modal and its sub-sections.
 */

// Main modal
export { SettingsModal } from './SettingsModal';

// Shared primitives
export { SettingsSectionHeading } from './SettingsSectionHeading';
export type { SettingsSectionHeadingProps } from './SettingsSectionHeading';

// SSH Remote configuration
export { SshRemoteModal } from './SshRemoteModal';
export type { SshRemoteModalProps } from './SshRemoteModal';

export { SshRemotesSection } from './SshRemotesSection';
export type { SshRemotesSectionProps } from './SshRemotesSection';

// Environment Variables editor
export { EnvVarsEditor } from './EnvVarsEditor';
export type { EnvVarsEditorProps, EnvVarEntry } from './EnvVarsEditor';

// File Panel Settings (indexer depth + entry cap)
export { FilePanelSettingsSection } from './FilePanelSettingsSection';
export type { FilePanelSettingsSectionProps } from './FilePanelSettingsSection';

// Claude Interactive Mode (maestro-p headless mode + Max plan quota snapshots)
export { ClaudeInteractiveModeSection } from './ClaudeInteractiveModeSection';
export type { ClaudeInteractiveModeSectionProps } from './ClaudeInteractiveModeSection';
