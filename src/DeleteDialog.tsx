import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useRef, useState } from 'react';

import { rowIdentity } from './columns';
import { dynamic, readable, type Row } from './db';
import type { EntityView } from './entity';

/**
 * "Delete this row?" — with the row named, because a confirm that does not
 * say what it is about confirms nothing.
 *
 * A failure shows here, in the dialog: the likeliest one is the database
 * refusing because other rows still reference this one, which is exactly the
 * moment the person needs to read something. All three dialogs share one
 * doctrine while a write is in flight: the primary button stays enabled with
 * a ref guard (disabling the focused element drops focus to <body> and kills
 * Escape), dismissal is blocked so a failure is never reported to a dialog
 * nobody can see, and Cancel is disabled to say so.
 */
export function DeleteDialog({
  view,
  row,
  lookups,
  onClose,
  onDeleted,
}: {
  view: EntityView;
  row: Row;
  lookups: Record<string, Row[]>;
  onClose: () => void;
  /** Called after a successful delete, with how the row read before it went,
   *  trimmed to the same length the save toast uses. */
  onDeleted: (identity: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inFlight = useRef(false);

  const identity = rowIdentity(row, view, lookups);
  /**
   * The same trim the save toast uses. Slicing at the call site instead cut
   * mid-word with no ellipsis, so one long value read as a truncated bug next
   * to "Saved AUD · Australian Dollar…" from the identical helper.
   */
  const shortIdentity = rowIdentity(row, view, lookups, 48);

  const onConfirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);
    try {
      await dynamic(view.name).delete(row.id);
      onDeleted(shortIdentity);
    } catch (e) {
      setError(readable(e));
      setDeleting(false);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    // `alert`, not the default `modal`: it renders role="alertdialog", which
    // tells a screen reader this is a decision to make rather than a panel that
    // opened, and it stops a stray click on the backdrop from dismissing a
    // destructive confirm. Escape is deliberately NOT gated by it (measured in
    // Fluent's useDialogSurface: only backdrop click is), so the guard below
    // still governs dismissal while the delete is in flight.
    <Dialog open modalType="alert" onOpenChange={(_, d) => !d.open && !deleting && onClose()}>
      {/*
        Swallowing the backdrop click is not enough on its own: the press still
        moves focus to <body>, and Escape is handled on the surface, so the
        dialog became dismissable by neither mouse nor keyboard (measured —
        activeElement was BODY and Escape did nothing). preventDefault on
        mousedown is what stops a press from taking focus, so it stays in the
        dialog and Escape keeps working. Same failure the primary button's ref
        guard exists to avoid, arriving by a different route.
      */}
      <DialogSurface backdrop={{ onMouseDown: (e) => e.preventDefault() }}>
        <DialogBody>
          <DialogTitle>Delete {view.title.toLowerCase()}?</DialogTitle>
          <DialogContent>
            {/* role=alert: Fluent's MessageBar is role="group". This error
                REPLACES the confirmation text, so without it the dialog's whole
                content changed silently — the worst instance in the app. */}
            {error ? (
              <div role="alert">
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              </div>
            ) : (
              <>
                <strong>{identity || row.id}</strong> will be deleted. This cannot be undone.
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={deleting}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void onConfirm()}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
