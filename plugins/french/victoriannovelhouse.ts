import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

// ─────────────────────────────────────────────────────────────
// Helpers – extraction des données Next.js SSR
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

function parseNovelsFromRSC(raw: string): NovelEntry[] {
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
    return JSON.parse(raw.slice(arrStart, end)) as NovelEntry[];
  } catch {
    return [];
  }
}

/**
 * Extrait tous les chapitres depuis le RSC, indépendamment de l'ordre des clés JSON.
 */
function parseChaptersFromRSC(raw: string): ChapterEntry[] {
  const results: ChapterEntry[] = [];
  const seen = new Set<string>();

  // Stratégie 1 : parser les blocs JSON complets contenant "chapterNumber"
  const chapterBlockRe = /\{[^{}]*"chapterNumber"\s*:\s*\d+[^{}]*\}/g;
  let m: RegExpExecArray | null;

  while ((m = chapterBlockRe.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      const id = obj.id;
      const volumeId = obj.volumeId;
      const chapterNumber = obj.chapterNumber;

      if (!id || !volumeId || typeof chapterNumber !== 'number') continue;
      if (seen.has(id)) continue;
      seen.add(id);

      results.push({
        id,
        title: obj.title || id,
        date: obj.date || 0,
        volumeId,
        volumeDisplayName: obj.volumeDisplayName || '',
        chapterNumber,
      });
    } catch {}
  }

  // Stratégie 2 (fallback) : extraction par regex champ par champ
  if (results.length === 0) {
    const chunkSize = 600;
    const idRe = /"id"\s*:\s*"([^"]+)"/g;
    let idMatch: RegExpExecArray | null;

    while ((idMatch = idRe.exec(raw)) !== null) {
      const start = Math.max(0, idMatch.index - 100);
      const end = Math.min(raw.length, idMatch.index + chunkSize);
      const chunk = raw.slice(start, end);

      const chapterNumMatch = chunk.match(/"chapterNumber"\s*:\s*(\d+)/);
      const volumeIdMatch = chunk.match(/"volumeId"\s*:\s*"([^"]+)"/);
      if (!chapterNumMatch || !volumeIdMatch) continue;

      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
      const dateMatch = chunk.match(/"date"\s*:\s*(\d+)/);
      const volumeDisplayMatch = chunk.match(/"volumeDisplayName"\s*:\s*"([^"]+)"/);

      results.push({
        id,
        title: titleMatch ? titleMatch[1] : id,
        date: dateMatch ? parseInt(dateMatch[1]) : 0,
        volumeId: volumeIdMatch[1],
        volumeDisplayName: volumeDisplayMatch ? volumeDisplayMatch[1] : '',
        chapterNumber: parseInt(chapterNumMatch[1]),
      });
    }
  }

  return results.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

// ─────────────────────────────────────────────────────────────
// Types internes
// ─────────────────────────────────────────────────────────────

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
  chapters: ChapterEntry[];
  dateMaj: number;
  genre: string;
  status: string;
  totalChapters: number;
  lastChapterNb: number;
  auteur: string;
  tags: string[];
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

class VictorianNovelHousePlugin implements Plugin.PluginBase {
  id = 'victoriannovelhouse';
  name = 'Victorian Novel House';
  icon = 'src/fr/victoriannovelhouse/icon.png';
  site = 'https://world-novel.fr';
  version = '1.2.0';

  private userId = 'FMWkEHmNArbpfkfgEb4xjNbCbL73';
  private cdnBase = 'https://cdn.world-novel.fr/chapitres';

  private cachedNovels: NovelEntry[] | null = null;

  private async getHomeNovels(): Promise<NovelEntry[]> {
    if (this.cachedNovels) return this.cachedNovels;
    const r = await fetchApi(this.site + '/');
    const html = await r.text();
    const raw = extractNextFlightData(html);
    this.cachedNovels = parseNovelsFromRSC(raw);
    return this.cachedNovels;
  }

  private chapterToItem(c: ChapterEntry, novelId: string): Plugin.ChapterItem {
    return {
      name: c.title || c.id,
      path: `/lecture/${novelId}/volumes/${encodeURIComponent(c.volumeId)}/chapitres/${encodeURIComponent(c.id)}`,
      releaseTime: c.date ? new Date(c.date).toISOString() : undefined,
      chapterNumber: c.chapterNumber,
    };
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

    const allNovels = await this.getHomeNovels();
    const entry = allNovels.find(n => n.id === novelId) || null;

    let chapters: Plugin.ChapterItem[] = [];

    try {
      const r = await fetchApi(this.site + novelPath);
      const html = await r.text();
      const raw = extractNextFlightData(html);
      const parsed = parseChaptersFromRSC(raw);

      if (parsed.length > 0) {
        chapters = parsed.map(c => this.chapterToItem(c, novelId));
      }
    } catch {}

    // Fallback : chapitres depuis la page d'accueil
    if (!chapters.length && entry?.chapters?.length) {
      chapters = [...entry.chapters]
        .sort((a, b) => a.chapterNumber - b.chapterNumber)
        .map(c => this.chapterToItem(c, novelId));
    }

    if (!entry) {
      return { path: novelPath, name: novelId, chapters };
    }

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
        const text = await r.text();

        // Réponse JSON
        try {
          const json = JSON.parse(text);
          const content = json.content ?? json.text ?? json.body ?? json.html ?? '';
          if (typeof content === 'string' && content.length > 100) {
            return content.replace(/\\n/g, '\n').replace(/\\"/g, '"');
          }
        } catch {}

        // Réponse HTML brut
        if (text.trimStart().startsWith('<') && text.length > 100) {
          return text;
        }

        // Texte brut → paragraphes
        if (text.length > 100) {
          return text
            .split('\n')
            .filter(l => l.trim())
            .map(l => `<p>${l.trim()}</p>`)
            .join('\n');
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
