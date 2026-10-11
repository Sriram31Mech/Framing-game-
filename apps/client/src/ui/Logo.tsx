/** Bharat Harvest mark: a marigold flame/grain over two paddy furrows. */
export function Logo({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#1f1912" />
      <path
        d="M32 9c-7.5 9-9.5 18.5-6.2 27.3 1.9 4.9 5 8 6.2 16.7 1.2-8.7 4.3-11.8 6.2-16.7C41.5 27.5 39.5 18 32 9z"
        fill="#f2a12e"
      />
      <path
        d="M32 18c-3 5-3.6 10.5-1.6 16 .8 2.1 1.3 3.4 1.6 6 .3-2.6.8-3.9 1.6-6 2-5.5 1.4-11-1.6-16z"
        fill="#ffd27a"
      />
      <path
        d="M12 47c8-2.4 13.5-1.4 20 6 6.5-7.4 12-8.4 20-6"
        stroke="#74c35f"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
