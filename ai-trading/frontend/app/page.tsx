import { HomeDirectory } from "@/components/home-directory";
import { PageShell } from "@/components/page-shell";
import { hubApps } from "@/lib/apps";

export default function HomePage() {
  return (
    <PageShell>
      <div className="mx-auto w-full max-w-[1440px] px-6 pt-7 pb-8 md:p-8 xl:px-10 xl:pt-9 xl:pb-7">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="max-w-[290px] text-[32px] leading-[38px] font-semibold tracking-[-0.045em] md:max-w-none md:leading-10 xl:text-4xl xl:leading-[44px]">Your research workspace.</h1>
            <p className="mt-3 max-w-[320px] text-[15px] leading-6 text-muted-foreground md:max-w-none md:mt-2.5">Four tools. Different perspectives. One place to start.</p>
          </div>
          <p className="hidden shrink-0 pb-1 text-[13px] leading-5 text-muted-foreground xl:block"><span className="mr-2 font-semibold text-foreground">{String(hubApps.filter((app) => app.status !== "planned").length).padStart(2, "0")}</span>research tools</p>
        </div>
        <HomeDirectory />
      </div>
    </PageShell>
  );
}
