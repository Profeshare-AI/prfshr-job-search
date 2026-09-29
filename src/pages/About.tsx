import { Link } from "react-router";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

/**
 * About.
 *
 * Deliberately short and specific: what ClearRoute is for, what it does, and
 * what it does not do. No product roadmap, no contact details that do not exist,
 * and no mention of anything that is not shipped.
 */
export default function About() {
  const facts = [
    {
      title: "What it does",
      body: "ClearRoute helps you search live job listings by describing the job you want in your own words. You write a sentence; it reads that sentence into the things you asked for, searches job boards, and ranks what it finds by how well each posting answers your request.",
    },
    {
      title: "Why it explains itself",
      body: "A ranked list with no reasons is just a list. Every result shows why it appeared: which of your requirements the posting confirms, what conflicts with them, and what the posting left out entirely. If the reading of your request is wrong, you correct it in the same box you searched with.",
    },
    {
      title: "What it evaluates",
      body: "ClearRoute evaluates what you want from a role — the work, the place, the work mode, the contract, the language. It compares that against what each posting actually states.",
    },
    {
      title: "What it does not do",
      body: "It does not assess whether you are qualified for a job, it does not score your experience, and it does not apply on your behalf. It has no view on your CV, because it never asks for one. Applying always happens on the employer's own page.",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="nb-border-b sticky top-0 z-30 bg-nb-deep/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <BrandMark to="/" />
          <div className="flex items-center gap-3">
            <Link
              to="/privacy"
              className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline"
            >
              Privacy
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-14">
        <p className="font-mono text-[10px] tracking-[0.22em] text-nb-amber uppercase">About</p>
        <h1 className="mt-3 font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
          ClearRoute by Profeshare AI
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-nb-line/55">
          ClearRoute is built by Profeshare AI. It exists because describing the job you want is
          easier than assembling it out of filters — and because a result you cannot interrogate is
          worth very little.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {facts.map((fact) => (
            <section key={fact.title} className="nb-border nb-shadow bg-nb-surface p-5">
              <h2 className="font-display text-sm tracking-wide text-nb-line uppercase">
                {fact.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-nb-line/60">{fact.body}</p>
            </section>
          ))}
        </div>

        <section className="nb-border nb-shadow mt-6 bg-nb-surface p-6">
          <h2 className="font-display text-sm tracking-wide text-nb-line uppercase">
            Feedback
          </h2>
          <p className="mt-3 text-sm leading-6 text-nb-line/60">
            ClearRoute is in active development, and the fastest way to improve it is to tell us
            where it read your request wrongly. If you have a signed-in account, the workspace
            itself is the right place for that: revise the prompt and clear the mistake. Anything
            beyond that goes through the channel you already use with the team.
          </p>
        </section>

        <div className="mt-10 flex flex-wrap gap-3">
          <Button
            asChild
            className="nb-border nb-shadow nb-press h-11 gap-2 rounded-none bg-nb-amber px-5 font-display text-xs tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
          >
            <Link to="/auth?returnTo=/dashboard">
              Open the search
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="nb-border h-11 rounded-none px-5 font-display text-xs tracking-[0.14em] uppercase"
          >
            <Link to="/privacy">Read the privacy notice</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
