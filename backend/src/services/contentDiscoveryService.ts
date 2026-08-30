/**
 * Content discovery — trending Netflix titles + top iOS apps, by region.
 * See /content-discovery-scope.md for the full scope doc (V1 vs V2 split).
 *
 * V1 sources, both official/free per the doc:
 *  - Apple's official App Store RSS feed (rss.marketingtools.apple.com) —
 *    stable JSON, no auth. Verified working during development.
 *  - Netflix's own published Top 10 data file (netflix.com/tudum/top10).
 *    This is Netflix's official source, but the exact bulk-TSV endpoint
 *    below could not be confirmed reachable from this build environment
 *    (network access is restricted here) — it's wired as the real,
 *    primary path and SHOULD be verified against a live run once this is
 *    deployed somewhere with normal outbound internet access. If it ever
 *    fails (network hiccup, endpoint/shape change), this falls back to a
 *    small labeled sample set rather than showing a blank section — same
 *    resilience pattern the scope doc calls for on the Android v2 item.
 *
 * Everything here is a public, unauthenticated read — no user data goes
 * out, nothing here is billed or metered.
 */

export type SourceStatus = "live" | "sample";

export interface AppEntry {
  rank: number;
  name: string;
  artist: string;
  artworkUrl: string;
  url: string;
}

export interface TitleEntry {
  rank: number;
  title: string;
}

export interface TrendingPayload {
  region: string;
  regionLabel: string;
  asOf: string;
  apps: AppEntry[];
  appsSource: SourceStatus;
  netflixMovies: TitleEntry[];
  netflixTV: TitleEntry[];
  netflixSource: SourceStatus;
  netflixWeek: string | null;
}

const REGION_MAP: Record<string, { appleCountry: string; netflixIso2: string; label: string }> = {
  us: { appleCountry: "us", netflixIso2: "US", label: "United States" },
  eu: { appleCountry: "de", netflixIso2: "DE", label: "Germany" },
  asia: { appleCountry: "sg", netflixIso2: "SG", label: "Singapore" },
};

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Netflix refreshes weekly, Apple ~daily — no need to hit either more often

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Sample fallback data — only ever shown if the live fetch fails. ----
const SAMPLE_APPS: Record<string, AppEntry[]> = {
  us: [
    { rank: 1, name: "ChatGPT", artist: "OpenAI", artworkUrl: "", url: "" },
    { rank: 2, name: "TikTok", artist: "TikTok Ltd.", artworkUrl: "", url: "" },
    { rank: 3, name: "Instagram", artist: "Meta", artworkUrl: "", url: "" },
    { rank: 4, name: "Google", artist: "Google LLC", artworkUrl: "", url: "" },
    { rank: 5, name: "Gmail", artist: "Google LLC", artworkUrl: "", url: "" },
  ],
  eu: [
    { rank: 1, name: "WhatsApp Messenger", artist: "Meta", artworkUrl: "", url: "" },
    { rank: 2, name: "TikTok", artist: "TikTok Ltd.", artworkUrl: "", url: "" },
    { rank: 3, name: "Instagram", artist: "Meta", artworkUrl: "", url: "" },
    { rank: 4, name: "ChatGPT", artist: "OpenAI", artworkUrl: "", url: "" },
    { rank: 5, name: "Deutsche Bahn Navigator", artist: "DB Vertrieb GmbH", artworkUrl: "", url: "" },
  ],
  asia: [
    { rank: 1, name: "WhatsApp Messenger", artist: "Meta", artworkUrl: "", url: "" },
    { rank: 2, name: "Grab", artist: "Grab Holdings", artworkUrl: "", url: "" },
    { rank: 3, name: "TikTok", artist: "TikTok Ltd.", artworkUrl: "", url: "" },
    { rank: 4, name: "ChatGPT", artist: "OpenAI", artworkUrl: "", url: "" },
    { rank: 5, name: "Telegram Messenger", artist: "Telegram FZ-LLC", artworkUrl: "", url: "" },
  ],
};

const SAMPLE_NETFLIX: Record<string, { movies: TitleEntry[]; tv: TitleEntry[] }> = {
  us: {
    movies: [
      { rank: 1, title: "Outer Banks: The Final Voyage" },
      { rank: 2, title: "Don't Say Good Luck" },
      { rank: 3, title: "Facing El Chapo" },
    ],
    tv: [
      { rank: 1, title: "Wednesday" },
      { rank: 2, title: "Stranger Things" },
      { rank: 3, title: "The Diplomat" },
    ],
  },
  eu: {
    movies: [
      { rank: 1, title: "Miraculous World" },
      { rank: 2, title: "Don't Say Good Luck" },
      { rank: 3, title: "The Union" },
    ],
    tv: [
      { rank: 1, title: "Wednesday" },
      { rank: 2, title: "Dark" },
      { rank: 3, title: "Berlin" },
    ],
  },
  asia: {
    movies: [
      { rank: 1, title: "Don't Say Good Luck" },
      { rank: 2, title: "Train to Busan Presents: Peninsula" },
      { rank: 3, title: "Confidential Assignment 3" },
    ],
    tv: [
      { rank: 1, title: "Squid Game" },
      { rank: 2, title: "Wednesday" },
      { rank: 3, title: "The Glory" },
    ],
  },
};

