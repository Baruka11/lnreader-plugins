import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 4.1.0
 *
 * Fix v3.1 : searchNovels retourne [] pour pageNo > 1 (pas de pagination
 * sur /search), évitant le crash "Network request failed" au scroll.
 */

const BASE = 'https://novelfrance.fr';

const NAV_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

const API_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Referer': BASE + '/',
};

// ---------------------------------------------------------------------------
// Extraction RSC
// ---------------------------------------------------------------------------

function extractRSC(html: string): string {
  const frags: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { frags.push(JSON.parse('"' + m[1] + '"') as string); } catch (_) {}
  }
  return frags.join('');
}

function extractObject(rsc: string, field: string): Record<string, any> | null {
  const key = '"' + field + '":{';
  const s = rsc.indexOf(key);
  if (s === -1) return null;
  let i = s + key.length, depth = 1;
  while (i < rsc.length && depth > 0) {
    if (rsc[i] === '{') depth++;
    else if (rsc[i] === '}') depth--;
    i++;
  }
  try { return JSON.parse('{' + rsc.slice(s + key.length, i)); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cover(path?: string): string {
  if (!path) return '';
  return path.startsWith('http') ? path : BASE + path;
}

function status(s?: string): string {
  if (!s) return NovelStatus.Unknown;
  const u = s.toUpperCase();
  if (u === 'ONGOING') return NovelStatus.Ongoing;
  if (u === 'COMPLETED') return NovelStatus.Completed;
  return NovelStatus.Unknown;
}

function slugFrom(p: string): string {
  return p.replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/novel\//, '').replace(/^\//, '').split('/')[0];
}

function novelUrl(p: string): string {
  if (p.startsWith('http')) return p;
  if (p.includes('/novel/')) return BASE + p;
  return BASE + '/novel/' + p.replace(/^\//, '');
}

function parseNovelsFromRSC(rsc: string): Plugin.NovelItem[] {
  const list: Plugin.NovelItem[] = [];
  const seen = new Set<string>();
  const re = /"title":"([^"]+)","slug":"([^"]+)"(?:[^}]*?)"coverImage":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rsc)) !== null) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      list.push({ name: m[1], cover: cover(m[3]), path: '/novel/' + m[2] });
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class NovelFrancePlugin implements Plugin.PluginBase {
  id = 'novelfrance';
  name = 'NovelFrance';
  icon = 'src/fr/novelfrance/icon.png';
  site = BASE;
  version = '3.1.0';
  filters = {} satisfies Filters;

  // -------------------------------------------------------------------------
  // popularNovels
  // -------------------------------------------------------------------------

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const url = showLatestNovels
      ? BASE + '/latest?page=' + pageNo
      : pageNo === 1 ? BASE + '/' : BASE + '/browse?sort=popular&page=' + pageNo;

    const r = await fetchApi(url, { headers: NAV_HEADERS });
    if (!r.ok) return [];
    const rsc = extractRSC(await r.text());

    const data = extractObject(rsc, 'initialData');
    if (data) {
      const list: any[] = showLatestNovels
        ? (data.recentlyAdded || [])
        : (data.popular || []);
      if (list.length > 0) {
        return list.map(it => ({
          name: it.title || '',
          cover: cover(it.coverImage),
          path: '/novel/' + it.slug,
        }));
      }
    }
    return parseNovelsFromRSC(rsc);
  }

  // -------------------------------------------------------------------------
  // searchNovels
  //
  // IMPORTANT : le site n'a pas de pagination de recherche côté SSR.
  // On retourne [] pour pageNo > 1 pour éviter le crash au scroll.
  // -------------------------------------------------------------------------

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Pas de pagination — une seule page de résultats
    if (pageNo > 1) return [];

    const term = searchTerm.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // Essai 1 : /search?q=
    try {
      const r = await fetchApi(
        BASE + '/search?q=' + encodeURIComponent(searchTerm),
        { headers: NAV_HEADERS },
      );
      if (r.ok) {
        const rsc = extractRSC(await r.text());
        const novels = parseNovelsFromRSC(rsc);
        if (novels.length > 0) {
          return novels.filter(n =>
            n.name.toLowerCase().normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '').includes(term),
          );
        }
      }
    } catch (_) {}

    // Essai 2 : /browse?q=
    try {
      const r = await fetchApi(
        BASE + '/browse?q=' + encodeURIComponent(searchTerm),
        { headers: NAV_HEADERS },
      );
      if (r.ok) {
        const rsc = extractRSC(await r.text());
        return parseNovelsFromRSC(rsc).filter(n =>
          n.name.toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').includes(term),
        );
      }
    } catch (_) {}

    return [];
  }

  // -------------------------------------------------------------------------
  // parseNovel
  // -------------------------------------------------------------------------

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = slugFrom(novelPath);
    const url  = novelUrl(novelPath);

    const r = await fetchApi(url, { headers: NAV_HEADERS });
    if (!r.ok) throw new Error('Échec chargement : ' + url);
    const html = await r.text();
    const rsc  = extractRSC(html);

    const novel: Plugin.SourceNovel = { path: novelPath, name: 'Untitled' };
    const data = extractObject(rsc, 'initialNovel');

    if (data) {
      novel.name    = data.title       || 'Untitled';
      novel.cover   = cover(data.coverImage);
      novel.summary = data.description || '';
      novel.author  = data.author      || '';
      novel.artist  = data.translatorName
        ? 'Traducteur : ' + data.translatorName : '';
      novel.status  = status(data.status);
      if (Array.isArray(data.genres)) {
        novel.genres = data.genres
          .map((g: any) => (typeof g === 'string' ? g : g.name))
          .filter(Boolean).join(',');
      }
    } else {
      const tm = /<title>([^<]+)<\/title>/.exec(html);
      novel.name = tm ? tm[1].replace(/ - Lire.*$/, '').trim() : 'Untitled';
      const cm = /<meta property="og:image" content="([^"]+)"/.exec(html);
      if (cm) novel.cover = cm[1];
      const dm = /<meta name="description" content="([^"]+)"/.exec(html);
      if (dm) novel.summary = dm[1];
    }

    novel.chapters = await this.fetchChaptersApi(slug);
    return novel;
  }

  // -------------------------------------------------------------------------
  // parseChapter
  // -------------------------------------------------------------------------

  async parseChapter(chapterPath: string): Promise<string> {
    const r = await fetchApi(BASE + '/novel' + chapterPath, {
      headers: NAV_HEADERS,
    });
    if (!r.ok) throw new Error('Échec chargement chapitre');
    const html = await r.text();
    const rsc  = extractRSC(html);

    // Stratégie 1 : initialChapter.paragraphs[].content
    const ch = extractObject(rsc, 'initialChapter');
    if (ch && Array.isArray(ch.paragraphs) && ch.paragraphs.length > 0) {
      const lines: string[] = ch.paragraphs
        .map((p: any) => (p.content || '').trim())
        .filter((l: string) => l.length > 0);
      return '<p>' + lines.join('</p><p>') + '</p>';
    }

    // Stratégie 2 : champs "content" bruts
    const contentRe = /"content":"((?:[^"\\]|\\.)*)"/g;
    const lines: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = contentRe.exec(rsc)) !== null) {
      const l = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\').trim();
      if (l.length > 0) lines.push(l);
    }
    if (lines.length > 0) return '<p>' + lines.join('</p><p>') + '</p>';

    // Stratégie 3 : balises HTML
    const pRe = /<p[^>]*class="[^"]*select-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    const htmlLines: string[] = [];
    while ((m = pRe.exec(html)) !== null) {
      const t = m[1].replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').trim();
      if (t) htmlLines.push(t);
    }
    return '<p>' + htmlLines.join('</p><p>') + '</p>';
  }

  // -------------------------------------------------------------------------
  // fetchChaptersApi — API REST native /api/chapters/{slug}
  //
  // Charge tout en une passe avec un take élevé pour éviter les boucles
  // de 60+ requêtes qui saturent la mémoire sur mobile.
  // -------------------------------------------------------------------------

  private async fetchChaptersApi(slug: string): Promise<Plugin.ChapterItem[]> {
    // Étape 1 : récupérer le total depuis la première page (take=1)
    let total = 9999;
    try {
      const probe = await fetchApi(
        BASE + '/api/chapters/' + slug + '?skip=0&take=1&order=asc',
        { headers: API_HEADERS },
      );
      if (probe.ok) {
        const j = await probe.json() as any;
        if (typeof j.total === 'number') total = j.total;
      }
    } catch (_) {}

    // Étape 2 : tout charger en une seule requête
    try {
      const r = await fetchApi(
        BASE + '/api/chapters/' + slug +
          '?skip=0&take=' + total + '&order=asc',
        { headers: API_HEADERS },
      );
      if (r.ok) {
        const json = await r.json() as any;
        const chapters: any[] = Array.isArray(json)
          ? json
          : (json.chapters || json.data || []);

        if (chapters.length > 0) {
          return this.formatChapters(slug, chapters);
        }
      }
    } catch (_) {}

    // Fallback : pagination par batch de 50 avec délai
    return this.fetchChaptersPaged(slug, total);
  }

  private async fetchChaptersPaged(
    slug: string,
    total: number,
  ): Promise<Plugin.ChapterItem[]> {
    const TAKE = 50;
    let all: any[] = [];
    let skip = 0;

    while (skip < total) {
      try {
        const r = await fetchApi(
          BASE + '/api/chapters/' + slug +
            '?skip=' + skip + '&take=' + TAKE + '&order=asc',
          { headers: API_HEADERS },
        );
        if (!r.ok) break;
        const json = await r.json() as any;
        const batch: any[] = Array.isArray(json)
          ? json : (json.chapters || json.data || []);
        if (batch.length === 0) break;
        all = all.concat(batch);
        skip += TAKE;
        // Petit délai pour ne pas saturer
        await new Promise(res => setTimeout(res, 200));
      } catch (_) {
        break;
      }
    }

    return this.formatChapters(slug, all);
  }

  private formatChapters(slug: string, chapters: any[]): Plugin.ChapterItem[] {
    const seen = new Set<number>();
    return chapters
      .filter(c => {
        if (seen.has(c.chapterNumber)) return false;
        seen.add(c.chapterNumber);
        return true;
      })
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .map((c, i) => ({
        name: 'Chapitre ' + c.chapterNumber + (c.title ? ' - ' + c.title : ''),
        path: '/' + slug + '/' + c.slug,
        releaseTime: c.createdAt || undefined,
        chapterNumber: i,
      }));
  }
}

export default new NovelFrancePlugin();
