type Props = {
  open: boolean;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** В Electron нативный confirm() часто ломает фокус в полях ввода после закрытия. */
export function ConfirmDialog({
  open,
  message,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  return (
    <div className="mod-confirm-overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="mod-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="mod-confirm-message">{message}</p>
        <div className="mod-confirm-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
