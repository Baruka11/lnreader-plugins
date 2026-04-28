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
  version = '1.1.0';

  // Votre userId world-novel.fr
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
    let entry = allNovels.find(n => n.id === novelId) || null;

    let chapters: Plugin.ChapterItem[] = [];
    try {
      const r = await fetchApi(this.site + novelPath);
      const html = await r.text();
      const raw = extractNextFlightData(html);

      const results: ChapterEntry[] = [];
      const re = /"id":"([^"]+)","title":"([^"]+)","date":(\d+),"volumeId":"([^"]+)","volumeDisplayName":"([^"]+)","chapterNumber":(\d+)/g;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();

      while ((m = re.exec(raw)) !== null) {
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
        results.sort((a, b) => a.chapterNumber - b.chapterNumber);
        chapters = results.map(c => this.chapterToItem(c, novelId));
      }
    } catch {}

    // Fallback : chapitres depuis l'accueil
    if (!chapters.length && entry) {
      chapters = entry.chapters.map(c => this.chapterToItem(c, novelId));
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
    // Extraire novelId, volumeId, chapterId depuis le path
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

        // Réponse HTML / texte brut
        if (text.length > 100) {
          // Si c'est du HTML, on le retourne directement
          if (text.trimStart().startsWith('<')) {
            return text;
          }
          // Sinon on enveloppe le texte brut dans des paragraphes
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

      // Fallback données RSC
      const raw = extractNextFlightData(html);
      const m = raw.match(/"(?:content|text|body)":"([\s\S]{200,}?)(?<!\\)"/);
      if (m) {
        return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
    } catch {}

    return '<p><em>Le contenu de ce chapitre est chargé dynamiquement. Veuillez l\'ouvrir dans le navigateur intégré.</em></p>';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const entries = await this.getHomeNovels();
    const q = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    return entries
      .filter(e => {
        const title = e.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
