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

// ─────────────────────────────────────────────────────────────
// RSC Helpers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Déobfuscation CDN
// ─────────────────────────────────────────────────────────────

function decodeMetaToken(metaB64: string): MetaToken | null {
  try {
    return JSON.parse(atob(metaB64)) as MetaToken;
  } catch {
    return null;
  }
}

/**
 * Reconstruit le texte depuis le HTML obfusqué du CDN.
 *
 * Règles :
 *  - <span class="CLS">X</span>  où CLS ∈ visible  → ajouter X (ou espace si X vide)
 *  - <span class="CLS">X</span>  où CLS ∈ hidden/hiddenSpace/fake → ignorer
 *  - <br><br> → nouveau paragraphe
 *  - <em>...</em> → italique
 *  - <h2>...</h2> → ignoré (titre déjà connu)
 */
function extractObfuscatedContent(html: string, meta: MetaToken): string {
  const visibleSet = new Set(meta.visible);

  // Se concentrer sur <div class="chapter-obf">
  const start = html.indexOf('<div class="chapter-obf">');
  const end = html.lastIndexOf('</div>');
  const src = start !== -1 ? html.slice(start, end + 6) : html;

  // Regex pour extraire tous les spans et les <br>
  // On traite le HTML comme une séquence de tokens
  const tokenRe = /<span class="([^"]+)">([\s\S]*?)<\/span>|<br>|<em>|<\/em>|<h2>|<\/h2>|<\/div>/g;

  const paragraphs: string[] = [];
  let current = '';
  let inItalic = false;
  let inH2 = false;
  let lastWasBr = false;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(src)) !== null) {
    const full = match[0];

    if (full === '<h2>') { inH2 = true; lastWasBr = false; continue; }
    if (full === '</h2>') { inH2 = false; continue; }
    if (full === '<em>') { inItalic = true; continue; }
    if (full === '</em>') { inItalic = false; continue; }
    if (full === '</div>') { break; }

    if (full === '<br>') {
      if (lastWasBr) {
        // Double <br> = fin de paragraphe
        const trimmed = current.trim();
        if (trimmed) paragraphs.push(`<p>${trimmed}</p>`);
        current = '';
      }
      lastWasBr = true;
      continue;
    }

    // C'est un <span>
    lastWasBr = false;
    if (inH2) continue; // ignorer le titre h2

    const cls = match[1];
    const content = match[2];

    if (visibleSet.has(cls)) {
      // contenu vide dans un span visible = espace
      const text = content !== '' ? content : ' ';
      if (inItalic) {
        current += `<em>${text}</em>`;
      } else {
        current += text;
      }
    }
    // hidden / hiddenSpace / fake → ignoré
  }

  // Dernier paragraphe
  const last = current.trim();
  if (last) paragraphs.push(`<p>${last}</p>`);

  return paragraphs.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────

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
      /\/lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/([^/]+)/,
    );
    if (!match) return '<p>Chemin de chapitre invalide.</p>';

    const [, novelId, volumeId, chapterId] = match;
    const cdnUrl = `${this.cdnBase}/?path=${novelId}/${volumeId}/${chapterId}&userId=${this.userId}`;

    try {
      const r = await fetchApi(cdnUrl);
      if (!r.ok) throw new Error(`CDN HTTP ${r.status}`);
      const html = await r.text();

      // Extraire le token meta= depuis le <link> vers le CSS
      const metaMatch = html.match(/chapitres\/css\?[^"']*?meta=([A-Za-z0-9+/=%-]+)/);
      if (!metaMatch) {
        // Pas d'obfuscation — retourner le HTML brut
        return html;
      }

      const metaB64 = decodeURIComponent(metaMatch[1]);
      const metaToken = decodeMetaToken(metaB64);
      if (!metaToken || metaToken.visible.length === 0) {
        return '<p>Impossible de décoder le token de déobfuscation.</p>';
      }

      const content = extractObfuscatedContent(html, metaToken);
      if (content.length > 50) return content;

      return '<p>Le contenu du chapitre est vide après déobfuscation.</p>';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `<p>Erreur lors du chargement : ${msg}</p>`;
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
