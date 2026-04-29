/**
 * Plugin LNreader — NovelFrance.fr v3.0.0
 *
 * IMPORTANT : LNreader fournit fetchApi() dans le contexte d'exécution des plugins.
 * On utilise fetchApi au lieu de fetch() pour éviter le "Network request failed".
 *
 * Format conforme à : https://github.com/LNReader/lnreader-plugins
 */

const plugin = {
  id: "novelfrance",
  name: "NovelFrance",
  version: "3.0.0",
  icon: "https://novelfrance.fr/icons/icon-32x32.png",
  site: "https://novelfrance.fr",
  lang: "French",
  isNsfw: false,
  requirePath: "",
  pluginType: "source",

  /* ─────────── Constantes ─────────── */
  _base: "https://novelfrance.fr",

  /* ─────────── Helpers ─────────── */

  // LNreader injecte fetchApi dans le scope global
  async _get(url) {
    // fetchApi est l'API réseau injectée par LNreader (React Native fetch wrapper)
    const fn = typeof fetchApi !== "undefined" ? fetchApi : fetch;
    const res = await fn(url, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36",
      },
    });
    return res.text();
  },

  /** Extrait le JSON embarqué dans le payload RSC de Next.js */
  _rsc(html) {
    let out = "";
    const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      out += m[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return out;
  },

  _cover(path) {
    if (!path) return "";
    return path.startsWith("http") ? path : this._base + path;
  },

  _status(s) {
    if (!s) return "Unknown";
    if (s === "ONGOING")   return "Ongoing";
    if (s === "COMPLETED") return "Completed";
    if (s === "DROPPED" || s === "CANCELED") return "Dropped";
    return "Unknown";
  },

  _unescape(s) {
    return (s || "")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\r/g, "");
  },

  /** Parse les cartes de romans depuis le payload RSC */
  _cards(payload) {
    const novels = [];
    const seen   = new Set();
    // Motif : "title":"...","slug":"...","description":"...","coverImage":"..."
    const re = /"title":"([^"]+)","slug":"([\w-]+)"[^}]{0,200}?"coverImage":"(\/uploads\/[^"]+)"/g;
    let m;
    while ((m = re.exec(payload)) !== null) {
      const slug = m[2];
      if (seen.has(slug)) continue;
      seen.add(slug);
      novels.push({
        name:  m[1],
        path:  `/novel/${slug}`,
        cover: this._cover(m[3]),
      });
    }
    return novels;
  },

  /* ─────────── 1. Populaires ─────────── */
  async popularNovels(page, { showLatestNovels } = {}) {
    const sort = showLatestNovels ? "newest" : "popular";
    const html  = await this._get(`${this._base}/browse?sort=${sort}&page=${page}`);
    const novels = this._cards(this._rsc(html));
    return { novels, hasNextPage: novels.length >= 18 };
  },

  /* ─────────── 2. Recherche ─────────── */
  async searchNovels(query, page) {
    const html   = await this._get(`${this._base}/search?q=${encodeURIComponent(query)}&page=${page}`);
    const novels = this._cards(this._rsc(html));
    return { novels, hasNextPage: novels.length >= 18 };
  },

  /* ─────────── 3. Détail roman ─────────── */
  async parseNovelAndChapters(novelPath) {
    const slug    = novelPath.replace(/^\/novel\//, "");
    const html    = await this._get(`${this._base}/novel/${slug}`);
    const payload = this._rsc(html);

    /* --- Métadonnées --- */
    let name    = slug.replace(/-/g, " ");
    let cover   = "";
    let summary = "";
    let author  = "";
    let status  = "Unknown";
    const genres = [];

    // Chercher le bloc complet pour ce slug
    const slugEsc = slug.replace(/-/g, "\\-");
    const full = payload.match(
      new RegExp(
        `"title":"([^"]+)","slug":"${slugEsc}"[\\s\\S]{0,400}?` +
        `"description":"((?:[^"\\\\]|\\\\.)*)"[\\s\\S]{0,200}?` +
        `"coverImage":"([^"]+)"[\\s\\S]{0,100}?` +
        `"author":"([^"]+)"[\\s\\S]{0,100}?` +
        `"status":"([A-Z]+)"`
      )
    );

    if (full) {
      name    = full[1];
      summary = this._unescape(full[2]);
      cover   = this._cover(full[3]);
      author  = full[4];
      status  = this._status(full[5]);
    } else {
      // Fallbacks individuels
      const t = payload.match(/"title":"([^"]+)"/);         if (t) name   = t[1];
      const d = payload.match(/"description":"((?:[^"\\]|\\.)*)"/); if (d) summary = this._unescape(d[1]);
      const c = payload.match(/"coverImage":"(\/uploads\/[^"]+)"/); if (c) cover   = this._cover(c[1]);
      const a = payload.match(/"author":"([^"]+)"/);         if (a) author = a[1];
      const s = payload.match(/"status":"([A-Z]+)"/);        if (s) status = this._status(s[1]);
    }

    // Genres
    const gblock = payload.match(/"genres":\[([^\]]{0,2000})\]/);
    if (gblock) {
      const gre = /"name":"([^"]{1,40})"/g;
      let gm;
      while ((gm = gre.exec(gblock[1])) !== null) genres.push(gm[1]);
    }

    /* --- Chapitres --- */
    const chapters = [];
    const seen     = new Set();
    const chRe     = /"chapterNumber":(\d+),"title":"([^"]*)","slug":"([\w-]+)","createdAt":"([^"]+)"/g;
    let cm;
    while ((cm = chRe.exec(payload)) !== null) {
      const num = parseInt(cm[1]);
      if (seen.has(num)) continue;
      seen.add(num);
      chapters.push({
        name:          cm[2] || `Chapitre ${num}`,
        path:          `/novel/${slug}/${cm[3]}`,
        releaseTime:   cm[4] ? new Date(cm[4]).toLocaleDateString("fr-FR") : null,
        chapterNumber: num,
      });
    }
    chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

    return { name, cover, summary, author, status, genres, chapters };
  },

  /* ─────────── 4. Contenu chapitre ─────────── */
  async parseChapter(chapterPath) {
    const html    = await this._get(this._base + chapterPath);
    const payload = this._rsc(html);
    let text      = "";

    // Le contenu est dans "contentMarkdown":"..." ou "content":"..."
    const cm = payload.match(/"content(?:Markdown)?":"((?:[^"\\]|\\.)*)"/);
    if (cm) {
      text = this._unescape(cm[1]).trim();
    }

    // Fallback : extraire les <p> du HTML rendu
    if (text.length < 50) {
      const paraRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      const paras  = [];
      let pm;
      while ((pm = paraRe.exec(html)) !== null) {
        const p = pm[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g,  "&")
          .replace(/&lt;/g,   "<")
          .replace(/&gt;/g,   ">")
          .replace(/&nbsp;/g, " ")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
        if (p.length > 10) paras.push(p);
      }
      text = paras.join("\n\n");
    }

    return { text: text.replace(/\n{3,}/g, "\n\n").trim() || "Contenu non disponible." };
  },

  /* ─────────── 5. Filtres ─────────── */
  filters: [
    {
      key: "sort",
      label: "Trier par",
      values: [
        { label: "Populaire",    value: "popular"  },
        { label: "Tendance",     value: "trending" },
        { label: "Mieux noté",   value: "rating"   },
        { label: "Plus récent",  value: "latest"   },
        { label: "Nouveau",      value: "newest"   },
      ],
      inputType: "Picker",
    },
    {
      key: "status",
      label: "Statut",
      values: [
        { label: "Tous",      value: ""          },
        { label: "En cours",  value: "ONGOING"   },
        { label: "Terminé",   value: "COMPLETED" },
        { label: "Abandonné", value: "DROPPED"   },
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
        { label: "Action",        value: "action"        },
        { label: "Aventure",      value: "aventure"      },
        { label: "Romance",       value: "romance"       },
        { label: "Fantaisie",     value: "fantaisie"     },
        { label: "Système",       value: "syst-me"       },
        { label: "Mystère",       value: "myst-re"       },
        { label: "Horreur",       value: "horreur"       },
        { label: "Comédie",       value: "com-die"       },
        { label: "Isekai",        value: "isekai"        },
        { label: "Mature",        value: "mature"        },
        { label: "Psychologique", value: "psychologique" },
        { label: "Seinen",        value: "seinen"        },
        { label: "Xianxia",       value: "xianxia"       },
        { label: "Xuanhuan",      value: "xuanhuan"      },
        { label: "Arts Martiaux", value: "arts-martiaux" },
        { label: "Réincarnation", value: "r-incarnation" },
        { label: "Drama",         value: "drama"         },
        { label: "Surnaturel",    value: "surnaturel"    },
        { label: "Sci-fi",        value: "sci-fi"        },
        { label: "Tragédie",      value: "trag-die"      },
        { label: "Anti-Héros",    value: "anti-h-ros"    },
        { label: "Harem",         value: "harem"         },
        { label: "School Life",   value: "school-life"   },
        { label: "Slice of Life", value: "slice-of-life" },
        { label: "Game",          value: "game"          },
      ],
      inputType: "Checkbox",
    },
  ],

  async filterNovels(page, filters = {}) {
    const { sort = "popular", status = "", type = "", genre = [] } = filters;
    const p = new URLSearchParams({ sort, page });
    if (status) p.set("status", status);
    if (type)   p.set("type",   type);
    genre.forEach((g) => p.append("genre", g));

    const html   = await this._get(`${this._base}/browse?${p.toString()}`);
    const novels = this._cards(this._rsc(html));
    return { novels, hasNextPage: novels.length >= 18 };
  },
};

// Export standard LNreader
export default plugin;
