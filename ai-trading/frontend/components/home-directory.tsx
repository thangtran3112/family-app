"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { filterHubApps, type CategoryId, hubApps, hubCategories } from "@/lib/apps";
import { AppCard } from "@/components/app-card";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function HomeDirectory() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryId | "all">("all");
  const filteredApps = filterHubApps(hubApps, query, activeCategory);
  const cards = filteredApps.filter((app) => app.status !== "planned");
  const planned = filteredApps.filter((app) => app.status === "planned");
  const categories = hubCategories.filter((category) => hubApps.some((app) => app.category === category.id && app.status !== "planned"));

  function clearFilters() {
    setQuery("");
    setActiveCategory("all");
  }

  return (
    <div className="mt-7 space-y-6 xl:space-y-7">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-[248px] md:shrink-0 xl:w-[294px]">
          <label htmlFor="app-search" className="sr-only">Find an application</label>
          <Search aria-hidden size={17} strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            id="app-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an application"
            className={`h-11 w-full rounded-lg border border-border bg-card pr-11 pl-10 text-[13px] text-foreground placeholder:text-muted-foreground ${FOCUS_RING}`}
          />
          {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className={`absolute top-0 right-0 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:text-foreground ${FOCUS_RING}`}><X aria-hidden size={16} /></button>}
        </div>
        <div role="group" aria-label="Filter by category" className="flex flex-wrap items-center gap-1.5 md:gap-2">
          {[{ id: "all" as const, label: "All apps" }, ...categories].map((category) => (
            <button
              key={category.id}
              type="button"
              aria-pressed={activeCategory === category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-3 text-xs transition-colors duration-150 md:text-[13px] xl:px-4 motion-reduce:transition-none ${FOCUS_RING} ${activeCategory === category.id ? "bg-foreground font-semibold text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >{category.label}</button>
          ))}
        </div>
      </div>

      <p role="status" className="sr-only">{cards.length} applications and {planned.length} planned workspaces match your filters.</p>
      {filteredApps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p>No apps match &quot;{query}&quot;</p>
          <p className="mt-2 text-sm text-muted-foreground">Try a different name, tag, or category.</p>
          <button type="button" onClick={clearFilters} className={`mt-4 min-h-11 cursor-pointer rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:bg-muted ${FOCUS_RING}`}>Clear filters</button>
        </div>
      ) : (
        <>
          {cards.length > 0 && <section aria-label="Research applications" className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">{cards.map((app) => <AppCard key={app.slug} app={app} />)}</section>}
          {planned.length > 0 && <section aria-label="Planned workspaces" className="space-y-4">{planned.map((app) => <AppCard key={app.slug} app={app} />)}</section>}
        </>
      )}
      <footer className="flex flex-col gap-2 text-xs leading-[18px] text-muted-foreground xl:flex-row xl:justify-between">
        <p>Research tools, not investment advice. Review every result before acting.</p>
        <p className="xl:hidden">Terminals work best with a keyboard. Web apps support touch.</p>
        <p className="hidden xl:block">Trading Hub · Family workspace</p>
      </footer>
    </div>
  );
}
