/**
 * Tests for DeleteAgentConfirmModal component
 *
 * Tests the core behavior of the delete agent confirmation dialog:
 * - Rendering with agent name, working directory, and three buttons
 * - Button click handlers (Cancel, Agent Only, Agent + Work Directory)
 * - Confirmation input for enabling destructive action
 * - Focus management
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteAgentConfirmModal } from '../../../renderer/components/DeleteAgentConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
  X: () => <svg data-testid="x-icon" />,
  AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
  Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="trash2-icon" className={className} style={style} />
  ),
}));

// Create a test theme
const testTheme: Theme = {
  id: 'test-theme',
  name: 'Test Theme',
  mode: 'dark',
  colors: {
    bgMain: '#1e1e1e',
    bgSidebar: '#252526',
    bgActivity: '#333333',
    textMain: '#d4d4d4',
    textDim: '#808080',
    accent: '#007acc',
    accentDim: '#007acc80',
    accentText: '#ffffff',
    accentForeground: '#ffffff',
    border: '#404040',
    error: '#f14c4c',
    warning: '#cca700',
    success: '#89d185',
  },
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
  return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('DeleteAgentConfirmModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders with agent name and three action buttons', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText(/TestAgent/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Only' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent + Work Directory' })).toBeInTheDocument();
    });

    it('renders working directory path', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('/home/user/project')).toBeInTheDocument();
    });

    it('renders danger warning text with agent name', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      // Check the danger warning text (now split into "Danger:" label and message)
      expect(screen.getByText('Danger:')).toBeInTheDocument();
      expect(screen.getByText(/You are about to delete the agent/)).toBeInTheDocument();
    });

    it('renders explanatory text about Agent + Work Directory', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      // Check the explanatory text
      expect(screen.getByText(/will also move the working directory to the trash/)).toBeInTheDocument();
    });

    it('renders header with title and close button', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
      expect(screen.getByTestId('x-icon')).toBeInTheDocument();
    });

    it('has correct ARIA attributes', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'Confirm Delete');
    });
  });

  describe('confirmation input', () => {
    it('renders confirmation input with correct placeholder', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      expect(input).toBeInTheDocument();
    });

    it('input value updates on change', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'Test' } });
      expect(input).toHaveValue('Test');
    });

    it('"Agent + Work Directory" button is disabled by default', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).toBeDisabled();
    });

    it('"Agent + Work Directory" button remains disabled with partial input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'Test' } });

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).toBeDisabled();
    });

    it('"Agent + Work Directory" button remains disabled with wrong input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'WrongName' } });

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).toBeDisabled();
    });

    it('"Agent + Work Directory" button becomes enabled when exact agent name is typed', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'TestAgent' } });

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).not.toBeDisabled();
    });

    it('"Agent + Work Directory" button becomes enabled with case-insensitive match', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'testagent' } });

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).not.toBeDisabled();
    });

    it('"Agent + Work Directory" button becomes enabled with trimmed input', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: '  TestAgent  ' } });

      const eraseButton = screen.getByRole('button', { name: 'Agent + Work Directory' });
      expect(eraseButton).not.toBeDisabled();
    });
  });

  describe('focus management', () => {
    it('focuses Agent Only button on mount (not Agent + Work Directory)', async () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agent Only' }));
      });
    });
  });

  describe('button handlers', () => {
    it('calls onClose when X button is clicked', () => {
      const onClose = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={onClose}
        />
      );

      const closeButton = screen.getByTestId('x-icon').closest('button');
      fireEvent.click(closeButton!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('"Agent Only" button is always enabled and calls onConfirm', () => {
      const callOrder: string[] = [];
      const onClose = vi.fn(() => callOrder.push('close'));
      const onConfirm = vi.fn(() => callOrder.push('confirm'));
      const onConfirmAndErase = vi.fn();

      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      const agentOnlyButton = screen.getByRole('button', { name: 'Agent Only' });
      expect(agentOnlyButton).not.toBeDisabled();

      fireEvent.click(agentOnlyButton);
      expect(callOrder).toEqual(['confirm', 'close']);
      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });

    it('calls onConfirmAndErase then onClose when Agent + Work Directory is clicked (after confirmation)', () => {
      const callOrder: string[] = [];
      const onClose = vi.fn(() => callOrder.push('close'));
      const onConfirm = vi.fn();
      const onConfirmAndErase = vi.fn(() => callOrder.push('confirmAndErase'));

      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      // First type the agent name to enable the button
      const input = screen.getByPlaceholderText('Type the agent name here to confirm directory deletion.');
      fireEvent.change(input, { target: { value: 'TestAgent' } });

      fireEvent.click(screen.getByRole('button', { name: 'Agent + Work Directory' }));
      expect(callOrder).toEqual(['confirmAndErase', 'close']);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('does not call onConfirmAndErase when Agent + Work Directory is clicked while disabled', () => {
      const onConfirmAndErase = vi.fn();
      const onClose = vi.fn();

      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={onConfirmAndErase}
          onClose={onClose}
        />
      );

      // Click without typing the agent name
      fireEvent.click(screen.getByRole('button', { name: 'Agent + Work Directory' }));
      expect(onConfirmAndErase).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Cancel does not call onConfirm or onConfirmAndErase', () => {
      const onConfirm = vi.fn();
      const onConfirmAndErase = vi.fn();
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={onConfirm}
          onConfirmAndErase={onConfirmAndErase}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onConfirmAndErase).not.toHaveBeenCalled();
    });
  });

  describe('keyboard interaction', () => {
    it('stops propagation of keydown events', () => {
      const parentHandler = vi.fn();

      render(
        <div onKeyDown={parentHandler}>
          <LayerStackProvider>
            <DeleteAgentConfirmModal
              theme={testTheme}
              agentName="TestAgent"
              workingDirectory="/home/user/project"
              onConfirm={vi.fn()}
              onConfirmAndErase={vi.fn()}
              onClose={vi.fn()}
            />
          </LayerStackProvider>
        </div>
      );

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
      expect(parentHandler).not.toHaveBeenCalled();
    });
  });

  describe('layer stack integration', () => {
    it('registers and unregisters without errors', () => {
      const { unmount } = renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('accessibility', () => {
    it('has tabIndex on dialog for focus', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
    });

    it('has semantic button elements and input (5 interactive elements total)', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      // X close, Cancel, Agent Only, Agent + Work Directory = 4 buttons
      expect(screen.getAllByRole('button')).toHaveLength(4);
      // Plus 1 text input
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('has heading for modal title', () => {
      renderWithLayerStack(
        <DeleteAgentConfirmModal
          theme={testTheme}
          agentName="TestAgent"
          workingDirectory="/home/user/project"
          onConfirm={vi.fn()}
          onConfirmAndErase={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('heading', { name: 'Confirm Delete' })).toBeInTheDocument();
    });
  });
});
