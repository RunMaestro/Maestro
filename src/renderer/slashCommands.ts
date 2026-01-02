// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

export interface SlashCommand {
  command: string;
  description: string;
  terminalOnly?: boolean; // Only show this command in terminal mode
  aiOnly?: boolean; // Only show this command in AI mode
}

// Built-in Maestro slash commands
// These are intercepted by Maestro and handled specially (not passed to the agent)
export const slashCommands: SlashCommand[] = [
  {
    command: '/history',
    description: 'Generate a synopsis of recent work and add to history',
    aiOnly: true,
  },
];

// iOS development slash commands
// These are passed to the AI agent which uses IPC handlers to execute them
export const iosSlashCommands: SlashCommand[] = [
  {
    command: '/ios.snapshot',
    description: 'Capture screenshot, logs, and crash info from iOS simulator',
    aiOnly: true,
  },
  {
    command: '/ios.inspect',
    description: 'Inspect UI hierarchy of iOS simulator to find elements',
    aiOnly: true,
  },
  {
    command: '/ios.run_flow',
    description: 'Run a Maestro test flow on iOS simulator',
    aiOnly: true,
  },
  {
    command: '/ios.assert_visible',
    description: 'Assert that a UI element is visible on screen',
    aiOnly: true,
  },
  {
    command: '/ios.assert_no_crash',
    description: 'Assert that the app has not crashed',
    aiOnly: true,
  },
  {
    command: '/ios.wait_for',
    description: 'Wait for a UI element to become visible',
    aiOnly: true,
  },
  {
    command: '/ios.ship_feature',
    description: 'Run closed-loop development: launch → flow → verify → snapshot',
    aiOnly: true,
  },
];

// All slash commands (for autocomplete)
export const allSlashCommands: SlashCommand[] = [...slashCommands, ...iosSlashCommands];
