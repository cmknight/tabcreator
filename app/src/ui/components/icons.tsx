// Shared status icons (DESIGN.md: icon + text, never colour alone). Decorative: the text beside
// each icon says what it means, so both are `aria-hidden`. Size and colour come from `className`.

/** The warning triangle: Too loud / Too quiet, near the take limit, warning banners. */
export function WarnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3 2 20h20z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The error circle: error banners (storage full, engine failed). */
export function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** The pencil: the Tab screen's Rename take button. */
export function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Bar lines: the Tab toolbar's Bar lines toggle (two staff lines crossed by a bar). */
export function BarLinesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 8h18M3 16h18M12 4v16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
