import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

// ─────────────────────────────────────────────────────────────
// Types internes
// ─────────────────────────────────────────────────────────────

interface RawChapter {
  id: string;
  title: string;
  date: string;
  volumeId: string;
  volumeDisplayName: string;
  ts: number;
}

interface RawVolume {
  volumeId: string;
  volumeDisplayName: string;
  chapters: RawChapter[];
}

interface RawOeuvre {
  id: string;
  title: string;
  description: string;
  image: string;
  tags: string[];
  genre: string;
  auteur: string;
  traducteur: string;
  dateMaj: string;
  addAt: string;
  volumes: RawVolume[];
  totalChapters: number;
  stats: {
    averageRating: number;
  };
}

interface HomeNovelEntry {
  id: string;
  title: string;
  image: string;
  rating: number;
  desc: string;
  chapters: Array<{
    id: string;
    title: string;
    date: number;
    volumeId: string;
    volumeDisplayName: string;
    chapterNumber: number;
  }>;
  dateMaj: number;
  genre: string;
  status: string;
  totalChapters: number;
  lastChapterNb: number;
  auteur: string;
  tags: string[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractNextFlightData(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      parts.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      parts.push(m[1]);
    }
  }
  return parts.join('');
}

/**
 * Parse les romans depuis la page d'accueil (prop "novels":[...])
 */
function parseNovelsFromRSC(raw: string): HomeNovelEntry[] {
  const marker = '"novels":[{';
  const idx = raw.indexOf(marker);
  if (idx === -1) return [];

  const arrStart = idx + '"novels":'.length;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = arrStart;

  for (; end < raw.length; end++) {
    const ch = raw[end];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }

  try {
    return JSON.parse(raw.slice(arrStart, end)) as HomeNovelEntry[];
  } catch {
    return [];
  }
}

/**
 * Parse le prop "oeuvre" depuis la page d'un roman /oeuvres/{id}
 * Les données sont dans: "oeuvre":{...}
 */
