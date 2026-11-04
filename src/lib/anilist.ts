// AniList GraphQL client + typed helpers.
// Docs: https://docs.anilist.co

export interface Title {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

export interface Media {
  id: number;
  title: Title;
  coverImage: { large: string; extraLarge: string } | null;
  bannerImage: string | null;
  description: string | null;
  format: string | null; // TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC
  season: string | null; // WINTER, SPRING, SUMMER, FALL
  seasonYear: number | null;
  episodes: number | null;
  duration: number | null; // minutes
  averageScore: number | null; // 0-100
  popularity: number | null;
  genres: string[] | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  trailer: { id: string; site: string; thumbnail: string | null } | null;
  // detail
  status: string | null; // FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS
  startDate: { year: number | null; month: number | null; day: number | null } | null;
  studios: { nodes: { name: string }[] } | null;
  characters: {
    edges: {
      node: { id: number; name: { full: string | null }; image: { large: string } | null };
      role: string | null;
    }[];
  } | null;
  streamingEpisodes: { title: string | null; url: string | null; site: string | null; thumbnail: string | null }[] | null;
}

export interface MediaPage<T> {
  pageInfo: { hasNextPage: boolean; total: number; currentPage: number };
  media: T[];
}

const ENDPOINT = "https://graphql.anilist.co";

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error("Could not reach AniList. Check your connection or try again shortly; AniList may be temporarily limiting requests.");
  }
  if (res.status === 429) throw new Error("AniList is rate-limiting requests. Wait a minute, then try again.");
  if (!res.ok) throw new Error(`AniList request failed (${res.status})`);
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("AniList returned no data");
  return json.data;
}

export const displayTitle = (t: Title) => t.english || t.romaji || "Unknown title";

export interface AiredEpisode {
  id: number;
  episode: number;
  airingAt: number;
  media: { id: number; title: Title; coverImage: { large: string | null; extraLarge: string | null } | null } | null;
}

/** AniList broadcast times; these do not describe provider releases. */
export async function getAiringSchedule(start: number, end: number): Promise<AiredEpisode[]> {
  const day = 86_400;
  const days = Math.ceil((end - start) / day);
  const ranges = Array.from({ length: days }, (_, i) => [start + i * day, Math.min(end, start + (i + 1) * day)] as const);
  const items = (await Promise.all(ranges.map(async ([from, to]) => {
    const dayItems: AiredEpisode[] = [];
    for (let page = 1; page <= 4; page++) {
      const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: AiredEpisode[] } }>(
        `query ($start: Int!, $end: Int!, $page: Int!) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) { id episode airingAt media { id title { romaji english native } coverImage { large extraLarge } } } } }`,
        { start: from - 1, end: to, page },
      );
      dayItems.push(...data.Page.airingSchedules.filter((item) => item.media));
      if (!data.Page.pageInfo.hasNextPage) return dayItems;
    }
    throw new Error("Too many releases on one day to load the complete schedule.");
  }))).flat();
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => a.airingAt - b.airingAt);
}

/** Broadcast schedule information, not a streaming availability feed. */
export async function getRecentlyAired(): Promise<AiredEpisode[]> {
  const data = await gql<{ Page: { airingSchedules: AiredEpisode[] } }>(
    `query ($before: Int!) {
      Page(perPage: 24) {
        airingSchedules(airingAt_lesser: $before, notYetAired: false, sort: TIME_DESC) {
          id episode airingAt
          media { id title { romaji english native } coverImage { large extraLarge } }
        }
      }
    }`, { before: Math.floor(Date.now() / 1000) },
  );
  return data.Page.airingSchedules.filter((item) => item.media != null);
}

const MEDIA_FIELDS = /* GraphQL */ `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  description
  format
  season
  seasonYear
  episodes
  duration
  averageScore
  popularity
  genres
  nextAiringEpisode { episode airingAt }
  trailer { id site thumbnail }
`;

