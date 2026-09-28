import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { SOURCE_CREDITS } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";

const NAV = [
  { key: "search", label: "Search", to: "/dashboard", hint: "Describe a role in plain English" },
  { key: "catalog", label: "Catalog", to: "/browse", hint: "Browse every live listing" },
] as const;

export function AppShell({
  active,
  children,
}: {
  active: (typeof NAV)[number]["key"];
  children: ReactNode;
}) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="nb-border-b sticky top-0 z-30 bg-nb-deep/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <BrandMark to="/dashboard" />

          <nav aria-label="Primary" className="flex items-center gap-2">
            {NAV.map((item) => {
              const current = item.key === active;
              return (
                <Link
                  key={item.key}
                  to={item.to}
                  title={item.hint}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "nb-border px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors",
                    current
                      ? "bg-nb-amber text-nb-deep"
                      : "bg-nb-surface text-nb-line/70 hover:bg-nb-surface2 hover:text-nb-line",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <span className="hidden max-w-[14rem] truncate font-mono text-[11px] text-nb-line/60 lg:block">
              {user?.email ?? user?.name ?? "Guest session"}
            </span>
            <ThemeToggle />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              className="nb-border nb-press gap-2 rounded-none bg-nb-surface text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">{children}</main>

      <footer className="nb-border-t bg-nb-deep">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5">
          <p className="max-w-2xl text-xs leading-5 text-nb-line/60">
            Live listings from{" "}
            {SOURCE_CREDITS.map((credit, index) => (
              <span key={credit.label}>
                {index > 0 ? (index === SOURCE_CREDITS.length - 1 ? " and " : ", ") : ""}
                <a
                  href={credit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-nb-line underline decoration-2 underline-offset-2"
                >
                  {credit.label}
                </a>
              </span>
            ))}{" "}
            · nothing is stored on our servers, your search lives in this tab.
          </p>
          <p className="font-mono text-[10px] tracking-[0.2em] text-nb-line/55 uppercase">
            PROFESHARE AI · Version 1
          </p>
        </div>
      </footer>
    </div>
  );
}
