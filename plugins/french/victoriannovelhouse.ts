import { fetchApi } from "@libs/fetch";
import { Filters } from "@libs/filterInputs";
import { Plugin } from "@typings/plugin";
import { load as loadCheerio } from "cheerio";

export const id = "victorian-novel-house";
export const name = "Victorian Novel House";
export const site = "https://world-novel.fr";
export const version = "1.1.1";
export const icon = "src/fr/victorian-novel-house/icon.png";

// ──────────────────────────────────────────────────────────────
// Helpers – extraction des données Next.js SSR
// ──────────────────────────────────────────────────────────────

/**
 * Le site est un Next.js qui injecte les données dans le HTML via :
 *   <script>self.__next_f.push([1,"...JSON encodé en string..."])</script>
 * Cette fonction concatène tous ces morceaux en une seule chaîne.
 */
function extractNextFlightData(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      // La valeur est une chaîne JSON encodée (\" → ", \n → newline…)
      parts.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      parts.push(m[1]);
    }
  }
  return parts.join("");
}

/**
 * Cherche le tableau `novels` dans les données RSC concaténées.
 * Le site embarque TOUS les romans (12+) dans la page d'accueil.
 */
function parseNovelsFromRSC(raw: string): NovelEntry[] {
  // On cherche le premier "novels":[{ dans les données
  const marker = '"novels":[{';
  const idx = raw.indexOf(marker);
  if (idx === -1) return [];

  // Extraction par comptage des accolades
  const arrStart = idx + '"novels":'.length;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = arrStart;

  for (; end < raw.length; end++) {
    const ch = raw[end];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }

  try {
    return JSON.parse(raw.slice(arrStart, end)) as NovelEntry[];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// Types internes
// ──────────────────────────────────────────────────────────────

interface ChapterEntry {
  id: string;
  title: string;
  date: number;
  volumeId: string;
  volumeDisplayName: string;
  chapterNumber: number;
}

interface NovelEntry {
  id: string;
  title: string;
  image: string;
  rating: number;
  desc: string;
  chapters: ChapterEntry[]; // seulement les 5 derniers dans l'accueil
  dateMaj: number;
  genre: string;
  status: string;
  totalChapters: number;
  lastChapterNb: number;
  auteur: string;
  tags: string[];
}

// Cache de la page d'accueil pour éviter plusieurs requêtes
let cachedNovels: NovelEntry[] | null = null;

async function getHomeNovels(): Promise<NovelEntry[]> {
  if (cachedNovels) return cachedNovels;
  const html = await fetchApi(site + "/").then((r) => r.text());
  const raw = extractNextFlightData(html);
  cachedNovels = parseNovelsFromRSC(raw);
  return cachedNovels;
}

// ──────────────────────────────────────────────────────────────
// Plugin – Romans populaires
// ──────────────────────────────────────────────────────────────

export const popularNovels: Plugin.popularNovels = async (
  pageNo,
  { showLatestNovels }
) => {
  if (pageNo > 1) return { novels: [] };

  const entries = await getHomeNovels();
  if (!entries.length) return { novels: [] };

  const sorted = showLatestNovels
    ? [...entries].sort((a, b) => b.dateMaj - a.dateMaj)
    : [...entries].sort((a, b) => b.rating - a.rating);

  return {
    novels: sorted.map((e) => ({
      name: e.title,
      path: `/oeuvres/${e.id}`,
      cover: e.image,
    })),
  };
};

// ──────────────────────────────────────────────────────────────
// Plugin – Détail d'un roman + liste chapitres
// ──────────────────────────────────────────────────────────────

export const parseNovel: Plugin.parseNovel = async (novelPath) => {
  // novelPath = "/oeuvres/shadow-slave"
  const novelId = novelPath.replace("/oeuvres/", "");

  // 1) Données de base depuis l'accueil (toujours disponibles)
  const allNovels = await getHomeNovels();
  let entry = allNovels.find((n) => n.id === novelId) || null;

  // 2) Tenter de récupérer la liste complète des chapitres depuis la page du roman
  let chapters: Plugin.ChapterItem[] = [];

  try {
    const novelHtml = await fetchApi(site + novelPath).then((r) => r.text());
    const raw = extractNextFlightData(novelHtml);

    // La page du roman contient normalement tous les chapitres
    const novels = parseNovelsFromRSC(raw);
    const fullEntry = novels.find((n) => n.id === novelId);
    if (fullEntry && fullEntry.chapters.length > 0) {
      entry = fullEntry;
    }

    // Extraire les chapitres depuis les données RSC de la page roman
    chapters = buildChapterList(entry, novelId, raw);
  } catch {
    // Fallback : juste les 5 derniers chapitres de l'accueil
    if (entry) {
      chapters = entry.chapters.map((c) => chapterToPluginItem(c, novelId));
    }
  }

  if (!entry) {
    return { name: novelId, path: novelPath, chapters };
  }

  return {
    name: entry.title,
    path: novelPath,
    cover: entry.image,
    summary: entry.desc,
    author: entry.auteur,
    genres: entry.genre,
    status: mapStatus(entry.status),
    rating: entry.rating,
    chapters,
  };
};

function buildChapterList(
  entry: NovelEntry | null,
  novelId: string,
  rscData: string
): Plugin.ChapterItem[] {
  if (!entry) return [];

  // Chercher un tableau de chapitres plus complet dans les données RSC
  // Le site peut avoir plusieurs sections avec des chapitres
  const results: ChapterEntry[] = [];
  const re = /"id":"([^"]+)","title":"([^"]+)","date":(\d+),"volumeId":"([^"]+)","volumeDisplayName":"([^"]+)","chapterNumber":(\d+)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((m = re.exec(rscData)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      title: m[2],
      date: parseInt(m[3]),
      volumeId: m[4],
      volumeDisplayName: m[5],
      chapterNumber: parseInt(m[6]),
    });
  }

  if (results.length > 0) {
    // Trier par numéro de chapitre
    results.sort((a, b) => a.chapterNumber - b.chapterNumber);
    return results.map((c) => chapterToPluginItem(c, novelId));
  }

  // Fallback : 5 derniers chapitres
  return entry.chapters.map((c) => chapterToPluginItem(c, novelId));
}

function chapterToPluginItem(c: ChapterEntry, novelId: string): Plugin.ChapterItem {
  return {
    name: c.title || c.id,
    path: `/lecture/${novelId}/volumes/${encodeURIComponent(c.volumeId)}/chapitres/${encodeURIComponent(c.id)}`,
    releaseTime: c.date ? new Date(c.date).toISOString() : undefined,
    chapterNumber: c.chapterNumber,
  };
}

// ──────────────────────────────────────────────────────────────
// Plugin – Contenu d'un chapitre
// ──────────────────────────────────────────────────────────────

export const parseChapter: Plugin.parseChapter = async (chapterPath) => {
  const html = await fetchApi(site + chapterPath).then((r) => r.text());
  const $ = loadCheerio(html);

  // Sélecteurs CSS à tester (à ajuster après test réel)
  const selectors = [
    ".chapter-content",
    "[class*='chapterContent']",
    "[class*='chapter-text']",
    "[class*='content']",
    "article .prose",
    "article",
    ".prose",
  ];

  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 200) {
        return el.html() || text;
      }
    }
  }

  // Plan B : données RSC (si le contenu est injecté côté serveur)
  const raw = extractNextFlightData(html);
  if (raw.length > 500) {
    // Chercher un champ "content" ou "text" dans les données
    const m = raw.match(/"(?:content|text|body)":"([\s\S]{200,}?)(?<!\\)"/);
    if (m) {
      return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  // Plan C : rendu côté client (Firebase) – contenu non disponible en SSR
  return (
    "<p><em>Le contenu de ce chapitre est chargé dynamiquement (Firebase). " +
    "LNReader ne peut pas l'afficher directement.</em></p>" +
    "<p>Veuillez ouvrir le chapitre dans le navigateur intégré.</p>"
  );
};

// ──────────────────────────────────────────────────────────────
// Plugin – Recherche
// ──────────────────────────────────────────────────────────────

export const searchNovels: Plugin.searchNovels = async (searchTerm, filters) => {
  const entries = await getHomeNovels();
  const q = searchTerm.toLowerCase();
  const genre = (filters?.genre as string) || "";

  const filtered = entries.filter((e) => {
    const matchSearch =
      !q ||
      e.title.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)) ||
      (e.auteur || "").toLowerCase().includes(q);

    const matchGenre =
      !genre || e.genre.toLowerCase().includes(genre.toLowerCase());

    return matchSearch && matchGenre;
  });

  return {
    novels: filtered.map((e) => ({
      name: e.title,
      path: `/oeuvres/${e.id}`,
      cover: e.image,
    })),
  };
};

// ──────────────────────────────────────────────────────────────
// Filtres
// ──────────────────────────────────────────────────────────────

export const filters = [
  {
    key: "genre",
    label: "Genre",
    values: [
      { label: "Tous", value: "" },
      { label: "Action", value: "Action" },
      { label: "Aventure", value: "Aventure" },
      { label: "Fantaisie / Fantasy", value: "Fantais" },
      { label: "Mystère", value: "Mystère" },
      { label: "Romance", value: "Romance" },
      { label: "Système / LitRPG", value: "Système" },
      { label: "Science-fiction", value: "Science" },
      { label: "Surnaturel", value: "Surnaturel" },
    ],
    inputType: Filters.Picker.type,
  },
] satisfies Filters.FilterTypes[];

// ──────────────────────────────────────────────────────────────
// Utilitaires
// ──────────────────────────────────────────────────────────────

function mapStatus(status: string): string {
  const s = (status || "").toLowerCase();
  if (s.includes("cours")) return Plugin.NovelStatus.Ongoing;
  if (s.includes("termin")) return Plugin.NovelStatus.Completed;
  if (s.includes("pause") || s.includes("abandon")) return Plugin.NovelStatus.OnHiatus;
  return Plugin.NovelStatus.Unknown;
}
