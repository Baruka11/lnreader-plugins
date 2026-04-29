/**
 * Plugin LNreader — NovelFrance.fr v2.0.0
 * Moteur : Next.js custom (ex-MassNovel)
 *
 * Structure des URLs :
 *   Roman    → https://novelfrance.fr/novel/{slug}
 *   Chapitre → https://novelfrance.fr/novel/{slug}/{chapter-slug}
 *   Images   → https://novelfrance.fr/uploads/covers/{filename}
 *
 * Le site embarque toutes les données en RSC (React Server Components)
 * dans des blocs self.__next_f.push([1, "..."]) — on parse ces blocs JSON.
 */

const plugin = {
  /* ── Métadonnées ──────────────────────────────────────────────── */
  id: "novelfrance",
  name: "NovelFrance",
  version: "2.0.0",
  icon: "https://novelfrance.fr/icons/icon-32x32.png",
  site: "https://novelfrance.fr",
  lang: "French",
  isNsfw: false,
  requirePath: "",
  pluginType: "source",

  /* ── Constantes ────────────────────────────────────────────────── */
  _base: "https://novelfrance.fr",

  /* ── Helpers ───────────────────────────────────────────────────── */
  _headers() {
    return {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/112 Mobile Safari/537.36",
      Referer: "https://novelfrance.fr/",
    };
  },

  async _fetchHTML(url) {
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.text();
  },

  /** Extrait tous les blocs JSON du payload RSC de Next.js */
  _extractRSCPayload(html) {
    // Le contenu JSON est dans : self.__next_f.push([1, "..."])
    // Les guillemets sont échappés dans la string JS
    const chunks = [];
    const rx = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
    let m;
    while ((m = rx.exec(html)) !== null) {
      try {
        // Désescaper la string JS
        const raw = m[1]
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        chunks.push(raw);
      } catch (_) {}
    }
    return chunks.join("\n");
  },

  _coverUrl(path) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    return this._base + path;
  },

  _mapStatus(raw) {
    if (!raw) return "Unknown";
    switch (raw.toUpperCase()) {
      case "ONGOING":   return "Ongoing";
      case "COMPLETED": return "Completed";
      case "DROPPED":
      case "CANCELED":  return "Dropped";
      default:          return "Unknown";
    }
  },

  _decodeText(s) {
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\r/g, "");
  },

  /* ── 1. ROMANS POPULAIRES ──────────────────────────────────────── */
  async popularNovels(page, { showLatestNovels } = {}) {
    const sort = showLatestNovels ? "newest" : "popular";
    const html = await this._fetchHTML(`${this._base}/browse?sort=${sort}&page=${page}`);
    const novels = this._parseNovelCards(html);
    return { novels, hasNextPage: novels.length >= 18 };
  },

  /* ── 2. RECHERCHE ──────────────────────────────────────────────── */
  async searchNovels(query, page) {
    const url = `${this._base}/search?q=${encodeURIComponent(query)}&page=${page}`;
    const html = await this._fetchHTML(url);
    const novels = this._parseNovelCards(html);
    return { novels, hasNextPage: novels.length >= 18 };
  },

  /**
   * Parse les cartes de romans depuis une page HTML.
   * Les données sont dans les blocs RSC sous forme :
   * "slug":"shadow-slave","coverImage":"/uploads/covers/xxx.webp","title":"Shadow Slave"
   */
  _parseNovelCards(html) {
    const payload = this._extractRSCPayload(html);
    const novels = [];
    const seen = new Set();

    // Pattern : "slug":"xxx","description":"...","coverImage":"...","author":"..."
    const rx = /"title":"([^"]+)","slug":"([^"\/]+)","description":"(?:[^"\\]|\\.)*","coverImage":"([^"]+)"/g;
    let m;
    while ((m = rx.exec(payload)) !== null) {
      const slug = m[2];
      if (seen.has(slug)) continue;
      seen.add(slug);
      novels.push({
        name: m[1],
        path: `/novel/${slug}`,
        cover: this._coverUrl(m[3]),
      });
    }

    // Fallback : chercher les liens /novel/ dans le HTML brut
    if (novels.length === 0) {
      const linkRx = /href="\/novel\/([^"\/]+)"/g;
      const imgRx = /\/uploads\/covers\/[^"]+\.(?:webp|jpg|jpeg|png)/g;
      const slugs = [...new Set([...html.matchAll(linkRx)].map((x) => x[1]))];
      const imgs = [...html.matchAll(imgRx)].map((x) => x[0]);
      slugs.forEach((slug, i) => {
        novels.push({
          name: slug.replace(/-/g, " "),
          path: `/novel/${slug}`,
          cover: imgs[i] ? this._coverUrl(imgs[i]) : "",
        });
      });
    }

    return novels;
  },

  /* ── 3. DÉTAIL D'UN ROMAN ──────────────────────────────────────── */
  async parseNovelAndChapters(novelPath) {
    const slug = novelPath.replace(/^\/novel\//, "");
    const html = await this._fetchHTML(`${this._base}/novel/${slug}`);
    const payload = this._extractRSCPayload(html);

    /* ---- Infos du roman ---- */
    let name = slug.replace(/-/g, " ");
    let cover = "";
    let summary = "";
    let author = "";
    let status = "Unknown";
    let genres = [];

    // Bloc complet du roman — on cherche le premier objet contenant le slug courant
    const novelRx = new RegExp(
      `"title":"([^"]+)","slug":"${slug.replace(/[-]/g, "\\-")}"[^}]*?"description":"((?:[^"\\\\]|\\\\.)*)"[^}]*?"coverImage":"([^"]+)"[^}]*?"author":"([^"]+)"[^}]*?"status":"([^"]+)"`
    );
    const nm = payload.match(novelRx);
    if (nm) {
      name    = nm[1];
      summary = this._decodeText(nm[2]);
      cover   = this._coverUrl(nm[3]);
      author  = nm[4];
      status  = this._mapStatus(nm[5]);
    } else {
      // Fallbacks individuels
      const t = payload.match(/"title":"([^"]+)"/);
      if (t) name = t[1];
      const d = payload.match(/"description":"((?:[^"\\]|\\.)*)"/);
      if (d) summary = this._decodeText(d[1]);
      const c = payload.match(/"coverImage":"(\/uploads\/covers\/[^"]+)"/);
      if (c) cover = this._coverUrl(c[1]);
      const a = payload.match(/"author":"([^"]+)"/);
      if (a) author = a[1];
      const s = payload.match(/"status":"([A-Z]+)"/);
      if (s) status = this._mapStatus(s[1]);
    }

    // Genres
    const genreRx = /"genres":\[([^\]]+)\]/;
    const gm = payload.match(genreRx);
    if (gm) {
      const nameRx = /"name":"([^"]+)"/g;
      let gn;
      while ((gn = nameRx.exec(gm[1])) !== null) {
        genres.push(gn[1]);
      }
    }

    /* ---- Chapitres ---- */
    const chapters = this._parseChapterList(payload, slug);

    return { name, cover, summary, author, status, genres, chapters };
  },

  _parseChapterList(payload, slug) {
    const chapters = [];
    const seen = new Set();

    // Pattern : "chapterNumber":1,"title":"Chapitre 1","slug":"chapter-1","createdAt":"2026-..."
    const rx = /"chapterNumber":(\d+),"title":"([^"]+)","slug":"([^"]+)","createdAt":"([^"]+)"/g;
    let m;
    while ((m = rx.exec(payload)) !== null) {
      const num = parseInt(m[1]);
      if (seen.has(num)) continue;
      seen.add(num);
      chapters.push({
        name: m[2] || `Chapitre ${num}`,
        path: `/novel/${slug}/${m[3]}`,
        releaseTime: m[4] ? new Date(m[4]).toLocaleDateString("fr-FR") : null,
        chapterNumber: num,
      });
    }

    // Trier du plus ancien au plus récent
    return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
  },

  /* ── 4. CONTENU D'UN CHAPITRE ──────────────────────────────────── */
  async parseChapter(chapterPath) {
    // chapterPath = "/novel/shadow-slave/chapter-42"
    const html = await this._fetchHTML(this._base + chapterPath);
    const payload = this._extractRSCPayload(html);

    let text = "";

    // Le contenu est dans "contentMarkdown":"..." ou "content":"..."
    const contentRx = /"content(?:Markdown)?":"((?:[^"\\]|\\.)*)"/;
    const cm = payload.match(contentRx);
    if (cm) {
      text = this._decodeText(cm[1]).trim();
    }

    // Si on n'a pas trouvé le contenu, chercher dans le HTML brut
    if (!text || text.length < 100) {
      // Enlever les balises et ne garder que le texte des paragraphes
      const paraRx = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      const paras = [];
      let pm;
      while ((pm = paraRx.exec(html)) !== null) {
        const p = pm[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
        if (p.length > 10) paras.push(p);
      }
      text = paras.join("\n\n");
    }

    // Nettoyage final
    text = text
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { text: text || "Contenu non disponible." };
  },

  /* ── 5. FILTRES ────────────────────────────────────────────────── */
  filters: [
    {
      key: "sort",
      label: "Trier par",
      values: [
        { label: "Populaire",   value: "popular"  },
        { label: "Tendance",    value: "trending" },
        { label: "Mieux noté",  value: "rating"   },
        { label: "Plus récent", value: "latest"   },
        { label: "Nouveau",     value: "newest"   },
      ],
      inputType: "Picker",
    },
    {
      key: "status",
      label: "Statut",
      values: [
        { label: "Tous",       value: ""          },
        { label: "En cours",   value: "ONGOING"   },
        { label: "Terminé",    value: "COMPLETED" },
        { label: "Abandonné",  value: "DROPPED"   },
      ],
      inputType: "Picker",
    },
    {
      key: "type",
      label: "Type",
      values: [
        { label: "Tous",       value: ""           },
        { label: "Traduit",    value: "TRANSLATED" },
        { label: "Web Novel",  value: "WEB_NOVEL"  },
        { label: "Original",   value: "ORIGINAL"   },
      ],
      inputType: "Picker",
    },
    {
      key: "genre",
      label: "Genre",
      values: [
        { label: "Action",        value: "action"         },
        { label: "Aventure",      value: "aventure"       },
        { label: "Romance",       value: "romance"        },
        { label: "Fantaisie",     value: "fantaisie"      },
        { label: "Système",       value: "syst-me"        },
        { label: "Mystère",       value: "myst-re"        },
        { label: "Horreur",       value: "horreur"        },
        { label: "Comédie",       value: "com-die"        },
        { label: "Isekai",        value: "isekai"         },
        { label: "Mature",        value: "mature"         },
        { label: "Psychologique", value: "psychologique"  },
        { label: "Seinen",        value: "seinen"         },
        { label: "Xianxia",       value: "xianxia"        },
        { label: "Xuanhuan",      value: "xuanhuan"       },
        { label: "Arts Martiaux", value: "arts-martiaux"  },
        { label: "Réincarnation", value: "r-incarnation"  },
        { label: "Drama",         value: "drama"          },
        { label: "Surnaturel",    value: "surnaturel"     },
        { label: "Sci-fi",        value: "sci-fi"         },
        { label: "Tragédie",      value: "trag-die"       },
        { label: "Anti-Héros",    value: "anti-h-ros"     },
        { label: "Harem",         value: "harem"          },
        { label: "School Life",   value: "school-life"    },
        { label: "Slice of Life", value: "slice-of-life"  },
        { label: "Game",          value: "game"           },
      ],
      inputType: "Checkbox",
    },
  ],

  async filterNovels(page, filters = {}) {
    const { sort = "popular", status = "", type = "", genre = [] } = filters;
    const params = new URLSearchParams({ sort, page });
    if (status) params.set("status", status);
    if (type)   params.set("type", type);
    genre.forEach((g) => params.append("genre", g));

    const html = await this._fetchHTML(`${this._base}/browse?${params.toString()}`);
    const novels = this._parseNovelCards(html);
    return { novels, hasNextPage: novels.length >= 18 };
  },
};

export default plugin;
