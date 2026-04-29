/**
 * Plugin LNReader — NovelFrance
 * Site : https://novelfrance.fr
 * Stratégie : scraping du SSR Next.js (__next_f payload)
 *
 * Fonctions disponibles :
 *   popularNovels(page)
 *   searchNovels(searchTerm, page, filters)
 *   novelInfo(novelPath)
 *   chapterList(novelPath)
 *   readChapter(chapterPath)
 */

const BASE_URL = "https://novelfrance.fr";

// ---------------------------------------------------------------------------
// Utilitaire : extraire les données JSON injectées par Next.js dans le HTML
// ---------------------------------------------------------------------------

/**
 * Reconstruit le payload RSC depuis les balises <script> __next_f.push(...)
 * et renvoie un objet JS parsé à partir des fragments JSON utiles.
 */
function extractNextData(html) {
  // Concatène tous les fragments RSC en une seule chaîne
  const fragments = [];
  const regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      // Les fragments sont encodés en JSON-string (échappements \\n, \\", etc.)
      fragments.push(JSON.parse('"' + match[1] + '"'));
    } catch (_) {
      // ignore les fragments malformés
    }
  }
  return fragments.join("");
}

/**
 * Extrait la valeur d'un champ JSON embarqué dans le flux RSC.
 * Le flux RSC de Next.js contient des lignes du type :
 *   XX:T<hex>,<json>
 * ou des objets directement sérialisés.
 *
 * On cherche un objet JSON qui possède la clé `key`.
 */
function parseRSCObject(rscText, key) {
  // Cherche un objet JSON contenant la clé demandée
  // Les données utiles sont souvent précédées d'un identifiant hexadécimal + ":"
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    '\\{[^{}]*"' + escaped + '"\\s*:[\\s\\S]*?\\}(?=\\s*[,\\]]|$)',
    "g"
  );

  let best = null;
  let m;
  while ((m = pattern.exec(rscText)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj[key] !== undefined) {
        if (best === null || JSON.stringify(obj).length > JSON.stringify(best).length) {
          best = obj;
        }
      }
    } catch (_) {}
  }
  return best;
}

/**
 * Extrait directement un objet `initialData` ou `initialChapter`
 * présent dans le payload RSC sous la forme :
 *   "initialData":{...}
 * ou la ligne RSC :
 *   XX:{"initialData":{...}}
 */
function extractJsonBlock(rscText, fieldName) {
  // Cherche le champ et récupère le JSON complet (gestion des accolades imbriquées)
  const start = rscText.indexOf('"' + fieldName + '":{');
  if (start === -1) return null;

  const bodyStart = start + fieldName.length + 3; // position après `"fieldName":{`
  let depth = 1;
  let i = bodyStart;
  while (i < rscText.length && depth > 0) {
    if (rscText[i] === "{") depth++;
    else if (rscText[i] === "}") depth--;
    i++;
  }

  try {
    return JSON.parse("{" + rscText.slice(bodyStart, i));
  } catch (_) {
    return null;
  }
}

/**
 * Extrait un tableau JSON depuis un champ RSC du type :
 *   "fieldName":[...]
 */
function extractJsonArray(rscText, fieldName) {
  const start = rscText.indexOf('"' + fieldName + '":[');
  if (start === -1) return null;

  const bodyStart = start + fieldName.length + 3;
  let depth = 1;
  let i = bodyStart;
  while (i < rscText.length && depth > 0) {
    if (rscText[i] === "[") depth++;
    else if (rscText[i] === "]") depth--;
    i++;
  }

  try {
    return JSON.parse("[" + rscText.slice(bodyStart, i));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers de mapping
// ---------------------------------------------------------------------------

function buildCoverUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return BASE_URL + path;
}

function mapStatus(status) {
  if (!status) return "Unknown";
  const s = status.toUpperCase();
  if (s === "ONGOING") return "Ongoing";
  if (s === "COMPLETED") return "Completed";
  return "Unknown";
}

function mapNovelCard(item) {
  return {
    name: item.title || "Sans titre",
    cover: buildCoverUrl(item.coverImage),
    path: "/novel/" + item.slug,
  };
}

// ---------------------------------------------------------------------------
// popularNovels — page d'accueil, section "Incontournables" (populaires)
// ---------------------------------------------------------------------------

const popularNovels = async (page) => {
  // La page d'accueil contient toutes les données en SSR
  // On utilise /browse?sort=popular&page=N pour la pagination
  const url =
    page === 1
      ? BASE_URL + "/"
      : BASE_URL + "/browse?sort=popular&page=" + page;

  const result = await fetch(url);
  const html = await result.text();
  const rsc = extractNextData(html);

  // Tenter de récupérer la section "popular" depuis initialData
  const initialData = extractJsonBlock(rsc, "initialData");

  let novels = [];

  if (initialData && initialData.popular && page === 1) {
    novels = initialData.popular.map(mapNovelCard);
  } else {
    // Fallback : page /browse — chercher les cards dans le HTML
    // Chercher les slugs et titres dans le RSC brut
    const slugPattern = /"slug":"([^"]+)","description"/g;
    const titlePattern = /"title":"([^"]+)","slug"/g;
    const coverPattern = /"coverImage":"([^"]+)"/g;

    const slugs = [];
    const titles = [];
    const covers = [];

    let m;
    while ((m = slugPattern.exec(rsc)) !== null) slugs.push(m[1]);
    while ((m = titlePattern.exec(rsc)) !== null) titles.push(m[1]);
    while ((m = coverPattern.exec(rsc)) !== null) covers.push(m[1]);

    const count = Math.min(slugs.length, titles.length);
    for (let i = 0; i < count; i++) {
      novels.push({
        name: titles[i],
        cover: buildCoverUrl(covers[i] || ""),
        path: "/novel/" + slugs[i],
      });
    }
  }

  return {
    novels,
    hasNextPage: novels.length >= 20,
  };
};

