import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EXAMPLE_LABELS, EXAMPLE_QUERIES } from "@/lib/examples";
import { cn } from "@/lib/utils";
import { CornerDownLeft, Loader2, Search } from "lucide-react";
import type { KeyboardEvent } from "react";

export function SearchBar({
  value,
  onChange,
  onSubmit,
  isSearching,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  isSearching: boolean;
}) {
  const submit = () => {
    if (isSearching) return;
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    onSubmit(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="nb-border nb-shadow bg-nb-surface">
      <div className="nb-border-b flex items-center justify-between gap-3 bg-nb-deep px-4 py-2">
        <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
          Describe the role you want
        </h2>
        <span className="hidden items-center gap-1 font-mono text-[10px] text-nb-line/55 uppercase sm:flex">
          <CornerDownLeft className="size-3" />
          Enter to search
        </span>
      </div>

      <div className="p-3 sm:p-4">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          maxLength={400}
          disabled={isSearching}
          placeholder="e.g. Find data and AI internships in Paris or Île-de-France, English-friendly, starting in January, suitable for a master's student with Python and SQL."
          className="min-h-[92px] resize-none rounded-none border-2 border-nb-line bg-nb-deep px-3 py-3 text-sm leading-6 text-nb-line shadow-none placeholder:text-nb-line/55 focus-visible:border-nb-amber focus-visible:ring-0 md:text-sm"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-5 text-nb-line/60">
            Plain English is enough. PROFESHARE reads the role, level, location, start
            date and skills, ranks the live listings against them, and attaches a
            reason to every score.
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={isSearching || value.trim().length < 3}
            className="nb-border nb-press h-11 gap-2 rounded-none bg-nb-amber px-5 font-display text-xs tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
          >
            {isSearching ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Searching
              </>
            ) : (
              <>
                <Search className="size-4" />
                Find matches
              </>
            )}
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLE_QUERIES.map((example, index) => (
            <button
              key={example}
              type="button"
              disabled={isSearching}
              onClick={() => {
                onChange(example);
                onSubmit(example);
              }}
              title={example}
              className={cn(
                "nb-border nb-press max-w-full truncate bg-nb-deep px-2.5 py-1.5 text-left font-mono text-[10px]",
                "tracking-[0.06em] text-nb-line/60 uppercase transition-colors",
                "hover:bg-nb-amber hover:text-nb-deep disabled:opacity-40",
              )}
            >
              {EXAMPLE_LABELS[index]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
