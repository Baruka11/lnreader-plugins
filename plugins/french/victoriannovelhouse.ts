import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

interface RawChapter {
  id: string; title: string; date: string; volumeId: string; volumeDisplayName: string; ts: number;
}
interface RawVolume {
  volumeId: string; volumeDisplayName: string; chapters: RawChapter[];
}
interface HomeNovelEntry {
  id: string; title: string; image: string; rating: number; desc: string;
  chapters: Array<{ id: string; title: string; date: number; volumeId: string; volumeDisplayName: string; chapterNumber: number; }>;
  dateMaj: number; genre: string; status: string; totalChapters: number; auteur: string; tags: string[];
}
interface MetaToken {
  visible: string[]; hidden: string[]; hiddenSpace: string[]; fake: string[]; key: string;
}

const FIREBASE_API_KEY = 'AIzaSyAvcYUE1unj_VAlqxpYUtBfk9C2Ah-XzpI';
const USER_EMAIL = 'leclercqsimon12@gmail.com';
const USER_ID = 'FMWkEHmNArbpfkfgEb4xjNbCbL73';

function extractNextFlightData(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse('"' + m[1] + '"')); } catch { parts.push(m[1]); }
  }
  return parts.join('');
}

function parseNovelsFromRSC(raw: string): HomeNovelEntry[] {
  const idx = raw.indexOf('"novels":[{');
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
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(arrStart, i + 1)) as HomeNovelEntry[]; } catch { return []; } } }
  }
  return [];
}

function parseVolumesFromRSC(raw: string): RawVolume[] {
  const idx = raw.indexOf('"volumes":[{"volumeId"');
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
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(arrStart, i + 1)) as RawVolume[]; } catch { return []; } } }
  }
  return [];
}

function parseOeuvreMetaFromRSC(raw: string) {
  const meta: { title?: string; image?: string; description?: string; auteur?: string; genre?: string } = {};
  const t = raw.match(/"title"\s*:\s*"([^"]+)"/); if (t) meta.title = t[1];
  const im = raw.match(/"image"\s*:\s*"(https:\/\/cdn\.world-novel\.fr\/images\/cover\/[^"]+)"/); if (im) meta.image = im[1];
  const au = raw.match(/"auteur"\s*:\s*"([^"]+)"/); if (au) meta.auteur = au[1];
  const ge = raw.match(/"genre"\s*:\s*"([^"]+)"/); if (ge) meta.genre = ge[1];
  const de = raw.match(/"description"\s*:\s*"([\s\S]+?)(?<!\\)"/); if (de) meta.description = de[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return meta;
}

function decodeMetaToken(b64: string): MetaToken | null {
  try { return JSON.parse(atob(b64)) as MetaToken; } catch { return null; }
}

function extractObfuscatedContent(html: string, meta: MetaToken): string {
  const visibleSet = new Set(meta.visible);
  const start = html.indexOf('<div class="chapter-obf">');
  const end = html.lastIndexOf('</div>');
  const src = start !== -1 ? html.slice(start, end + 6) : html;
  const tokenRe = /<span class="([^"]+)">([\s\S]*?)<\/span>|<br>|<em>|<\/em>|<h2>|<\/h2>|<\/div>/g;
  const paragraphs: string[] = [];
  let current = '', inItalic = false, inH2 = false, lastWasBr = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src)) !== null) {
    const full = m[0];
    if (full === '<h2>') { inH2 = true; lastWasBr = false; continue; }
    if (full === '</h2>') { inH2 = false; continue; }
    if (full === '<em>') { inItalic = true; continue; }
    if (full === '</em>') { inItalic = false; continue; }
    if (full === '</div>') break;
    if (full === '<br>') {
      if (lastWasBr) { const t = current.trim(); if (t) paragraphs.push(`<p>${t}</p>`); current = ''; }
      lastWasBr = true; continue;
    }
    lastWasBr = false;
    if (inH2) continue;
    const cls = m[1], content = m[2];
    if (visibleSet.has(cls)) {
      const text = content !== '' ? content : ' ';
      current += inItalic ? `<em>${text}</em>` : text;
    }
  }
  const last = current.trim();
  if (last) paragraphs.push(`<p>${last}</p>`);
  return paragraphs.join('\n');
}

class VictorianNovelHousePlugin implements Plugin.PluginBase {
  id = 'victoriannovelhouse';
  name = 'Victorian Novel House';
  icon = 'src/fr/victoriannovelhouse/icon.png';
  site = 'https://world-novel.fr';
  version = '2.4.0';

