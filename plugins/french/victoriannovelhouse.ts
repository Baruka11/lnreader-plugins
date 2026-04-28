import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

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
  auteur: string;
  tags: string[];
}

function extractNextFlightData(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse('"' + m[1] + '"')); }
    catch { parts.push(m[1]); }
  }
  return parts.join('');
}

function parseNovelsFromRSC(raw: string): HomeNovelEntry[] {
  const marker = '"novels":[{';
  const idx = raw.indexOf(marker);
  if (idx === -1) return [];
  const arrStart = idx + '"novels":'.length;
  let depth = 0, inStr = false, escape = false;
  for (let i = arrStart; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(arrStart, i + 1)) as HomeNovelEntry[]; }
        catch { return []; }
      }
    }
  }
  return [];
}

function parseVolumesFromRSC(raw: string): RawVolume[] {
  const marker = '"volumes":[{"volumeId"';
  const idx = raw.indexOf(marker);
  if (idx === -1) return [];
  const arrStart = raw.indexOf('[', idx + '"volumes":'.length);
  if (arrStart === -1) return [];
  let depth = 0, inStr = false, escape = false;
  for (let i = arrStart; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(arrStart, i + 1)) as RawVolume[]; }
        catch { return []; }
      }
    }
  }
  return [];
}

function parseOeuvreMetaFromRSC(raw: string) {
  const meta: { title?: string; image?: string; description?: string; auteur?: string; genre?: string } = {};
  const titleM = raw.match(/"title"\s*:\s*"([^"]+)"/); if (titleM) meta.title = titleM[1];
  const imgM = raw.match(/"image"\s*:\s*"(https:\/\/cdn\.world-novel\.fr\/images\/cover\/[^"]+)"/); if (imgM) meta.image = imgM[1];
  const autM = raw.match(/"auteur"\s*:\s*"([^"]+)"/); if (autM) meta.auteur = autM[1];
  const genM = raw.match(/"genre"\s*:\s*"([^"]+)"/); if (genM) meta.genre = genM[1];
  const desM = raw.match(/"description"\s*:\s*"([\s\S]+?)(?<!\\)"/); if (desM) meta.description = desM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return meta;
}

class VictorianNovelHousePlugin implements Plugin.PluginBase {
  id = 'victoriannovelhouse';
  name = 'Victorian Novel House';
  icon = 'src/fr/victoriannovelhouse/icon.png';
  site = 'https://world-novel.fr';
  version = '1.6.0-debug';

  private userId = 'FMWkEHmNArbpfkfgEb4xjNbCbL73';
  private cdnBase = 'https://cdn.world-novel.fr/chapitres';
  private cachedNovels: HomeNovelEntry[] | null = null;

  private async getHomeNovels(): Promise<HomeNovelEntry[]> {
    if (this.cachedNovels) return this.cachedNovels;
    try {
      const r = await fetchApi(this.site + '/');
      const html = await r.text();
      const raw = extractNextFlightData(html);
      this.cachedNovels = parseNovelsFromRSC(raw);
    } catch { this.cachedNovels = []; }
    return this.cachedNovels;
  }

