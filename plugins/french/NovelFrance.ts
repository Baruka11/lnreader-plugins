import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

/**
 * Plugin LNReader — NovelFrance
 * Site    : https://novelfrance.fr
 * Version : 2.0.0
 *
 * Stratégie : scraping du payload SSR Next.js (__next_f)
 * Structure confirmée :
 *   - Page /novel/{slug}          → initialNovel + initialChaptersResponse
 *   - Page /novel/{slug}/{chap}   → initialChapter.paragraphs[].content
 *   - Pagination chapitres        → ?skip=N&take=50&order=desc
 */

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

function extractObject(rsc: string, fieldName: string): Record<string, any> | null {
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
  version = '2.0.0';
  filters = {} satisfies Filters;

  // -------------------------------------------------------------------------
  // popularNovels
  // -------------------------------------------------------------------------

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Page d'accueil pour la section popular, /latest pour les récents
    const url = showLatestNovels
      ? this.site + '/latest?page=' + pageNo
      : pageNo === 1
        ? this.site + '/'
        : this.site + '/browse?sort=popular&page=' + pageNo;

    const r = await fetchApi(url);
    if (!r.ok) return [];
    const html = await r.text();
    const rsc = extractRSC(html);

    const initialData = extractObject(rsc, 'initialData');

    // Page d'accueil : utiliser la section popular
    if (initialData && pageNo === 1 && !showLatestNovels) {
      const popular: any[] = initialData.popular || [];
      return popular.map(item => ({
        name: item.title || '',
        cover: this.buildCover(item.coverImage),
        path: '/novel/' + item.slug,
      }));
    }

    // Page /latest : utiliser recentlyAdded ou newChapters
    if (showLatestNovels && initialData) {
      const recent: any[] = initialData.recentlyAdded || [];
      return recent.map(item => ({
        name: item.title || '',
        cover: this.buildCover(item.coverImage),
        path: '/novel/' + item.slug,
      }));
    }

    // Fallback regex générique
    return this.parseNovelsFromRSC(rsc);
  }

  // -------------------------------------------------------------------------
  // parseNovel
  // -------------------------------------------------------------------------

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const r = await fetchApi(this.site + novelPath);
    if (!r.ok) throw new Error('Impossible de charger la page');
    const html = await r.text();
    const rsc = extractRSC(html);

    const novel: Plugin.SourceNovel = { path: novelPath, name: 'Untitled' };

    const data = extractObject(rsc, 'initialNovel');
    if (!data) {
      // Fallback meta tags
      const titleM = /<title>([^<]+)<\/title>/.exec(html);
      novel.name = titleM ? titleM[1].replace(/ - Lire.*$/, '').trim() : 'Untitled';
      const coverM = /<meta property="og:image" content="([^"]+)"/.exec(html);
      if (coverM) novel.cover = coverM[1];
      return novel;
    }

    novel.name   = data.title       || 'Untitled';
    novel.cover  = this.buildCover(data.coverImage);
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

    // Chapitres : pagination complète
    novel.chapters = await this.fetchAllChapters(data.slug || '');

    return novel;
  }

  // -------------------------------------------------------------------------
  // parseChapter
  // -------------------------------------------------------------------------

  async parseChapter(chapterPath: string): Promise<string> {
    // chapterPath = "/{novelSlug}/{chapterSlug}"
    const r = await fetchApi(this.site + '/novel' + chapterPath);
    if (!r.ok) throw new Error('Impossible de charger le chapitre');
    const html = await r.text();
    const rsc = extractRSC(html);

    // Stratégie 1 : initialChapter.paragraphs[].content (structure confirmée)
    const chapter = extractObject(rsc, 'initialChapter');
    if (chapter && Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0) {
      const lines: string[] = chapter.paragraphs
        .map((p: any) => (p.content || '').trim())
        .filter((l: string) => l.length > 0);
      return '<p>' + lines.join('</p><p>') + '</p>';
    }

    // Stratégie 2 : champs "content" dans le RSC brut
    const contentPattern = /"content":"((?:[^"\\]|\\.)*)"/g;
    const lines: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = contentPattern.exec(rsc)) !== null) {
      const line = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
      if (line.length > 0) lines.push(line);
    }
    if (lines.length > 0) return '<p>' + lines.join('</p><p>') + '</p>';

    // Stratégie 3 : balises HTML <p class="...select-text...">
    const pPattern = /<p[^>]*class="[^"]*select-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    const htmlLines: string[] = [];
    while ((m = pPattern.exec(html)) !== null) {
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
  // searchNovels
  // -------------------------------------------------------------------------

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      this.site + '/search?q=' + encodeURIComponent(searchTerm) +
      (pageNo > 1 ? '&page=' + pageNo : '');

    const r = await fetchApi(url);
    if (!r.ok) return [];
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

    return this.parseNovelsFromRSC(rsc);
  }

  // -------------------------------------------------------------------------
  // Méthodes utilitaires privées
  // -------------------------------------------------------------------------

  private buildCover(path: string | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    return this.site + path;
  }

  private mapStatus(s: string | undefined): string {
    if (!s) return NovelStatus.Unknown;
    const u = s.toUpperCase();
    if (u === 'ONGOING')   return NovelStatus.Ongoing;
    if (u === 'COMPLETED') return NovelStatus.Completed;
    return NovelStatus.Unknown;
  }

  private parseNovelsFromRSC(rsc: string): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const slugSet = new Set<string>();
    const pattern = /"title":"([^"]+)","slug":"([^"]+)","description":"[^"]*","coverImage":"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rsc)) !== null) {
      const slug = m[2];
      if (!slugSet.has(slug)) {
        slugSet.add(slug);
        novels.push({
          name: m[1],
          cover: this.buildCover(m[3]),
          path: '/novel/' + slug,
        });
      }
    }
    return novels;
  }

  /**
   * Récupère TOUS les chapitres d'un novel en paginant.
   * L'API renvoie 50 chapitres par page (ordre desc).
   * On trie en ASC à la fin pour LNReader.
   */
  private async fetchAllChapters(slug: string): Promise<Plugin.ChapterItem[]> {
    // Premier appel déjà fait dans parseNovel, on relit la page
    const r = await fetchApi(this.site + '/novel/' + slug);
    if (!r.ok) return [];
    const html = await r.text();
    const rsc = extractRSC(html);

    const resp = extractObject(rsc, 'initialChaptersResponse');
    if (!resp || !Array.isArray(resp.chapters)) return [];

    const total: number = resp.total || 0;
    const take: number  = resp.take  || 50;
    let all: any[]      = [...resp.chapters];

    // Paginer si nécessaire
    if (resp.hasMore && total > all.length) {
      const numPages = Math.ceil(total / take);
      for (let page = 1; page < numPages; page++) {
        if (all.length >= total) break;
        const skip = page * take;
        try {
          const pr = await fetchApi(
            this.site + '/novel/' + slug +
            '?skip=' + skip + '&take=' + take + '&order=desc',
          );
          if (!pr.ok) break;
          const pageHtml = await pr.text();
          const pageRsc  = extractRSC(pageHtml);
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
        name: 'Chapitre ' + c.chapterNumber + (c.title ? ' - ' + c.title : ''),
        path: '/' + slug + '/' + c.slug,
        releaseTime: c.createdAt || undefined,
        chapterNumber: index,
      }));
  }
}

export default new NovelFrancePlugin();
