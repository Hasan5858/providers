import ISO6391 from "iso-639-1";
import { searchSubtitles } from "wyzie-lib";
import * as cheerio from "cheerio";
import { load } from "cheerio";
import { customAlphabet } from "nanoid";
import * as unpacker from "unpacker";
import { unpack } from "unpacker";
import crypto from "crypto-js";
import cookie from "cookie";
import setCookieParser from "set-cookie-parser";
import AbortController from "abort-controller";
import FormData from "form-data";
class NotFoundError extends Error {
  constructor(reason) {
    super(`Couldn't find a stream: ${reason ?? "not found"}`);
    this.name = "NotFoundError";
  }
}
function formatSourceMeta(v) {
  const types = [];
  if (v.scrapeMovie) types.push("movie");
  if (v.scrapeShow) types.push("show");
  return {
    type: "source",
    id: v.id,
    rank: v.rank,
    name: v.name,
    mediaTypes: types
  };
}
function formatEmbedMeta(v) {
  return {
    type: "embed",
    id: v.id,
    rank: v.rank,
    name: v.name
  };
}
function getAllSourceMetaSorted(list) {
  return list.sources.sort((a, b) => b.rank - a.rank).map(formatSourceMeta);
}
function getAllEmbedMetaSorted(list) {
  return list.embeds.sort((a, b) => b.rank - a.rank).map(formatEmbedMeta);
}
function getSpecificId(list, id) {
  const foundSource = list.sources.find((v) => v.id === id);
  if (foundSource) {
    return formatSourceMeta(foundSource);
  }
  const foundEmbed = list.embeds.find((v) => v.id === id);
  if (foundEmbed) {
    return formatEmbedMeta(foundEmbed);
  }
  return null;
}
function makeFullUrl(url, ops) {
  let leftSide = (ops == null ? void 0 : ops.baseUrl) ?? "";
  let rightSide = url;
  if (leftSide.length > 0 && !leftSide.endsWith("/")) leftSide += "/";
  if (rightSide.startsWith("/")) rightSide = rightSide.slice(1);
  const fullUrl = leftSide + rightSide;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://") && !fullUrl.startsWith("data:"))
    throw new Error(`Invald URL -- URL doesn't start with a http scheme: '${fullUrl}'`);
  const parsedUrl = new URL(fullUrl);
  Object.entries((ops == null ? void 0 : ops.query) ?? {}).forEach(([k, v]) => {
    parsedUrl.searchParams.set(k, v);
  });
  return parsedUrl.toString();
}
function makeFetcher(fetcher) {
  const newFetcher = (url, ops) => {
    return fetcher(url, {
      headers: (ops == null ? void 0 : ops.headers) ?? {},
      method: (ops == null ? void 0 : ops.method) ?? "GET",
      query: (ops == null ? void 0 : ops.query) ?? {},
      baseUrl: (ops == null ? void 0 : ops.baseUrl) ?? "",
      readHeaders: (ops == null ? void 0 : ops.readHeaders) ?? [],
      body: ops == null ? void 0 : ops.body,
      credentials: ops == null ? void 0 : ops.credentials
    });
  };
  const output = async (url, ops) => (await newFetcher(url, ops)).body;
  output.full = newFetcher;
  return output;
}
const flags = {
  // CORS are set to allow any origin
  CORS_ALLOWED: "cors-allowed",
  // the stream is locked on IP, so only works if
  // request maker is same as player (not compatible with proxies)
  IP_LOCKED: "ip-locked",
  // The source/embed is blocking cloudflare ip's
  // This flag is not compatible with a proxy hosted on cloudflare
  CF_BLOCKED: "cf-blocked",
  // Streams and sources with this flag wont be proxied
  // And will be exclusive to the extension
  PROXY_BLOCKED: "proxy-blocked"
};
const targets = {
  // browser with CORS restrictions
  BROWSER: "browser",
  // browser, but no CORS restrictions through a browser extension
  BROWSER_EXTENSION: "browser-extension",
  // native app, so no restrictions in what can be played
  NATIVE: "native",
  // any target, no target restrictions
  ANY: "any"
};
const targetToFeatures = {
  browser: {
    requires: [flags.CORS_ALLOWED],
    disallowed: []
  },
  "browser-extension": {
    requires: [],
    disallowed: []
  },
  native: {
    requires: [],
    disallowed: []
  },
  any: {
    requires: [],
    disallowed: []
  }
};
function getTargetFeatures(target, consistentIpForRequests, proxyStreams) {
  const features = targetToFeatures[target];
  if (!consistentIpForRequests) features.disallowed.push(flags.IP_LOCKED);
  if (proxyStreams) features.disallowed.push(flags.PROXY_BLOCKED);
  return features;
}
function flagsAllowedInFeatures(features, inputFlags) {
  const hasAllFlags = features.requires.every((v) => inputFlags.includes(v));
  if (!hasAllFlags) return false;
  const hasDisallowedFlag = features.disallowed.some((v) => inputFlags.includes(v));
  if (hasDisallowedFlag) return false;
  return true;
}
const captionTypes = {
  srt: "srt",
  vtt: "vtt"
};
function getCaptionTypeFromUrl(url) {
  const extensions = Object.keys(captionTypes);
  const type = extensions.find((v) => url.endsWith(`.${v}`));
  if (!type) return null;
  return type;
}
function labelToLanguageCode(label) {
  const code = ISO6391.getCode(label);
  if (code.length === 0) return null;
  return code;
}
async function addWyzieCaptions(captions, tmdbId, imdbId, season, episode) {
  try {
    const searchParams = {
      encoding: "utf-8",
      source: "all",
      imdb_id: imdbId
    };
    if (tmdbId && !imdbId) {
      searchParams.tmdb_id = typeof tmdbId === "string" ? parseInt(tmdbId, 10) : tmdbId;
    }
    if (season && episode) {
      searchParams.season = season;
      searchParams.episode = episode;
    }
    console.log("Searching Wyzie subtitles with params:", searchParams);
    const wyzieSubtitles = await searchSubtitles(searchParams);
    console.log("Found Wyzie subtitles:", wyzieSubtitles);
    const wyzieCaptions = wyzieSubtitles.map((subtitle) => ({
      id: subtitle.id,
      url: subtitle.url,
      type: subtitle.format === "srt" || subtitle.format === "vtt" ? subtitle.format : "srt",
      hasCorsRestrictions: false,
      language: subtitle.language
    }));
    return [...captions, ...wyzieCaptions];
  } catch (error) {
    console.error("Error fetching Wyzie subtitles:", error);
    return captions;
  }
}
const timeout = (ms, source) => new Promise((resolve) => {
  setTimeout(() => {
    console.error(`${source} captions request timed out after ${ms}ms`);
    resolve(null);
  }, ms);
});
async function addOpenSubtitlesCaptions(captions, ops, media) {
  var _a, _b;
  try {
    const [imdbId, season, episode] = atob(media).split(".").map((x, i) => i === 0 ? x : Number(x) || null);
    if (!imdbId) return captions;
    const allCaptions = [...captions];
    const wyziePromise = addWyzieCaptions(
      [],
      ((_b = (_a = ops.media) == null ? void 0 : _a.tmdbId) == null ? void 0 : _b.toString()) || "",
      imdbId.toString(),
      typeof season === "number" ? season : void 0,
      typeof episode === "number" ? episode : void 0
    ).then((wyzieCaptions2) => {
      if (wyzieCaptions2 && wyzieCaptions2.length > 0) {
        return wyzieCaptions2.map((caption) => ({
          ...caption,
          opensubtitles: true
        }));
      }
      return [];
    }).catch((error) => {
      console.error("Wyzie subtitles fetch failed:", error);
      return [];
    });
    const openSubsPromise = ops.proxiedFetcher(
      `https://rest.opensubtitles.org/search/${season && episode ? `episode-${episode}/` : ""}imdbid-${imdbId.slice(2)}${season && episode ? `/season-${season}` : ""}`,
      {
        headers: {
          "X-User-Agent": "VLSub 0.10.2"
        }
      }
    ).then((Res) => {
      const openSubtilesCaptions = [];
      for (const caption of Res) {
        const url = caption.SubDownloadLink.replace(".gz", "").replace("download/", "download/subencoding-utf8/");
        const language = labelToLanguageCode(caption.LanguageName);
        if (!url || !language) continue;
        else
          openSubtilesCaptions.push({
            id: url,
            opensubtitles: true,
            url,
            type: caption.SubFormat || "srt",
            hasCorsRestrictions: false,
            language
          });
      }
      return openSubtilesCaptions;
    }).catch((error) => {
      console.error("OpenSubtitles fetch failed:", error);
      return [];
    });
    const [wyzieCaptions, openSubsCaptions] = await Promise.all([
      Promise.race([wyziePromise, timeout(2e3, "Wyzie")]),
      Promise.race([openSubsPromise, timeout(5e3, "OpenSubtitles")])
    ]);
    if (wyzieCaptions) allCaptions.push(...wyzieCaptions);
    if (openSubsCaptions) allCaptions.push(...openSubsCaptions);
    return allCaptions;
  } catch (error) {
    console.error("Error in addOpenSubtitlesCaptions:", error);
    return captions;
  }
}
const DEFAULT_PROXY_URL = "https://proxy.nsbx.ru/proxy";
let CONFIGURED_M3U8_PROXY_URL = "https://proxy.fifthwit.net";
function setM3U8ProxyUrl(proxyUrl) {
  CONFIGURED_M3U8_PROXY_URL = proxyUrl;
}
function getM3U8ProxyUrl() {
  return CONFIGURED_M3U8_PROXY_URL;
}
function requiresProxy(stream) {
  if (!stream.flags.includes(flags.CORS_ALLOWED) || !!(stream.headers && Object.keys(stream.headers).length > 0))
    return true;
  return false;
}
function setupProxy(stream) {
  const headers = stream.headers && Object.keys(stream.headers).length > 0 ? stream.headers : void 0;
  const options = {
    ...stream.type === "hls" && { depth: stream.proxyDepth ?? 0 }
  };
  const payload = {
    headers,
    options
  };
  if (stream.type === "hls") {
    payload.type = "hls";
    payload.url = stream.playlist;
    stream.playlist = `${DEFAULT_PROXY_URL}?${new URLSearchParams({ payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })}`;
  }
  if (stream.type === "file") {
    payload.type = "mp4";
    Object.entries(stream.qualities).forEach((entry) => {
      payload.url = entry[1].url;
      entry[1].url = `${DEFAULT_PROXY_URL}?${new URLSearchParams({ payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })}`;
    });
  }
  stream.headers = {};
  stream.flags = [flags.CORS_ALLOWED];
  return stream;
}
function createM3U8ProxyUrl(url, headers = {}) {
  const encodedUrl = encodeURIComponent(url);
  const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
  return `${CONFIGURED_M3U8_PROXY_URL}/m3u8-proxy?url=${encodedUrl}${headers ? `&headers=${encodedHeaders}` : ""}`;
}
function updateM3U8ProxyUrl(url) {
  if (url.includes("/m3u8-proxy?url=")) {
    return url.replace(/https:\/\/[^/]+\/m3u8-proxy/, `${CONFIGURED_M3U8_PROXY_URL}/m3u8-proxy`);
  }
  return url;
}
function makeSourcerer(state) {
  const mediaTypes = [];
  if (state.scrapeMovie) mediaTypes.push("movie");
  if (state.scrapeShow) mediaTypes.push("show");
  return {
    ...state,
    type: "source",
    disabled: state.disabled ?? false,
    externalSource: state.externalSource ?? false,
    mediaTypes
  };
}
function makeEmbed(state) {
  return {
    ...state,
    type: "embed",
    disabled: state.disabled ?? false,
    mediaTypes: void 0
  };
}
const CINEMAOS_API = atob("aHR0cHM6Ly9jaW5lbWFvcy12My52ZXJjZWwuYXBwL2FwaS9uZW8vYmFja2VuZGZldGNo");
function makeCinemaOSEmbed(server, rank) {
  return makeEmbed({
    id: `cinemaos-${server}`,
    name: `${server.charAt(0).toUpperCase() + server.slice(1)}`,
    rank,
    async scrape(ctx) {
      var _a;
      const query = JSON.parse(ctx.url);
      const { tmdbId, type, season, episode } = query;
      let url = `${CINEMAOS_API}?requestID=${type === "show" ? "tvVideoProvider" : "movieVideoProvider"}&id=${tmdbId}&service=${server}`;
      if (type === "show") {
        url += `&season=${season}&episode=${episode}`;
      }
      const res = await ctx.proxiedFetcher(url);
      const data = typeof res === "string" ? JSON.parse(res) : res;
      const sources = (_a = data == null ? void 0 : data.data) == null ? void 0 : _a.sources;
      if (!sources || !Array.isArray(sources) || sources.length === 0) {
        throw new NotFoundError("No sources found");
      }
      ctx.progress(80);
      if (sources.length === 1) {
        return {
          stream: [
            {
              id: "primary",
              type: "hls",
              playlist: sources[0].url,
              flags: [flags.CORS_ALLOWED],
              captions: []
            }
          ]
        };
      }
      const qualityMap = {};
      for (const src of sources) {
        const quality = (src.quality || src.source || "unknown").toString();
        let qualityKey;
        if (quality === "4K") {
          qualityKey = 2160;
        } else {
          qualityKey = parseInt(quality.replace("P", ""), 10);
        }
        if (Number.isNaN(qualityKey) || qualityMap[qualityKey]) continue;
        qualityMap[qualityKey] = {
          type: "mp4",
          url: src.url
        };
      }
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            flags: [flags.CORS_ALLOWED],
            qualities: qualityMap,
            captions: []
          }
        ]
      };
    }
  });
}
const CINEMAOS_SERVERS$1 = [
  //   'flowcast',
  "shadow",
  "asiacloud",
  //   'hindicast',
  //   'anime',
  //   'animez',
  //   'guard',
  //   'hq',
  //   'ninja',
  //   'alpha',
  //   'kaze',
  //   'zenith',
  //   'cast',
  //   'ghost',
  //   'halo',
  //   'kinoecho',
  //   'ee3',
  //   'volt',
  //   'putafilme',
  "ophim"
  //   'kage',
];
const cinemaosEmbeds = CINEMAOS_SERVERS$1.map((server, i) => makeCinemaOSEmbed(server, 300 - i));
function makeCinemaOSHexaEmbed(id, rank = 100) {
  return makeEmbed({
    id: `cinemaos-hexa-${id}`,
    name: `Hexa ${id.charAt(0).toUpperCase() + id.slice(1)}`,
    disabled: true,
    rank,
    async scrape(ctx) {
      const query = JSON.parse(ctx.url);
      const directUrl = query.directUrl;
      if (!directUrl) {
        throw new NotFoundError("No directUrl provided for Hexa embed");
      }
      const headers = {
        referer: "https://megacloud.store/",
        origin: "https://megacloud.store"
      };
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: createM3U8ProxyUrl(directUrl, headers),
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const HEXA_SERVERS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
const cinemaosHexaEmbeds = HEXA_SERVERS.map((server, i) => makeCinemaOSHexaEmbed(server, 315 - i));
const providers$4 = [
  {
    id: "streamwish-japanese",
    name: "StreamWish (Japones Sub Español)",
    rank: 171
  },
  {
    id: "streamwish-latino",
    name: "StreamWish (Latino)",
    rank: 170
  },
  {
    id: "streamwish-spanish",
    name: "StreamWish (Castellano)",
    rank: 169
  },
  {
    id: "streamwish-english",
    name: "StreamWish (English)",
    rank: 168
  }
];
function embed$4(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    async scrape(ctx) {
      const encodedUrl = encodeURIComponent(ctx.url);
      const apiUrl2 = `https://ws-m3u8.moonpic.qzz.io/m3u8/${encodedUrl}`;
      const response = await fetch(apiUrl2, {
        headers: {
          Accept: "application/json"
          // 'ngrok-skip-browser-warning': 'true', // this header bypass ngrok warning
        }
      });
      const data = await response.json();
      const videoUrl = data.m3u8;
      if (!videoUrl) throw new NotFoundError("No video URL found");
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: videoUrl,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [streamwishJapaneseScraper, streamwishLatinoScraper, streamwishSpanishScraper, streamwishEnglishScraper] = providers$4.map(embed$4);
const viperScraper = makeEmbed({
  id: "viper",
  name: "Viper",
  rank: 182,
  async scrape(ctx) {
    const apiResponse = await ctx.proxiedFetcher.full(ctx.url, {
      headers: {
        Accept: "application/json",
        Referer: "https://embed.su/"
      }
    });
    if (!apiResponse.body.source) {
      throw new NotFoundError("No source found");
    }
    const playlistUrl = apiResponse.body.source.replace(/^.*\/viper\//, "https://");
    const headers = {
      referer: "https://megacloud.store/",
      origin: "https://megacloud.store"
    };
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist: createM3U8ProxyUrl(playlistUrl, headers),
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const warezcdnBase = "https://embed.warezcdn.link";
const warezcdnPlayerBase = "https://warezcdn.link/player";
const warezcdnWorkerProxy = "https://workerproxy.warezcdn.workers.dev";
function decrypt$1(input) {
  let output = atob(input);
  output = output.trim();
  output = output.split("").reverse().join("");
  let last = output.slice(-5);
  last = last.split("").reverse().join("");
  output = output.slice(0, -5);
  return `${output}${last}`;
}
async function getDecryptedId(ctx) {
  var _a;
  const page = await ctx.proxiedFetcher(`/player.php`, {
    baseUrl: warezcdnPlayerBase,
    headers: {
      Referer: `${warezcdnPlayerBase}/getEmbed.php?${new URLSearchParams({
        id: ctx.url,
        sv: "warezcdn"
      })}`
    },
    query: {
      id: ctx.url
    }
  });
  const allowanceKey = (_a = page.match(/let allowanceKey = "(.*?)";/)) == null ? void 0 : _a[1];
  if (!allowanceKey) throw new NotFoundError("Failed to get allowanceKey");
  const streamData = await ctx.proxiedFetcher("/functions.php", {
    baseUrl: warezcdnPlayerBase,
    method: "POST",
    body: new URLSearchParams({
      getVideo: ctx.url,
      key: allowanceKey
    })
  });
  const stream = JSON.parse(streamData);
  if (!stream.id) throw new NotFoundError("can't get stream id");
  const decryptedId = decrypt$1(stream.id);
  if (!decryptedId) throw new NotFoundError("can't get file id");
  return decryptedId;
}
const cdnListing = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64];
async function checkUrls(ctx, fileId) {
  for (const id of cdnListing) {
    const url = `https://cloclo${id}.cloud.mail.ru/weblink/view/${fileId}`;
    const response = await ctx.proxiedFetcher.full(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-1"
      }
    });
    if (response.statusCode === 206) return url;
  }
  return null;
}
const warezcdnembedMp4Scraper = makeEmbed({
  id: "warezcdnembedmp4",
  // WarezCDN is both a source and an embed host
  name: "WarezCDN MP4",
  // method no longer works
  rank: 82,
  disabled: true,
  async scrape(ctx) {
    const decryptedId = await getDecryptedId(ctx);
    if (!decryptedId) throw new NotFoundError("can't get file id");
    const streamUrl = await checkUrls(ctx, decryptedId);
    if (!streamUrl) throw new NotFoundError("can't get stream id");
    return {
      stream: [
        {
          id: "primary",
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: `${warezcdnWorkerProxy}/?${new URLSearchParams({
                url: streamUrl
              })}`
            }
          },
          type: "file",
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
async function stringAtob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const str = input.replace(/=+$/, "");
  let output = "";
  if (str.length % 4 === 1) {
    throw new Error("The string to be decoded is not correctly encoded.");
  }
  for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
    const buffer = str.charAt(i);
    const charIndex = chars.indexOf(buffer);
    if (charIndex === -1) continue;
    bs = bc % 4 ? bs * 64 + charIndex : charIndex;
    if (bc++ % 4) {
      output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
    }
  }
  return output;
}
async function comboScraper$h(ctx) {
  const embedUrl = `https://embed.su/embed/${ctx.media.type === "movie" ? `movie/${ctx.media.tmdbId}` : `tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`;
  const embedPage = await ctx.proxiedFetcher(embedUrl, {
    headers: {
      Referer: "https://embed.su/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });
  const vConfigMatch = embedPage.match(/window\.vConfig\s*=\s*JSON\.parse\(atob\(`([^`]+)/i);
  const encodedConfig = vConfigMatch == null ? void 0 : vConfigMatch[1];
  if (!encodedConfig) throw new NotFoundError("No encoded config found");
  const decodedConfig = JSON.parse(await stringAtob(encodedConfig));
  if (!(decodedConfig == null ? void 0 : decodedConfig.hash)) throw new NotFoundError("No stream hash found");
  const firstDecode = (await stringAtob(decodedConfig.hash)).split(".").map((item) => item.split("").reverse().join(""));
  const secondDecode = JSON.parse(await stringAtob(firstDecode.join("").split("").reverse().join("")));
  if (!(secondDecode == null ? void 0 : secondDecode.length)) throw new NotFoundError("No servers found");
  ctx.progress(50);
  const embeds = secondDecode.map((server) => ({
    embedId: "viper",
    url: `https://embed.su/api/e/${server.hash}`
  }));
  ctx.progress(90);
  return { embeds };
}
const embedsuScraper = makeSourcerer({
  id: "embedsu",
  name: "embed.su",
  rank: 170,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$h,
  scrapeShow: comboScraper$h
});
function normalizeTitle(title) {
  let titleTrimmed = title.trim().toLowerCase();
  if (titleTrimmed !== "the movie" && titleTrimmed.endsWith("the movie")) {
    titleTrimmed = titleTrimmed.replace("the movie", "");
  }
  if (titleTrimmed !== "the series" && titleTrimmed.endsWith("the series")) {
    titleTrimmed = titleTrimmed.replace("the series", "");
  }
  return titleTrimmed.replace(/['":]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
}
function compareTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}
function compareMedia(media, title, releaseYear) {
  const isSameYear = releaseYear === void 0 ? true : media.releaseYear === releaseYear;
  return compareTitle(media.title, title) && isSameYear;
}
const baseUrl$d = "https://soaper.cc";
const universalScraper$4 = async (ctx) => {
  var _a;
  const searchResult = await ctx.proxiedFetcher("/search.html", {
    baseUrl: baseUrl$d,
    query: {
      keyword: ctx.media.title
    }
  });
  const search$ = load(searchResult);
  const searchResults = [];
  search$(".thumbnail").each((_, element) => {
    const title = search$(element).find("h5").find("a").first().text().trim();
    const year = search$(element).find(".img-tip").first().text().trim();
    const url = search$(element).find("h5").find("a").first().attr("href");
    if (!title || !url) return;
    searchResults.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  let showLink = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!showLink) throw new NotFoundError("Content not found");
  if (ctx.media.type === "show") {
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const showPage = await ctx.proxiedFetcher(showLink, { baseUrl: baseUrl$d });
    const showPage$ = load(showPage);
    const seasonBlock = showPage$("h4").filter((_, el) => showPage$(el).text().trim().split(":")[0].trim() === `Season${seasonNumber}`).parent();
    const episodes = seasonBlock.find("a").toArray();
    showLink = showPage$(
      episodes.find((el) => parseInt(showPage$(el).text().split(".")[0], 10) === episodeNumber)
    ).attr("href");
  }
  if (!showLink) throw new NotFoundError("Content not found");
  const contentPage = await ctx.proxiedFetcher(showLink, { baseUrl: baseUrl$d });
  const contentPage$ = load(contentPage);
  const pass = contentPage$("#hId").attr("value");
  if (!pass) throw new NotFoundError("Content not found");
  ctx.progress(50);
  const formData = new URLSearchParams();
  formData.append("pass", pass);
  formData.append("e2", "0");
  formData.append("server", "0");
  const infoEndpoint = ctx.media.type === "show" ? "/home/index/getEInfoAjax" : "/home/index/getMInfoAjax";
  const streamRes = await ctx.proxiedFetcher(infoEndpoint, {
    baseUrl: baseUrl$d,
    method: "POST",
    body: formData,
    headers: {
      referer: `${baseUrl$d}${showLink}`,
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Viewport-Width": "375"
    }
  });
  const streamResJson = JSON.parse(streamRes);
  const languageMap = {
    "chinese - hong kong": "zh",
    "chinese - traditional": "zh",
    czech: "cs",
    danish: "da",
    dutch: "nl",
    english: "en",
    "english - sdh": "en",
    finnish: "fi",
    french: "fr",
    german: "de",
    greek: "el",
    hungarian: "hu",
    italian: "it",
    korean: "ko",
    norwegian: "no",
    polish: "pl",
    portuguese: "pt",
    "portuguese - brazilian": "pt",
    romanian: "ro",
    "spanish - european": "es",
    "spanish - latin american": "es",
    swedish: "sv",
    turkish: "tr",
    اَلْعَرَبِيَّةُ: "ar",
    বাংলা: "bn",
    filipino: "tl",
    indonesia: "id",
    اردو: "ur",
    English: "en",
    Arabic: "ar",
    Bosnian: "bs",
    Bulgarian: "bg",
    Croatian: "hr",
    Czech: "cs",
    Danish: "da",
    Dutch: "nl",
    Estonian: "et",
    Finnish: "fi",
    French: "fr",
    German: "de",
    Greek: "el",
    Hebrew: "he",
    Hungarian: "hu",
    Indonesian: "id",
    Italian: "it",
    Norwegian: "no",
    Persian: "fa",
    Polish: "pl",
    Portuguese: "pt",
    "Protuguese (BR)": "pt-br",
    Romanian: "ro",
    Russian: "ru",
    Serbian: "sr",
    Slovenian: "sl",
    Spanish: "es",
    Swedish: "sv",
    Thai: "th",
    Turkish: "tr"
  };
  const captions = [];
  if (Array.isArray(streamResJson.subs)) {
    for (const sub of streamResJson.subs) {
      let language = "";
      if (sub.name.includes(".srt")) {
        const langName = sub.name.split(".srt")[0].toLowerCase().trim();
        language = languageMap[langName] || labelToLanguageCode(langName);
      } else if (sub.name.includes(":")) {
        const langName = sub.name.split(":")[0].toLowerCase().trim();
        language = languageMap[langName] || labelToLanguageCode(langName);
      } else {
        const langName = sub.name.toLowerCase().trim();
        language = languageMap[langName] || labelToLanguageCode(langName);
      }
      if (!language) continue;
      captions.push({
        id: sub.path,
        url: `${baseUrl$d}${sub.path}`,
        type: "srt",
        hasCorsRestrictions: false,
        language
      });
    }
  }
  ctx.progress(90);
  const headers = {
    referer: `${baseUrl$d}${showLink}`,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Viewport-Width": "375"
  };
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: createM3U8ProxyUrl(`${baseUrl$d}/${streamResJson.val}`, headers),
        type: "hls",
        proxyDepth: 2,
        flags: [flags.CORS_ALLOWED],
        captions
      },
      ...streamResJson.val_bak ? [
        {
          id: "backup",
          playlist: createM3U8ProxyUrl(`${baseUrl$d}/${streamResJson.val_bak}`, headers),
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          proxyDepth: 2,
          captions
        }
      ] : []
    ]
  };
};
const soaperTvScraper = makeSourcerer({
  id: "soapertv",
  name: "SoaperTV",
  rank: 130,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$4,
  scrapeShow: universalScraper$4
});
const baseUrl$c = "https://wecima.tube";
async function comboScraper$g(ctx) {
  const searchPage = await ctx.proxiedFetcher(`/search/${encodeURIComponent(ctx.media.title)}/`, {
    baseUrl: baseUrl$c
  });
  const search$ = load(searchPage);
  const firstResult = search$(".Grid--WecimaPosts .GridItem a").first();
  if (!firstResult.length) throw new NotFoundError("No results found");
  const contentUrl = firstResult.attr("href");
  if (!contentUrl) throw new NotFoundError("No content URL found");
  ctx.progress(30);
  const contentPage = await ctx.proxiedFetcher(contentUrl, { baseUrl: baseUrl$c });
  const content$ = load(contentPage);
  let embedUrl;
  if (ctx.media.type === "movie") {
    embedUrl = content$('meta[itemprop="embedURL"]').attr("content");
  } else {
    const seasonLinks = content$(".List--Seasons--Episodes a");
    let seasonUrl;
    for (const element of seasonLinks) {
      const text = content$(element).text().trim();
      if (text.includes(`موسم ${ctx.media.season}`)) {
        seasonUrl = content$(element).attr("href");
        break;
      }
    }
    if (!seasonUrl) throw new NotFoundError(`Season ${ctx.media.season} not found`);
    const seasonPage = await ctx.proxiedFetcher(seasonUrl, { baseUrl: baseUrl$c });
    const season$ = load(seasonPage);
    const episodeLinks = season$(".Episodes--Seasons--Episodes a");
    for (const element of episodeLinks) {
      const epTitle = season$(element).find("episodetitle").text().trim();
      if (epTitle === `الحلقة ${ctx.media.episode}`) {
        const episodeUrl = season$(element).attr("href");
        if (episodeUrl) {
          const episodePage = await ctx.proxiedFetcher(episodeUrl, { baseUrl: baseUrl$c });
          const episode$ = load(episodePage);
          embedUrl = episode$('meta[itemprop="embedURL"]').attr("content");
        }
        break;
      }
    }
  }
  if (!embedUrl) throw new NotFoundError("No embed URL found");
  ctx.progress(60);
  const embedPage = await ctx.proxiedFetcher(embedUrl);
  const embed$ = load(embedPage);
  const videoSource = embed$('source[type="video/mp4"]').attr("src");
  if (!videoSource) throw new NotFoundError("No video source found");
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [],
        headers: {
          referer: baseUrl$c
        },
        qualities: {
          unknown: {
            type: "mp4",
            url: videoSource
          }
        },
        captions: []
      }
    ]
  };
}
const wecimaScraper = makeSourcerer({
  id: "wecima",
  name: "Wecima (Arabic)",
  rank: 3,
  disabled: true,
  flags: [],
  scrapeMovie: comboScraper$g,
  scrapeShow: comboScraper$g
});
const SKIP_VALIDATION_CHECK_IDS = [
  warezcdnembedMp4Scraper.id,
  // deltaScraper.id,
  // alphaScraper.id,
  // novaScraper.id,
  // astraScraper.id,
  // orionScraper.id,
  viperScraper.id,
  streamwishLatinoScraper.id,
  streamwishSpanishScraper.id,
  streamwishEnglishScraper.id,
  embedsuScraper.id,
  wecimaScraper.id,
  ...cinemaosHexaEmbeds.map((e) => e.id),
  soaperTvScraper.id
];
function isValidStream(stream) {
  if (!stream) return false;
  if (stream.type === "hls") {
    if (!stream.playlist) return false;
    return true;
  }
  if (stream.type === "file") {
    const validQualities = Object.values(stream.qualities).filter((v) => v.url.length > 0);
    if (validQualities.length === 0) return false;
    return true;
  }
  return false;
}
async function validatePlayableStream(stream, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return stream;
  if (stream.type === "hls") {
    if (stream.playlist.startsWith("data:")) return stream;
    const result = await ops.proxiedFetcher.full(stream.playlist, {
      method: "GET",
      headers: {
        ...stream.preferredHeaders,
        ...stream.headers
      }
    });
    if (result.statusCode < 200 || result.statusCode >= 400) return null;
    return stream;
  }
  if (stream.type === "file") {
    const validQualitiesResults = await Promise.all(
      Object.values(stream.qualities).map(
        (quality) => ops.proxiedFetcher.full(quality.url, {
          method: "GET",
          headers: {
            ...stream.preferredHeaders,
            ...stream.headers,
            Range: "bytes=0-1"
          }
        })
      )
    );
    const validQualities = stream.qualities;
    Object.keys(stream.qualities).forEach((quality, index) => {
      if (validQualitiesResults[index].statusCode < 200 || validQualitiesResults[index].statusCode >= 400) {
        delete validQualities[quality];
      }
    });
    if (Object.keys(validQualities).length === 0) return null;
    return { ...stream, qualities: validQualities };
  }
  return null;
}
async function validatePlayableStreams(streams, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return streams;
  return (await Promise.all(streams.map((stream) => validatePlayableStream(stream, ops, sourcererId)))).filter(
    (v) => v !== null
  );
}
async function scrapeInvidualSource(list, ops) {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper) throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie) throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow) throw new Error("Source is not compatible with shows");
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: sourceScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  };
  let output = null;
  if (ops.media.type === "movie" && sourceScraper.scrapeMovie)
    output = await sourceScraper.scrapeMovie({
      ...contextBase,
      media: ops.media
    });
  else if (ops.media.type === "show" && sourceScraper.scrapeShow)
    output = await sourceScraper.scrapeShow({
      ...contextBase,
      media: ops.media
    });
  if (output == null ? void 0 : output.stream) {
    output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
    output.stream = output.stream.map(
      (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
    );
  }
  if (!output) throw new Error("output is null");
  output.embeds = output.embeds.filter((embed2) => {
    const e = list.embeds.find((v) => v.id === embed2.embedId);
    if (!e || e.disabled) return false;
    return true;
  });
  if (!ops.disableOpensubtitles)
    for (const embed2 of output.embeds)
      embed2.url = `${embed2.url}${btoa("MEDIA=")}${btoa(
        `${ops.media.imdbId}${ops.media.type === "show" ? `.${ops.media.season.number}.${ops.media.episode.number}` : ""}`
      )}`;
  if ((!output.stream || output.stream.length === 0) && output.embeds.length === 0)
    throw new NotFoundError("No streams found");
  if (output.stream && output.stream.length > 0 && output.embeds.length === 0) {
    const playableStreams = await validatePlayableStreams(output.stream, ops, sourceScraper.id);
    if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
    if (!ops.disableOpensubtitles) {
      for (const playableStream of playableStreams) {
        playableStream.captions = await addOpenSubtitlesCaptions(
          playableStream.captions,
          ops,
          btoa(
            `${ops.media.imdbId}${ops.media.type === "show" ? `.${ops.media.season.number}.${ops.media.episode.number}` : ""}`
          )
        );
      }
    }
    output.stream = playableStreams;
  }
  return output;
}
async function scrapeIndividualEmbed(list, ops) {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper) throw new Error("Embed with ID not found");
  let url = ops.url;
  let media;
  if (ops.url.includes(btoa("MEDIA="))) [url, media] = url.split(btoa("MEDIA="));
  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    url,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: embedScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  });
  output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
  if (output.stream.length === 0) throw new NotFoundError("No streams found");
  output.stream = output.stream.map(
    (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
  );
  const playableStreams = await validatePlayableStreams(output.stream, ops, embedScraper.id);
  if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
  if (media && !ops.disableOpensubtitles) {
    const [imdbId, season, episode] = atob(media).split(".").map((x, i) => i === 0 ? x : Number(x) || null);
    const mediaInfo = {
      ...ops,
      media: {
        type: season && episode ? "show" : "movie",
        imdbId: (imdbId == null ? void 0 : imdbId.toString()) || "",
        ...season && episode ? { season: { number: season }, episode: { number: episode } } : {}
      }
    };
    for (const playableStream of playableStreams)
      playableStream.captions = await addOpenSubtitlesCaptions(playableStream.captions, mediaInfo, media);
  }
  output.stream = playableStreams;
  return output;
}
function reorderOnIdList(order, list) {
  const copy = [...list];
  copy.sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
    if (bIndex >= 0) return 1;
    if (aIndex >= 0) return -1;
    return b.rank - a.rank;
  });
  return copy;
}
async function runAllProviders(list, ops) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((source) => {
    if (ops.media.type === "movie") return !!source.scrapeMovie;
    if (ops.media.type === "show") return !!source.scrapeShow;
    return false;
  });
  const embeds = reorderOnIdList(ops.embedOrder ?? [], list.embeds);
  const embedIds = embeds.map((embed2) => embed2.id);
  let lastId = "";
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a2, _b2;
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.update) == null ? void 0 : _b2.call(_a2, {
        id: lastId,
        percentage: val,
        status: "pending"
      });
    }
  };
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  for (const source of sources) {
    (_d = (_c = ops.events) == null ? void 0 : _c.start) == null ? void 0 : _d.call(_c, source.id);
    lastId = source.id;
    let output = null;
    try {
      if (ops.media.type === "movie" && source.scrapeMovie)
        output = await source.scrapeMovie({
          ...contextBase,
          media: ops.media
        });
      else if (ops.media.type === "show" && source.scrapeShow)
        output = await source.scrapeShow({
          ...contextBase,
          media: ops.media
        });
      if (output) {
        output.stream = (output.stream ?? []).filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        output.stream = output.stream.map(
          (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
        );
      }
      if (!output || !((_e = output.stream) == null ? void 0 : _e.length) && !output.embeds.length) {
        throw new NotFoundError("No streams found");
      }
    } catch (error) {
      const updateParams = {
        id: source.id,
        percentage: 100,
        status: error instanceof NotFoundError ? "notfound" : "failure",
        reason: error instanceof NotFoundError ? error.message : void 0,
        error: error instanceof NotFoundError ? void 0 : error
      };
      (_g = (_f = ops.events) == null ? void 0 : _f.update) == null ? void 0 : _g.call(_f, updateParams);
      continue;
    }
    if (!output) throw new Error("Invalid media type");
    if ((_h = output.stream) == null ? void 0 : _h[0]) {
      const playableStream = await validatePlayableStream(output.stream[0], ops, source.id);
      if (!playableStream) throw new NotFoundError("No streams found");
      if (!ops.disableOpensubtitles) {
        if (ops.media.imdbId) {
          playableStream.captions = await addOpenSubtitlesCaptions(
            playableStream.captions,
            ops,
            btoa(
              `${ops.media.imdbId}${ops.media.type === "show" ? `.${ops.media.season.number}.${ops.media.episode.number}` : ""}`
            )
          );
        }
      }
      return {
        sourceId: source.id,
        stream: playableStream
      };
    }
    const sortedEmbeds = output.embeds.filter((embed2) => {
      const e = list.embeds.find((v) => v.id === embed2.embedId);
      return e && !e.disabled;
    }).sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));
    if (sortedEmbeds.length > 0) {
      (_j = (_i = ops.events) == null ? void 0 : _i.discoverEmbeds) == null ? void 0 : _j.call(_i, {
        embeds: sortedEmbeds.map((embed2, i) => ({
          id: [source.id, i].join("-"),
          embedScraperId: embed2.embedId
        })),
        sourceId: source.id
      });
    }
    for (const [ind, embed2] of sortedEmbeds.entries()) {
      const scraper = embeds.find((v) => v.id === embed2.embedId);
      if (!scraper) throw new Error("Invalid embed returned");
      const id = [source.id, ind].join("-");
      (_l = (_k = ops.events) == null ? void 0 : _k.start) == null ? void 0 : _l.call(_k, id);
      lastId = id;
      let embedOutput;
      try {
        embedOutput = await scraper.scrape({
          ...contextBase,
          url: embed2.url
        });
        embedOutput.stream = embedOutput.stream.filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        embedOutput.stream = embedOutput.stream.map(
          (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
        );
        if (embedOutput.stream.length === 0) {
          throw new NotFoundError("No streams found");
        }
        const playableStream = await validatePlayableStream(embedOutput.stream[0], ops, embed2.embedId);
        if (!playableStream) throw new NotFoundError("No streams found");
        if (!ops.disableOpensubtitles) {
          if (ops.media.imdbId) {
            playableStream.captions = await addOpenSubtitlesCaptions(
              playableStream.captions,
              ops,
              btoa(
                `${ops.media.imdbId}${ops.media.type === "show" ? `.${ops.media.season.number}.${ops.media.episode.number}` : ""}`
              )
            );
          }
        }
        embedOutput.stream = [playableStream];
      } catch (error) {
        const updateParams = {
          id,
          percentage: 100,
          status: error instanceof NotFoundError ? "notfound" : "failure",
          reason: error instanceof NotFoundError ? error.message : void 0,
          error: error instanceof NotFoundError ? void 0 : error
        };
        (_n = (_m = ops.events) == null ? void 0 : _m.update) == null ? void 0 : _n.call(_m, updateParams);
        continue;
      }
      return {
        sourceId: source.id,
        embedId: scraper.id,
        stream: embedOutput.stream[0]
      };
    }
  }
  return null;
}
function makeControls(ops) {
  const list = {
    embeds: ops.embeds,
    sources: ops.sources
  };
  const providerRunnerOps = {
    features: ops.features,
    fetcher: makeFetcher(ops.fetcher),
    proxiedFetcher: makeFetcher(ops.proxiedFetcher ?? ops.fetcher),
    proxyStreams: ops.proxyStreams
  };
  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    }
  };
}
const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 10);
const baseUrl$b = "https://d000d.com";
const doodScraper = makeEmbed({
  id: "dood",
  name: "dood",
  rank: 173,
  async scrape(ctx) {
    var _a, _b;
    let url = ctx.url;
    if (ctx.url.includes("primewire")) {
      const request = await ctx.proxiedFetcher.full(ctx.url);
      url = request.finalUrl;
    }
    const id = url.split("/d/")[1] || url.split("/e/")[1];
    const doodData = await ctx.proxiedFetcher(`/e/${id}`, {
      method: "GET",
      baseUrl: baseUrl$b
    });
    const dataForLater = (_a = doodData.match(/\?token=([^&]+)&expiry=/)) == null ? void 0 : _a[1];
    const path = (_b = doodData.match(/\$\.get\('\/pass_md5([^']+)/)) == null ? void 0 : _b[1];
    const thumbnailTrack = doodData.match(/thumbnails:\s\{\s*vtt:\s'([^']*)'/);
    const doodPage = await ctx.proxiedFetcher(`/pass_md5${path}`, {
      headers: {
        Referer: `${baseUrl$b}/e/${id}`
      },
      method: "GET",
      baseUrl: baseUrl$b
    });
    const downloadURL = `${doodPage}${nanoid()}?token=${dataForLater}&expiry=${Date.now()}`;
    if (!downloadURL.startsWith("http")) throw new Error("Invalid URL");
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: downloadURL
            }
          },
          headers: {
            Referer: baseUrl$b
          },
          ...thumbnailTrack ? {
            thumbnailTrack: {
              type: "vtt",
              url: `https:${thumbnailTrack[1]}`
            }
          } : {}
        }
      ]
    };
  }
});
const mixdropBase = "https://mixdrop.ag";
const packedRegex$1 = /(eval\(function\(p,a,c,k,e,d\){.*{}\)\))/;
const linkRegex$1 = /MDCore\.wurl="(.*?)";/;
const mixdropScraper = makeEmbed({
  id: "mixdrop",
  name: "MixDrop",
  rank: 198,
  async scrape(ctx) {
    let embedUrl = ctx.url;
    if (ctx.url.includes("primewire")) embedUrl = (await ctx.fetcher.full(ctx.url)).finalUrl;
    const embedId = new URL(embedUrl).pathname.split("/")[2];
    const streamRes = await ctx.proxiedFetcher(`/e/${embedId}`, {
      baseUrl: mixdropBase
    });
    const packed = streamRes.match(packedRegex$1);
    if (!packed) {
      throw new Error("failed to find packed mixdrop JavaScript");
    }
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex$1);
    if (!link) {
      throw new Error("failed to find packed mixdrop source link");
    }
    const url = link[1];
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.IP_LOCKED],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: url.startsWith("http") ? url : `https:${url}`,
              // URLs don't always start with the protocol
              headers: {
                // MixDrop requires this header on all streams
                Referer: mixdropBase
              }
            }
          }
        }
      ]
    };
  }
});
function hexToChar(hex) {
  return String.fromCharCode(parseInt(hex, 16));
}
function decrypt(data, key) {
  var _a;
  const formatedData = ((_a = data.match(/../g)) == null ? void 0 : _a.map(hexToChar).join("")) || "";
  return formatedData.split("").map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join("");
}
const turbovidScraper = makeEmbed({
  id: "turbovid",
  name: "Turbovid",
  rank: 122,
  async scrape(ctx) {
    var _a, _b;
    const baseUrl3 = new URL(ctx.url).origin;
    const embedPage = await ctx.proxiedFetcher(ctx.url);
    ctx.progress(30);
    const apkey = (_a = embedPage.match(/const\s+apkey\s*=\s*"(.*?)";/)) == null ? void 0 : _a[1];
    const xxid = (_b = embedPage.match(/const\s+xxid\s*=\s*"(.*?)";/)) == null ? void 0 : _b[1];
    if (!apkey || !xxid) throw new Error("Failed to get required values");
    const encodedJuiceKey = JSON.parse(
      await ctx.proxiedFetcher("/api/cucked/juice_key", {
        baseUrl: baseUrl3,
        headers: {
          referer: ctx.url,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
          "Content-Type": "application/json",
          "X-Turbo": "TurboVidClient",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin"
        }
      })
    ).juice;
    if (!encodedJuiceKey) throw new Error("Failed to fetch the key");
    const juiceKey = atob(encodedJuiceKey);
    ctx.progress(60);
    const data = JSON.parse(
      await ctx.proxiedFetcher("/api/cucked/the_juice_v2/", {
        baseUrl: baseUrl3,
        query: {
          [apkey]: xxid
        },
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
          "Content-Type": "application/json",
          "X-Turbo": "TurboVidClient",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          referer: ctx.url
        }
      })
    ).data;
    if (!data) throw new Error("Failed to fetch required data");
    ctx.progress(90);
    const playlist = decrypt(data, juiceKey);
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist,
          headers: {
            referer: `${baseUrl3}/`,
            origin: baseUrl3
          },
          flags: [],
          captions: []
        }
      ]
    };
  }
});
const origin = "https://rabbitstream.net";
const referer$2 = "https://rabbitstream.net/";
const { AES, enc } = crypto;
function isJSON(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}
function extractKey(script) {
  const startOfSwitch = script.lastIndexOf("switch");
  const endOfCases = script.indexOf("partKeyStartPosition");
  const switchBody = script.slice(startOfSwitch, endOfCases);
  const nums = [];
  const matches = switchBody.matchAll(/:[a-zA-Z0-9]+=([a-zA-Z0-9]+),[a-zA-Z0-9]+=([a-zA-Z0-9]+);/g);
  for (const match of matches) {
    const innerNumbers = [];
    for (const varMatch of [match[1], match[2]]) {
      const regex = new RegExp(`${varMatch}=0x([a-zA-Z0-9]+)`, "g");
      const varMatches = [...script.matchAll(regex)];
      const lastMatch = varMatches[varMatches.length - 1];
      if (!lastMatch) return null;
      const number = parseInt(lastMatch[1], 16);
      innerNumbers.push(number);
    }
    nums.push([innerNumbers[0], innerNumbers[1]]);
  }
  return nums;
}
const upcloudScraper = makeEmbed({
  id: "upcloud",
  name: "UpCloud",
  rank: 200,
  disabled: true,
  async scrape(ctx) {
    const parsedUrl = new URL(ctx.url.replace("embed-5", "embed-4"));
    const dataPath = parsedUrl.pathname.split("/");
    const dataId = dataPath[dataPath.length - 1];
    const streamRes = await ctx.proxiedFetcher(`${parsedUrl.origin}/ajax/embed-4/getSources?id=${dataId}`, {
      headers: {
        Referer: parsedUrl.origin,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    let sources = null;
    if (!isJSON(streamRes.sources)) {
      const scriptJs = await ctx.proxiedFetcher(`https://rabbitstream.net/js/player/prod/e4-player.min.js`, {
        query: {
          // browser side caching on this endpoint is quite extreme. Add version query paramter to circumvent any caching
          v: Date.now().toString()
        }
      });
      const decryptionKey = extractKey(scriptJs);
      if (!decryptionKey) throw new Error("Key extraction failed");
      let extractedKey = "";
      let strippedSources = streamRes.sources;
      let totalledOffset = 0;
      decryptionKey.forEach(([a, b]) => {
        const start = a + totalledOffset;
        const end = start + b;
        extractedKey += streamRes.sources.slice(start, end);
        strippedSources = strippedSources.replace(streamRes.sources.substring(start, end), "");
        totalledOffset += b;
      });
      const decryptedStream = AES.decrypt(strippedSources, extractedKey).toString(enc.Utf8);
      const parsedStream = JSON.parse(decryptedStream)[0];
      if (!parsedStream) throw new Error("No stream found");
      sources = parsedStream;
    }
    if (!sources) throw new Error("upcloud source not found");
    const captions = [];
    streamRes.tracks.forEach((track) => {
      if (track.kind !== "captions") return;
      const type = getCaptionTypeFromUrl(track.file);
      if (!type) return;
      const language = labelToLanguageCode(track.label.split(" ")[0]);
      if (!language) return;
      captions.push({
        id: track.file,
        language,
        hasCorsRestrictions: false,
        type,
        url: track.file
      });
    });
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: sources.file,
          flags: [flags.CORS_ALLOWED],
          captions,
          preferredHeaders: {
            Referer: referer$2,
            Origin: origin
          }
        }
      ]
    };
  }
});
const videasyScraper$1 = makeEmbed({
  id: "videasy-embed",
  name: "VIDEASY",
  rank: 200,
  disabled: false,
  async scrape(ctx) {
    new URL(ctx.url);
    ctx.progress(30);
    ctx.progress(90);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: ctx.url,
          flags: [flags.CORS_ALLOWED],
          captions: [],
          preferredHeaders: {
            Referer: "https://player.videasy.net/",
            Origin: "https://player.videasy.net"
          }
        }
      ]
    };
  }
});
const apiUrl = "https://tom.autoembed.cc";
async function comboScraper$f(ctx) {
  const mediaType = ctx.media.type === "show" ? "tv" : "movie";
  let id = ctx.media.tmdbId;
  if (ctx.media.type === "show") {
    id = `${id}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  }
  const data = await ctx.proxiedFetcher(`/api/getVideoSource`, {
    baseUrl: apiUrl,
    query: {
      type: mediaType,
      id
    },
    headers: {
      Referer: apiUrl,
      Origin: apiUrl
    }
  });
  if (!data) throw new NotFoundError("Failed to fetch video source");
  if (!data.videoSource) throw new NotFoundError("No video source found");
  ctx.progress(50);
  const embeds = [
    {
      embedId: `autoembed-english`,
      url: data.videoSource
    }
  ];
  ctx.progress(90);
  return {
    embeds
  };
}
const autoembedScraper = makeSourcerer({
  id: "autoembed",
  name: "Autoembed",
  rank: 110,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$f,
  scrapeShow: comboScraper$f
});
const baseUrl$a = "https://catflix.su";
async function comboScraper$e(ctx) {
  const mediaTitle = ctx.media.title.replace(/ /g, "-").replace(/[():]/g, "").toLowerCase();
  const mediaType = ctx.media.type;
  const movieId = ctx.media.tmdbId;
  const watchPageUrl = mediaType === "movie" ? `${baseUrl$a}/movie/${mediaTitle}-${movieId}` : `${baseUrl$a}/episode/${mediaTitle}-season-${ctx.media.season.number}-episode-${ctx.media.episode.number}/eid-${ctx.media.episode.tmdbId}`;
  ctx.progress(60);
  const watchPage = await ctx.proxiedFetcher(watchPageUrl);
  const $ = load(watchPage);
  const scriptContent = $("script").toArray().find((script) => {
    const child = script.children[0];
    return child && "type" in child && child.type === "text" && "data" in child && child.data.includes("main_origin =");
  });
  if (!scriptContent) throw new NotFoundError("No embed data found");
  const scriptData = scriptContent.children[0];
  const mainOriginMatch = scriptData.data.match(/main_origin = "(.*?)";/);
  if (!mainOriginMatch) throw new NotFoundError("Failed to extract embed URL");
  const decodedUrl = atob(mainOriginMatch[1]);
  ctx.progress(90);
  return {
    embeds: [
      {
        embedId: "turbovid",
        url: decodedUrl
      }
    ]
  };
}
const catflixScraper = makeSourcerer({
  id: "catflix",
  name: "Catflix",
  rank: 160,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$e,
  scrapeShow: comboScraper$e
});
function makeCookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => cookie.serialize(name, value)).join("; ");
}
function parseSetCookie(headerValue) {
  const splitHeaderValue = setCookieParser.splitCookiesString(headerValue);
  const parsedCookies = setCookieParser.parse(splitHeaderValue, {
    map: true
  });
  return parsedCookies;
}
const baseUrl$9 = "https://ee3.me";
const username = "_sf_";
const password = "defonotscraping";
async function login(user, pass, ctx) {
  const req = await ctx.proxiedFetcher.full("/login", {
    baseUrl: baseUrl$9,
    method: "POST",
    body: new URLSearchParams({ user, pass, action: "login" }),
    readHeaders: ["Set-Cookie"]
  });
  const res = JSON.parse(req.body);
  const cookie2 = parseSetCookie(
    // It retruns a cookie even when the login failed
    // I have the backup cookie here just in case
    res.status === 1 ? req.headers.get("Set-Cookie") ?? "" : "PHPSESSID=mk2p73c77qc28o5i5120843ruu;"
  );
  return cookie2.PHPSESSID.value;
}
function parseSearch$1(body) {
  const result = [];
  const $ = load(body);
  $("div").each((_, element) => {
    const title = $(element).find(".title").text().trim();
    const year = parseInt($(element).find(".details span").first().text().trim(), 10);
    const id = $(element).find(".control-buttons").attr("data-id");
    if (title && year && id) {
      result.push({ title, year, id });
    }
  });
  return result;
}
async function comboScraper$d(ctx) {
  var _a, _b;
  const pass = await login(username, password, ctx);
  if (!pass) throw new Error("Login failed");
  const search = parseSearch$1(
    await ctx.proxiedFetcher("/get", {
      baseUrl: baseUrl$9,
      method: "POST",
      body: new URLSearchParams({ query: ctx.media.title, action: "search" }),
      headers: {
        cookie: makeCookieHeader({ PHPSESSID: pass })
      }
    })
  );
  const id = (_a = search.find((v) => v && compareMedia(ctx.media, v.title, v.year))) == null ? void 0 : _a.id;
  if (!id) throw new NotFoundError("No watchable item found");
  ctx.progress(20);
  const details = JSON.parse(
    await ctx.proxiedFetcher("/get", {
      baseUrl: baseUrl$9,
      method: "POST",
      body: new URLSearchParams({ id, action: "get_movie_info" }),
      headers: {
        cookie: makeCookieHeader({ PHPSESSID: pass })
      }
    })
  );
  if (!details.message.video) throw new Error("Failed to get the stream");
  ctx.progress(40);
  const keyParams = JSON.parse(
    await ctx.proxiedFetcher("/renew", {
      baseUrl: baseUrl$9,
      method: "POST",
      headers: {
        cookie: makeCookieHeader({ PHPSESSID: pass })
      }
    })
  );
  if (!keyParams.k) throw new Error("Failed to get the key");
  ctx.progress(60);
  const server = details.message.server === "1" ? "https://vid.ee3.me/vid/" : "https://vault.rips.cc/video/";
  const k = keyParams.k;
  const url = `${server}${details.message.video}?${new URLSearchParams({ k })}`;
  const captions = [];
  if (((_b = details.message.subs) == null ? void 0 : _b.toLowerCase()) === "yes" && details.message.imdbID) {
    captions.push({
      id: `https://rips.cc/subs/${details.message.imdbID}.vtt`,
      url: `https://rips.cc/subs/${details.message.imdbID}.vtt`,
      type: "vtt",
      hasCorsRestrictions: false,
      language: "en"
    });
  }
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [flags.CORS_ALLOWED],
        captions,
        qualities: {
          // should be unknown, but all the videos are 720p
          720: {
            type: "mp4",
            url
          }
        }
      }
    ]
  };
}
const ee3Scraper = makeSourcerer({
  id: "ee3",
  name: "EE3",
  rank: 120,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$d
});
function getValidQualityFromString(quality) {
  switch (quality.toLowerCase().replace("p", "")) {
    case "360":
      return "360";
    case "480":
      return "480";
    case "720":
      return "720";
    case "1080":
      return "1080";
    case "2160":
      return "4k";
    case "4k":
      return "4k";
    default:
      return "unknown";
  }
}
const baseUrl$8 = "https://fsharetv.co";
async function comboScraper$c(ctx) {
  var _a, _b;
  const searchPage = await ctx.proxiedFetcher("/search", {
    baseUrl: baseUrl$8,
    query: {
      q: ctx.media.title
    }
  });
  const search$ = load(searchPage);
  const searchResults = [];
  search$(".movie-item").each((_, element) => {
    var _a2;
    const [, title, year] = ((_a2 = search$(element).find("b").text()) == null ? void 0 : _a2.match(/^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/)) || [];
    const url = search$(element).find("a").attr("href");
    if (!title || !url) return;
    searchResults.push({ title, year: Number(year) ?? void 0, url });
  });
  const watchPageUrl = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!watchPageUrl) throw new NotFoundError("No watchable item found");
  ctx.progress(50);
  const watchPage = await ctx.proxiedFetcher(watchPageUrl.replace("/movie", "/w"), { baseUrl: baseUrl$8 });
  const fileId = (_b = watchPage.match(/Movie\.setSource\('([^']*)'/)) == null ? void 0 : _b[1];
  if (!fileId) throw new Error("File ID not found");
  const apiRes = await ctx.proxiedFetcher(
    `/api/file/${fileId}/source`,
    {
      baseUrl: baseUrl$8,
      query: {
        type: "watch"
      }
    }
  );
  if (!apiRes.data.file.sources.length) throw new Error("No sources found");
  const mediaBase = new URL((await ctx.proxiedFetcher.full(apiRes.data.file.sources[0].src, { baseUrl: baseUrl$8 })).finalUrl).origin;
  const qualities = apiRes.data.file.sources.reduce(
    (acc, source) => {
      const quality = typeof source.quality === "number" ? source.quality.toString() : source.quality;
      const validQuality = getValidQualityFromString(quality);
      acc[validQuality] = {
        type: "mp4",
        url: `${mediaBase}${source.src.replace("/api", "")}`
      };
      return acc;
    },
    {}
  );
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [],
        headers: {
          referer: "https://fsharetv.co"
        },
        qualities,
        captions: []
      }
    ]
  };
}
const fsharetvScraper = makeSourcerer({
  id: "fsharetv",
  name: "FshareTV",
  rank: 190,
  flags: [],
  scrapeMovie: comboScraper$c
});
const BASE_URL = "https://isut.streamflix.one";
async function comboScraper$b(ctx) {
  const embedPage = await ctx.fetcher(
    `${BASE_URL}/api/source/${ctx.media.type === "movie" ? `${ctx.media.tmdbId}` : `${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`
  );
  const sources = embedPage.sources;
  if (!sources || sources.length === 0) throw new NotFoundError("No sources found");
  const file = sources[0].file;
  if (!file) throw new NotFoundError("No file URL found");
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: file,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const insertunitScraper = makeSourcerer({
  id: "insertunit",
  name: "Insertunit",
  rank: 12,
  disabled: true,
  flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
  scrapeMovie: comboScraper$b,
  scrapeShow: comboScraper$b
});
const baseUrl$7 = "https://mp4hydra.org/";
async function comboScraper$a(ctx) {
  var _a;
  const searchPage = await ctx.proxiedFetcher("/search", {
    baseUrl: baseUrl$7,
    query: {
      q: ctx.media.title
    }
  });
  ctx.progress(40);
  const $search = load(searchPage);
  const searchResults = [];
  $search(".search-details").each((_, element) => {
    var _a2;
    const [, title, year] = $search(element).find("a").first().text().trim().match(/^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/) || [];
    const url = (_a2 = $search(element).find("a").attr("href")) == null ? void 0 : _a2.split("/")[4];
    if (!title || !url) return;
    searchResults.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  const s = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!s) throw new NotFoundError("No watchable item found");
  ctx.progress(60);
  const data = await ctx.proxiedFetcher("/info2?v=8", {
    method: "POST",
    body: new URLSearchParams({ z: JSON.stringify([{ s, t: "movie" }]) }),
    baseUrl: baseUrl$7
  });
  if (!data.playlist[0].src || !data.servers) throw new NotFoundError("No watchable item found");
  ctx.progress(80);
  const embeds = [];
  [
    data.servers[data.servers.auto],
    ...Object.values(data.servers).filter((x) => x !== data.servers[data.servers.auto] && x !== data.servers.auto)
  ].forEach(
    (server, _) => embeds.push({ embedId: `mp4hydra-${_ + 1}`, url: `${server}${data.playlist[0].src}|${data.playlist[0].label}` })
  );
  ctx.progress(90);
  return {
    embeds
  };
}
const mp4hydraScraper = makeSourcerer({
  id: "mp4hydra",
  name: "Mp4Hydra",
  rank: 4,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$a,
  scrapeShow: comboScraper$a
});
const baseUrl$6 = "https://tugaflix.best/";
function parseSearch(page) {
  const results = [];
  const $ = load(page);
  $(".items .poster").each((_, element) => {
    var _a;
    const $link = $(element).find("a");
    const url = $link.attr("href");
    const [, title, year] = ((_a = $link.attr("title")) == null ? void 0 : _a.match(/^(.*?)\s*(?:\((\d{4})\))?\s*$/)) || [];
    if (!title || !url) return;
    results.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  return results;
}
const tugaflixScraper = makeSourcerer({
  id: "tugaflix",
  name: "Tugaflix",
  rank: 70,
  flags: [flags.IP_LOCKED],
  scrapeMovie: async (ctx) => {
    var _a;
    const searchResults = parseSearch(
      await ctx.proxiedFetcher("/filmes/", {
        baseUrl: baseUrl$6,
        query: {
          s: ctx.media.title
        }
      })
    );
    if (searchResults.length === 0) throw new NotFoundError("No watchable item found");
    const url = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
    if (!url) throw new NotFoundError("No watchable item found");
    ctx.progress(50);
    const videoPage = await ctx.proxiedFetcher(url, {
      method: "POST",
      body: new URLSearchParams({ play: "" })
    });
    const $ = load(videoPage);
    const embeds = [];
    for (const element of $(".play a")) {
      const embedUrl = $(element).attr("href");
      if (!embedUrl) continue;
      const embedPage = await ctx.proxiedFetcher.full(
        embedUrl.startsWith("https://") ? embedUrl : `https://${embedUrl}`
      );
      const finalUrl = load(embedPage.body)('a:contains("Download Filme")').attr("href");
      if (!finalUrl) continue;
      if (finalUrl.includes("streamtape")) {
        embeds.push({
          embedId: "streamtape",
          url: finalUrl
        });
      } else if (finalUrl.includes("dood")) {
        embeds.push({
          embedId: "dood",
          url: finalUrl
        });
      }
    }
    ctx.progress(90);
    return {
      embeds
    };
  },
  scrapeShow: async (ctx) => {
    var _a;
    const searchResults = parseSearch(
      await ctx.proxiedFetcher("/series/", {
        baseUrl: baseUrl$6,
        query: {
          s: ctx.media.title
        }
      })
    );
    if (searchResults.length === 0) throw new NotFoundError("No watchable item found");
    const url = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
    if (!url) throw new NotFoundError("No watchable item found");
    ctx.progress(50);
    const s = ctx.media.season.number < 10 ? `0${ctx.media.season.number}` : ctx.media.season.number.toString();
    const e = ctx.media.episode.number < 10 ? `0${ctx.media.episode.number}` : ctx.media.episode.number.toString();
    const videoPage = await ctx.proxiedFetcher(url, {
      method: "POST",
      body: new URLSearchParams({ [`S${s}E${e}`]: "" })
    });
    const embedUrl = load(videoPage)('iframe[name="player"]').attr("src");
    if (!embedUrl) throw new Error("Failed to find iframe");
    const playerPage = await ctx.proxiedFetcher(embedUrl.startsWith("https:") ? embedUrl : `https:${embedUrl}`, {
      method: "POST",
      body: new URLSearchParams({ submit: "" })
    });
    const embeds = [];
    const finalUrl = load(playerPage)('a:contains("Download Episodio")').attr("href");
    if (finalUrl == null ? void 0 : finalUrl.includes("streamtape")) {
      embeds.push({
        embedId: "streamtape",
        url: finalUrl
      });
    } else if (finalUrl == null ? void 0 : finalUrl.includes("dood")) {
      embeds.push({
        embedId: "dood",
        url: finalUrl
      });
    }
    ctx.progress(90);
    return {
      embeds
    };
  }
});
function createProxyUrl(originalUrl, referer2) {
  const headers = {
    referer: referer2
  };
  return createM3U8ProxyUrl(originalUrl, headers);
}
function processProxiedURL(url) {
  if (url.includes("orbitproxy")) {
    try {
      const urlParts = url.split(/orbitproxy\.[^/]+\//);
      if (urlParts.length >= 2) {
        const encryptedPart = urlParts[1].split(".m3u8")[0];
        try {
          const decodedData = Buffer.from(encryptedPart, "base64").toString("utf-8");
          const jsonData = JSON.parse(decodedData);
          const originalUrl = jsonData.u;
          const referer2 = jsonData.r || "";
          return createProxyUrl(originalUrl, referer2);
        } catch (jsonError) {
          console.error("Error decoding/parsing orbitproxy data:", jsonError);
        }
      }
    } catch (error) {
      console.error("Error processing orbitproxy URL:", error);
    }
  }
  if (url.includes("/m3u8-proxy?url=")) {
    return updateM3U8ProxyUrl(url);
  }
  return url;
}
const getHost = () => {
  const urlObj = new URL(window.location.href);
  return `${urlObj.protocol}//${urlObj.host}`;
};
async function comboScraper$9(ctx) {
  const embedPage = await ctx.proxiedFetcher(
    `https://vidsrc.su/embed/${ctx.media.type === "movie" ? `movie/${ctx.media.tmdbId}` : `tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`,
    {
      headers: {
        Referer: getHost()
      }
    }
  );
  console.log("host", getHost());
  ctx.progress(30);
  const decodedPeterMatch = embedPage.match(/decodeURIComponent\('([^']+)'\)/);
  const decodedPeterUrl = decodedPeterMatch ? decodeURIComponent(decodedPeterMatch[1]) : null;
  const serverMatches = [...embedPage.matchAll(/label: 'Server (\d+)', url: '(https.*)'/g)];
  const servers = serverMatches.map((match) => ({
    serverNumber: parseInt(match[1], 10),
    url: match[2]
  }));
  if (decodedPeterUrl) {
    servers.push({
      serverNumber: 40,
      url: decodedPeterUrl
    });
  }
  ctx.progress(60);
  if (!servers.length) throw new NotFoundError("No server playlist found");
  const processedServers = servers.map((server) => ({
    ...server,
    url: processProxiedURL(server.url)
  }));
  const embeds = processedServers.map((server) => ({
    embedId: `server-${server.serverNumber}`,
    url: server.url
  }));
  ctx.progress(90);
  return {
    embeds
  };
}
const vidsrcsuScraper = makeSourcerer({
  id: "vidsrcsu",
  name: "vidsrc.su",
  rank: 140,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$9,
  scrapeShow: comboScraper$9
});
const baseUrl$5 = "https://player.videasy.net";
async function scrapeMovie(ctx) {
  const movieId = ctx.media.tmdbId;
  ctx.progress(30);
  const embedUrl = `${baseUrl$5}/movie/${movieId}`;
  ctx.progress(90);
  return {
    embeds: [
      {
        embedId: "videasy-embed",
        url: embedUrl
      }
    ]
  };
}
async function scrapeShow(ctx) {
  const showId = ctx.media.tmdbId;
  const season = ctx.media.season.number;
  const episode = ctx.media.episode.number;
  ctx.progress(30);
  const embedUrl = `${baseUrl$5}/tv/${showId}/${season}/${episode}`;
  ctx.progress(90);
  return {
    embeds: [
      {
        embedId: "videasy-embed",
        url: embedUrl
      }
    ]
  };
}
const videasyScraper = makeSourcerer({
  id: "videasy",
  name: "VIDEASY",
  rank: 150,
  disabled: false,
  flags: [],
  scrapeMovie,
  scrapeShow
});
const providers$3 = [
  {
    id: "autoembed-english",
    rank: 10
  },
  {
    id: "autoembed-hindi",
    rank: 9,
    disabled: true
  },
  {
    id: "autoembed-tamil",
    rank: 8,
    disabled: true
  },
  {
    id: "autoembed-telugu",
    rank: 7,
    disabled: true
  },
  {
    id: "autoembed-bengali",
    rank: 6,
    disabled: true
  }
];
function embed$3(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    disabled: provider.disabled,
    rank: provider.rank,
    async scrape(ctx) {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: ctx.url,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [
  autoembedEnglishScraper,
  autoembedHindiScraper,
  autoembedBengaliScraper,
  autoembedTamilScraper,
  autoembedTeluguScraper
] = providers$3.map(embed$3);
const referer$1 = "https://ridomovies.tv/";
const closeLoadScraper = makeEmbed({
  id: "closeload",
  name: "CloseLoad",
  rank: 106,
  async scrape(ctx) {
    var _a;
    const baseUrl3 = new URL(ctx.url).origin;
    const iframeRes = await ctx.proxiedFetcher(ctx.url, {
      headers: { referer: referer$1 }
    });
    const iframeRes$ = load(iframeRes);
    const captions = iframeRes$("track").map((_, el) => {
      const track = iframeRes$(el);
      const url2 = `${baseUrl3}${track.attr("src")}`;
      const label = track.attr("label") ?? "";
      const language = labelToLanguageCode(label);
      const captionType = getCaptionTypeFromUrl(url2);
      if (!language || !captionType) return null;
      return {
        id: url2,
        language,
        hasCorsRestrictions: true,
        type: captionType,
        url: url2
      };
    }).get().filter((x) => x !== null);
    const evalCode = iframeRes$("script").filter((_, el) => {
      var _a2;
      const script = iframeRes$(el);
      return (script.attr("type") === "text/javascript" && ((_a2 = script.html()) == null ? void 0 : _a2.includes("p,a,c,k,e,d"))) ?? false;
    }).html();
    if (!evalCode) throw new Error("Couldn't find eval code");
    const decoded = unpack(evalCode);
    const regexPattern = /var\s+(\w+)\s*=\s*"([^"]+)";/g;
    const base64EncodedUrl = (_a = regexPattern.exec(decoded)) == null ? void 0 : _a[2];
    if (!base64EncodedUrl) throw new NotFoundError("Unable to find source url");
    const url = atob(base64EncodedUrl);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions,
          flags: [flags.IP_LOCKED],
          headers: {
            Referer: "https://closeload.top/",
            Origin: "https://closeload.top"
          }
        }
      ]
    };
  }
});
const providers$2 = [
  {
    id: "mp4hydra-1",
    name: "Server 1",
    rank: 36
  },
  {
    id: "mp4hydra-2",
    name: "Server 2",
    rank: 35,
    disabled: true
  }
];
function embed$2(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    disabled: provider.disabled,
    rank: provider.rank,
    async scrape(ctx) {
      const [url, quality] = ctx.url.split("|");
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            qualities: {
              [getValidQualityFromString(quality || "")]: { url, type: "mp4" }
            },
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [mp4hydraServer1Scraper, mp4hydraServer2Scraper] = providers$2.map(embed$2);
const referer = "https://ridomovies.tv/";
const ridooScraper = makeEmbed({
  id: "ridoo",
  name: "Ridoo",
  rank: 105,
  async scrape(ctx) {
    var _a;
    const res = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer
      }
    });
    const regexPattern = /file:"([^"]+)"/g;
    const url = (_a = regexPattern.exec(res)) == null ? void 0 : _a[1];
    if (!url) throw new NotFoundError("Unable to find source url");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions: [],
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const providers$1 = [
  {
    id: "streamtape",
    name: "Streamtape",
    rank: 160
  },
  {
    id: "streamtape-latino",
    name: "Streamtape (Latino)",
    rank: 159
  }
];
function embed$1(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    async scrape(ctx) {
      var _a;
      const response = await fetch(ctx.url, {
        headers: {
          Accept: "text/html"
        }
      });
      const embedHtml = await response.text();
      const match = embedHtml.match(/robotlink'\).innerHTML = (.*)'/);
      if (!match) throw new Error("No match found");
      const [fh, sh] = ((_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.split("+ ('")) ?? [];
      if (!fh || !sh) throw new Error("No match found");
      const url = `https:${fh == null ? void 0 : fh.replace(/'/g, "").trim()}${sh == null ? void 0 : sh.substring(3).trim()}`;
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
            captions: [],
            qualities: {
              unknown: {
                type: "mp4",
                url
              }
            },
            headers: {
              Referer: "https://streamtape.com"
            }
          }
        ]
      };
    }
  });
}
const [streamtapeScraper, streamtapeLatinoScraper] = providers$1.map(embed$1);
const packedRegex = /(eval\(function\(p,a,c,k,e,d\).*\)\)\))/;
const linkRegex = /src:"(https:\/\/[^"]+)"/;
const streamvidScraper = makeEmbed({
  id: "streamvid",
  name: "Streamvid",
  rank: 215,
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex);
    if (!packed) throw new Error("streamvid packed not found");
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex);
    if (!link) throw new Error("streamvid link not found");
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist: link[1],
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const vidCloudScraper = makeEmbed({
  id: "vidcloud",
  name: "VidCloud",
  rank: 201,
  disabled: true,
  async scrape(ctx) {
    const result = await upcloudScraper.scrape(ctx);
    return {
      stream: result.stream.map((s) => ({
        ...s,
        flags: []
      }))
    };
  }
});
const providers = [
  {
    id: "server-13",
    rank: 112
  },
  {
    id: "server-18",
    rank: 111
  },
  {
    id: "server-11",
    rank: 102
  },
  {
    id: "server-7",
    rank: 92
  },
  {
    id: "server-10",
    rank: 82
  },
  {
    id: "server-1",
    rank: 72
  },
  {
    id: "server-16",
    rank: 64
  },
  {
    id: "server-3",
    rank: 62
  },
  {
    id: "server-17",
    rank: 52
  },
  {
    id: "server-2",
    rank: 42
  },
  {
    id: "server-4",
    rank: 32
  },
  {
    id: "server-5",
    rank: 24
  },
  {
    id: "server-14",
    // catflix? uwu.m3u8
    rank: 22
  },
  {
    id: "server-6",
    rank: 21
  },
  {
    id: "server-15",
    rank: 20
  },
  {
    id: "server-8",
    rank: 19
  },
  {
    id: "server-9",
    rank: 18
  },
  {
    id: "server-19",
    rank: 17
  },
  {
    id: "server-12",
    rank: 16
  }
  // { // Looks like this was removed
  //   id: 'server-20',
  //   rank: 1,
  //   name: 'Cineby',
  // },
];
function embed(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name || provider.id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    disabled: provider.disabled,
    rank: provider.rank,
    async scrape(ctx) {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: ctx.url,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [
  VidsrcsuServer1Scraper,
  VidsrcsuServer2Scraper,
  VidsrcsuServer3Scraper,
  VidsrcsuServer4Scraper,
  VidsrcsuServer5Scraper,
  VidsrcsuServer6Scraper,
  VidsrcsuServer7Scraper,
  VidsrcsuServer8Scraper,
  VidsrcsuServer9Scraper,
  VidsrcsuServer10Scraper,
  VidsrcsuServer11Scraper,
  VidsrcsuServer12Scraper,
  VidsrcsuServer20Scraper
] = providers.map(embed);
async function getVideowlUrlStream(ctx, decryptedId) {
  var _a;
  const sharePage = await ctx.proxiedFetcher("https://cloud.mail.ru/public/uaRH/2PYWcJRpH");
  const regex = /"videowl_view":\{"count":"(\d+)","url":"([^"]+)"\}/g;
  const videowlUrl = (_a = regex.exec(sharePage)) == null ? void 0 : _a[2];
  if (!videowlUrl) throw new NotFoundError("Failed to get videoOwlUrl");
  return `${videowlUrl}/0p/${btoa(decryptedId)}.m3u8?${new URLSearchParams({
    double_encode: "1"
  })}`;
}
const warezcdnembedHlsScraper = makeEmbed({
  id: "warezcdnembedhls",
  // WarezCDN is both a source and an embed host
  name: "WarezCDN HLS",
  // method no longer works
  disabled: true,
  rank: 83,
  async scrape(ctx) {
    const decryptedId = await getDecryptedId(ctx);
    if (!decryptedId) throw new NotFoundError("can't get file id");
    const streamUrl = await getVideowlUrlStream(ctx, decryptedId);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          flags: [flags.IP_LOCKED],
          captions: [],
          playlist: streamUrl
        }
      ]
    };
  }
});
const warezPlayerScraper = makeEmbed({
  id: "warezplayer",
  name: "warezPLAYER",
  disabled: true,
  rank: 85,
  async scrape(ctx) {
    const playerPageUrl = new URL(ctx.url);
    const hash = playerPageUrl.pathname.split("/")[2];
    const playerApiRes = await ctx.proxiedFetcher("/player/index.php", {
      baseUrl: playerPageUrl.origin,
      query: {
        data: hash,
        do: "getVideo"
      },
      method: "POST",
      body: new URLSearchParams({
        hash
      }),
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const sources = JSON.parse(playerApiRes);
    if (!sources.videoSource) throw new Error("Playlist not found");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          flags: [],
          captions: [],
          playlist: sources.videoSource,
          headers: {
            // without this it returns "security error"
            Accept: "*/*"
          }
        }
      ]
    };
  }
});
async function getStream$2(ctx, id) {
  var _a, _b;
  try {
    const baseUrl3 = "https://ftmoh345xme.com";
    const headers = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1"
    };
    const url = `${baseUrl3}/play/${id}`;
    const result = await ctx.proxiedFetcher(url, {
      headers: {
        ...headers
      },
      method: "GET"
    });
    const $ = cheerio.load(result);
    const script = $("script").last().html();
    if (!script) {
      throw new NotFoundError("Failed to extract script data");
    }
    const content = ((_a = script.match(/(\{[^;]+});/)) == null ? void 0 : _a[1]) || ((_b = script.match(/\((\{.*\})\)/)) == null ? void 0 : _b[1]);
    if (!content) {
      throw new NotFoundError("Media not found");
    }
    const data = JSON.parse(content);
    let file = data.file;
    if (!file) {
      throw new NotFoundError("File not found");
    }
    if (file.startsWith("/")) {
      file = baseUrl3 + file;
    }
    const key = data.key;
    const headers2 = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1",
      "X-Csrf-Token": key
    };
    const PlayListRes = await ctx.proxiedFetcher(file, {
      headers: {
        ...headers2
      },
      method: "GET"
    });
    const playlist = PlayListRes;
    return {
      success: true,
      data: {
        playlist,
        key
      }
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch media info");
  }
}
async function getStream$1(ctx, file, key) {
  const f = file;
  const path = `${f.slice(1)}.txt`;
  try {
    const baseUrl3 = "https://ftmoh345xme.com";
    const headers = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1",
      "X-Csrf-Token": key
    };
    const url = `${baseUrl3}/playlist/${path}`;
    const result = await ctx.proxiedFetcher(url, {
      headers: {
        ...headers
      },
      method: "GET"
    });
    return {
      success: true,
      data: {
        link: result
      }
    };
  } catch (error) {
    throw new NotFoundError("Failed to fetch stream data");
  }
}
async function getMovie(ctx, id, lang = "English") {
  var _a, _b;
  try {
    const mediaInfo = await getStream$2(ctx, id);
    if (mediaInfo == null ? void 0 : mediaInfo.success) {
      const playlist = (_a = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _a.playlist;
      if (!playlist || !Array.isArray(playlist)) {
        throw new NotFoundError("Playlist not found or invalid");
      }
      let file = playlist.find((item) => (item == null ? void 0 : item.title) === lang);
      if (!file) {
        file = playlist == null ? void 0 : playlist[0];
      }
      if (!file) {
        throw new NotFoundError("No file found");
      }
      const availableLang = playlist.map((item) => item == null ? void 0 : item.title);
      const key = (_b = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _b.key;
      ctx.progress(70);
      const streamUrl = await getStream$1(ctx, file == null ? void 0 : file.file, key);
      if (streamUrl == null ? void 0 : streamUrl.success) {
        return { success: true, data: streamUrl == null ? void 0 : streamUrl.data, availableLang };
      }
      throw new NotFoundError("No stream url found");
    }
    throw new NotFoundError("No media info found");
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch movie data");
  }
}
async function getTV(ctx, id, season, episode, lang) {
  var _a, _b, _c;
  try {
    const mediaInfo = await getStream$2(ctx, id);
    if (!(mediaInfo == null ? void 0 : mediaInfo.success)) {
      throw new NotFoundError("No media info found");
    }
    const playlist = (_a = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _a.playlist;
    const getSeason = playlist.find((item) => (item == null ? void 0 : item.id) === season.toString());
    if (!getSeason) {
      throw new NotFoundError("No season found");
    }
    const getEpisode = getSeason == null ? void 0 : getSeason.folder.find((item) => (item == null ? void 0 : item.episode) === episode.toString());
    if (!getEpisode) {
      throw new NotFoundError("No episode found");
    }
    let file = getEpisode == null ? void 0 : getEpisode.folder.find((item) => (item == null ? void 0 : item.title) === lang);
    if (!file) {
      file = (_b = getEpisode == null ? void 0 : getEpisode.folder) == null ? void 0 : _b[0];
    }
    if (!file) {
      throw new NotFoundError("No file found");
    }
    const availableLang = getEpisode == null ? void 0 : getEpisode.folder.map((item) => {
      return item == null ? void 0 : item.title;
    });
    const filterLang = availableLang.filter((item) => (item == null ? void 0 : item.length) > 0);
    const key = (_c = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _c.key;
    ctx.progress(70);
    const streamUrl = await getStream$1(ctx, file == null ? void 0 : file.file, key);
    if (streamUrl == null ? void 0 : streamUrl.success) {
      return {
        success: true,
        data: streamUrl == null ? void 0 : streamUrl.data,
        availableLang: filterLang
      };
    }
    throw new NotFoundError("No stream url found");
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch TV data");
  }
}
async function comboScraper$8(ctx) {
  ({
    title: ctx.media.title,
    releaseYear: ctx.media.releaseYear,
    tmdbId: ctx.media.tmdbId,
    imdbId: ctx.media.imdbId,
    type: ctx.media.type,
    season: "",
    episode: ""
  });
  if (ctx.media.type === "show") {
    ctx.media.season.number.toString();
    ctx.media.episode.number.toString();
  }
  if (ctx.media.type === "movie") {
    ctx.progress(40);
    const res = await getMovie(ctx, ctx.media.imdbId);
    if (res == null ? void 0 : res.success) {
      ctx.progress(90);
      return {
        embeds: [],
        stream: [
          {
            id: "primary",
            captions: [],
            playlist: res.data.link,
            type: "hls",
            flags: [flags.CORS_ALLOWED]
          }
        ]
      };
    }
    throw new NotFoundError("No providers available");
  }
  if (ctx.media.type === "show") {
    ctx.progress(40);
    const lang = "English";
    const res = await getTV(ctx, ctx.media.imdbId, ctx.media.season.number, ctx.media.episode.number, lang);
    if (res == null ? void 0 : res.success) {
      ctx.progress(90);
      return {
        embeds: [],
        stream: [
          {
            id: "primary",
            captions: [],
            playlist: res.data.link,
            type: "hls",
            flags: [flags.CORS_ALLOWED]
          }
        ]
      };
    }
    throw new NotFoundError("No providers available");
  }
  throw new NotFoundError("No providers available");
}
const EightStreamScraper = makeSourcerer({
  id: "8stream",
  name: "8stream",
  rank: 111,
  flags: [],
  disabled: false,
  scrapeMovie: comboScraper$8,
  scrapeShow: comboScraper$8
});
const apiBase = "https://ws-m3u8.moonpic.qzz.io:3006";
async function searchAnimeFlvAPI(title) {
  const res = await fetch(`${apiBase}/search?title=${encodeURIComponent(title)}`);
  if (!res.ok) throw new NotFoundError("Anime not found in API");
  const data = await res.json();
  if (!data.url) throw new NotFoundError("Anime not found in API");
  return data.url;
}
async function getEpisodesAPI(animeUrl) {
  const res = await fetch(`${apiBase}/episodes?url=${encodeURIComponent(animeUrl)}`);
  if (!res.ok) throw new NotFoundError("Episodes not found in API");
  const data = await res.json();
  if (!data.episodes) throw new NotFoundError("Episodes not found in API");
  return data.episodes;
}
async function getEmbedsAPI(episodeUrl) {
  const res = await fetch(`${apiBase}/embeds?episodeUrl=${encodeURIComponent(episodeUrl)}`);
  if (!res.ok) throw new NotFoundError("No embed found for this content");
  const data = await res.json();
  return data;
}
async function comboScraper$7(ctx) {
  var _a;
  const title = ctx.media.title;
  if (!title) throw new NotFoundError("Missing title");
  const animeUrl = await searchAnimeFlvAPI(title);
  const episodes = await getEpisodesAPI(animeUrl);
  let episodeUrl = animeUrl;
  if (ctx.media.type === "show") {
    const episode = (_a = ctx.media.episode) == null ? void 0 : _a.number;
    if (!episode) throw new NotFoundError("Missing episode data");
    const ep = episodes.find((e) => e.number === episode);
    if (!ep) throw new NotFoundError("Episode not found");
    episodeUrl = ep.url;
  } else if (ctx.media.type === "movie") {
    const ep = episodes.find((e) => e.number === 1) || episodes[0];
    if (!ep) throw new NotFoundError("Movie episode not found");
    episodeUrl = ep.url;
  }
  const embedsData = await getEmbedsAPI(episodeUrl);
  const embeds = [];
  if (embedsData["streamwish-japanese"]) {
    embeds.push({
      embedId: "streamwish-japanese",
      url: embedsData["streamwish-japanese"]
    });
  }
  if (embedsData["streamtape-latino"]) {
    embeds.push({
      embedId: "streamtape-latino",
      url: embedsData["streamtape-latino"]
    });
  }
  if (embeds.length === 0) throw new NotFoundError("No valid embed found for this content");
  return { embeds };
}
const animeflvScraper = makeSourcerer({
  id: "animeflv",
  name: "AnimeFLV",
  rank: 90,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeShow: comboScraper$7,
  scrapeMovie: comboScraper$7
});
const CINEMAOS_SERVERS = [
  //   'flowcast',
  "shadow",
  "asiacloud",
  //   'hindicast',
  //   'anime',
  //   'animez',
  //   'guard',
  //   'hq',
  //   'ninja',
  //   'alpha',
  //   'kaze',
  //   'zenith',
  //   'cast',
  //   'ghost',
  //   'halo',
  //   'kinoecho',
  //   'ee3',
  //   'volt',
  //   'putafilme',
  "ophim"
  //   'kage',
];
async function comboScraper$6(ctx) {
  const embeds = [];
  const query = {
    type: ctx.media.type,
    tmdbId: ctx.media.tmdbId
  };
  if (ctx.media.type === "show") {
    query.season = ctx.media.season.number;
    query.episode = ctx.media.episode.number;
  }
  for (const server of CINEMAOS_SERVERS) {
    embeds.push({
      embedId: `cinemaos-${server}`,
      url: JSON.stringify({ ...query, service: server })
    });
  }
  ctx.progress(50);
  return { embeds };
}
const cinemaosScraper = makeSourcerer({
  id: "cinemaos",
  name: "CinemaOS",
  rank: 150,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$6,
  scrapeShow: comboScraper$6
});
const baseUrl$4 = "https://api.coitus.ca";
async function comboScraper$5(ctx) {
  const apiUrl2 = ctx.media.type === "movie" ? `${baseUrl$4}/movie/${ctx.media.tmdbId}` : `${baseUrl$4}/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2);
  if (!apiRes.videoSource) throw new NotFoundError("No watchable item found");
  let processedUrl = apiRes.videoSource;
  if (processedUrl.includes("orbitproxy")) {
    try {
      const urlParts = processedUrl.split(/orbitproxy\.[^/]+\//);
      if (urlParts.length >= 2) {
        const encryptedPart = urlParts[1].split(".m3u8")[0];
        try {
          const decodedData = Buffer.from(encryptedPart, "base64").toString("utf-8");
          const jsonData = JSON.parse(decodedData);
          const originalUrl = jsonData.u;
          const referer2 = jsonData.r || "";
          const headers = { referer: referer2 };
          processedUrl = createM3U8ProxyUrl(originalUrl, headers);
        } catch (jsonError) {
          console.error("Error decoding/parsing orbitproxy data:", jsonError);
        }
      }
    } catch (error) {
      console.error("Error processing orbitproxy URL:", error);
    }
  }
  console.log(apiRes);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions: [],
        playlist: processedUrl,
        type: "hls",
        flags: [flags.CORS_ALLOWED]
      }
    ]
  };
}
const coitusScraper = makeSourcerer({
  id: "coitus",
  name: "Autoembed+",
  rank: 91,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$5,
  scrapeShow: comboScraper$5
});
async function comboScraper$4(ctx) {
  var _a, _b;
  const { tmdbId, type } = ctx.media;
  if (!tmdbId) {
    throw new NotFoundError("TMDB ID is required");
  }
  const baseUrl3 = `https://ws-m3u8.moonpic.qzz.io:3008/tmdb`;
  let url = "";
  if (type === "movie") {
    url = `${baseUrl3}/movie/${tmdbId}`;
  } else if (type === "show") {
    const showMedia = ctx.media;
    if (((_a = showMedia.season) == null ? void 0 : _a.number) != null && ((_b = showMedia.episode) == null ? void 0 : _b.number) != null) {
      url = `${baseUrl3}/tv/${tmdbId}/season/${showMedia.season.number}/episode/${showMedia.episode.number}`;
    } else {
      throw new NotFoundError("Missing parameters for TV episode");
    }
  } else {
    throw new NotFoundError("Missing parameters for TV episode");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new NotFoundError(`Failed to fetch data from local server: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.embeds || !Array.isArray(data.embeds) || data.embeds.length === 0) {
    throw new NotFoundError("No valid streams found");
  }
  return { embeds: data.embeds };
}
const cuevana3Scraper = makeSourcerer({
  id: "cuevana3",
  name: "Cuevana3",
  rank: 80,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$4,
  scrapeShow: comboScraper$4
});
function generateRandomFavs() {
  const randomHex = () => Math.floor(Math.random() * 16).toString(16);
  const generateSegment = (length) => Array.from({ length }, randomHex).join("");
  return `${generateSegment(8)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(
    12
  )}`;
}
function parseSubtitleLinks(inputString) {
  if (!inputString || typeof inputString === "boolean") return [];
  const linksArray = inputString.split(",");
  const captions = [];
  linksArray.forEach((link) => {
    const match = link.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/);
    if (match) {
      const type = getCaptionTypeFromUrl(match[2]);
      const language = labelToLanguageCode(match[1]);
      if (!type || !language) return;
      captions.push({
        id: match[2],
        language,
        hasCorsRestrictions: false,
        type,
        url: match[2]
      });
    }
  });
  return captions;
}
function parseVideoLinks(inputString) {
  if (!inputString) throw new NotFoundError("No video links found");
  try {
    const qualityMap = {};
    const links = inputString.split(",");
    links.forEach((link) => {
      const match = link.match(/\[([^\]]+)\](https?:\/\/[^\s,]+)/);
      if (match) {
        const [_, quality, url] = match;
        if (url === "null") return;
        const normalizedQuality = quality.replace(/<[^>]+>/g, "").toLowerCase().replace("p", "").trim();
        qualityMap[normalizedQuality] = {
          type: "mp4",
          url: url.trim()
        };
      }
    });
    const result = {};
    Object.entries(qualityMap).forEach(([quality, data]) => {
      const validQuality = getValidQualityFromString(quality);
      result[validQuality] = data;
    });
    return result;
  } catch (error) {
    console.error("Error parsing video links:", error);
    throw new NotFoundError("Failed to parse video links");
  }
}
const rezkaBase = "https://hdrezka.ag/";
const baseHeaders = {
  "X-Hdrezka-Android-App": "1",
  "X-Hdrezka-Android-App-Version": "2.2.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "CF-IPCountry": "RU"
};
async function searchAndFindMediaId(ctx) {
  const searchData = await ctx.proxiedFetcher(`/engine/ajax/search.php`, {
    baseUrl: rezkaBase,
    headers: baseHeaders,
    query: { q: ctx.media.title }
  });
  const $ = load(searchData);
  const items = $("a").map((_, el) => {
    var _a;
    const $el = $(el);
    const url = $el.attr("href");
    const titleText = $el.find("span.enty").text();
    const yearMatch = titleText.match(/\((\d{4})\)/) || (url == null ? void 0 : url.match(/-(\d{4})(?:-|\.html)/)) || titleText.match(/(\d{4})/);
    const itemYear = yearMatch ? yearMatch[1] : null;
    const id = (_a = url == null ? void 0 : url.match(/\/(\d+)-[^/]+\.html$/)) == null ? void 0 : _a[1];
    if (id) {
      return {
        id,
        year: itemYear ? parseInt(itemYear, 10) : ctx.media.releaseYear,
        type: ctx.media.type,
        url: url || ""
      };
    }
    return null;
  }).get().filter(Boolean);
  items.sort((a, b) => {
    const diffA = Math.abs(a.year - ctx.media.releaseYear);
    const diffB = Math.abs(b.year - ctx.media.releaseYear);
    return diffA - diffB;
  });
  return items[0] || null;
}
async function getStream(id, translatorId, ctx) {
  const searchParams = new URLSearchParams();
  searchParams.append("id", id);
  searchParams.append("translator_id", translatorId);
  if (ctx.media.type === "show") {
    searchParams.append("season", ctx.media.season.number.toString());
    searchParams.append("episode", ctx.media.episode.number.toString());
  }
  searchParams.append("favs", generateRandomFavs());
  searchParams.append("action", ctx.media.type === "show" ? "get_stream" : "get_movie");
  searchParams.append("t", Date.now().toString());
  const response = await ctx.proxiedFetcher("/ajax/get_cdn_series/", {
    baseUrl: rezkaBase,
    method: "POST",
    body: searchParams,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${rezkaBase}films/action/${id}-novokain-2025-latest.html`
    }
  });
  try {
    const data = JSON.parse(response);
    if (!data.url && data.success) {
      throw new NotFoundError("Movie found but no stream available (might be premium or not yet released)");
    }
    if (!data.url) {
      throw new NotFoundError("No stream URL found in response");
    }
    return data;
  } catch (error) {
    console.error("Error parsing stream response:", error);
    throw new NotFoundError("Failed to parse stream response");
  }
}
async function getTranslatorId(url, id, ctx) {
  const response = await ctx.proxiedFetcher(url, {
    headers: baseHeaders
  });
  if (response.includes(`data-translator_id="238"`)) {
    return "238";
  }
  const functionName = ctx.media.type === "movie" ? "initCDNMoviesEvents" : "initCDNSeriesEvents";
  const regexPattern = new RegExp(`sof\\.tv\\.${functionName}\\(${id}, ([^,]+)`, "i");
  const match = response.match(regexPattern);
  const translatorId = match ? match[1] : null;
  return translatorId;
}
const universalScraper$3 = async (ctx) => {
  const result = await searchAndFindMediaId(ctx);
  if (!result || !result.id) throw new NotFoundError("No result found");
  const translatorId = await getTranslatorId(result.url, result.id, ctx);
  if (!translatorId) throw new NotFoundError("No translator id found");
  const { url: streamUrl, subtitle: streamSubtitle } = await getStream(result.id, translatorId, ctx);
  const parsedVideos = parseVideoLinks(streamUrl);
  const parsedSubtitles = parseSubtitleLinks(streamSubtitle);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
        captions: parsedSubtitles,
        qualities: parsedVideos
      }
    ]
  };
};
const hdRezkaScraper = makeSourcerer({
  id: "hdrezka",
  name: "HDRezka",
  rank: 100,
  flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
  scrapeShow: universalScraper$3,
  scrapeMovie: universalScraper$3
});
const baseUrl$3 = "https://iosmirror.cc";
const baseUrl2$1 = "https://vercel-sucks.up.railway.app/iosmirror.cc:443";
const universalScraper$2 = async (ctx) => {
  var _a, _b, _c, _d, _e;
  const hash = decodeURIComponent(await ctx.fetcher("https://iosmirror-hash.pstream.org/"));
  if (!hash) throw new NotFoundError("No hash found");
  ctx.progress(10);
  const searchRes = await ctx.proxiedFetcher("/search.php", {
    baseUrl: baseUrl2$1,
    query: { s: ctx.media.title },
    headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
  });
  if (searchRes.status !== "y" || !searchRes.searchResult) throw new NotFoundError(searchRes.error);
  async function getMeta(id2) {
    return ctx.proxiedFetcher("/post.php", {
      baseUrl: baseUrl2$1,
      query: { id: id2 },
      headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
    });
  }
  ctx.progress(30);
  let metaRes;
  let id = (_a = searchRes.searchResult.find(async (x) => {
    metaRes = await getMeta(x.id);
    return compareTitle(x.t, ctx.media.title) && (Number(metaRes.year) === ctx.media.releaseYear || metaRes.type === (ctx.media.type === "movie" ? "m" : "t"));
  })) == null ? void 0 : _a.id;
  if (!id) throw new NotFoundError("No watchable item found");
  if (ctx.media.type === "show") {
    metaRes = await getMeta(id);
    const showMedia = ctx.media;
    const seasonId = (_b = metaRes == null ? void 0 : metaRes.season.find((x) => Number(x.s) === showMedia.season.number)) == null ? void 0 : _b.id;
    if (!seasonId) throw new NotFoundError("Season not available");
    const episodeRes = await ctx.proxiedFetcher("/episodes.php", {
      baseUrl: baseUrl2$1,
      query: { s: seasonId, series: id },
      headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
    });
    let episodes = [...episodeRes.episodes];
    let currentPage = 2;
    while (episodeRes.nextPageShow === 1) {
      const nextPageRes = await ctx.proxiedFetcher("/episodes.php", {
        baseUrl: baseUrl2$1,
        query: { s: seasonId, series: id, page: currentPage.toString() },
        headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
      });
      episodes = [...episodes, ...nextPageRes.episodes];
      episodeRes.nextPageShow = nextPageRes.nextPageShow;
      currentPage++;
    }
    const episodeId = (_c = episodes.find(
      (x) => x.ep === `E${showMedia.episode.number}` && x.s === `S${showMedia.season.number}`
    )) == null ? void 0 : _c.id;
    if (!episodeId) throw new NotFoundError("Episode not available");
    id = episodeId;
  }
  const playlistRes = await ctx.proxiedFetcher("/playlist.php?", {
    baseUrl: baseUrl2$1,
    query: { id },
    headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
  });
  ctx.progress(50);
  let autoFile = (_d = playlistRes[0].sources.find((source) => source.label === "Auto")) == null ? void 0 : _d.file;
  if (!autoFile) {
    autoFile = (_e = playlistRes[0].sources.find((source) => source.label === "Full HD")) == null ? void 0 : _e.file;
  }
  if (!autoFile) {
    console.log('"Full HD" or "Auto" file not found, falling back to first source');
    autoFile = playlistRes[0].sources[0].file;
  }
  if (!autoFile) throw new Error("Failed to fetch playlist");
  const headers = {
    referer: baseUrl$3,
    cookie: makeCookieHeader({ hd: "on" })
  };
  const playlist = createM3U8ProxyUrl(`${baseUrl$3}${autoFile}`, headers);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
};
const iosmirrorScraper = makeSourcerer({
  id: "iosmirror",
  name: "NetMirror",
  rank: 182,
  // disabled: !!isIos,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$2,
  scrapeShow: universalScraper$2
});
const baseUrl$2 = "https://iosmirror.cc";
const baseUrl2 = "https://vercel-sucks.up.railway.app/iosmirror.cc:443/pv";
const universalScraper$1 = async (ctx) => {
  var _a, _b, _c, _d, _e;
  const hash = decodeURIComponent(await ctx.fetcher("https://iosmirror-hash.pstream.org/"));
  if (!hash) throw new NotFoundError("No hash found");
  ctx.progress(10);
  const searchRes = await ctx.proxiedFetcher("/search.php", {
    baseUrl: baseUrl2,
    query: { s: ctx.media.title },
    headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
  });
  if (!searchRes.searchResult) throw new NotFoundError(searchRes.error);
  async function getMeta(id2) {
    return ctx.proxiedFetcher("/post.php", {
      baseUrl: baseUrl2,
      query: { id: id2 },
      headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
    });
  }
  ctx.progress(30);
  let id = (_a = searchRes.searchResult.find(async (x) => {
    const metaRes = await getMeta(x.id);
    return compareTitle(x.t, ctx.media.title) && (Number(x.y) === ctx.media.releaseYear || metaRes.type === (ctx.media.type === "movie" ? "m" : "t"));
  })) == null ? void 0 : _a.id;
  if (!id) throw new NotFoundError("No watchable item found");
  if (ctx.media.type === "show") {
    const metaRes = await getMeta(id);
    const showMedia = ctx.media;
    const seasonId = (_b = metaRes == null ? void 0 : metaRes.season.find((x) => Number(x.s) === showMedia.season.number)) == null ? void 0 : _b.id;
    if (!seasonId) throw new NotFoundError("Season not available");
    const episodeRes = await ctx.proxiedFetcher("/episodes.php", {
      baseUrl: baseUrl2,
      query: { s: seasonId, series: id },
      headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
    });
    let episodes = [...episodeRes.episodes];
    let currentPage = 2;
    while (episodeRes.nextPageShow === 1) {
      const nextPageRes = await ctx.proxiedFetcher("/episodes.php", {
        baseUrl: baseUrl2,
        query: { s: seasonId, series: id, page: currentPage.toString() },
        headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
      });
      episodes = [...episodes, ...nextPageRes.episodes];
      episodeRes.nextPageShow = nextPageRes.nextPageShow;
      currentPage++;
    }
    const episodeId = (_c = episodes.find(
      (x) => x.ep === `E${showMedia.episode.number}` && x.s === `S${showMedia.season.number}`
    )) == null ? void 0 : _c.id;
    if (!episodeId) throw new NotFoundError("Episode not available");
    id = episodeId;
  }
  const playlistRes = await ctx.proxiedFetcher("/playlist.php?", {
    baseUrl: baseUrl2,
    query: { id },
    headers: { cookie: makeCookieHeader({ t_hash_t: hash, hd: "on" }) }
  });
  ctx.progress(50);
  let autoFile = (_d = playlistRes[0].sources.find((source) => source.label === "Auto")) == null ? void 0 : _d.file;
  if (!autoFile) {
    autoFile = (_e = playlistRes[0].sources.find((source) => source.label === "Full HD")) == null ? void 0 : _e.file;
  }
  if (!autoFile) {
    console.log('"Full HD" or "Auto" file not found, falling back to first source');
    autoFile = playlistRes[0].sources[0].file;
  }
  if (!autoFile) throw new Error("Failed to fetch playlist");
  const headers = {
    referer: baseUrl$2,
    cookie: makeCookieHeader({ hd: "on" })
  };
  const playlist = createM3U8ProxyUrl(`${baseUrl$2}${autoFile}`, headers);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
};
const iosmirrorPVScraper = makeSourcerer({
  id: "iosmirrorpv",
  name: "PrimeMirror",
  rank: 183,
  // disabled: !!isIos,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$1,
  scrapeShow: universalScraper$1
});
const mamaApiBase = "https://mama.up.railway.app/api/showbox";
const getUserToken = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem("febbox_ui_token") : null;
  } catch (e) {
    console.warn("Unable to access localStorage:", e);
    return null;
  }
};
async function comboScraper$3(ctx) {
  const userToken = getUserToken();
  const apiUrl2 = ctx.media.type === "movie" ? `${mamaApiBase}/movie/${ctx.media.tmdbId}?token=${userToken}` : `${mamaApiBase}/tv/${ctx.media.tmdbId}?season=${ctx.media.season.number}&episode=${ctx.media.episode.number}&token=${userToken}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2);
  if (!apiRes) {
    throw new NotFoundError("No response from API");
  }
  const data = await apiRes;
  if (!data.success) {
    throw new NotFoundError("No streams found");
  }
  const streamItems = Array.isArray(data.streams) ? data.streams : [data.streams];
  if (streamItems.length === 0 || !streamItems[0].player_streams) {
    throw new NotFoundError("No valid streams found");
  }
  let bestStreamItem = streamItems[0];
  for (const item of streamItems) {
    if (item.quality.includes("4K") || item.quality.includes("2160p")) {
      bestStreamItem = item;
      break;
    }
  }
  const streams = bestStreamItem.player_streams.reduce((acc, stream) => {
    let qualityKey;
    if (stream.quality === "4K" || stream.quality.includes("4K")) {
      qualityKey = 2160;
    } else if (stream.quality === "ORG" || stream.quality.includes("ORG")) {
      return acc;
    } else {
      qualityKey = parseInt(stream.quality.replace("P", ""), 10);
    }
    if (Number.isNaN(qualityKey) || acc[qualityKey]) return acc;
    acc[qualityKey] = stream.file;
    return acc;
  }, {});
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions: [],
        qualities: {
          ...streams[2160] && {
            "4k": {
              type: "mp4",
              url: streams[2160]
            }
          },
          ...streams[1080] && {
            1080: {
              type: "mp4",
              url: streams[1080]
            }
          },
          ...streams[720] && {
            720: {
              type: "mp4",
              url: streams[720]
            }
          },
          ...streams[480] && {
            480: {
              type: "mp4",
              url: streams[480]
            }
          },
          ...streams[360] && {
            360: {
              type: "mp4",
              url: streams[360]
            }
          }
        },
        type: "file",
        flags: [flags.CORS_ALLOWED]
      }
    ]
  };
}
const nunflixScraper = makeSourcerer({
  id: "nunflix",
  name: "NFlix",
  rank: 155,
  disabled: !getUserToken(),
  // disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$3,
  scrapeShow: comboScraper$3
});
const ridoMoviesBase = `https://ridomovies.tv`;
const ridoMoviesApiBase = `${ridoMoviesBase}/core/api`;
const universalScraper = async (ctx) => {
  const searchResult = await ctx.proxiedFetcher("/search", {
    baseUrl: ridoMoviesApiBase,
    query: {
      q: ctx.media.title
    }
  });
  const mediaData = searchResult.data.items.map((movieEl) => {
    const name = movieEl.title;
    const year = movieEl.contentable.releaseYear;
    const fullSlug = movieEl.fullSlug;
    return { name, year, fullSlug };
  });
  const targetMedia = mediaData.find((m) => m.name === ctx.media.title && m.year === ctx.media.releaseYear.toString());
  if (!(targetMedia == null ? void 0 : targetMedia.fullSlug)) throw new NotFoundError("No watchable item found");
  ctx.progress(40);
  let iframeSourceUrl = `/${targetMedia.fullSlug}/videos`;
  if (ctx.media.type === "show") {
    const showPageResult = await ctx.proxiedFetcher(`/${targetMedia.fullSlug}`, {
      baseUrl: ridoMoviesBase
    });
    const fullEpisodeSlug = `season-${ctx.media.season.number}/episode-${ctx.media.episode.number}`;
    const regexPattern = new RegExp(
      `\\\\"id\\\\":\\\\"(\\d+)\\\\"(?=.*?\\\\\\"fullSlug\\\\\\":\\\\\\"[^"]*${fullEpisodeSlug}[^"]*\\\\\\")`,
      "g"
    );
    const matches = [...showPageResult.matchAll(regexPattern)];
    const episodeIds = matches.map((match) => match[1]);
    if (episodeIds.length === 0) throw new NotFoundError("No watchable item found");
    const episodeId = episodeIds.at(-1);
    iframeSourceUrl = `/episodes/${episodeId}/videos`;
  }
  const iframeSource = await ctx.proxiedFetcher(iframeSourceUrl, {
    baseUrl: ridoMoviesApiBase
  });
  const iframeSource$ = load(iframeSource.data[0].url);
  const iframeUrl = iframeSource$("iframe").attr("data-src");
  if (!iframeUrl) throw new NotFoundError("No watchable item found");
  ctx.progress(60);
  const embeds = [];
  if (iframeUrl.includes("closeload")) {
    embeds.push({
      embedId: closeLoadScraper.id,
      url: iframeUrl
    });
  }
  if (iframeUrl.includes("ridoo")) {
    embeds.push({
      embedId: ridooScraper.id,
      url: iframeUrl
    });
  }
  ctx.progress(90);
  return {
    embeds
  };
};
const ridooMoviesScraper = makeSourcerer({
  id: "ridomovies",
  name: "RidoMovies",
  rank: 200,
  flags: [],
  scrapeMovie: universalScraper
  // scrapeShow: universalScraper,
});
const baseUrl$1 = "https://pupp.slidemovies-dev.workers.dev";
async function comboScraper$2(ctx) {
  const watchPageUrl = ctx.media.type === "movie" ? `${baseUrl$1}/movie/${ctx.media.tmdbId}` : `${baseUrl$1}/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/-${ctx.media.episode.number}`;
  const watchPage = await ctx.proxiedFetcher(watchPageUrl);
  const $ = load(watchPage);
  ctx.progress(50);
  const proxiedStreamUrl = $("media-player").attr("src");
  if (!proxiedStreamUrl) {
    throw new NotFoundError("Stream URL not found");
  }
  const proxyUrl = new URL(proxiedStreamUrl);
  const encodedUrl = proxyUrl.searchParams.get("url") || "";
  const playlist = decodeURIComponent(encodedUrl);
  const isoLanguageMap = {
    ng: "en",
    re: "fr",
    pa: "es"
  };
  const captions = $("media-provider track").map((_, el) => {
    const url = $(el).attr("src") || "";
    const rawLang = $(el).attr("lang") || "unknown";
    const languageCode = isoLanguageMap[rawLang] || rawLang;
    const isVtt = url.endsWith(".vtt") ? "vtt" : "srt";
    return {
      type: isVtt,
      id: url,
      url,
      language: languageCode,
      hasCorsRestrictions: false
    };
  }).get();
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        flags: [],
        playlist,
        captions
      }
    ]
  };
}
const slidemoviesScraper = makeSourcerer({
  id: "slidemovies",
  name: "SlideMovies",
  rank: 135,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$2,
  scrapeShow: comboScraper$2
});
const streamboxBase = "https://vidjoy.pro/embed/api/fastfetch";
async function comboScraper$1(ctx) {
  var _a, _b;
  const apiRes = await ctx.proxiedFetcher(
    ctx.media.type === "movie" ? `${streamboxBase}/${ctx.media.tmdbId}?sr=0` : `${streamboxBase}/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}?sr=0`
  );
  if (!apiRes) {
    throw new NotFoundError("Failed to fetch StreamBox data");
  }
  console.log(apiRes);
  const data = await apiRes;
  const streams = {};
  data.url.forEach((stream) => {
    streams[stream.resulation] = stream.link;
  });
  const captions = data.tracks.map((track) => ({
    id: track.lang,
    url: track.url,
    language: track.code,
    type: "srt"
  }));
  if (data.provider === "MovieBox") {
    return {
      embeds: [],
      stream: [
        {
          id: "primary",
          captions,
          qualities: {
            ...streams["1080"] && {
              1080: {
                type: "mp4",
                url: streams["1080"]
              }
            },
            ...streams["720"] && {
              720: {
                type: "mp4",
                url: streams["720"]
              }
            },
            ...streams["480"] && {
              480: {
                type: "mp4",
                url: streams["480"]
              }
            },
            ...streams["360"] && {
              360: {
                type: "mp4",
                url: streams["360"]
              }
            }
          },
          type: "file",
          flags: [flags.CORS_ALLOWED],
          preferredHeaders: {
            Referer: (_a = data.headers) == null ? void 0 : _a.Referer
          }
        }
      ]
    };
  }
  const hlsStream = data.url.find((stream) => stream.type === "hls") || data.url[0];
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions,
        playlist: hlsStream.link,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        preferredHeaders: {
          Referer: (_b = data.headers) == null ? void 0 : _b.Referer
        }
      }
    ]
  };
}
const streamboxScraper = makeSourcerer({
  id: "streambox",
  name: "StreamBox",
  rank: 119,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$1,
  scrapeShow: comboScraper$1
});
const baseUrl = "https://vidapi.click";
async function comboScraper(ctx) {
  const apiUrl2 = ctx.media.type === "show" ? `${baseUrl}/api/video/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}` : `${baseUrl}/api/video/movie/${ctx.media.tmdbId}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  if (!apiRes) throw new NotFoundError("Failed to fetch video source");
  if (!apiRes.sources[0].file) throw new NotFoundError("No video source found");
  ctx.progress(50);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: apiRes.sources[0].file,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const vidapiClickScraper = makeSourcerer({
  id: "vidapi-click",
  name: "vidapi.click",
  rank: 89,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper
});
async function getEmbeds(id, servers, ctx) {
  var _a;
  const embeds = [];
  for (const server of servers.split(",")) {
    await ctx.proxiedFetcher(`/getEmbed.php`, {
      baseUrl: warezcdnBase,
      headers: {
        Referer: `${warezcdnBase}/getEmbed.php?${new URLSearchParams({ id, sv: server })}`
      },
      method: "HEAD",
      query: { id, sv: server }
    });
    const embedPage = await ctx.proxiedFetcher(`/getPlay.php`, {
      baseUrl: warezcdnBase,
      headers: {
        Referer: `${warezcdnBase}/getEmbed.php?${new URLSearchParams({ id, sv: server })}`
      },
      query: { id, sv: server }
    });
    const url = (_a = embedPage.match(/window.location.href\s*=\s*"([^"]+)"/)) == null ? void 0 : _a[1];
    if (url && server === "warezcdn") {
      embeds.push(
        { embedId: warezcdnembedHlsScraper.id, url },
        { embedId: warezcdnembedMp4Scraper.id, url },
        { embedId: warezPlayerScraper.id, url }
      );
    } else if (url && server === "mixdrop") embeds.push({ embedId: mixdropScraper.id, url });
  }
  return { embeds };
}
const warezcdnScraper = makeSourcerer({
  id: "warezcdn",
  name: "WarezCDN",
  disabled: true,
  rank: 115,
  flags: [],
  scrapeMovie: async (ctx) => {
    if (!ctx.media.imdbId) throw new NotFoundError("This source requires IMDB id.");
    const serversPage = await ctx.proxiedFetcher(`/filme/${ctx.media.imdbId}`, {
      baseUrl: warezcdnBase
    });
    const [, id, servers] = serversPage.match(/let\s+data\s*=\s*'\[\s*\{\s*"id":"([^"]+)".*?"servers":"([^"]+)"/);
    if (!id || !servers) throw new NotFoundError("Failed to find episode id");
    ctx.progress(40);
    return getEmbeds(id, servers, ctx);
  }
  // scrapeShow: async (ctx) => {
  //   if (!ctx.media.imdbId) throw new NotFoundError('This source requires IMDB id.');
  //   const url = `${warezcdnBase}/serie/${ctx.media.imdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  //   const serversPage = await ctx.proxiedFetcher<string>(url);
  //   const seasonsApi = serversPage.match(/var\s+cachedSeasons\s*=\s*"([^"]+)"/)?.[1];
  //   if (!seasonsApi) throw new NotFoundError('Failed to find data');
  //   ctx.progress(40);
  //   const streamsData = await ctx.proxiedFetcher<cachedSeasonsRes>(seasonsApi, {
  //     baseUrl: warezcdnBase,
  //     headers: {
  //       Referer: url,
  //       'X-Requested-With': 'XMLHttpRequest',
  //     },
  //   });
  //   const season = Object.values(streamsData.seasons).find((s) => s.name === ctx.media.season.number.toString());
  //   if (!season) throw new NotFoundError('Failed to find season id');
  //   const episode = Object.values(season.episodes).find((e) => e.name === ctx.media.season.number.toString())?.id;
  //   if (!episode) throw new NotFoundError('Failed to find episode id');
  //   const episodeData = await ctx.proxiedFetcher<string>('/core/ajax.php', {
  //     baseUrl: warezcdnBase,
  //     headers: {
  //       Referer: url,
  //       'X-Requested-With': 'XMLHttpRequest',
  //     },
  //     query: { audios: episode },
  //   });
  //   const [, id, servers] = episodeData.replace(/\\"/g, '"').match(/"\[\s*\{\s*"id":"([^"]+)".*?"servers":"([^"]+)"/)!;
  //   if (!id || !servers) throw new NotFoundError('Failed to find episode id');
  //   return getEmbeds(id, servers, ctx);
  // },
});
function gatherAllSources() {
  return [
    cuevana3Scraper,
    catflixScraper,
    ridooMoviesScraper,
    hdRezkaScraper,
    warezcdnScraper,
    insertunitScraper,
    soaperTvScraper,
    autoembedScraper,
    tugaflixScraper,
    ee3Scraper,
    fsharetvScraper,
    vidsrcsuScraper,
    mp4hydraScraper,
    embedsuScraper,
    slidemoviesScraper,
    iosmirrorScraper,
    iosmirrorPVScraper,
    vidapiClickScraper,
    coitusScraper,
    streamboxScraper,
    nunflixScraper,
    EightStreamScraper,
    wecimaScraper,
    animeflvScraper,
    cinemaosScraper,
    videasyScraper
  ];
}
function gatherAllEmbeds() {
  return [
    upcloudScraper,
    vidCloudScraper,
    mixdropScraper,
    ridooScraper,
    closeLoadScraper,
    doodScraper,
    streamvidScraper,
    streamtapeScraper,
    warezcdnembedHlsScraper,
    warezcdnembedMp4Scraper,
    warezPlayerScraper,
    autoembedEnglishScraper,
    autoembedHindiScraper,
    autoembedBengaliScraper,
    autoembedTamilScraper,
    autoembedTeluguScraper,
    turbovidScraper,
    mp4hydraServer1Scraper,
    mp4hydraServer2Scraper,
    VidsrcsuServer1Scraper,
    VidsrcsuServer2Scraper,
    VidsrcsuServer3Scraper,
    VidsrcsuServer4Scraper,
    VidsrcsuServer5Scraper,
    VidsrcsuServer6Scraper,
    VidsrcsuServer7Scraper,
    VidsrcsuServer8Scraper,
    VidsrcsuServer9Scraper,
    VidsrcsuServer10Scraper,
    VidsrcsuServer11Scraper,
    VidsrcsuServer12Scraper,
    VidsrcsuServer20Scraper,
    viperScraper,
    streamwishJapaneseScraper,
    streamwishLatinoScraper,
    streamwishSpanishScraper,
    streamwishEnglishScraper,
    streamtapeLatinoScraper,
    videasyScraper$1,
    ...cinemaosEmbeds
    // ...cinemaosHexaEmbeds,
  ];
}
function getBuiltinSources() {
  return gatherAllSources().filter((v) => !v.disabled && !v.externalSource);
}
function getBuiltinExternalSources() {
  return gatherAllSources().filter((v) => v.externalSource && !v.disabled);
}
function getBuiltinEmbeds() {
  return gatherAllEmbeds().filter((v) => !v.disabled);
}
function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}
function getProviders(features, list) {
  const sources = list.sources.filter((v) => !(v == null ? void 0 : v.disabled));
  const embeds = list.embeds.filter((v) => !(v == null ? void 0 : v.disabled));
  const combined = [...sources, ...embeds];
  const anyDuplicateId = hasDuplicates(combined.map((v) => v.id));
  const anyDuplicateSourceRank = hasDuplicates(sources.map((v) => v.rank));
  const anyDuplicateEmbedRank = hasDuplicates(embeds.map((v) => v.rank));
  if (anyDuplicateId) throw new Error("Duplicate id found in sources/embeds");
  if (anyDuplicateSourceRank) throw new Error("Duplicate rank found in sources");
  if (anyDuplicateEmbedRank) throw new Error("Duplicate rank found in embeds");
  return {
    sources: sources.filter((s) => flagsAllowedInFeatures(features, s.flags)),
    embeds
  };
}
function makeProviders(ops) {
  var _a;
  const features = getTargetFeatures(
    ops.proxyStreams ? "any" : ops.target,
    ops.consistentIpForRequests ?? false,
    ops.proxyStreams
  );
  const sources = [...getBuiltinSources()];
  if (ops.externalSources === "all") sources.push(...getBuiltinExternalSources());
  else {
    (_a = ops.externalSources) == null ? void 0 : _a.forEach((source) => {
      const matchingSource = getBuiltinExternalSources().find((v) => v.id === source);
      if (!matchingSource) return;
      sources.push(matchingSource);
    });
  }
  const list = getProviders(features, {
    embeds: getBuiltinEmbeds(),
    sources
  });
  return makeControls({
    embeds: list.embeds,
    sources: list.sources,
    features,
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    proxyStreams: ops.proxyStreams
  });
}
function buildProviders() {
  let consistentIpForRequests = false;
  let target = null;
  let fetcher = null;
  let proxiedFetcher = null;
  const embeds = [];
  const sources = [];
  const builtinSources = getBuiltinSources();
  const builtinExternalSources = getBuiltinExternalSources();
  const builtinEmbeds = getBuiltinEmbeds();
  return {
    enableConsistentIpForRequests() {
      consistentIpForRequests = true;
      return this;
    },
    setFetcher(f) {
      fetcher = f;
      return this;
    },
    setProxiedFetcher(f) {
      proxiedFetcher = f;
      return this;
    },
    setTarget(t) {
      target = t;
      return this;
    },
    addSource(input) {
      if (typeof input !== "string") {
        sources.push(input);
        return this;
      }
      const matchingSource = [...builtinSources, ...builtinExternalSources].find((v) => v.id === input);
      if (!matchingSource) throw new Error("Source not found");
      sources.push(matchingSource);
      return this;
    },
    addEmbed(input) {
      if (typeof input !== "string") {
        embeds.push(input);
        return this;
      }
      const matchingEmbed = builtinEmbeds.find((v) => v.id === input);
      if (!matchingEmbed) throw new Error("Embed not found");
      embeds.push(matchingEmbed);
      return this;
    },
    addBuiltinProviders() {
      sources.push(...builtinSources);
      embeds.push(...builtinEmbeds);
      return this;
    },
    build() {
      if (!target) throw new Error("Target not set");
      if (!fetcher) throw new Error("Fetcher not set");
      const features = getTargetFeatures(target, consistentIpForRequests);
      const list = getProviders(features, {
        embeds,
        sources
      });
      return makeControls({
        fetcher,
        proxiedFetcher: proxiedFetcher ?? void 0,
        embeds: list.embeds,
        sources: list.sources,
        features
      });
    }
  };
}
const isReactNative = () => {
  try {
    require("react-native");
    return true;
  } catch (e) {
    return false;
  }
};
function serializeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) {
    if (body instanceof URLSearchParams && isReactNative()) {
      return {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      };
    }
    return {
      headers: {},
      body
    };
  }
  return {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}
