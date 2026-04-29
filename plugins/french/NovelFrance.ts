import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 3.7.0
 *
 * Fix v3.3 :
 *  - API /api/chapters limite à 100 par page (confirmé)
 *  - Pagination par batch de 100 avec retry + délai
 *  - Shadow Slave = 30 requêtes, roman de 50ch = 1 requête
 */

const BASE = 'https://novelfrance.fr';
const TAKE = 100; // Limite serveur confirmée

const API_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Referer': BASE + '/',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  baseDelay = 1000,
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchApi(url, options);
      if (r.ok) return r;
      if ((r.status === 429 || r.status >= 500) && i < retries) {
        await sleep(baseDelay * Math.pow(2, i));
        continue;
      }
      return r;
    } catch (e) {
      if (i < retries) await sleep(baseDelay * Math.pow(2, i));
      else throw e;
    }
  }
  throw new Error('Max retries: ' + url);
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class NovelFrancePlugin implements Plugin.PluginBase {
  id = 'novelfrance';
  name = 'NovelFrance';
  icon = 'src/fr/novelfrance/icon.png';
  site = BASE;
  version = '3.3.0';
  filters = {} satisfies Filters;

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // API REST native — total: 408 romans, totalPages: 21, 20 par page
    const sort = showLatestNovels ? 'latest' : 'popular';
    const url = BASE + '/api/novels?page=' + pageNo + '&take=20&sort=' + sort;

    const r = await fetchWithRetry(url, { headers: API_HEADERS });
    if (!r.ok) return [];

    const json = await r.json() as any;
    const novels: any[] = json.novels || json.data || [];

    return novels.map(it => ({
      name: it.title || '',
      cover: cover(it.coverImage),
      path: '/novel/' + it.slug,
    }));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // API REST native avec pagination — totalPages: 21
    const url =
      BASE + '/api/novels?search=' + encodeURIComponent(searchTerm) +
      '&page=' + pageNo + '&take=20';

    const r = await fetchWithRetry(url, { headers: API_HEADERS });
    if (!r.ok) return [];

    const json = await r.json() as any;
    const novels: any[] = json.novels || json.data || [];

    return novels.map(it => ({
      name: it.title || '',
      cover: cover(it.coverImage),
      path: '/novel/' + it.slug,
    }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    // API REST native : /api/novels/{slug}
    const slug = slugFrom(novelPath);
    const r = await fetchWithRetry(
      BASE + '/api/novels/' + slug,
      { headers: API_HEADERS },
    );
    if (!r.ok) throw new Error('Echec chargement novel : ' + slug);

    const data = await r.json() as any;
    const novel: Plugin.SourceNovel = { path: novelPath, name: 'Untitled' };

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

    novel.chapters = await this.fetchChaptersApi(slug);
    return novel;
  }


  async parseChapter(chapterPath: string): Promise<string> {
    // chapterPath = "/{novelSlug}/{chapterSlug}"
    // API REST native : /api/chapters/{novelSlug}/{chapterSlug}
    // Retourne : { paragraphs: [{content}], content, prevChapter, nextChapter }
    const apiUrl = BASE + '/api/chapters' + chapterPath;

    const r = await fetchWithRetry(apiUrl, { headers: API_HEADERS }, 3, 1500);
    if (!r.ok) throw new Error('Echec chapitre (status ' + r.status + ')');

    const json = await r.json() as any;

    // Strategie 1 : paragraphs[].content (structure confirmee)
    if (Array.isArray(json.paragraphs) && json.paragraphs.length > 0) {
      return '<p>' + json.paragraphs
        .map((p: any) => (p.content || '').trim())
        .filter((l: string) => l.length > 0)
        .join('</p><p>') + '</p>';
    }

    // Strategie 2 : champ content direct
    if (typeof json.content === 'string' && json.content.trim().length > 0) {
      return json.content;
    }

    throw new Error('Contenu introuvable - reessayez');
  }

  // -------------------------------------------------------------------------
  // fetchChaptersApi — 100 chapitres par page, pagination complète
  // Exemple : Shadow Slave (2967 ch) = 30 requêtes
  //           Roman de 50 ch        = 1 requête
  // -------------------------------------------------------------------------

  private async fetchChaptersApi(slug: string): Promise<Plugin.ChapterItem[]> {
    // Récupérer le total d'abord
    let total = 0;
    try {
      const probe = await fetchWithRetry(
        BASE + '/api/chapters/' + slug + '?skip=0&take=1&order=asc',
        { headers: API_HEADERS },
      );
      if (probe.ok) {
        const j = await probe.json() as any;
        if (typeof j.total === 'number') total = j.total;
      }
    } catch (_) {}

    if (total === 0) return [];

    const numPages = Math.ceil(total / TAKE);
    let all: any[] = [];

    for (let page = 0; page < numPages; page++) {
      const skip = page * TAKE;
      try {
        const r = await fetchWithRetry(
          BASE + '/api/chapters/' + slug +
            '?skip=' + skip + '&take=' + TAKE + '&order=asc',
          { headers: API_HEADERS },
          3,
          1000,
        );
        if (!r.ok) break;
        const json = await r.json() as any;
        const batch: any[] = Array.isArray(json)
          ? json : (json.chapters || json.data || []);
        if (batch.length === 0) break;
        all = all.concat(batch);

        // Délai entre les pages pour éviter le rate-limit
        // ~300ms × 30 pages = ~9s pour Shadow Slave
        if (page < numPages - 1) await sleep(300);
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
