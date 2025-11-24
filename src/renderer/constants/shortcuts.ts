import type { Shortcut } from '../types';

export const DEFAULT_SHORTCUTS: Record<string, Shortcut> = {
  toggleSidebar: { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: ['Meta', 'b'] },
  toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle Right Panel', keys: ['Meta', '\\'] },
  cyclePrev: { id: 'cyclePrev', label: 'Previous Instance', keys: ['Meta', 'Shift', '{'] },
  cycleNext: { id: 'cycleNext', label: 'Next Instance', keys: ['Meta', 'Shift', '}'] },
  newInstance: { id: 'newInstance', label: 'New Instance', keys: ['Meta', 'n'] },
  killInstance: { id: 'killInstance', label: 'Kill Instance', keys: ['Meta', 'Shift', 'Backspace'] },
  toggleMode: { id: 'toggleMode', label: 'Switch AI/Shell Mode', keys: ['Meta', 'j'] },
  quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Meta', 'k'] },
  help: { id: 'help', label: 'Show Shortcuts', keys: ['Meta', '/'] },
  settings: { id: 'settings', label: 'Open Settings', keys: ['Meta', ','] },
  goToFiles: { id: 'goToFiles', label: 'Go to Files Tab', keys: ['Meta', 'Shift', 'f'] },
  goToHistory: { id: 'goToHistory', label: 'Go to History Tab', keys: ['Meta', 'Shift', 'h'] },
  goToScratchpad: { id: 'goToScratchpad', label: 'Go to Scratchpad Tab', keys: ['Meta', 'Shift', 's'] },
};
