/**
 * @file AutoRunExpandedModal.test.tsx
 * @description Tests for the AutoRunExpandedModal component - an expanded fullscreen modal for Auto Run editing
 *
 * The AutoRunExpandedModal:
 * - Opens as a fullscreen modal with the Auto Run component embedded
 * - Has Edit/Preview mode controls in the header
 * - Has Save/Revert buttons when content is dirty
 * - Has Run/Stop buttons for batch processing
 * - Closes via Escape key, backdrop click, or close buttons
 * - Syncs with the embedded AutoRun component for content and dirty state
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoRunExpandedModal } from '../../../renderer/components/AutoRunExpandedModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState, SessionState, Shortcut } from '../../../renderer/types';

// Mock createPortal to render in same container
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="x-icon" className={className} style={style} />
  ),
  Minimize2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="minimize2-icon" className={className} style={style} />
  ),
  Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="eye-icon" className={className} style={style} />
  ),
  Edit: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="edit-icon" className={className} style={style} />
  ),
  Play: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="play-icon" className={className} style={style} />
  ),
  Square: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="square-icon" className={className} style={style} />
  ),
  Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="loader2-icon" className={className} style={style} />
  ),
  Image: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="image-icon" className={className} style={style} />
  ),
  Save: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="save-icon" className={className} style={style} />
  ),
  RotateCcw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="rotate-ccw-icon" className={className} style={style} />
  ),
  LayoutGrid: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <svg data-testid="layout-grid-icon" className={className} style={style} />
  ),
}));

// Track AutoRun ref methods
let autoRunRefMethods: {
  focus: ReturnType<typeof vi.fn>;
  switchMode: ReturnType<typeof vi.fn>;
  isDirty: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
};

// Mock AutoRun component
vi.mock('../../../renderer/components/AutoRun', () => ({
  AutoRun: React.forwardRef((props: any, ref: any) => {
    // Expose ref methods
    React.useImperativeHandle(ref, () => autoRunRefMethods);
    return (
      <div data-testid="autorun-component">
        <span data-testid="autorun-mode">{props.mode}</span>
        <span data-testid="autorun-content">{props.content}</span>
        <span data-testid="autorun-hidetopcontrols">{String(props.hideTopControls)}</span>
        <textarea
          data-testid="autorun-textarea"
          value={props.content}
          onChange={(e) => props.onContentChange(e.target.value)}
        />
      </div>
    );
  }),
}));

// Mock shortcut formatter
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
  formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
  id: 'test-theme',
  name: 'Test Theme',
  mode: 'dark',
  colors: {
    bgMain: '#1a1a1a',
    bgSidebar: '#252525',
    bgPanel: '#2d2d2d',
    bgActivity: '#333333',
    textMain: '#ffffff',
    textDim: '#888888',
    accent: '#0066ff',
    accentForeground: '#ffffff',
    border: '#333333',
    highlight: '#0066ff33',
    success: '#00aa00',
    warning: '#ffaa00',
    error: '#ff0000',
  },
});

// Default props for AutoRunExpandedModal
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRunExpandedModal>> = {}) => ({
  theme: createMockTheme(),
  onClose: vi.fn(),
  sessionId: 'test-session-1',
  folderPath: '/test/folder',
  selectedFile: 'test-doc',
  documentList: ['test-doc', 'another-doc'],
  content: '# Test Content\n\nSome markdown content.',
  onContentChange: vi.fn(),
  mode: 'edit' as const,
  onModeChange: vi.fn(),
  onOpenSetup: vi.fn(),
  onRefresh: vi.fn(),
  onSelectDocument: vi.fn(),
  onCreateDocument: vi.fn().mockResolvedValue(true),
  ...overrides,
});

// Helper to render with LayerStackProvider
const renderWithProvider = (ui: React.ReactElement) => {
  return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('AutoRunExpandedModal', () => {
  beforeEach(() => {
    // Reset AutoRun ref methods
    autoRunRefMethods = {
      focus: vi.fn(),
      switchMode: vi.fn(),
      isDirty: vi.fn().mockReturnValue(false),
      save: vi.fn().mockResolvedValue(undefined),
      revert: vi.fn(),
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Rendering', () => {
    it('should render modal with Auto Run title', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByText('Auto Run')).toBeInTheDocument();
    });

    it('should render the embedded AutoRun component', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByTestId('autorun-component')).toBeInTheDocument();
    });

    it('should pass hideTopControls=true to AutoRun', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByTestId('autorun-hidetopcontrols')).toHaveTextContent('true');
    });

    it('should render Edit button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
    });

    it('should render Preview button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument();
      expect(screen.getByTestId('eye-icon')).toBeInTheDocument();
    });

    // NOTE: Image upload button is currently disabled in the component (wrapped in `false &&`)
    // This test is skipped until the feature is re-enabled
    it.skip('should render image upload button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByTitle(/add image/i)).toBeInTheDocument();
      expect(screen.getByTestId('image-icon')).toBeInTheDocument();
    });

    it('should render Run button when not running batch', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
      expect(screen.getByTestId('play-icon')).toBeInTheDocument();
    });

    it('should render Collapse button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
      expect(screen.getByTestId('minimize2-icon')).toBeInTheDocument();
    });

    it('should render close button with X icon', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByTitle('Close (Esc)')).toBeInTheDocument();
      expect(screen.getByTestId('x-icon')).toBeInTheDocument();
    });
  });

  describe('Mode Controls', () => {
    it('should show Edit button as selected when mode is edit', () => {
      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Find the Edit button by its title (not the image button)
      const editButton = screen.getByTitle('Edit document');
      expect(editButton).toHaveClass('font-semibold');
    });

    it('should show Preview button as selected when mode is preview', () => {
      const props = createDefaultProps({ mode: 'preview' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const previewButton = screen.getByRole('button', { name: /preview/i });
      expect(previewButton).toHaveClass('font-semibold');
    });

    it('should call AutoRun switchMode when Edit button is clicked', () => {
      const props = createDefaultProps({ mode: 'preview' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Find the Edit button by its title (not the image button)
      const editButton = screen.getByTitle('Edit document');
      fireEvent.click(editButton);

      expect(autoRunRefMethods.switchMode).toHaveBeenCalledWith('edit');
    });

    it('should call AutoRun switchMode when Preview button is clicked', () => {
      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const previewButton = screen.getByRole('button', { name: /preview/i });
      fireEvent.click(previewButton);

      expect(autoRunRefMethods.switchMode).toHaveBeenCalledWith('preview');
    });

    it('should fall back to onModeChange if switchMode is not available', () => {
      // Remove switchMode from ref
      autoRunRefMethods.switchMode = undefined as any;

      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const previewButton = screen.getByRole('button', { name: /preview/i });
      fireEvent.click(previewButton);

      expect(props.onModeChange).toHaveBeenCalledWith('preview');
    });
  });

  describe('Batch Run State', () => {
    it('should show Stop button when batch run is active', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
      expect(screen.getByTestId('square-icon')).toBeInTheDocument();
    });

    it('should show Stopping button when stopping batch run', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: true } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();
      expect(screen.getByTestId('loader2-icon')).toBeInTheDocument();
    });

    it('should disable Stop button when stopping', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: true } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const stopButton = screen.getByRole('button', { name: /stopping/i });
      expect(stopButton).toBeDisabled();
    });

    it('should call onStopBatchRun when Stop button is clicked', () => {
      const onStopBatchRun = vi.fn();
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
        onStopBatchRun,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const stopButton = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(stopButton);

      expect(onStopBatchRun).toHaveBeenCalled();
    });

    it('should call onOpenBatchRunner when Run button is clicked', () => {
      const onOpenBatchRunner = vi.fn();
      const props = createDefaultProps({ onOpenBatchRunner });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const runButton = screen.getByRole('button', { name: /run/i });
      fireEvent.click(runButton);

      expect(onOpenBatchRunner).toHaveBeenCalled();
    });

    it('should disable Run button when agent is busy', () => {
      const props = createDefaultProps({
        sessionState: 'busy' as SessionState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).toBeDisabled();
    });

    it('should disable Run button when agent is connecting', () => {
      const props = createDefaultProps({
        sessionState: 'connecting' as SessionState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).toBeDisabled();
    });
  });

  describe('Locked State (During Batch Run)', () => {
    it('should disable Edit button when locked', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Find the Edit button by title (it shows "Editing disabled while Auto Run active" when locked)
      const editButton = screen.getByTitle('Editing disabled while Auto Run active');
      expect(editButton).toBeDisabled();
    });

    it('should show Edit button as disabled style when locked', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Find the Edit button by title
      const editButton = screen.getByTitle('Editing disabled while Auto Run active');
      expect(editButton).toHaveClass('opacity-50', 'cursor-not-allowed');
    });

    // NOTE: Image upload button is currently disabled in the component (wrapped in `false &&`)
    // This test is skipped until the feature is re-enabled
    it.skip('should disable image upload button when locked', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const imageButton = screen.getByTitle(/editing disabled while auto run active/i);
      expect(imageButton).toBeDisabled();
    });

    it('should show Preview as selected when locked', () => {
      const props = createDefaultProps({
        mode: 'edit',
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const previewButton = screen.getByRole('button', { name: /preview/i });
      expect(previewButton).toHaveClass('font-semibold');
    });
  });

  describe('Dirty State and Save/Revert', () => {
    it('should not show Save/Revert buttons when not dirty', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(false);

      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /revert/i })).not.toBeInTheDocument();
    });

    it('should show Save/Revert buttons when dirty', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /revert/i })).toBeInTheDocument();
    });

    it('should call AutoRun save when Save button is clicked', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      expect(autoRunRefMethods.save).toHaveBeenCalled();
    });

    it('should call AutoRun revert when Revert button is clicked', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const revertButton = screen.getByRole('button', { name: /revert/i });
      fireEvent.click(revertButton);

      expect(autoRunRefMethods.revert).toHaveBeenCalled();
    });

    it('should not show Save/Revert in preview mode even if dirty', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({ mode: 'preview' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    it('should not show Save/Revert when locked even if dirty', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({
        mode: 'edit',
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    it('should save before opening batch runner if dirty', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);
      const onOpenBatchRunner = vi.fn();

      const props = createDefaultProps({ mode: 'edit', onOpenBatchRunner });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Click Run button
      const runButton = screen.getByRole('button', { name: /run/i });
      fireEvent.click(runButton);

      expect(autoRunRefMethods.save).toHaveBeenCalled();
      expect(onOpenBatchRunner).toHaveBeenCalled();
    });
  });

  describe('Close Functionality', () => {
    it('should call onClose when close button is clicked', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const closeButton = screen.getByTitle('Close (Esc)');
      fireEvent.click(closeButton);

      expect(props.onClose).toHaveBeenCalled();
    });

    it('should call onClose when Collapse button is clicked', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const collapseButton = screen.getByRole('button', { name: /collapse/i });
      fireEvent.click(collapseButton);

      expect(props.onClose).toHaveBeenCalled();
    });

    it('should call onClose when backdrop is clicked', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Click on the backdrop (outer div)
      const backdrop = container.querySelector('.fixed.inset-0');
      if (backdrop) {
        fireEvent.click(backdrop);
      }

      expect(props.onClose).toHaveBeenCalled();
    });

    it('should not call onClose when modal content is clicked', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Click on the AutoRun component
      const autoRunComponent = screen.getByTestId('autorun-component');
      fireEvent.click(autoRunComponent);

      expect(props.onClose).not.toHaveBeenCalled();
    });
  });

  describe('Layer Stack Integration', () => {
    it('should close when Escape key is pressed', async () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Simulate Escape key (handled by layer stack)
      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(props.onClose).toHaveBeenCalled();
      });
    });
  });

  describe('Focus Management', () => {
    it('should focus AutoRun component on mount', async () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance past the focus timeout (50ms)
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(autoRunRefMethods.focus).toHaveBeenCalled();
    });
  });

  describe('Keyboard Shortcuts Display', () => {
    it('should show keyboard shortcut in Collapse button title when provided', () => {
      const shortcuts: Record<string, Shortcut> = {
        toggleAutoRunExpanded: {
          id: 'toggleAutoRunExpanded',
          name: 'Toggle Auto Run Expanded',
          keys: ['Meta', 'Shift', 'A'],
        },
      };

      const props = createDefaultProps({ shortcuts });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const collapseButton = screen.getByRole('button', { name: /collapse/i });
      expect(collapseButton).toHaveAttribute('title', 'Collapse (Meta+Shift+A)');
    });

    it('should show default Esc shortcut in Collapse button when no shortcut provided', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const collapseButton = screen.getByRole('button', { name: /collapse/i });
      expect(collapseButton).toHaveAttribute('title', 'Collapse (Esc)');
    });
  });

  describe('Theme Colors', () => {
    it('should apply theme background color to modal', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const modal = container.querySelector('.rounded-xl.border.shadow-2xl');
      expect(modal).toHaveStyle({
        backgroundColor: props.theme.colors.bgSidebar,
        borderColor: props.theme.colors.border,
      });
    });

    it('should apply theme text color to title', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const title = screen.getByText('Auto Run');
      expect(title).toHaveStyle({ color: props.theme.colors.textMain });
    });

    it('should apply theme accent color to Run button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).toHaveStyle({
        backgroundColor: props.theme.colors.accent,
      });
    });

    it('should apply theme error color to Stop button', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const stopButton = screen.getByRole('button', { name: /stop/i });
      expect(stopButton).toHaveStyle({
        backgroundColor: props.theme.colors.error,
      });
    });
  });

  describe('Modal Structure', () => {
    it('should have fixed positioning with z-100', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const overlay = container.querySelector('.fixed.inset-0');
      expect(overlay).toHaveClass('z-[100]');
    });

    it('should have semi-transparent backdrop', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const overlay = container.querySelector('.fixed.inset-0');
      expect(overlay).toHaveStyle({ backgroundColor: 'rgba(0,0,0,0.7)' });
    });

    it('should have 90vw width and 80vh height', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const modal = container.querySelector('.w-\\[90vw\\].h-\\[80vh\\]');
      expect(modal).toBeInTheDocument();
    });

    it('should have max-w-5xl class', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const modal = container.querySelector('.max-w-5xl');
      expect(modal).toBeInTheDocument();
    });

    it('should have rounded corners and border', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const modal = container.querySelector('.rounded-xl.border.shadow-2xl');
      expect(modal).toBeInTheDocument();
    });
  });

  // NOTE: Image upload button is currently disabled in the component (wrapped in `false &&`)
  // These tests are skipped until the feature is re-enabled
  describe.skip('Image Upload Button', () => {
    it('should be enabled in edit mode', () => {
      const props = createDefaultProps({ mode: 'edit' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const imageButton = screen.getByTitle(/add image/i);
      expect(imageButton).not.toBeDisabled();
    });

    it('should be disabled in preview mode', () => {
      const props = createDefaultProps({ mode: 'preview' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const imageButton = screen.getByTitle(/switch to edit mode/i);
      expect(imageButton).toBeDisabled();
    });

    it('should have ghosted style in preview mode', () => {
      const props = createDefaultProps({ mode: 'preview' });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const imageButton = screen.getByTitle(/switch to edit mode/i);
      expect(imageButton).toHaveClass('opacity-30', 'cursor-not-allowed');
    });

    it('should have file input for image selection', () => {
      const props = createDefaultProps();
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute('accept', 'image/*');
    });
  });

  describe('Dirty State Polling', () => {
    it('should poll isDirty every 100ms', async () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance time to trigger multiple polls
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // isDirty should be called multiple times (approximately 5 times for 500ms at 100ms intervals)
      expect(autoRunRefMethods.isDirty).toHaveBeenCalledTimes(5);
    });

    it('should stop polling when unmounted', async () => {
      const props = createDefaultProps();
      const { unmount } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance time to trigger some polls
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const callCountBeforeUnmount = autoRunRefMethods.isDirty.mock.calls.length;

      unmount();

      // Advance more time
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Call count should not have increased after unmount
      expect(autoRunRefMethods.isDirty.mock.calls.length).toBe(callCountBeforeUnmount);
    });
  });

  describe('Accessibility', () => {
    it('should have accessible Edit button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const editButton = screen.getByRole('button', { name: /edit/i });
      expect(editButton).toHaveAttribute('title');
    });

    it('should have accessible Preview button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const previewButton = screen.getByRole('button', { name: /preview/i });
      expect(previewButton).toHaveAttribute('title', 'Preview document');
    });

    it('should have accessible Run button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).toHaveAttribute('title');
    });

    it('should have accessible close button', () => {
      const props = createDefaultProps();
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const closeButton = screen.getByTitle('Close (Esc)');
      expect(closeButton.tagName).toBe('BUTTON');
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined batchRunState', () => {
      const props = createDefaultProps({ batchRunState: undefined });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Should render Run button
      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('should handle undefined sessionState', () => {
      const props = createDefaultProps({ sessionState: undefined });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Run button should be enabled
      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).not.toBeDisabled();
    });

    it('should handle undefined shortcuts', () => {
      const props = createDefaultProps({ shortcuts: undefined });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const collapseButton = screen.getByRole('button', { name: /collapse/i });
      expect(collapseButton).toHaveAttribute('title', 'Collapse (Esc)');
    });

    it('should handle undefined onOpenBatchRunner', () => {
      const props = createDefaultProps({ onOpenBatchRunner: undefined });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Run button should still render
      const runButton = screen.getByRole('button', { name: /run/i });
      expect(runButton).toBeInTheDocument();

      // Clicking should not throw
      expect(() => fireEvent.click(runButton)).not.toThrow();
    });

    it('should handle undefined onStopBatchRun', () => {
      const props = createDefaultProps({
        batchRunState: { isRunning: true, isStopping: false } as BatchRunState,
        onStopBatchRun: undefined,
      });
      renderWithProvider(<AutoRunExpandedModal {...props} />);

      const stopButton = screen.getByRole('button', { name: /stop/i });
      expect(() => fireEvent.click(stopButton)).not.toThrow();
    });
  });

  describe('Save Button Keyboard Shortcut Hint', () => {
    it('should show ⌘S shortcut on Save button hover', async () => {
      autoRunRefMethods.isDirty.mockReturnValue(true);

      const props = createDefaultProps({ mode: 'edit' });
      const { container } = renderWithProvider(<AutoRunExpandedModal {...props} />);

      // Advance timer to trigger dirty state poll
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Find the shortcut hint element
      const shortcutHint = container.querySelector('span.opacity-0.group-hover\\:opacity-100');
      expect(shortcutHint).toBeInTheDocument();
      expect(shortcutHint).toHaveTextContent('⌘S');
    });
  });
});
