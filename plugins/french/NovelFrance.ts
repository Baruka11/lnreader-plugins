/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 2.0.0
 * Stratégie : scraping SSR Next.js (__next_f payload)
 *
 * Structure de données confirmée :
 *   - Page novel   : initialNovel + initialChaptersResponse
 *   - Page chapitre: initialChapter.paragraphs[].content
 *   - Pagination   : ?skip=N&take=50&order=desc
 */

const BASE_URL = "https://novelfrance.fr";

// ---------------------------------------------------------------------------
// Extraction du payload RSC Next.js
// ---------------------------------------------------------------------------

function extractRSC(html) {
  const fragments = [];
  const regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      fragments.push(JSON.parse('"' + m[1] + '"'));
    } catch (_) {}
  }
  return fragments.join("");
}

/**
 * Extrait un objet JSON depuis le RSC à partir de `"fieldName":{`.
 * Gère les accolades imbriquées.
 */
function extractObject(rsc, fieldName) {
  const key = '"' + fieldName + '":{';
  const start = rsc.indexOf(key);
  if (start === -1) return null;

  let i = start + key.length;
  let depth = 1;
  while (i < rsc.length && depth > 0) {
    if (rsc[i] === "{") depth++;
    else if (rsc[i] === "}") depth--;
    i++;
  }
  try {
    return JSON.parse("{" + rsc.slice(start + key.length, i));
  } catch (_) {
    return null;
  }
}

/**
 * Extrait un tableau JSON depuis le RSC à partir de `"fieldName":[`.
 */
