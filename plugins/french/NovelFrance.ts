import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 3.3.0
 *
 * Fix v3.3 :
 *  - API /api/chapters limite à 100 par page (confirmé)
 *  - Pagination par batch de 100 avec retry + délai
 *  - Shadow Slave = 30 requêtes, roman de 50ch = 1 requête
 */

const BASE = 'https://novelfrance.fr';
const TAKE = 100; // Limite serveur confirmée

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
    const slug = slugFrom(novelPath);
    const url  = novelUrl(novelPath);

    const r = await fetchWithRetry(url, { headers: NAV_HEADERS });
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

  async parseChapter(chapterPath: string): Promise<string> {
    const r = await fetchWithRetry(
      BASE + '/novel' + chapterPath,
      { headers: NAV_HEADERS },
      3,
      1500,
    );
    if (!r.ok) throw new Error('Échec chapitre (status ' + r.status + ')');

    const html = await r.text();
    const rsc  = extractRSC(html);

    const ch = extractObject(rsc, 'initialChapter');
    if (ch && Array.isArray(ch.paragraphs) && ch.paragraphs.length > 0) {
      return '<p>' + ch.paragraphs
        .map((p: any) => (p.content || '').trim())
        .filter((l: string) => l.length > 0)
        .join('</p><p>') + '</p>';
    }

    const contentRe = /"content":"((?:[^"\\]|\\.)*)"/g;
    const lines: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = contentRe.exec(rsc)) !== null) {
      const l = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\').trim();
      if (l.length > 0) lines.push(l);
    }
    if (lines.length > 0) return '<p>' + lines.join('</p><p>') + '</p>';

    const pRe = /<p[^>]*class="[^"]*select-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    const htmlLines: string[] = [];
    while ((m = pRe.exec(html)) !== null) {
      const t = m[1].replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').trim();
      if (t) htmlLines.push(t);
    }
    if (htmlLines.length > 0) return '<p>' + htmlLines.join('</p><p>') + '</p>';

    throw new Error('Contenu introuvable — réessayez');
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
