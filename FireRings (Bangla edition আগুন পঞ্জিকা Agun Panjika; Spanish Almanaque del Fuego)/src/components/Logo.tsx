/** Original mark: concentric fire rings with one ember segment. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 2 A14 14 0 0 1 28.1 9" fill="none" stroke="var(--ember)" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M16 6.5 A9.5 9.5 0 0 1 24.2 11.2" fill="none" stroke="var(--ember)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.8" fill="var(--ember)" />
    </svg>
  );
}