function getHeaders(list, res) {
  const output = new Headers();
  list.forEach((header) => {
    var _a;
    const realHeader = header.toLowerCase();
    const realValue = res.headers.get(realHeader);
    const extraValue = (_a = res.extraHeaders) == null ? void 0 : _a.get(realHeader);
    const value = extraValue ?? realValue;
    if (!value) return;
    output.set(realHeader, value);
  });
  return output;
}
function makeStandardFetcher(f) {
  const normalFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const controller = new AbortController();
    const timeout2 = 15e3;
    const timeoutId = setTimeout(() => controller.abort(), timeout2);
    try {
      const res = await f(fullUrl, {
        method: ops.method,
        headers: {
          ...seralizedBody.headers,
          ...ops.headers
        },
        body: seralizedBody.body,
        credentials: ops.credentials,
        signal: controller.signal
        // Pass the signal to fetch
      });
      clearTimeout(timeoutId);
      let body;
      const isJson = (_a = res.headers.get("content-type")) == null ? void 0 : _a.includes("application/json");
      if (isJson) body = await res.json();
      else body = await res.text();
      return {
        body,
        finalUrl: res.extraUrl ?? res.url,
        headers: getHeaders(ops.readHeaders, res),
        statusCode: res.status
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Fetch request to ${fullUrl} timed out after ${timeout2}ms`);
      }
      throw error;
    }
  };
  return normalFetch;
}
const headerMap = {
  cookie: "X-Cookie",
  referer: "X-Referer",
  origin: "X-Origin",
  "user-agent": "X-User-Agent",
  "x-real-ip": "X-X-Real-Ip"
};
const responseHeaderMap = {
  "x-set-cookie": "Set-Cookie"
};
function makeSimpleProxyFetcher(proxyUrl, f) {
  const proxiedFetch = async (url, ops) => {
    const fetcher = makeStandardFetcher(async (a, b) => {
      const controller = new AbortController();
      const timeout2 = 15e3;
      const timeoutId = setTimeout(() => controller.abort(), timeout2);
      try {
        const res = await f(a, {
          method: (b == null ? void 0 : b.method) || "GET",
          headers: (b == null ? void 0 : b.headers) || {},
          body: b == null ? void 0 : b.body,
          credentials: b == null ? void 0 : b.credentials,
          signal: controller.signal
          // Pass the signal to fetch
        });
        clearTimeout(timeoutId);
        res.extraHeaders = new Headers();
        Object.entries(responseHeaderMap).forEach((entry) => {
          var _a;
          const value = res.headers.get(entry[0]);
          if (!value) return;
          (_a = res.extraHeaders) == null ? void 0 : _a.set(entry[1].toLowerCase(), value);
        });
        res.extraUrl = res.headers.get("X-Final-Destination") ?? res.url;
        return res;
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(`Fetch request to ${a} timed out after ${timeout2}ms`);
        }
        throw error;
      }
    });
    const fullUrl = makeFullUrl(url, ops);
    const headerEntries = Object.entries(ops.headers).map((entry) => {
      const key = entry[0].toLowerCase();
      if (headerMap[key]) return [headerMap[key], entry[1]];
      return entry;
    });
    return fetcher(proxyUrl, {
      ...ops,
      query: {
        destination: fullUrl
      },
      headers: Object.fromEntries(headerEntries),
      baseUrl: void 0
    });
  };
  return proxiedFetch;
}
export {
  NotFoundError,
  buildProviders,
  createM3U8ProxyUrl,
  flags,
  getBuiltinEmbeds,
  getBuiltinExternalSources,
  getBuiltinSources,
  getM3U8ProxyUrl,
  makeProviders,
  makeSimpleProxyFetcher,
  makeStandardFetcher,
  setM3U8ProxyUrl,
  targets,
  updateM3U8ProxyUrl
};