function extractArray(rsc, fieldName) {
  const key = '"' + fieldName + '":[';
  const start = rsc.indexOf(key);
  if (start === -1) return null;

  let i = start + key.length;
  let depth = 1;
  while (i < rsc.length && depth > 0) {
    if (rsc[i] === "[") depth++;
    else if (rsc[i] === "]") depth--;
    i++;
  }
  try {
    return JSON.parse("[" + rsc.slice(start + key.length, i));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coverUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return BASE_URL + path;
}

function mapStatus(s) {
  if (!s) return "Unknown";
  const u = s.toUpperCase();
  if (u === "ONGOING") return "Ongoing";
  if (u === "COMPLETED") return "Completed";
  return "Unknown";
}

function mapNovelCard(item) {
  return {
    name: item.title || "",
    cover: coverUrl(item.coverImage),
    path: "/novel/" + item.slug,
  };
}

// ---------------------------------------------------------------------------
// popularNovels — section "popular" de la page d'accueil
// ---------------------------------------------------------------------------

const popularNovels = async (page) => {
  const url = page === 1
    ? BASE_URL + "/"
    : BASE_URL + "/browse?sort=popular&page=" + page;

  const res = await fetch(url);
  const html = await res.text();
  const rsc = extractRSC(html);

  const initialData = extractObject(rsc, "initialData");
  if (initialData && Array.isArray(initialData.popular) && page === 1) {
    return {
      novels: initialData.popular.map(mapNovelCard),
      hasNextPage: true,
    };
  }

  // Fallback : regex générique sur le RSC
  const novels = [];
  const slugSet = new Set();
  const pattern = /"title":"([^"]+)","slug":"([^"]+)","description":"[^"]*","coverImage":"([^"]+)"/g;
  let m;
  while ((m = pattern.exec(rsc)) !== null) {
    const slug = m[2];
    if (!slugSet.has(slug)) {
      slugSet.add(slug);
      novels.push({ name: m[1], cover: coverUrl(m[3]), path: "/novel/" + slug });
    }
  }

  return { novels, hasNextPage: novels.length >= 20 };
};

// ---------------------------------------------------------------------------
// searchNovels — /search?q=...
// ---------------------------------------------------------------------------

const searchNovels = async (searchTerm, page, filters) => {
  const url = BASE_URL + "/search?q=" + encodeURIComponent(searchTerm) +
    (page > 1 ? "&page=" + page : "");

  const res = await fetch(url);
  const html = await res.text();
  const rsc = extractRSC(html);

  let items = extractArray(rsc, "novels") || extractArray(rsc, "results") || [];
  const novels = items.map(mapNovelCard);

  if (novels.length === 0) {
    const slugSet = new Set();
    const pattern = /"title":"([^"]+)","slug":"([^"]+)","description":"[^"]*","coverImage":"([^"]+)"/g;
    let m;
    while ((m = pattern.exec(rsc)) !== null) {
      const slug = m[2];
      if (!slugSet.has(slug)) {
        slugSet.add(slug);
        novels.push({ name: m[1], cover: coverUrl(m[3]), path: "/novel/" + slug });
      }
    }
  }

  return { novels, hasNextPage: novels.length >= 20 };
};

// ---------------------------------------------------------------------------
// novelInfo — /novel/{slug} → initialNovel
// ---------------------------------------------------------------------------

const novelInfo = async (novelPath) => {
  const res = await fetch(BASE_URL + novelPath);
  const html = await res.text();
  const rsc = extractRSC(html);

  const novel = extractObject(rsc, "initialNovel");

  if (!novel) {
    // Fallback meta tags
    const title = (/<title>([^<]+)<\/title>/.exec(html) || [])[1] || "";
    const desc = (/<meta name="description" content="([^"]+)"/.exec(html) || [])[1] || "";
    const cover = (/<meta property="og:image" content="([^"]+)"/.exec(html) || [])[1] || "";
    return {
      name: title.replace(/ - Lire.*$/, "").trim(),
      cover,
      summary: desc,
      author: "",
      artist: "",
      status: "Unknown",
      genres: [],
      chapters: [],
    };
  }

  const genres = Array.isArray(novel.genres)
    ? novel.genres.map((g) => (typeof g === "string" ? g : g.name)).filter(Boolean)
    : [];

  return {
    name: novel.title || "",
    cover: coverUrl(novel.coverImage),
    summary: novel.description || "",
    author: novel.author || "",
    artist: novel.translatorName ? "Traducteur : " + novel.translatorName : "",
    status: mapStatus(novel.status),
    genres,
    chapters: [],
  };
};

// ---------------------------------------------------------------------------
// chapterList — /novel/{slug} avec pagination complète
//
// La page novel expose initialChaptersResponse :
//   { chapters: [...50 items], total: N, take: 50, hasMore: bool }
//
// Pour obtenir tous les chapitres on pagine avec :
//   /novel/{slug}?skip=N&take=50&order=desc
// ---------------------------------------------------------------------------

const chapterList = async (novelPath) => {
  const slug = novelPath.replace(/^\/novel\//, "").replace(/\/$/, "");

  // Chargement initial
  const res = await fetch(BASE_URL + novelPath);
  const html = await res.text();
  const rsc = extractRSC(html);

  const chaptersResp = extractObject(rsc, "initialChaptersResponse");
  if (!chaptersResp || !Array.isArray(chaptersResp.chapters)) return [];

  const total = chaptersResp.total || 0;
  const take = chaptersResp.take || 50;
  let allChapters = [...chaptersResp.chapters];

  // Pagination si nécessaire
  if (chaptersResp.hasMore && total > allChapters.length) {
    const numPages = Math.ceil(total / take);

    for (let page = 1; page < numPages; page++) {
      const skip = page * take;
      if (allChapters.length >= total) break;

      try {
        const pageRes = await fetch(
          BASE_URL + "/novel/" + slug + "?skip=" + skip + "&take=" + take + "&order=desc"
        );
        const pageHtml = await pageRes.text();
        const pageRsc = extractRSC(pageHtml);
        const pageData = extractObject(pageRsc, "initialChaptersResponse");

        if (pageData && Array.isArray(pageData.chapters)) {
          allChapters = allChapters.concat(pageData.chapters);
        }
      } catch (_) {
        break;
      }
    }
  }

  // Dédoublonnage + tri ASC
  const seen = new Set();
  const unique = allChapters
    .filter((c) => {
      if (seen.has(c.chapterNumber)) return false;
      seen.add(c.chapterNumber);
      return true;
    })
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  return unique.map((c) => ({
    name: "Chapitre " + c.chapterNumber + (c.title ? " - " + c.title : ""),
    path: "/" + slug + "/" + c.slug,
    releaseTime: c.createdAt || "",
    chapterNumber: c.chapterNumber,
  }));
};

// ---------------------------------------------------------------------------
// readChapter — /novel/{novelSlug}/{chapterSlug}
// Données dans initialChapter.paragraphs[].content
// ---------------------------------------------------------------------------

const readChapter = async (chapterPath) => {
  // chapterPath = "/{novelSlug}/{chapterSlug}"
  const res = await fetch(BASE_URL + "/novel" + chapterPath);
  const html = await res.text();
  const rsc = extractRSC(html);

  // Stratégie 1 : initialChapter.paragraphs (structure confirmée)
  const chapter = extractObject(rsc, "initialChapter");
  if (chapter && Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0) {
    const lines = chapter.paragraphs
      .map((p) => (p.content || "").trim())
      .filter((l) => l.length > 0);
    return "<p>" + lines.join("</p><p>") + "</p>";
  }

  // Stratégie 2 : champs "content" dans le RSC brut
  const contentPattern = /"content":"((?:[^"\\]|\\.)*)"/g;
  const lines = [];
  let m;
  while ((m = contentPattern.exec(rsc)) !== null) {
    const line = m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    if (line.length > 0) lines.push(line);
  }
  if (lines.length > 0) return "<p>" + lines.join("</p><p>") + "</p>";

  // Stratégie 3 : scraping HTML des balises <p class="...select-text...">
  const pPattern = /<p[^>]*class="[^"]*select-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  const htmlLines = [];
  while ((m = pPattern.exec(html)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x2F;/g, "/")
      .trim();
    if (text) htmlLines.push(text);
  }
  return "<p>" + htmlLines.join("</p><p>") + "</p>";
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  id: "novelfrance",
  name: "NovelFrance",
  site: BASE_URL,
  lang: "fr",
  version: "2.0.0",

  popularNovels,
  searchNovels,
  novelInfo,
  chapterList,
  readChapter,
};
