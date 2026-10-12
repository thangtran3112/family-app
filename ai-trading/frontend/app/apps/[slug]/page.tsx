import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { ExternalLaunch, TerminalFrame } from "@/components/terminal-frame";
import { appIcons, findApp, hubApps } from "@/lib/apps";

export const dynamicParams = false;

export function generateStaticParams() {
  return hubApps.filter((app) => app.status !== "planned").map((app) => ({ slug: app.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${findApp(slug)?.name ?? "App"} | Trading Hub` };
}

export default async function AppPage({ params }: Props) {
  const { slug } = await params;
  const app = findApp(slug);
  if (!app || app.status === "planned") notFound();

  if (app.kind === "terminal") {
    return (
      <PageShell breadcrumb={app.name}>
        <TerminalFrame app={app} />
      </PageShell>
    );
  }

  if (app.kind === "upstream-setup") {
    const Icon = appIcons[app.icon];
    return (
      <PageShell breadcrumb={app.name}>
        <div className="mx-auto w-full max-w-[800px] px-6 py-9 md:px-8">
          <div className="rounded-xl border border-border bg-card p-6 text-center sm:p-8">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-muted">
              <Icon aria-hidden size={20} />
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-foreground">{app.name}</h1>
            <div className="mt-2 flex justify-center">
              <StatusBadge app={app} />
            </div>
            <p className="mt-4 text-muted-foreground">{app.summary}</p>
            <dl className="mt-4 space-y-1 text-left text-sm text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">Good for: </dt>
                <dd className="inline">{app.goodFor}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Cost: </dt>
                <dd className="inline">{app.costNote}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Needs: </dt>
                <dd className="inline">{app.requiredKeys.join(", ")}</dd>
              </div>
            </dl>
            <p className="mt-6 text-left text-sm text-muted-foreground">
              Both of us share this experimental instance&apos;s projects. Activation (auth, keys, and a verified
              end-to-end run) is a separate, reviewed change — this page has no launch link yet.
            </p>
            <div className="mt-6 flex justify-center gap-4 text-sm">
              <a href={app.sourceUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
                Pinned source
              </a>
              <a href={app.licenseUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
                AGPL-3.0 license
              </a>
            </div>
          </div>
        </div>
      </PageShell>
    );
  }

  const Icon = appIcons[app.icon];
  return (
    <PageShell breadcrumb={app.name}>
      <div className="mx-auto w-full max-w-[800px] px-6 py-9 md:px-8">
        <div className="rounded-xl border border-border bg-card p-6 sm:p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-[10px] bg-muted text-accent">
            <Icon aria-hidden size={24} strokeWidth={1.5} />
          </div>
          <h1 className="mt-4 text-[32px] leading-10 font-semibold tracking-[-0.04em] text-foreground">{app.name}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{app.subtitle}</p>
          <div className="mt-2 flex">
            <StatusBadge app={app} />
          </div>
          <p className="mt-4 text-[15px] leading-6 text-muted-foreground">{app.summary}</p>
          <dl className="mt-4 space-y-1 text-left text-sm text-muted-foreground">
            <div>
              <dt className="inline font-medium text-foreground">Good for: </dt>
              <dd className="inline">{app.goodFor}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Cost: </dt>
              <dd className="inline">{app.costNote}</dd>
            </div>
          </dl>
          <ExternalLaunch app={app} />
        </div>
      </div>
    </PageShell>
  );
}