function resolveRegion(regionCode: string): string {
  return REGION_MAP[regionCode] ? regionCode : "us";
}

async function fetchTopApps(regionCode: string): Promise<{ status: SourceStatus; apps: AppEntry[] }> {
  const country = REGION_MAP[regionCode].appleCountry;
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/apps/top-free/10/apps.json`;
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Apple RSS responded ${res.status}`);
    const data: any = await res.json();
    const results = data?.feed?.results;
    if (!Array.isArray(results) || results.length === 0) throw new Error("Apple RSS returned no results");
    const apps: AppEntry[] = results.map((r: any, i: number) => ({
      rank: i + 1,
      name: String(r.name ?? "Unknown"),
      artist: String(r.artistName ?? ""),
      artworkUrl: String(r.artworkUrl100 ?? ""),
      url: String(r.url ?? ""),
    }));
    return { status: "live", apps };
  } catch (err) {
    console.warn(`[content-discovery] Apple RSS fetch failed for ${regionCode}, using sample data:`, (err as Error).message);
    return { status: "sample", apps: SAMPLE_APPS[regionCode] ?? SAMPLE_APPS.us };
  }
}

const NETFLIX_TSV_URL = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv";

async function fetchNetflixTop10(
  regionCode: string
): Promise<{ status: SourceStatus; movies: TitleEntry[]; tv: TitleEntry[]; week: string | null }> {
  const iso2 = REGION_MAP[regionCode].netflixIso2;
  try {
    const res = await fetchWithTimeout(NETFLIX_TSV_URL, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Netflix TSV responded ${res.status}`);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new Error("Netflix TSV was empty");

    const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const iIso = col("country_iso2");
    const iWeek = col("week");
    const iCategory = col("category");
    const iRank = col("weekly_rank");
    const iTitle = col("show_title");
    if ([iIso, iWeek, iCategory, iRank, iTitle].some((i) => i < 0)) {
      throw new Error("Netflix TSV columns did not match expected shape");
    }

    let latestWeek = "";
    const countryRows: string[][] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      if (cols[iIso] !== iso2) continue;
      countryRows.push(cols);
      if (cols[iWeek] > latestWeek) latestWeek = cols[iWeek];
    }
    if (!countryRows.length) throw new Error(`No Netflix rows for country ${iso2}`);

    const latestRows = countryRows.filter((c) => c[iWeek] === latestWeek);
    const toList = (prefix: string): TitleEntry[] =>
      latestRows
        .filter((c) => c[iCategory]?.toLowerCase().startsWith(prefix))
        .sort((a, b) => Number(a[iRank]) - Number(b[iRank]))
        .slice(0, 10)
        .map((c) => ({ rank: Number(c[iRank]), title: c[iTitle] }));

    const movies = toList("film");
    const tv = toList("tv");
    if (!movies.length && !tv.length) throw new Error("Parsed Netflix rows produced no movies or TV");

    return { status: "live", movies, tv, week: latestWeek };
  } catch (err) {
    console.warn(`[content-discovery] Netflix TSV fetch failed for ${regionCode}, using sample data:`, (err as Error).message);
    const sample = SAMPLE_NETFLIX[regionCode] ?? SAMPLE_NETFLIX.us;
    return { status: "sample", movies: sample.movies, tv: sample.tv, week: null };
  }
}

const cache = new Map<string, { data: TrendingPayload; expiresAt: number }>();

export async function getTrending(regionCodeInput: string): Promise<TrendingPayload> {
  const region = resolveRegion(regionCodeInput);
  const cached = cache.get(region);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [appsResult, netflixResult] = await Promise.all([fetchTopApps(region), fetchNetflixTop10(region)]);

  const payload: TrendingPayload = {
    region,
    regionLabel: REGION_MAP[region].label,
    asOf: new Date().toISOString(),
    apps: appsResult.apps,
    appsSource: appsResult.status,
    netflixMovies: netflixResult.movies,
    netflixTV: netflixResult.tv,
    netflixSource: netflixResult.status,
    netflixWeek: netflixResult.week,
  };

  cache.set(region, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}
