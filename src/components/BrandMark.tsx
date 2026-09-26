import { cn } from "@/lib/utils";
import { Link } from "react-router";

/**
 * The PROFESHARE wordmark: a flat amber glyph block, the brand in display type and
 * the descriptor in mono so the technical side of the product shows up early.
 * Colours come from the theme tokens, so it reads correctly on both themes.
 *
 * `ai` is for the footer only: the brand is "PROFESHARE" in the nav, the auth
 * card and body copy, and "PROFESHARE AI" in the site footer. Keeping it a flag
 * rather than a second component means the glyph, spacing and descriptor stay in
 * one place.
 */
export function BrandMark({
  to = "/dashboard",
  showDescriptor = true,
  ai = false,
  className,
}: {
  to?: string;
  showDescriptor?: boolean;
  ai?: boolean;
  className?: string;
}) {
  const name = ai ? "PROFESHARE AI" : "PROFESHARE";

  return (
    <Link
      to={to}
      aria-label={`${name} Opportunity Search — home`}
      className={cn("flex items-center gap-2.5", className)}
    >
      <span
        className="grid size-8 shrink-0 place-items-center border-2 border-nb-line bg-nb-amber font-display text-sm leading-none text-nb-deep"
        aria-hidden="true"
      >
        P
      </span>
      <span className="leading-none">
        <span className="block font-display text-base tracking-tight text-nb-line">{name}</span>
        {showDescriptor && (
          <span className="mt-1 hidden font-mono text-[9px] tracking-[0.18em] text-nb-line/60 uppercase sm:block">
            Opportunity Search
          </span>
        )}
      </span>
    </Link>
  );
}
