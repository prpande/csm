interface ChevronIconProps {
  className?: string;
  /** Rendered square, in px. */
  size?: number;
}

export function ChevronIcon({ className, size = 15 }: ChevronIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