  async popularNovels(pageNo: number, { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const entries = await this.getHomeNovels();
    if (!entries.length) return [];
    const sorted = showLatestNovels
      ? [...entries].sort((a, b) => b.dateMaj - a.dateMaj)
      : [...entries].sort((a, b) => b.rating - a.rating);
    return sorted.map(e => ({ name: e.title, path: `/oeuvres/${e.id}`, cover: e.image }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelId = novelPath.replace('/oeuvres/', '');
    try {
      const r = await fetchApi(this.site + novelPath);
      const html = await r.text();
      const raw = extractNextFlightData(html);
      const meta = parseOeuvreMetaFromRSC(raw);
      const volumes = parseVolumesFromRSC(raw);
      if (volumes.length > 0) {
        const orderedVolumes = [...volumes].reverse();
        const chapters: Plugin.ChapterItem[] = [];
        let n = 1;
        for (const vol of orderedVolumes) {
          const sorted = [...vol.chapters].sort((a, b) => (a.ts || 0) - (b.ts || 0));
          for (const ch of sorted) {
            chapters.push({
              name: ch.title || ch.id,
              path: `/lecture/${novelId}/volumes/${encodeURIComponent(ch.volumeId)}/chapitres/${encodeURIComponent(ch.id)}`,
              releaseTime: ch.ts ? new Date(ch.ts).toISOString() : undefined,
              chapterNumber: n++,
            });
          }
        }
        return { path: novelPath, name: meta.title || novelId, cover: meta.image, summary: meta.description, author: meta.auteur, genres: meta.genre, status: NovelStatus.Unknown, chapters };
      }
    } catch {}
    const allNovels = await this.getHomeNovels();
    const entry = allNovels.find(n => n.id === novelId);
    if (!entry) return { path: novelPath, name: novelId, chapters: [] };
    const chapters = [...entry.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber).map((c, i) => ({
      name: c.title || c.id,
      path: `/lecture/${novelId}/volumes/${encodeURIComponent(c.volumeId)}/chapitres/${encodeURIComponent(c.id)}`,
      releaseTime: c.date ? new Date(c.date).toISOString() : undefined,
      chapterNumber: c.chapterNumber || i + 1,
    }));
    return { path: novelPath, name: entry.title, cover: entry.image, summary: entry.desc, author: entry.auteur, genres: entry.genre, status: NovelStatus.Unknown, chapters };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const debugLines: string[] = [`<h3>DEBUG parseChapter</h3>`, `<p>chapterPath = <code>${chapterPath}</code></p>`];

    const match = chapterPath.match(/\/lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/([^/]+)/);

    if (!match) {
      debugLines.push(`<p>❌ Regex non matchée</p>`);
    } else {
      const [, novelId, volumeId, chapterId] = match;
      debugLines.push(`<p>novelId = ${novelId}<br>volumeId = ${volumeId}<br>chapterId = ${chapterId}</p>`);

      // Test CDN
      const cdnUrl = `${this.cdnBase}/?path=${novelId}/${volumeId}/${chapterId}&userId=${this.userId}`;
      debugLines.push(`<p>CDN URL = <code>${cdnUrl}</code></p>`);

      try {
        const r = await fetchApi(cdnUrl);
        debugLines.push(`<p>CDN status = ${r.status}</p>`);
        const text = await r.text();
        debugLines.push(`<p>CDN réponse (200 premiers chars) = <code>${text.slice(0, 200).replace(/</g, '&lt;')}</code></p>`);

        if (r.ok && text.length > 100) {
          // Tenter JSON
          try {
            const json = JSON.parse(text);
            const keys = Object.keys(json).join(', ');
            debugLines.push(`<p>JSON keys = ${keys}</p>`);
            const content = json.content ?? json.text ?? json.body ?? json.html ?? json.data ?? '';
            if (typeof content === 'string' && content.length > 50) {
              return content.replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
            // Chercher récursivement une longue chaîne
            for (const [k, v] of Object.entries(json)) {
              if (typeof v === 'string' && v.length > 100) {
                debugLines.push(`<p>Contenu trouvé dans clé "${k}"</p>`);
                return (v as string).replace(/\\n/g, '\n').replace(/\\"/g, '"');
              }
            }
          } catch {
            debugLines.push(`<p>Pas du JSON</p>`);
          }

          if (text.trimStart().startsWith('<')) {
            debugLines.push(`<p>Réponse HTML directe</p>`);
            return text;
          }

          if (text.length > 100) {
            return text.split('\n').filter(l => l.trim()).map(l => `<p>${l.trim()}</p>`).join('\n');
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        debugLines.push(`<p>❌ Erreur CDN : ${msg}</p>`);
      }

      // Test page web
      const webUrl = this.site + chapterPath;
      debugLines.push(`<p>Fallback page web : <code>${webUrl}</code></p>`);
      try {
        const r2 = await fetchApi(webUrl);
        debugLines.push(`<p>Web status = ${r2.status}</p>`);
        const html = await r2.text();
        debugLines.push(`<p>HTML length = ${html.length}</p>`);
        const $ = load(html);
        for (const sel of ['.chapter-content', '[class*="chapterContent"]', '[class*="chapter-text"]', '.prose', 'article', 'main']) {
          const el = $(sel);
          if (el.length && el.text().trim().length > 200) {
            debugLines.push(`<p>✅ Contenu trouvé via sélecteur CSS "${sel}"</p>`);
            return `${debugLines.join('\n')}\n<hr>${el.html() || ''}`;
          }
        }
        debugLines.push(`<p>Aucun sélecteur CSS n'a trouvé de contenu</p>`);
        const raw = extractNextFlightData(html);
        debugLines.push(`<p>RSC length = ${raw.length}</p>`);
        const contentM = raw.match(/"(?:content|text|body|html)"\s*:\s*"([\s\S]{200,}?)(?<!\\)"/);
        if (contentM) {
          debugLines.push(`<p>✅ Contenu trouvé dans RSC</p>`);
          return contentM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
        debugLines.push(`<p>Extrait RSC (500 chars) = <code>${raw.slice(0, 500).replace(/</g, '&lt;')}</code></p>`);
      } catch (e2: unknown) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        debugLines.push(`<p>❌ Erreur web : ${msg}</p>`);
      }
    }

    return debugLines.join('\n');
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const entries = await this.getHomeNovels();
    const q = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return entries.filter(e => {
      const title = e.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return title.includes(q) || (e.auteur || '').toLowerCase().includes(q);
    }).map(e => ({ name: e.title, path: `/oeuvres/${e.id}`, cover: e.image }));
  }

  filters = {
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      value: '',
      options: [{ label: 'Tous', value: '' }],
    },
  } satisfies Filters;
}

export default new VictorianNovelHousePlugin();
