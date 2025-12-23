/**
 * Spec Kit prompts module
 *
 * Bundled prompts from GitHub's spec-kit project with our custom Maestro implementation.
 * These prompts are imported at build time using Vite's ?raw suffix.
 *
 * Source: https://github.com/github/spec-kit
 * Version: 0.0.90
 */

// Bundled spec-kit prompts (from upstream)
import constitutionPrompt from './speckit.constitution.md?raw';
import specifyPrompt from './speckit.specify.md?raw';
import clarifyPrompt from './speckit.clarify.md?raw';
import planPrompt from './speckit.plan.md?raw';
import tasksPrompt from './speckit.tasks.md?raw';
import analyzePrompt from './speckit.analyze.md?raw';
import checklistPrompt from './speckit.checklist.md?raw';
import tasksToIssuesPrompt from './speckit.taskstoissues.md?raw';

// Custom Maestro prompts
import helpPrompt from './speckit.help.md?raw';
import implementPrompt from './speckit.implement.md?raw';

// Metadata
import metadataJson from './metadata.json';

export interface SpecKitCommandDefinition {
  id: string;
  command: string;
  description: string;
  prompt: string;
  isCustom: boolean;
}

export interface SpecKitMetadata {
  lastRefreshed: string;
  commitSha: string;
  sourceVersion: string;
  sourceUrl: string;
}

/**
 * All bundled spec-kit commands
 */
export const speckitCommands: SpecKitCommandDefinition[] = [
  {
    id: 'help',
    command: '/speckit.help',
    description: 'Learn how to use spec-kit with Maestro',
    prompt: helpPrompt,
    isCustom: true,
  },
  {
    id: 'constitution',
    command: '/speckit.constitution',
    description: 'Create or update the project constitution',
    prompt: constitutionPrompt,
    isCustom: false,
  },
  {
    id: 'specify',
    command: '/speckit.specify',
    description: 'Create or update feature specification',
    prompt: specifyPrompt,
    isCustom: false,
  },
  {
    id: 'clarify',
    command: '/speckit.clarify',
    description: 'Identify underspecified areas and ask clarification questions',
    prompt: clarifyPrompt,
    isCustom: false,
  },
  {
    id: 'plan',
    command: '/speckit.plan',
    description: 'Execute implementation planning workflow',
    prompt: planPrompt,
    isCustom: false,
  },
  {
    id: 'tasks',
    command: '/speckit.tasks',
    description: 'Generate actionable, dependency-ordered tasks',
    prompt: tasksPrompt,
    isCustom: false,
  },
  {
    id: 'analyze',
    command: '/speckit.analyze',
    description: 'Cross-artifact consistency and quality analysis',
    prompt: analyzePrompt,
    isCustom: false,
  },
  {
    id: 'checklist',
    command: '/speckit.checklist',
    description: 'Generate custom checklist for feature',
    prompt: checklistPrompt,
    isCustom: false,
  },
  {
    id: 'taskstoissues',
    command: '/speckit.taskstoissues',
    description: 'Convert tasks to GitHub issues',
    prompt: tasksToIssuesPrompt,
    isCustom: false,
  },
  {
    id: 'implement',
    command: '/speckit.implement',
    description: 'Execute tasks using Maestro Auto Run with worktree support',
    prompt: implementPrompt,
    isCustom: true,
  },
];

/**
 * Get a spec-kit command by ID
 */
export function getSpeckitCommand(id: string): SpecKitCommandDefinition | undefined {
  return speckitCommands.find((cmd) => cmd.id === id);
}

/**
 * Get a spec-kit command by slash command string
 */
export function getSpeckitCommandBySlash(command: string): SpecKitCommandDefinition | undefined {
  return speckitCommands.find((cmd) => cmd.command === command);
}

/**
 * Get the metadata for bundled spec-kit prompts
 */
export function getSpeckitMetadata(): SpecKitMetadata {
  return {
    lastRefreshed: metadataJson.lastRefreshed,
    commitSha: metadataJson.commitSha,
    sourceVersion: metadataJson.sourceVersion,
    sourceUrl: metadataJson.sourceUrl,
  };
}

// Export individual prompts for direct access
export {
  helpPrompt,
  constitutionPrompt,
  specifyPrompt,
  clarifyPrompt,
  planPrompt,
  tasksPrompt,
  analyzePrompt,
  checklistPrompt,
  tasksToIssuesPrompt,
  implementPrompt,
};
