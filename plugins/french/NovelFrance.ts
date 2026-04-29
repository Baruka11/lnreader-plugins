import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 2.2.0
 *
 * Le site Next.js injecte les données via __next_f.push() dans les scripts SSR.
 * Un User-Agent navigateur est nécessaire pour contourner Cloudflare/protections.
 */

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

// ---------------------------------------------------------------------------
// Extraction du payload RSC Next.js
// ---------------------------------------------------------------------------

function extractRSC(html: string): string {
  const fragments: string[] = [];
  const regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    try {
      fragments.push(JSON.parse('"' + m[1] + '"') as string);
    } catch (_) {}
  }
  return fragments.join('');
}

function extractObject(
  rsc: string,
  fieldName: string,
): Record<string, any> | null {
  const key = '"' + fieldName + '":{';
  const start = rsc.indexOf(key);
  if (start === -1) return null;
  let i = start + key.length;
  let depth = 1;
  while (i < rsc.length && depth > 0) {
    if (rsc[i] === '{') depth++;
    else if (rsc[i] === '}') depth--;
    i++;
  }
  try {
    return JSON.parse('{' + rsc.slice(start + key.length, i));
  } catch (_) {
    return null;
  }
}

function extractArray(rsc: string, fieldName: string): any[] | null {
  const key = '"' + fieldName + '":[';
  const start = rsc.indexOf(key);
  if (start === -1) return null;
  let i = start + key.length;
  let depth = 1;
  while (i < rsc.length && depth > 0) {
    if (rsc[i] === '[') depth++;
    else if (rsc[i] === ']') depth--;
    i++;
  }
  try {
    return JSON.parse('[' + rsc.slice(start + key.length, i));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class NovelFrancePlugin implements Plugin.PluginBase {
  id = 'novelfrance';
  name = 'NovelFrance';
  icon = 'src/fr/novelfrance/icon.png';
  site = 'https://novelfrance.fr';
  version = '2.2.0';
  filters = {} satisfies Filters;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildCover(path: string | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    return this.site + path;
  }

  private mapStatus(s: string | undefined): string {
    if (!s) return NovelStatus.Unknown;
    const u = s.toUpperCase();
    if (u === 'ONGOING') return NovelStatus.Ongoing;
    if (u === 'COMPLETED') return NovelStatus.Completed;
    return NovelStatus.Unknown;
  }

  /** Retourne l'URL complète d'une page novel quel que soit le format du path. */
  private novelUrl(novelPath: string): string {
    if (novelPath.startsWith('http')) return novelPath;
    if (novelPath.includes('/novel/')) return this.site + novelPath;
    return this.site + '/novel/' + novelPath.replace(/^\//, '');
  }

  /** Extrait le slug depuis n'importe quel format de path. */
  private slug(novelPath: string): string {
    return novelPath
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/novel\//, '')
      .replace(/^\//, '')
      .split('/')[0];
  }

  private parseNovelsFromRSC(rsc: string): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();
    // Cherche les paires titre/slug/cover dans le RSC
    const re =
      /"title":"([^"]+)","slug":"([^"]+)"(?:[^}]*?)"coverImage":"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rsc)) !== null) {
      const slug = m[2];
      if (!seen.has(slug)) {
        seen.add(slug);
        novels.push({
          name: m[1],
          cover: this.buildCover(m[3]),
          path: '/novel/' + slug,
        });
      }
    }
    return novels;
  }

  // -------------------------------------------------------------------------
  // popularNovels
  // -------------------------------------------------------------------------

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const url = showLatestNovels
      ? this.site + '/latest?page=' + pageNo
      : pageNo === 1
        ? this.site + '/'
        : this.site + '/browse?sort=popular&page=' + pageNo;

    const r = await fetchApi(url, { headers: HEADERS });
    if (!r.ok) return [];
    const html = await r.text();
    const rsc = extractRSC(html);

    const initialData = extractObject(rsc, 'initialData');
    if (initialData) {
      const list: any[] = showLatestNovels
        ? initialData.recentlyAdded || []
        : initialData.popular || [];
      if (list.length > 0) {
        return list.map(item => ({
          name: item.title || '',
          cover: this.buildCover(item.coverImage),
          path: '/novel/' + item.slug,
        }));
      }
    }

    return this.parseNovelsFromRSC(rsc);
  }

  // -------------------------------------------------------------------------
  // searchNovels
  // -------------------------------------------------------------------------

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const term = searchTerm
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // Essai 1 : /search?q=...
    try {
      const r = await fetchApi(
        this.site + '/search?q=' + encodeURIComponent(searchTerm),
        { headers: HEADERS },
      );
      if (r.ok) {
        const html = await r.text();
        const rsc = extractRSC(html);
        const items =
          extractArray(rsc, 'novels') ||
          extractArray(rsc, 'results') ||
          [];
        if (items.length > 0) {
          return items.map((item: any) => ({
            name: item.title || '',
            cover: this.buildCover(item.coverImage),
            path: '/novel/' + item.slug,
          }));
        }
        const fromRsc = this.parseNovelsFromRSC(rsc);
        if (fromRsc.length > 0) {
          return fromRsc.filter(n =>
            n.name.toLowerCase().normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .includes(term),
          );
        }
      }
    } catch (_) {}

    // Essai 2 : /browse?q=...
    try {
      const r = await fetchApi(
        this.site + '/browse?q=' + encodeURIComponent(searchTerm),
        { headers: HEADERS },
      );
      if (r.ok) {
        const html = await r.text();
        const rsc = extractRSC(html);
        const novels = this.parseNovelsFromRSC(rsc);
        return novels.filter(n =>
          n.name.toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .includes(term),
        );
      }
    } catch (_) {}

    return [];
  }

  // -------------------------------------------------------------------------
  // parseNovel
  // -------------------------------------------------------------------------

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.novelUrl(novelPath);
    const slug = this.slug(novelPath);

    const r = await fetchApi(url, { headers: HEADERS });
    if (!r.ok) throw new Error('Échec chargement : ' + url);
    const html = await r.text();
    const rsc = extractRSC(html);

    const novel: Plugin.SourceNovel = { path: novelPath, name: 'Untitled' };

    const data = extractObject(rsc, 'initialNovel');
    if (!data) {
      // Fallback meta tags HTML
      const titleM = /<title>([^<]+)<\/title>/.exec(html);
      novel.name = titleM
        ? titleM[1].replace(/ - Lire.*$/, '').trim()
        : 'Untitled';
      const coverM = /<meta property="og:image" content="([^"]+)"/.exec(html);
      if (coverM) novel.cover = coverM[1];
      const descM = /<meta name="description" content="([^"]+)"/.exec(html);
      if (descM) novel.summary = descM[1];
      novel.chapters = await this.fetchAllChapters(slug);
      return novel;
    }

    novel.name    = data.title       || 'Untitled';
    novel.cover   = this.buildCover(data.coverImage);
    novel.summary = data.description || '';
    novel.author  = data.author      || '';
    novel.artist  = data.translatorName
      ? 'Traducteur : ' + data.translatorName
      : '';
    novel.status  = this.mapStatus(data.status);

    if (Array.isArray(data.genres)) {
      novel.genres = data.genres
        .map((g: any) => (typeof g === 'string' ? g : g.name))
        .filter(Boolean)
        .join(',');
    }

    novel.chapters = await this.fetchAllChapters(slug, rsc);
    return novel;
  }

  // -------------------------------------------------------------------------
  // parseChapter
  // -------------------------------------------------------------------------

  async parseChapter(chapterPath: string): Promise<string> {
    // chapterPath = "/{novelSlug}/{chapterSlug}"
    const r = await fetchApi(this.site + '/novel' + chapterPath, {
      headers: HEADERS,
    });
    if (!r.ok) throw new Error('Échec chargement chapitre');
    const html = await r.text();
    const rsc = extractRSC(html);

    // Stratégie 1 : initialChapter.paragraphs[].content
    const chapter = extractObject(rsc, 'initialChapter');
    if (
      chapter &&
      Array.isArray(chapter.paragraphs) &&
      chapter.paragraphs.length > 0
    ) {
      const lines: string[] = chapter.paragraphs
        .map((p: any) => (p.content || '').trim())
        .filter((l: string) => l.length > 0);
      return '<p>' + lines.join('</p><p>') + '</p>';
    }

    // Stratégie 2 : champs "content" dans le RSC brut
    const contentRe = /"content":"((?:[^"\\]|\\.)*)"/g;
    const lines: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = contentRe.exec(rsc)) !== null) {
      const line = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
      if (line.length > 0) lines.push(line);
    }
    if (lines.length > 0) return '<p>' + lines.join('</p><p>') + '</p>';

    // Stratégie 3 : scraping HTML
    const pRe = /<p[^>]*class="[^"]*select-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    const htmlLines: string[] = [];
    while ((m = pRe.exec(html)) !== null) {
      const text = m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      if (text) htmlLines.push(text);
    }
    return '<p>' + htmlLines.join('</p><p>') + '</p>';
  }

  // -------------------------------------------------------------------------
  // fetchAllChapters — pagination complète
  // -------------------------------------------------------------------------

  private async fetchAllChapters(
    slug: string,
    existingRsc?: string,
  ): Promise<Plugin.ChapterItem[]> {
    let rsc = existingRsc;

    // Si on n'a pas encore le RSC, on charge la page
    if (!rsc) {
      const r = await fetchApi(this.site + '/novel/' + slug, {
        headers: HEADERS,
      });
      if (!r.ok) return [];
      const html = await r.text();
      rsc = extractRSC(html);
    }

    const resp = extractObject(rsc, 'initialChaptersResponse');
    if (!resp || !Array.isArray(resp.chapters)) return [];

    const total: number = resp.total || 0;
    const take: number  = resp.take  || 50;
    let all: any[]      = [...resp.chapters];

    // Paginer pour récupérer tous les chapitres
    if (resp.hasMore && total > all.length) {
      const numPages = Math.ceil(total / take);
      for (let page = 1; page < numPages; page++) {
        if (all.length >= total) break;
        const skip = page * take;
        try {
          const pr = await fetchApi(
            this.site + '/novel/' + slug +
              '?skip=' + skip + '&take=' + take + '&order=desc',
            { headers: HEADERS },
          );
          if (!pr.ok) break;
          const pageRsc = extractRSC(await pr.text());
          const pageData = extractObject(pageRsc, 'initialChaptersResponse');
          if (pageData && Array.isArray(pageData.chapters)) {
            all = all.concat(pageData.chapters);
          }
        } catch (_) {
          break;
        }
      }
    }

    // Dédoublonnage + tri ASC
    const seen = new Set<number>();
    return all
      .filter(c => {
        if (seen.has(c.chapterNumber)) return false;
        seen.add(c.chapterNumber);
        return true;
      })
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .map((c, index) => ({
        name:
          'Chapitre ' + c.chapterNumber + (c.title ? ' - ' + c.title : ''),
        path: '/' + slug + '/' + c.slug,
        releaseTime: c.createdAt || undefined,
        chapterNumber: index,
      }));
  }
}

export default new NovelFrancePlugin();
