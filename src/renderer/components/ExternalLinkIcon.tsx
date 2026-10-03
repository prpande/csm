interface ExternalLinkIconProps {
  className?: string;
  /** Rendered square, in px. */
  size?: number;
}

export function ExternalLinkIcon({
  className,
  size = 15,
}: ExternalLinkIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
