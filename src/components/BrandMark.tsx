import { cn } from "@/lib/utils";
import { Link } from "react-router";

/**
 * The ClearRoute wordmark: a flat amber glyph block, the brand in display type
 * and the descriptor in mono so the technical side of the product shows up early.
 * Colours come from the theme tokens, so it reads correctly on both themes.
 *
 * The product name is the whole mark — the homepage header, the hero, the auth
 * card and both footers show "ClearRoute" and nothing else.
 */
export function BrandMark({
  to = "/dashboard",
  showDescriptor = true,
  className,
}: {
  to?: string;
  showDescriptor?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      aria-label="ClearRoute — home"
      className={cn("flex items-center gap-2.5", className)}
    >
      <span
        className="grid size-8 shrink-0 place-items-center border-2 border-nb-line bg-nb-amber font-display text-sm leading-none text-nb-deep"
        aria-hidden="true"
      >
        C
      </span>
      <span className="leading-none">
        <span className="block font-display text-base tracking-tight text-nb-line">
          ClearRoute
        </span>
        {showDescriptor && (
          <span className="mt-1 hidden font-mono text-[9px] tracking-[0.18em] text-nb-line/60 uppercase sm:block">
            Opportunity Search
          </span>
        )}
      </span>
    </Link>
  );
}
