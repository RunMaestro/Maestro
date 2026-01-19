/**
 * Wizard Module
 *
 * Onboarding wizard for new users to set up their first AI coding assistant session.
 * Guides users through agent selection, directory configuration, project discovery,
 * and document generation.
 */

export { MaestroWizard } from './MaestroWizard';
export { WizardProvider, useWizard } from './WizardContext';
export { WizardResumeModal } from './WizardResumeModal';
export { WizardExitConfirmModal } from './WizardExitConfirmModal';
export { ScreenReaderAnnouncement, useAnnouncement } from './ScreenReaderAnnouncement';
export { AUTO_RUN_FOLDER_NAME } from './services/phaseGenerator';
export type { WizardState, WizardStep, SerializableWizardState } from './WizardContext';
export type { AnnouncementPoliteness } from './ScreenReaderAnnouncement';
