import { Toast, ToastTitle, Toaster, useId, useToastController } from '@fluentui/react-components';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * A short confirmation that an action landed.
 *
 * Saves, deletes and imports used to close their dialog and say nothing, so on
 * a slow backend an accepted write and a silent no-op looked identical — and a
 * screen reader was told neither. Fluent's toast carries its own polite live
 * region, so this is the accessible announcement as much as the visible one.
 *
 * Deliberately plain: one line, no body text, no icon of its own, dismissed on
 * a timer. A confirmation that has to be read or clicked away costs more
 * attention than the action it is confirming.
 */
const ToastContext = createContext<(message: string) => void>(() => {});

/** Announce a completed action. Nothing is shown for failures — those belong
 *  in the dialog that failed, where the user can act on them. */
export const useAnnounce = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);
  const announce = (message: string) =>
    dispatchToast(
      <Toast>
        <ToastTitle>{message}</ToastTitle>
      </Toast>,
      // Bottom-end keeps it out of the toolbar and the grid's first rows, which
      // is where the eye already is after an action. Long enough to read at a
      // glance, short enough not to stack up during a run of edits.
      { intent: 'success', position: 'bottom-end', timeout: 2600 }
    );

  return (
    <ToastContext.Provider value={announce}>
      {children}
      <Toaster toasterId={toasterId} />
    </ToastContext.Provider>
  );
}
