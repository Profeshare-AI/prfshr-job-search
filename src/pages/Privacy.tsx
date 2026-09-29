import { Link } from "react-router";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * Privacy notice.
 *
 * This page has to be true. The product stores search prompts and outcomes for
 * matching research, so the previous "nothing is stored" claim is gone and the
 * disclosure below is the one the schema actually implements:
 *
 *   - what is stored (searchEvents / searchResults / searchInteractions)
 *   - how identity is kept separate (pseudonymous ids from a salted hash)
 *   - what is never stored (passwords, one-time codes, tokens, API keys)
 *   - how long it is kept (RETENTION_DAYS, enforced by a daily purge)
 *   - who can see it (administrators only, with two-factor access)
 */
export default function Privacy() {
  const retentionDays = 180;

  const sections = [
    {
      title: "What we store",
      items: [
        "Your search prompt, in the form you wrote it.",
        "How it was read: the requirements, preferences and exclusions we detected, and which of them were mandatory.",
        "The ranked results we returned, with the reasons, the conflicts and the missing information behind each one.",
        "Operational information: which job boards answered, how long the search took, and how much model usage it cost.",
        "The actions you take on a result, such as opening a listing, expanding its details, or clicking through to apply.",
      ],
    },
    {
      title: "What we never store",
      items: [
        "Passwords, sign-in codes or email verification codes.",
        "Session tokens, API keys or provider credentials.",
        "The model's internal reasoning.",
        "Precise location — we only record a place if you named one in your prompt.",
        "Any cross-site tracking, advertising identifiers or unrelated behavioural surveillance.",
      ],
    },
    {
      title: "Your identity stays separate",
      items: [
        "Search analytics are stored against a pseudonymous identifier derived from a salted, one-way hash. It cannot be reversed into your account.",
        "Your account identity is kept out of the behaviour records entirely: no email address is written to a search event.",
        "Guests and signed-in accounts are recorded as different kinds of session, without naming either.",
      ],
    },
    {
      title: "Retention and deletion",
      items: [
        `Search prompts, their results and the interactions attached to them are deleted automatically after ${retentionDays} days.`,
        "Deletion is complete: the prompt, the result snapshot and the interaction records expire together, so nothing lingers after the window.",
        "You can ask for your own records to be deleted sooner, and the pseudonymous identifier makes that request possible without exposing anyone else's data.",
      ],
    },
    {
      title: "Please do not paste sensitive information",
      items: [
        "The prompt box is a free-text field, so treat it as you would a public job board search.",
        "There is no reason to include your salary history, your address, your identification numbers or anything medical.",
      ],
    },
    {
      title: "Research use",
      items: [
        "We keep search prompts and results so we can study where the matching goes wrong and improve it.",
        "Access is restricted to authorised administrators, who sign in with their own verified account and a separate access code.",
        "Retained records may be used later to evaluate and improve the matching and interpretation models.",
        "Records are never sold, and are not used for advertising.",
      ],
    },
    {
      title: "If you would rather not have prompts stored",
      items: [
        "Raw-prompt retention for matching research is the disclosed default of the current pilot, and it is what the workspace tells you before you search.",
        "If you would prefer aggregate-only telemetry, that preference is respected: the prompt text is then never written to the database, while the counts that keep the service working are.",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="nb-border-b sticky top-0 z-30 bg-nb-deep/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <BrandMark to="/" />
          <div className="flex items-center gap-3">
            <Link
              to="/about"
              className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline"
            >
              About
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-14">
        <p className="font-mono text-[10px] tracking-[0.22em] text-nb-amber uppercase">Privacy</p>
        <h1 className="mt-3 font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
          What ClearRoute keeps, and why
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-nb-line/55">
          ClearRoute searches live job listings and explains its results. To keep improving how it
          reads a request, it records searches and their outcomes. This page describes exactly what
          that means — including how long anything is kept and who can see it.
        </p>

        <div className="mt-10 space-y-4">
          {sections.map((section) => (
            <section key={section.title} className="nb-border nb-shadow bg-nb-surface p-5">
              <h2 className="font-display text-sm tracking-wide text-nb-line uppercase">
                {section.title}
              </h2>
              <ul className="mt-3 space-y-2">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-6 text-nb-line/60">
                    <span className="mt-[9px] size-1.5 shrink-0 bg-nb-amber" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="nb-border nb-shadow mt-4 bg-nb-surface p-5">
          <h2 className="font-display text-sm tracking-wide text-nb-line uppercase">
            Terms of use
          </h2>
          <p className="mt-3 text-sm leading-6 text-nb-line/60">
            ClearRoute is a free tool provided as-is. Listings come from third-party job boards and
            are credited where they appear; always confirm the details, and the terms of the
            employer, on the original posting before applying. Do not use the service to scrape,
            republish or resell listings, or to send automated traffic at the boards behind it.
          </p>
        </section>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            to="/"
            className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline"
          >
            Back to ClearRoute
          </Link>
          <Link
            to="/about"
            className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline"
          >
            About ClearRoute
          </Link>
        </div>
      </main>
    </div>
  );
}
