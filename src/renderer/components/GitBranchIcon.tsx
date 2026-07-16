interface GitBranchIconProps {
  className?: string;
  /** Rendered square, in px. */
  size?: number;
}

// The git glyph, shared by the session row's branch chip (#101/#110) and the
// folder tree's repo marker (#111). Extracted so the two cannot drift into two
// different-looking git icons — the repo's rule-of-three convention (#61)
// governs duplicated LOGIC; path data that must stay visually identical is a
// different case.
//
// Always aria-hidden: it is decorative in both call sites, each of which carries
// the meaning in its own accessible name / title.
export function GitBranchIcon({ className, size = 11 }: GitBranchIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}
