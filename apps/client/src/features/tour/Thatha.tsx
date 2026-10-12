/**
 * Muthu Thatha: an original SVG Tamil farmer-mentor (white mundasu turban, spectacles, vibhuti,
 * grey moustache, green thundu). The mouth animates while `talking`; the eyes blink.
 */
export function Thatha({ talking, size = 96 }: { talking: boolean; size?: number }) {
  return (
    <svg
      className={`tour-thatha${talking ? ' talking' : ''}`}
      width={size}
      height={size * 1.1}
      viewBox="0 0 120 132"
      role="img"
      aria-label="Muthu Thatha, your farming mentor"
    >
      <circle cx="60" cy="62" r="56" fill="#f6d9a8" />
      {/* veshti shirt + green thundu over the shoulder */}
      <path d="M18 132 C20 102 36 92 60 92 C84 92 100 102 102 132 Z" fill="#fbf6ea" />
      <path d="M30 100 C46 96 58 110 72 132 L56 132 C48 118 38 108 26 106 Z" fill="#3f8f4e" />
      <path d="M54 92 L60 104 L66 92" fill="none" stroke="#d8cdb6" strokeWidth="2" />
      {/* neck, ears, face */}
      <rect x="52" y="78" width="16" height="16" rx="6" fill="#9b6238" />
      <ellipse cx="33" cy="60" rx="5" ry="8" fill="#a8693d" />
      <ellipse cx="87" cy="60" rx="5" ry="8" fill="#a8693d" />
      <ellipse cx="60" cy="58" rx="27" ry="31" fill="#b5784a" />
      {/* mundasu turban */}
      <path
        d="M30 44 C30 22 46 14 60 14 C76 14 92 22 90 44 C80 36 70 34 60 34 C48 34 40 36 30 44 Z"
        fill="#fffdf6"
        stroke="#e2d6bd"
        strokeWidth="1.5"
      />
      <path d="M34 34 C48 26 72 24 88 34" fill="none" stroke="#e2d6bd" strokeWidth="2" />
      <path d="M38 24 C52 20 68 20 82 26" fill="none" stroke="#e2d6bd" strokeWidth="2" />
      <path d="M84 30 C94 30 98 40 92 48 C90 40 88 36 84 34 Z" fill="#fffdf6" stroke="#e2d6bd" />
      {/* vibhuti + kumkum */}
      <g stroke="#f4efe6" strokeWidth="2" strokeLinecap="round">
        <line x1="48" y1="40" x2="72" y2="40" />
        <line x1="47" y1="44" x2="73" y2="44" />
        <line x1="48" y1="48" x2="72" y2="48" />
      </g>
      <circle cx="60" cy="44" r="2.2" fill="#c8102e" />
      {/* brows, eyes, spectacles */}
      <path
        d="M42 52 Q48 48 54 52"
        fill="none"
        stroke="#e8e8e8"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M66 52 Q72 48 78 52"
        fill="none"
        stroke="#e8e8e8"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <g className="tour-eyes">
        <circle cx="48" cy="59" r="2.6" fill="#2a1d14" />
        <circle cx="72" cy="59" r="2.6" fill="#2a1d14" />
      </g>
      <g fill="rgba(255,255,255,0.18)" stroke="#5a4130" strokeWidth="1.6">
        <circle cx="48" cy="59" r="8" />
        <circle cx="72" cy="59" r="8" />
        <path d="M56 59 Q60 56 64 59" fill="none" />
      </g>
      <path d="M58 62 Q60 70 56 72 Q60 74 63 72" fill="none" stroke="#8d5630" strokeWidth="1.6" />
      {/* mouth (behind the moustache) */}
      <ellipse className="tour-mouth" cx="60" cy="82" rx="6" ry="3.2" fill="#5b2318" />
      <path
        d="M60 74 C52 72 42 74 38 82 C46 80 52 80 60 78 C68 80 74 80 82 82 C78 74 68 72 60 74 Z"
        fill="#ececec"
        stroke="#cfcfcf"
        strokeWidth="1"
      />
    </svg>
  );
}
