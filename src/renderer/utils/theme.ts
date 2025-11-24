import type { Theme, SessionState } from '../types';

// Get color based on context usage percentage
export const getContextColor = (usage: number, theme: Theme): string => {
  if (usage >= 80) return theme.colors.error;
  if (usage >= 60) return theme.colors.warning;
  return theme.colors.success;
};

// Get color based on session state
export const getStatusColor = (state: SessionState, theme: Theme): string => {
  switch (state) {
    case 'busy': return theme.colors.error;
    case 'waiting_input': return theme.colors.warning;
    default: return theme.colors.success;
  }
};