// ---------------------------------------------------------------------------
// searchNovels — utilise /search?q=...
// ---------------------------------------------------------------------------

const searchNovels = async (searchTerm, page, filters) => {
  const url =
    BASE_URL + "/search?q=" + encodeURIComponent(searchTerm) +
    (page > 1 ? "&page=" + page : "");

  const result = await fetch(url);
  const html = await result.text();
  const rsc = extractNextData(html);

  // Les résultats de recherche sont dans un tableau "novels" ou "results"
  const novelsArray = extractJsonArray(rsc, "novels") ||
                      extractJsonArray(rsc, "results") ||
                      [];

  const novels = novelsArray.map(mapNovelCard);

  // Fallback si aucun résultat structuré : extraire depuis le RSC brut
  if (novels.length === 0) {
    const slugPattern = /"slug":"([^"]+)","description"/g;
    const titlePattern = /"title":"([^"]+)","slug"/g;
    const coverPattern = /"coverImage":"([^"]+)"/g;

    const slugs = [];
    const titles = [];
    const covers = [];

    let m;
    while ((m = slugPattern.exec(rsc)) !== null) slugs.push(m[1]);
    while ((m = titlePattern.exec(rsc)) !== null) titles.push(m[1]);
    while ((m = coverPattern.exec(rsc)) !== null) covers.push(m[1]);

    const count = Math.min(slugs.length, titles.length);
    for (let i = 0; i < count; i++) {
      novels.push({
        name: titles[i],
        cover: buildCoverUrl(covers[i] || ""),
        path: "/novel/" + slugs[i],
      });
    }
  }

  return {
    novels,
    hasNextPage: novels.length >= 20,
  };
};

// ---------------------------------------------------------------------------
// novelInfo — page du novel /novel/{slug}
// ---------------------------------------------------------------------------

const novelInfo = async (novelPath) => {
  const url = BASE_URL + novelPath;
  const result = await fetch(url);
  const html = await result.text();
  const rsc = extractNextData(html);

  // Chercher l'objet principal du novel dans le RSC
  // Il contient : title, slug, author, description, coverImage, status, genres, _count.chapters
  let info = {};

  // Tenter d'extraire depuis un bloc JSON structuré
  const novelBlock = extractJsonBlock(rsc, "novel") ||
                     extractJsonBlock(rsc, "initialData");

  // Patterns de fallback directs dans le RSC
  const getField = (field) => {
    const m = new RegExp('"' + field + '":"([^"]*)"').exec(rsc);
    return m ? m[1] : "";
  };

  const title = novelBlock?.title || getField("title");
  const author = novelBlock?.author || getField("author");
  const description = novelBlock?.description || getField("description");
  const coverImage = novelBlock?.coverImage || getField("coverImage");
  const status = novelBlock?.status || getField("status");

  // Genres
  let genres = [];
  try {
    const genreMatches = rsc.match(/"genres":\[([^\]]*)\]/);
    if (genreMatches) {
      const genreArr = JSON.parse("[" + genreMatches[1] + "]");
      genres = genreArr.map((g) => g.name || g).filter(Boolean);
    }
  } catch (_) {
    // Fallback : regex simple
    const genrePattern = /"name":"([^"]+)","slug"/g;
    let gm;
    while ((gm = genrePattern.exec(rsc)) !== null) {
      genres.push(gm[1]);
    }
    genres = [...new Set(genres)]; // dédoublonnage
  }

  // Traducteur
  const translatorName = novelBlock?.translatorName || getField("translatorName");

  return {
    name: title,
    cover: buildCoverUrl(coverImage),
    summary: description,
    author,
    artist: translatorName ? "Traducteur : " + translatorName : "",
    status: mapStatus(status),
    genres,
    // Le chargement des chapitres est fait par chapterList()
    chapters: [],
  };
};