function parseOeuvreFromRSC(raw: string): RawOeuvre | null {
  // Chercher le marqueur "oeuvre":{ dans les données RSC
  const marker = '"oeuvre":{';
  const idx = raw.indexOf(marker);
  if (idx === -1) return null;

  const objStart = idx + '"oeuvre":'.length;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = objStart;

  for (; end < raw.length; end++) {
    const ch = raw[end];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }

  try {
    return JSON.parse(raw.slice(objStart, end)) as RawOeuvre;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

class VictorianNovelHousePlugin implements Plugin.PluginBase {
  id = 'victoriannovelhouse';
  name = 'Victorian Novel House';
  icon = 'src/fr/victoriannovelhouse/icon.png';
  site = 'https://world-novel.fr';
  version = '1.4.0';

  private userId = 'FMWkEHmNArbpfkfgEb4xjNbCbL73';
  private cdnBase = 'https://cdn.world-novel.fr/chapitres';

  private cachedNovels: HomeNovelEntry[] | null = null;

  private async getHomeNovels(): Promise<HomeNovelEntry[]> {
    if (this.cachedNovels) return this.cachedNovels;
    const r = await fetchApi(this.site + '/');
    const html = await r.text();
    const raw = extractNextFlightData(html);
    this.cachedNovels = parseNovelsFromRSC(raw);
    return this.cachedNovels;
  }

  private mapStatus(status: string): string {
    const s = (status || '').toLowerCase();
    if (s.includes('cours')) return NovelStatus.Ongoing;
    if (s.includes('termin')) return NovelStatus.Completed;
    if (s.includes('pause') || s.includes('abandon')) return NovelStatus.OnHiatus;
    return NovelStatus.Unknown;
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const entries = await this.getHomeNovels();
    if (!entries.length) return [];

    const sorted = showLatestNovels
      ? [...entries].sort((a, b) => b.dateMaj - a.dateMaj)
      : [...entries].sort((a, b) => b.rating - a.rating);

    return sorted.map(e => ({
      name: e.title,
      path: `/oeuvres/${e.id}`,
      cover: e.image,
    }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelId = novelPath.replace('/oeuvres/', '');

    // Charger la page du roman pour avoir les volumes complets
    const r = await fetchApi(this.site + novelPath);
    const html = await r.text();
    const raw = extractNextFlightData(html);

    // Parser le prop "oeuvre" qui contient TOUS les volumes et chapitres
    const oeuvre = parseOeuvreFromRSC(raw);

    if (oeuvre && oeuvre.volumes && oeuvre.volumes.length > 0) {
      // Aplatir tous les volumes en une liste de chapitres triés par ts (timestamp)
      const allChapters: Plugin.ChapterItem[] = [];

      for (const volume of oeuvre.volumes) {
        for (const ch of volume.chapters) {
          allChapters.push({
            name: ch.title || ch.id,
            path: `/lecture/${novelId}/volumes/${encodeURIComponent(ch.volumeId)}/chapitres/${encodeURIComponent(ch.id)}`,
            releaseTime: ch.date ? new Date(ch.ts || 0).toISOString() : undefined,
            chapterNumber: undefined, // sera déduit de l'ordre
          });
        }
      }

      // Trier par timestamp croissant (du plus ancien au plus récent)
      allChapters.sort((a, b) => {
        // Récupérer les ts depuis les volumes
        return 0; // déjà dans le bon ordre depuis les données
      });

      // Extraire les chapitres de tous les volumes dans l'ordre (vol 0 → vol 1 → ...)
      // Les volumes sont déjà dans l'ordre dans le JSON, on les inverse car
      // ils sont affichés en ordre décroissant sur le site (volume le plus récent en premier)
      const orderedChapters: Plugin.ChapterItem[] = [];
      const reversedVolumes = [...oeuvre.volumes].reverse(); // Volume 0 d'abord

      let chapterNumber = 1;
      for (const volume of reversedVolumes) {
        // Trier les chapitres du volume par ts croissant
        const sortedChaps = [...volume.chapters].sort((a, b) => (a.ts || 0) - (b.ts || 0));
        for (const ch of sortedChaps) {
          orderedChapters.push({
            name: ch.title || ch.id,
            path: `/lecture/${novelId}/volumes/${encodeURIComponent(ch.volumeId)}/chapitres/${encodeURIComponent(ch.id)}`,
            releaseTime: ch.ts ? new Date(ch.ts).toISOString() : undefined,
            chapterNumber: chapterNumber++,
          });
        }
      }

      return {
        path: novelPath,
        name: oeuvre.title,
        cover: oeuvre.image,
        summary: oeuvre.description,
        author: oeuvre.auteur,
        genres: oeuvre.genre,
        status: NovelStatus.Unknown,
        chapters: orderedChapters,
      };
    }

    // Fallback : utiliser les données de la page d'accueil
    const allNovels = await this.getHomeNovels();
    const entry = allNovels.find(n => n.id === novelId);

    if (!entry) {
      return { path: novelPath, name: novelId, chapters: [] };
    }

    const chapters = [...entry.chapters]
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .map((c, i) => ({
        name: c.title || c.id,
        path: `/lecture/${novelId}/volumes/${encodeURIComponent(c.volumeId)}/chapitres/${encodeURIComponent(c.id)}`,
        releaseTime: c.date ? new Date(c.date).toISOString() : undefined,
        chapterNumber: c.chapterNumber || i + 1,
      }));

    return {
      path: novelPath,
      name: entry.title,
      cover: entry.image,
      summary: entry.desc,
      author: entry.auteur,
      genres: entry.genre,
      status: this.mapStatus(entry.status),
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    // Format : /lecture/{novelId}/volumes/{volumeId}/chapitres/{chapterId}
    const match = chapterPath.match(
      /\/lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/([^/]+)/
    );

    if (match) {
      const [, novelId, volumeId, chapterId] = match;
      const cdnUrl = `${this.cdnBase}/?path=${novelId}/${volumeId}/${chapterId}&userId=${this.userId}`;

      try {
        const r = await fetchApi(cdnUrl);
        if (r.ok) {
          const text = await r.text();

          // Réponse JSON
          try {
            const json = JSON.parse(text);
            const content = json.content ?? json.text ?? json.body ?? json.html ?? '';
            if (typeof content === 'string' && content.length > 100) {
              return content.replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
          } catch {}

          // Réponse HTML
          if (text.trimStart().startsWith('<') && text.length > 100) {
            return text;
          }

          // Texte brut
          if (text.length > 100) {
            return text
              .split('\n')
              .filter(l => l.trim())
              .map(l => `<p>${l.trim()}</p>`)
              .join('\n');
          }
        }
      } catch {}
    }

    // Fallback : parser la page web
    try {
      const r = await fetchApi(this.site + chapterPath);
      const html = await r.text();
      const $ = load(html);

      const selectors = [
        '.chapter-content',
        '[class*="chapterContent"]',
        '[class*="chapter-text"]',
        '.prose',
        'article',
      ];

      for (const sel of selectors) {
        const el = $(sel);
        if (el.length && el.text().trim().length > 200) {
          return el.html() || '';
        }
      }

      const raw = extractNextFlightData(html);
      const m = raw.match(/"(?:content|text|body)":"([\s\S]{200,}?)(?<!\\)"/);
      if (m) {
        return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
    } catch {}

    return "<p><em>Le contenu de ce chapitre est chargé dynamiquement. Veuillez l'ouvrir dans le navigateur intégré.</em></p>";
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const entries = await this.getHomeNovels();
    const q = searchTerm
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    return entries
      .filter(e => {
        const title = e.title
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        const author = (e.auteur || '').toLowerCase();
        const tags = e.tags.join(' ').toLowerCase();
        return title.includes(q) || author.includes(q) || tags.includes(q);
      })
      .map(e => ({
        name: e.title,
        path: `/oeuvres/${e.id}`,
        cover: e.image,
      }));
  }

  filters = {
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      value: '',
      options: [
        { label: 'Tous', value: '' },
        { label: 'Action', value: 'Action' },
        { label: 'Aventure', value: 'Aventure' },
        { label: 'Fantaisie', value: 'Fantais' },
        { label: 'Mystère', value: 'Mystère' },
        { label: 'Romance', value: 'Romance' },
        { label: 'Système / LitRPG', value: 'Système' },
        { label: 'Science-fiction', value: 'Science' },
        { label: 'Surnaturel', value: 'Surnaturel' },
      ],
    },
  } satisfies Filters;
}

export default new VictorianNovelHousePlugin();