export async function searchMedia(
  search: string,
  page = 1,
  perPage = 24,
  filters: { genre?: string; season?: string; seasonYear?: number; format?: string } = {},
): Promise<MediaPage<Media>> {
  const data = await gql<{ Page: MediaPage<Media> }>(
    `query ($search: String, $page: Int, $perPage: Int, $genre: String, $season: MediaSeason, $seasonYear: Int, $format: MediaFormat) {
       Page(page: $page, perPage: $perPage) {
         pageInfo { hasNextPage total currentPage }
         media(type: ANIME, search: $search, genre: $genre, season: $season, seasonYear: $seasonYear, format: $format, sort: ${search.trim() ? "SEARCH_MATCH" : "POPULARITY_DESC"}) { ${MEDIA_FIELDS} }
       }
     }`,
    { search: search.trim() || null, page, perPage, ...filters },
  );
  return data.Page;
}

export async function getTrending(page = 1, perPage = 24): Promise<MediaPage<Media>> {
  const data = await gql<{ Page: MediaPage<Media> }>(
    `query ($page: Int, $perPage: Int) {
       Page(page: $page, perPage: $perPage) {
         pageInfo { hasNextPage total currentPage }
         media(type: ANIME, sort: TRENDING_DESC) { ${MEDIA_FIELDS} }
       }
     }`,
    { page, perPage },
  );
  return data.Page;
}

export async function getTopRated(page = 1, perPage = 24): Promise<MediaPage<Media>> {
  const data = await gql<{ Page: MediaPage<Media> }>(
    `query ($page: Int, $perPage: Int) {
       Page(page: $page, perPage: $perPage) {
         pageInfo { hasNextPage total currentPage }
         media(type: ANIME, sort: SCORE_DESC) { ${MEDIA_FIELDS} }
       }
     }`,
    { page, perPage },
  );
  return data.Page;
}

export async function getSeasonal(year: number, season: string, page = 1, perPage = 24): Promise<MediaPage<Media>> {
  const data = await gql<{ Page: MediaPage<Media> }>(
    `query ($seasonYear: Int, $season: MediaSeason, $page: Int, $perPage: Int) {
       Page(page: $page, perPage: $perPage) {
         pageInfo { hasNextPage total currentPage }
         media(type: ANIME, seasonYear: $seasonYear, season: $season, sort: POPULARITY_DESC) { ${MEDIA_FIELDS} }
       }
     }`,
    { seasonYear: year, season, page, perPage },
  );
  return data.Page;
}

export async function getPopular(page = 1, perPage = 24): Promise<MediaPage<Media>> {
  const data = await gql<{ Page: MediaPage<Media> }>(
    `query ($page: Int, $perPage: Int) {
       Page(page: $page, perPage: $perPage) {
         pageInfo { hasNextPage total currentPage }
         media(type: ANIME, sort: POPULARITY_DESC) { ${MEDIA_FIELDS} }
       }
     }`,
    { page, perPage },
  );
  return data.Page;
}

export function currentSeason(): { year: number; season: string } {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  let season: string;
  if (month >= 0 && month <= 2) season = "WINTER";
  else if (month >= 3 && month <= 5) season = "SPRING";
  else if (month >= 6 && month <= 8) season = "SUMMER";
  else season = "FALL";
  return { year, season };
}

export async function getMedia(id: number): Promise<Media> {
  const { isTauri } = await import("./tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
  const data = await gql<{ Media: Media }>(
    `query ($id: Int) {
       Media(id: $id, type: ANIME) {
         ${MEDIA_FIELDS}
          status
          streamingEpisodes { title url site thumbnail }
         startDate { year month day }
         studios { nodes { name } }
         characters(sort: ROLE) {
           edges { node { id name { full } image { large } } role }
         }
       }
     }`,
    { id },
  );
  if (isTauri) await invoke("cache_media_json", { media: data.Media }).catch(() => {});
  return data.Media;
  } catch (error) {
    if (isTauri) {
      const cached = await invoke<Media | null>("get_cached_media", { mediaId: id }).catch(() => null);
      if (cached) return cached;
    }
    throw error;
  }
}

// ─── MediaList / list sync (requires token) ──────────────────────────────────

export type ListStatus =
  | "CURRENT"
  | "PLANNING"
  | "COMPLETED"
  | "DROPPED"
  | "PAUSED"
  | "REPEATING";

export const LIST_STATUS_LABELS: Record<ListStatus, string> = {
  CURRENT: "Watching",
  PLANNING: "Plan to Watch",
  COMPLETED: "Completed",
  DROPPED: "Dropped",
  PAUSED: "Paused",
  REPEATING: "Repeating",
};

export interface MediaListEntry {
  id: number;
  status: ListStatus | null;
  progress: number | null;
  score: number | null; // 0-100
  media: Media;
}

