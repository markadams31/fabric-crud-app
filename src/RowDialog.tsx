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
  makeStyles,
} from '@fluentui/react-components';
import { useRef, useState } from 'react';

import { dynamic, readable, type Row } from './db';
import { validateDraft } from './validate';
import type { EntityView, FieldView } from './entity';
import { Field } from './Field';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '4px' },
});

/**
 * The create/edit form for one row.
 *
 * Mounted only while open, so there is no reset logic: the initial state
 * computed below *is* the freshly opened form, every time.
 */
export function RowDialog({
  view,
  row,
  lookups,
  onClose,
  onSaved,
}: {
  view: EntityView;
  /** The row being edited, or null when creating. */
  row: Row | null;
  /** Rows of each lookup target, keyed by foreign-key field. */
  lookups: Record<string, Row[]>;
  onClose: () => void;
  /** Called after a successful save, with the row as it now stands — so the
   *  caller can name what changed rather than say "a row was saved". */
  onSaved: (saved: Row) => void;
}) {
  const styles = useStyles();
  /**
   * Each mode offers only what its own grant permits. The same list for the
   * sample, whose only exclusions are audit columns absent from both.
   */
  const shown = row ? view.updatable : view.creatable;
  /**
   * A new row starts at the schema's declared defaults, not at blank. Blank
   * made a defaulted column read as unset — the form asked for a value the
   * schema already had, and a `default: true` boolean rendered unticked while
   * the write stored `true`, showing the opposite of what was saved.
   */
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      shown.map((f) => {
        const value = row ? row[f.name] : f.defaultValue;
        return [f.name, value == null ? '' : toInput(value, f)];
      })
    )
  );
  /**
   * The draft as opened, so a save can send only what actually changed.
   * Sending every field made one person's edit overwrite another's work on
   * columns they never touched: updates are partial server-side, so a diffed
   * write lets concurrent edits to different columns merge instead of clobber.
   */
  const opened = useRef(draft);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // A failure here has to be shown inside the dialog — a banner on the page
  // sits behind the modal scrim, dimmed, where nobody looks.
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Guards against a second submit while the first is in flight.
   *
   * A ref, not state: two clicks in the same tick both read the old state, so
   * state cannot stop a genuine double-click. And it must be a guard rather
   * than `disabled` on the button — disabling the element that currently has
   * focus drops focus to <body>, outside the modal, after which the dialog
   * never sees the Escape key and the app looks frozen.
   */
  const submitting = useRef(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;

    const { input, errors } = validateDraft(view, draft, shown);
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setError(null);
      return;
    }

    setFieldErrors({});
    setError(null);
    submitting.current = true;
    setSaving(true);
    try {
      if (row) {
        const touched = Object.fromEntries(
          Object.entries(input).filter(([name]) => draft[name] !== opened.current[name])
        );
        // Nothing edited: writing anyway would stamp the audit columns and
        // claim a change that never happened.
        if (Object.keys(touched).length) await dynamic(view.name).update(row.id, touched);
        // The stored row plus what this save changed — `update` returns
        // nothing, and naming the row by its pre-edit values would report the
        // old name for a row whose name was just corrected.
        onSaved({ ...row, ...touched });
      } else onSaved(await dynamic(view.name).create(input));
    } catch (e) {
      setError(readable(e));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  // Dismissal is blocked while saving — otherwise a failed save reports its
  // error to a dialog nobody can see. Same doctrine as delete and import.
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && !saving && onClose()}>
      <DialogSurface>
        <form onSubmit={onSubmit} noValidate>
          <DialogBody>
            <DialogTitle>
              {row ? `Edit ${view.title.toLowerCase()}` : `New ${view.title.toLowerCase()}`}
            </DialogTitle>
            <DialogContent className={styles.form}>
              {/* role=alert: Fluent's MessageBar is role="group", so a failed
                  save rendered silently — the user pressed Add, nothing was
                  announced, and the button still said Add. */}
              {error && (
                <div role="alert">
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                </div>
              )}
              {shown.map((f) => (
                <Field
                  key={f.name}
                  field={f}
                  value={draft[f.name] ?? ''}
                  error={fieldErrors[f.name]}
                  options={lookups[f.name]}
                  onChange={(value) => setDraft({ ...draft, [f.name]: value })}
                />
              ))}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit">
                {saving ? 'Saving…' : row ? 'Save' : 'Add'}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/** A stored value as the form's text input wants it. */
function toInput(value: unknown, field: FieldView): string {
  if (field.constraints.type === 'boolean') return value ? 'true' : 'false';
  if (field.constraints.type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return String(value);
}

