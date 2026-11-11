import { useId, type SVGProps } from "react";

/** Credence AI "Spark C" mark. Source: src-tauri/icons/src/logo-mark.svg */
const ARC = "M44.05 16.39A21 21 0 1 0 44.05 47.61";
const SPARK = "M46.5 21.5Q46.5 32 57 32Q46.5 32 46.5 42.5Q46.5 32 36 32Q46.5 32 46.5 21.5Z";

/** App icon: white mark on the brand gradient tile. Size it with width/height or className. */
export function BrandTile(p: SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="0 0 64 64" width={32} height={32} aria-hidden {...p}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c6cff" />
          <stop offset="1" stopColor="#4f39f6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${id})`} />
      <g transform="translate(32 32) scale(0.72) translate(-32 -32)" fill="#fff">
        <path d={ARC} fill="none" stroke="#fff" strokeWidth="7.5" strokeLinecap="round" />
        <path d={SPARK} />
      </g>
    </svg>
  );
}
