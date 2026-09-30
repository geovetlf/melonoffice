/** A small spinner in the current text colour. It is decoration: its container says what waits. */
export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span className={['mo-spinner', className].filter(Boolean).join(' ')} aria-hidden="true" />
  );
}