  private cdnBase = 'https://cdn.world-novel.fr/chapitres';
  private cachedNovels: HomeNovelEntry[] | null = null;
  private authToken: string | null = null;
  private authTokenExpiry = 0;

  private async getAuthToken(password: string): Promise<string> {
    const now = Date.now();
    if (this.authToken && now < this.authTokenExpiry - 60000) {
      return this.authToken;
    }
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
    const r = await fetchApi(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: USER_EMAIL,
        password: password,
        returnSecureToken: true,
      }),
    });
    if (!r.ok) throw new Error(`Auth échouée (mot de passe incorrect ?) : ${r.status}`);
    const data = await r.json() as { idToken: string; expiresIn: string };
    this.authToken = data.idToken;
    this.authTokenExpiry = now + parseInt(data.expiresIn) * 1000;
    return this.authToken;
  }

  private async getHomeNovels(): Promise<HomeNovelEntry[]> {
    if (this.cachedNovels) return this.cachedNovels;
    try {
      const r = await fetchApi(this.site + '/');
      const html = await r.text();
      this.cachedNovels = parseNovelsFromRSC(extractNextFlightData(html));
    } catch { this.cachedNovels = []; }
    return this.cachedNovels;
  }

  async popularNovels(pageNo: number, { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const entries = await this.getHomeNovels();
    if (!entries.length) return [];
    const sorted = showLatestNovels ? [...entries].sort((a, b) => b.dateMaj - a.dateMaj) : [...entries].sort((a, b) => b.rating - a.rating);
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
        const chapters: Plugin.ChapterItem[] = [];
        let n = 1;
        for (const vol of [...volumes].reverse()) {
          for (const ch of [...vol.chapters].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
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
    const entry = (await this.getHomeNovels()).find(n => n.id === novelId);
    if (!entry) return { path: novelPath, name: novelId, chapters: [] };
    return {
      path: novelPath, name: entry.title, cover: entry.image, summary: entry.desc,
      author: entry.auteur, genres: entry.genre, status: NovelStatus.Unknown,
      chapters: [...entry.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber).map((c, i) => ({
        name: c.title || c.id,
        path: `/lecture/${novelId}/volumes/${encodeURIComponent(c.volumeId)}/chapitres/${encodeURIComponent(c.id)}`,
        releaseTime: c.date ? new Date(c.date).toISOString() : undefined,
        chapterNumber: c.chapterNumber || i + 1,
      })),
    };
  }

  async parseChapter(
    chapterPath: string,
    { filters }: Plugin.ParseChapterOptions<typeof this.filters>,
  ): Promise<string> {
    const password = filters?.password?.value as string || '';
    if (!password) {
      return `<p>⚠️ Veuillez entrer votre mot de passe Victorian Novel House dans les filtres du plugin (icône entonnoir).</p>`;
    }

    const match = chapterPath.match(/\/lecture\/([^/]+)\/volumes\/([^/]+)\/chapitres\/([^/]+)/);
    if (!match) return `<p>Chemin invalide : ${chapterPath}</p>`;

    const [, novelId, volumeId, chapterId] = match;
    const cdnUrl = `${this.cdnBase}/?path=${novelId}/${volumeId}/${chapterId}&userId=${USER_ID}`;

    try {
      const token = await this.getAuthToken(password);
      const r = await fetchApi(cdnUrl, {
        headers: {
          'authorization': `Bearer ${token}`,
          'referer': 'https://world-novel.fr/',
        },
      });
      if (!r.ok) return `<p>Erreur CDN ${r.status}</p>`;

      const html = await r.text();
      const metaMatch = html.match(/chapitres\/css\?[^"']*?meta=([A-Za-z0-9+/=%-]+)/);
      if (!metaMatch) return html;

      const metaToken = decodeMetaToken(decodeURIComponent(metaMatch[1]));
      if (!metaToken || !metaToken.visible.length) return `<p>Token invalide.</p>`;

      const content = extractObfuscatedContent(html, metaToken);
      return content.length > 50 ? content : `<p>Contenu vide.</p>`;

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `<p>Erreur : ${msg}</p>`;
    }
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const q = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return (await this.getHomeNovels()).filter(e => {
      const t = e.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return t.includes(q) || (e.auteur || '').toLowerCase().includes(q);
    }).map(e => ({ name: e.title, path: `/oeuvres/${e.id}`, cover: e.image }));
  }

  filters = {
    password: {
      type: FilterTypes.TextInput,
      label: 'Mot de passe Victorian Novel House',
      value: '',
    },
  } satisfies Filters;
}

export default new VictorianNovelHousePlugin();
