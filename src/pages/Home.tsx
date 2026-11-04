import { useQuery } from "@tanstack/react-query";
import Hero from "../components/Hero";
import Row from "../components/Row";
import RecentReleases from "../components/RecentReleases";
import { currentSeason, getPopular, getSeasonal, getTopRated, getTrending } from "../lib/anilist";
import ContinuePlayback from "../components/ContinuePlayback";
import { settingEnabled } from "../lib/settings";
import { useAppStore, useAuthStore } from "../store/app";

export default function Home() {
  const { year, season } = currentSeason();
  const viewer = useAuthStore((s) => s.viewer);
  const setView = useAppStore((s) => s.setView);

  const trending = useQuery({ queryKey: ["trending"], queryFn: () => getTrending(1, 24) });
  const showTop = settingEnabled("megu.home.top");
  const showPopular = settingEnabled("megu.home.popular");
  const topRated = useQuery({ queryKey: ["topRated"], queryFn: () => getTopRated(1, 24), enabled: showTop, staleTime: 300_000 });
  const seasonal = useQuery({ queryKey: ["seasonal", year, season], queryFn: () => getSeasonal(year, season, 1, 24) });
  const popular = useQuery({ queryKey: ["popular"], queryFn: () => getPopular(1, 24), enabled: showPopular, staleTime: 300_000 });

  const heroItems = trending.data?.media ?? [];

  return (
    <main className="pb-16">
      <Hero items={heroItems} />
      <div className="relative z-20 pt-6 space-y-2">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 pb-4 sm:px-8"><div className="min-w-0"><h2 className="break-words text-lg font-bold">{viewer ? `Welcome back, ${viewer.name}` : "Your anime, your way"}</h2><p className="text-sm text-zinc-400">Pick up where you left off or discover something new.</p></div><button onClick={() => setView("settings")} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white">Customize home</button></div>
        {settingEnabled("megu.home.continue") && <div className="mx-auto max-w-[1600px] px-4 sm:px-8"><ContinuePlayback /></div>}
        {settingEnabled("megu.home.airing") && <RecentReleases />}
        <Row
          title="Trending Now"
          subtitle="Updated daily"
          items={trending.data?.media ?? []}
          loading={trending.isLoading}
          error={trending.error?.message}
        />
        {showTop && <Row
          title="Top Rated"
          subtitle="Highest rated all time"
          items={topRated.data?.media ?? []}
          loading={topRated.isLoading}
          error={topRated.error?.message}
        />}
        <Row
          title={`${season.charAt(0) + season.slice(1).toLowerCase()} ${year}`}
          subtitle="This season"
          items={seasonal.data?.media ?? []}
          loading={seasonal.isLoading}
          error={seasonal.error?.message}
        />
        {showPopular && <Row
          title="Most Popular"
          subtitle="All time favorites"
          items={popular.data?.media ?? []}
          loading={popular.isLoading}
          error={popular.error?.message}
        />}
      </div>
    </main>
  );
}