// ---------------------------------------------------------------------------
// chapterList — liste des chapitres depuis /novel/{slug}
// Stratégie : la page novel contient parfois les chapitres en SSR,
// sinon on tente l'endpoint paginé découvert via le network.
// ---------------------------------------------------------------------------

const chapterList = async (novelPath) => {
  // Essai 1 : récupérer depuis la page novel directement
  const url = BASE_URL + novelPath;
  const result = await fetch(url);
  const html = await result.text();
  const rsc = extractNextData(html);

  // Chercher un tableau "chapters" dans le RSC
  let chapters = [];

  // Pattern pour les chapitres dans le RSC :
  // {"id":"...","chapterNumber":N,"title":"...","slug":"chapter-N","createdAt":"..."}
  const chapterPattern =
    /\{"id":"[^"]+","chapterNumber":(\d+),"title":"([^"]+)","slug":"([^"]+)","createdAt":"([^"]+)"[^}]*\}/g;

  // Extraire le slug du novel depuis le path
  const novelSlug = novelPath.replace("/novel/", "").replace(/\/$/, "");

  let m;
  while ((m = chapterPattern.exec(rsc)) !== null) {
    chapters.push({
      name: "Chapitre " + m[1] + " - " + m[2],
      path: "/" + novelSlug + "/chapter-" + m[1],
      releaseTime: m[4],
      chapterNumber: parseInt(m[1]),
    });
  }

  // Si aucun chapitre trouvé via pattern simple, chercher tableau "chapters"
  if (chapters.length === 0) {
    const chapterArray = extractJsonArray(rsc, "chapters");
    if (chapterArray) {
      chapters = chapterArray.map((c) => ({
        name: "Chapitre " + c.chapterNumber + (c.title ? " - " + c.title : ""),
        path: "/" + novelSlug + "/" + c.slug,
        releaseTime: c.createdAt || c.publishedAt || "",
        chapterNumber: c.chapterNumber,
      }));
    }
  }

  // Dédoublonner par chapterNumber et trier (ordre croissant par défaut)
  const seen = new Set();
  chapters = chapters
    .filter((c) => {
      if (seen.has(c.chapterNumber)) return false;
      seen.add(c.chapterNumber);
      return true;
    })
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  return chapters;
};

// ---------------------------------------------------------------------------
// readChapter — contenu d'un chapitre
// URL : /novel/{novelSlug}/{chapterSlug}
// Les paragraphes sont dans initialChapter.paragraphs[].content
// ---------------------------------------------------------------------------

const readChapter = async (chapterPath) => {
  // chapterPath = "/{novelSlug}/{chapterSlug}" (sans /novel/ devant)
  const url = BASE_URL + "/novel" + chapterPath;
  const result = await fetch(url);
  const html = await result.text();
  const rsc = extractNextData(html);

  // Chercher le bloc initialChapter dans le RSC
  // Structure : "initialChapter":{..., "paragraphs":[{"content":"..."},...], ...}
  const chapterBlock = extractJsonBlock(rsc, "initialChapter");

  if (chapterBlock && chapterBlock.paragraphs) {
    const paragraphs = chapterBlock.paragraphs;

    // Construire le texte en assemblant les paragraphes
    // On saute le premier (titre redondant) et l'éventuel crédit traducteur (index 1)
    const textLines = paragraphs
      .slice(0) // garder tout, y compris titre et crédits
      .map((p) => (p.content || "").trim())
      .filter((line) => line.length > 0);

    const content = "<p>" + textLines.join("</p><p>") + "</p>";

    return content;
  }

  // Fallback : extraire les `content` depuis les paragraphes en RSC brut
  const contentPattern = /"content":"((?:[^"\\]|\\.)*)"/g;
  const lines = [];
  let m;
  while ((m = contentPattern.exec(rsc)) !== null) {
    const line = m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\")
      .trim();
    if (line.length > 0) lines.push(line);
  }

  if (lines.length > 0) {
    return "<p>" + lines.join("</p><p>") + "</p>";
  }

  // Dernier recours : scraping HTML classique des balises <p>
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
      .trim();
    if (text) htmlLines.push(text);
  }

  return "<p>" + htmlLines.join("</p><p>") + "</p>";
};

// ---------------------------------------------------------------------------
// Export du plugin
// ---------------------------------------------------------------------------

module.exports = {
  id: "novelfrance",
  name: "NovelFrance",
  site: BASE_URL,
  lang: "fr",
  version: "1.0.0",

  popularNovels,
  searchNovels,
  novelInfo,
  chapterList,
  readChapter,
};
