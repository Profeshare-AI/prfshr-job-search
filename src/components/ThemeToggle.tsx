import { cn } from "@/lib/utils";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/**
 * next-themes has not resolved yet on the very first render, so the initial
 * value is read straight off the document element (the blocking script in the
 * provider has already written the class). That keeps the icon correct on the
 * first paint instead of flashing the wrong one.
 */
function readIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return !document.documentElement.classList.contains("light");
}

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [isDark, setIsDark] = useState(readIsDark);

  useEffect(() => {
    if (resolvedTheme) setIsDark(resolvedTheme === "dark");
  }, [resolvedTheme]);

  const label = isDark ? "Switch to the light theme" : "Switch to the dark theme";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = isDark ? "light" : "dark";
        setTheme(next);
        setIsDark(!isDark);
      }}
      className={cn(
        "nb-focus nb-border nb-press grid size-9 shrink-0 place-items-center bg-nb-surface text-nb-line",
        "hover:bg-nb-amber hover:text-nb-deep",
        className,
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