const LIST_FIELDS = /* GraphQL */ `
  id
  status
  progress
  score(format: POINT_100)
  media { id title { romaji english native } coverImage { large extraLarge } episodes seasonYear format averageScore nextAiringEpisode { episode airingAt } }
`;

/** Fetch the full list in one request, including entries in custom lists. */
export async function getUserList(token: string): Promise<MediaListEntry[]> {
  const userId = (await getViewer(token)).id;
  const data = await gql<{ MediaListCollection: { lists: { entries: MediaListEntry[] }[]; hasNextChunk: boolean } }>(
    `query ($userId: Int) {
       MediaListCollection(type: ANIME, userId: $userId) {
         hasNextChunk
         lists { entries { ${LIST_FIELDS} } }
       }
     }`,
    { userId }, token,
  );
  if (data.MediaListCollection.hasNextChunk) throw new Error("AniList returned an incomplete list; the existing offline cache was kept. Please try again.");
  const entries = new Map<number, MediaListEntry>();
  for (const list of data.MediaListCollection.lists) {
    for (const entry of list.entries) entries.set(entry.id, entry);
  }
  return [...entries.values()];
}

/** Change status / progress / score for a media. AniList score is 0-100. */
export async function saveListEntry(
  token: string,
  mediaId: number,
  input: { status?: ListStatus | null; progress?: number | null; score?: number | null; scoreFormatted?: number; advancedScores?: number[]; repeat?: number | null; notes?: string | null; private?: boolean | null; hiddenFromStatusLists?: boolean; customLists?: string[]; startedAt?: { year?: number | null; month?: number | null; day?: number | null }; completedAt?: { year?: number | null; month?: number | null; day?: number | null } },
): Promise<MediaListEntry> {
  // Omit fields that were not explicitly edited. Passing unrelated values to
  // AniList risks clearing a user's score, notes, or other existing details.
  const candidates = [
    { key: "status", type: "MediaListStatus", argument: "status" },
    { key: "progress", type: "Int", argument: "progress" },
    { key: "score", type: "Int", argument: "scoreRaw" },
    { key: "scoreFormatted", type: "Float", argument: "score" },
    { key: "advancedScores", type: "[Float]", argument: "advancedScores" },
    { key: "repeat", type: "Int", argument: "repeat" },
    { key: "notes", type: "String", argument: "notes" },
    { key: "private", type: "Boolean", argument: "private" },
    { key: "hiddenFromStatusLists", type: "Boolean", argument: "hiddenFromStatusLists" },
    { key: "customLists", type: "[String]", argument: "customLists" },
    { key: "startedAt", type: "FuzzyDateInput", argument: "startedAt" },
    { key: "completedAt", type: "FuzzyDateInput", argument: "completedAt" },
  ] as const;
  const selected = candidates.filter(({ key }) => input[key] !== undefined && input[key] !== null);
  const declarations = selected.map(({ key, type }) => `, $${key}: ${type}`).join("");
  const argumentsList = selected.map(({ key, argument }) => `, ${argument}: $${key}`).join("");
  const variables: Record<string, unknown> = { mediaId };
  for (const { key } of selected) variables[key] = input[key];
  const data = await gql<{ SaveMediaListEntry: MediaListEntry }>(
    `mutation ($mediaId: Int${declarations}) {
       SaveMediaListEntry(mediaId: $mediaId${argumentsList}) {
         ${LIST_FIELDS}
       }
     }`,
    variables,
    token,
  );
  return data.SaveMediaListEntry;
}

export async function deleteListEntry(token: string, entryId: number): Promise<void> {
  const data = await gql<{ DeleteMediaListEntry: { deleted: boolean } }>(
    `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
    { id: entryId },
    token,
  );
  if (!data.DeleteMediaListEntry.deleted) throw new Error("AniList did not remove this entry.");
}

// ─── Viewer (requires token, Phase 2) ───────────────────────────────────────

export interface Viewer {
  id: number;
  name: string;
  avatar: { large: string } | null;
  bannerImage: string | null;
}

export async function getViewer(token: string): Promise<Viewer> {
  const data = await gql<{ Viewer: Viewer }>(
    `query { Viewer { id name avatar { large } bannerImage } }`,
    {},
    token,
  );
  return data.Viewer;
}
