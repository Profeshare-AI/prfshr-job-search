import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="nb-grid flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16 text-center"
    >
      <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
        Error 404
      </p>
      <h1 className="mt-3 font-display text-4xl leading-tight text-nb-line uppercase sm:text-5xl">
        This page does not exist
      </h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-nb-line/60">
        The link is broken or the page moved. Head back to the search, or browse the
        live catalog of opportunities instead.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button
          asChild
          className="nb-border nb-shadow nb-press h-11 gap-2 rounded-none bg-nb-amber px-5 font-display text-xs tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
        >
          <Link to="/dashboard">
            Back to search
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Link
          to="/browse"
          className="nb-border nb-press inline-flex h-11 items-center bg-nb-surface px-5 font-display text-xs tracking-[0.14em] text-nb-line uppercase hover:bg-nb-line hover:text-nb-deep"
        >
          Browse the catalog
        </Link>
      </div>
    </motion.main>
  );
}
