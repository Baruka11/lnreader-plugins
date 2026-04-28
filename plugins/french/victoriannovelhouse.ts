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

interface MetaToken {
  visible: string[];
  hidden: string[];
  hiddenSpace: string[];
  fake: string[];
  key: string;
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

/**
 * Décode le token meta base64 → MetaToken
 */
function decodeMetaToken(metaB64: string): MetaToken | null {
  try {
    const decoded = atob(decodeURIComponent(metaB64));
    return JSON.parse(decoded) as MetaToken;
  } catch {
    return null;
  }
}

/**
 * Reconstruit le texte depuis le HTML obfusqué en utilisant les classes "visible".
 *
 * Structure HTML CDN :
 *   <div class="chapter-obf">
 *     <h2>...</h2>
 *     <span class="CLS">lettre</span>
 *     <span class="CLS">lettre</span>
 *     <br>
 *     ...
 *   </div>
 *
 * Chaque span contient UNE lettre. Les classes dans meta.visible sont celles à garder.
 * Les classes dans meta.hiddenSpace correspondent à des espaces cachés.
 * On ignore hidden et fake.
 */
function extractObfuscatedContent(html: string, meta: MetaToken): string {
  const $ = load(html);
  const visibleSet = new Set(meta.visible);

  const container = $('.chapter-obf');
  if (!container.length) return '';

  const paragraphs: string[] = [];
  let currentText = '';
  let inEm = false;

  // Parcourir tous les nœuds enfants de .chapter-obf
  container.contents().each((_, node) => {
    if (node.type === 'tag') {
      const tag = (node as cheerio.TagElement).name;

      if (tag === 'br') {
        // Fin de paragraphe : on flush
        const trimmed = currentText.trim();
        if (trimmed) {
          if (inEm) {
            paragraphs.push(`<p><em>${trimmed}</em></p>`);
          } else {
            paragraphs.push(`<p>${trimmed}</p>`);
          }
          currentText = '';
          inEm = false;
        }
        return;
      }

      if (tag === 'span') {
        const cls = ($(node).attr('class') || '').trim();
        if (visibleSet.has(cls)) {
          currentText += $(node).text();
        }
        // hidden, hiddenSpace, fake → ignorés
        return;
      }

      if (tag === 'em') {
        // Balise italique : extraire ses spans visibles
        inEm = true;
        $(node).find('span').each((_, span) => {
          const cls = ($(span).attr('class') || '').trim();
          if (visibleSet.has(cls)) {
            currentText += $(span).text();
          }
        });
        return;
      }

      if (tag === 'h2') {
        // Titre du chapitre
        let titleText = '';
        $(node).find('span').each((_, span) => {
          const cls = ($(span).attr('class') || '').trim();
          if (visibleSet.has(cls)) {
            titleText += $(span).text();
          }
        });
        if (titleText.trim()) {
          paragraphs.push(`<h2>${titleText.trim()}</h2>`);
        }
        return;
      }

      if (tag === 'div') {
        // Div notice (copyright) → ignorer
        return;
      }
    }
  });

  // Flush le dernier paragraphe si non vide
  const lastTrimmed = currentText.trim();
  if (lastTrimmed) {
    paragraphs.push(inEm ? `<p><em>${lastTrimmed}</em></p>` : `<p>${lastTrimmed}</p>`);
  }

  return paragraphs.join('\n');
}

class VictorianNovelHousePlugin implements Plugin.PluginBase {
  id = 'victoriannovelhouse';
  name = 'Victorian Novel House';
  icon = 'src/fr/victoriannovelhouse/icon.png';
  site = 'https://world-novel.fr';
  version = '2.0.0';

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
        return {
          path: novelPath,
          name: meta.title || novelId,
          cover: meta.image,
          summary: meta.description,
          author: meta.auteur,
          genres: meta.genre,
          status: NovelStatus.Unknown,
          chapters,
        };
      }
    } catch {}

    const allNovels = await this.getHomeNovels();
    const entry = allNovels.find(n => n.id === novelId);
    if (!entry) return { path: novelPath, name: novelId, chapters: [] };
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
      status: NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const match = chapterPath.match(
      /\/lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/([^/]+)/
    );
    if (!match) return '<p>Chemin de chapitre invalide.</p>';

    const [, novelId, volumeId, chapterId] = match;
    const cdnUrl = `${this.cdnBase}/?path=${novelId}/${volumeId}/${chapterId}&userId=${this.userId}`;

    try {
      const r = await fetchApi(cdnUrl);
      if (!r.ok) throw new Error(`CDN status ${r.status}`);
      const html = await r.text();

      // Extraire le token meta depuis le lien CSS
      // Format : <link rel="stylesheet" href="...chapitres/css?path=...&meta=BASE64">
      const metaMatch = html.match(/chapitres\/css\?[^"']*?meta=([A-Za-z0-9+/=%]+)/);
      if (!metaMatch) throw new Error('Token meta introuvable');

      const metaToken = decodeMetaToken(metaMatch[1]);
      if (!metaToken || !metaToken.visible.length) throw new Error('Token meta invalide');

      const content = extractObfuscatedContent(html, metaToken);
      if (content.length > 50) return content;

      throw new Error('Contenu vide après déobfuscation');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `<p>Erreur lors du chargement du chapitre : ${msg}</p>`;
    }
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const entries = await this.getHomeNovels();
    const q = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return entries
      .filter(e => {
        const title = e.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return title.includes(q) || (e.auteur || '').toLowerCase().includes(q);
      })
      .map(e => ({ name: e.title, path: `/oeuvres/${e.id}`, cover: e.image }));
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
