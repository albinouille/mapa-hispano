#!/usr/bin/env python3
"""Récupère les actualités de chaque pays et écrit news.json.

Pour chaque pays, sources.json liste les journaux choisis (nom + adresse du site).
Le robot trouve lui-même le flux RSS de chaque site :
  1. le flux indiqué dans sources.json, s'il y en a un ;
  2. sinon celui annoncé dans la page d'accueil du site (balise <link rel="alternate">) ;
  3. sinon les adresses usuelles (/rss.xml, /feed, /arc/outboundfeeds/rss/...).
Si aucun journal d'un pays ne répond, une recherche GDELT sert de secours.

Lancé par GitHub Actions (.github/workflows/update-news.yml).
Le journal d'exécution indique, pour chaque journal, OK ou ÉCHEC.
"""
import datetime
import email.utils
import html
import json
import pathlib
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
COUNTRIES = json.loads((ROOT / "countries.json").read_text(encoding="utf-8"))
SOURCES = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
NEWS_FILE = ROOT / "news.json"

GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
USER_AGENT = "Mozilla/5.0 (compatible; mapa-hispano/1.0; +https://github.com)"
MAX_BYTES = 3_000_000
MAX_AGE_DAYS = 7
MAX_PER_COUNTRY = 60
MAX_CANDIDATES = 10  # adresses de flux testées au maximum par journal
SITE_DELAY = 1.0     # secondes entre deux journaux
GDELT_DELAY = 6.0    # GDELT impose environ 1 requête / 5 s

GENERIC_PATHS = [
    "/arc/outboundfeeds/rss/?outputType=xml",
    "/rss.xml", "/rss", "/rss/", "/feed", "/feed/", "/index.xml",
]
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
LINK_TAG_RE = re.compile(r"<link\b[^>]*>", re.I)
ATTR_RE = re.compile(r"""([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


# ---------------------------------------------------------------- utilitaires

def clean_text(s):
    s = html.unescape(s or "")
    s = TAG_RE.sub(" ", s)
    return SPACE_RE.sub(" ", s).strip()


def fold(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def domain_of(url):
    host = urllib.parse.urlparse(url or "").netloc.lower()
    return host[4:] if host.startswith("www.") else host


def to_seendate(dt):
    """datetime -> '20261008T101500Z' (format lu par la page)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_date(text):
    text = (text or "").strip()
    if not text:
        return None
    try:
        return email.utils.parsedate_to_datetime(text)   # RSS : RFC 822
    except (TypeError, ValueError):
        pass
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))  # Atom / dc:date
    except ValueError:
        return None


# ------------------------------------------------------------------- lecture RSS

def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def child_text(node, *names):
    for child in node:
        if local(child.tag) in names and (child.text or "").strip():
            return child.text.strip()
    return ""


def parse_feed(data):
    """Lit un flux RSS 2.0 ou Atom. Renvoie [{'title','url','date'}]."""
    root = ET.fromstring(data)
    items = []
    for node in root.iter():
        if local(node.tag) not in ("item", "entry"):
            continue
        title = clean_text(child_text(node, "title"))
        url = child_text(node, "link")
        if not url:  # Atom : <link href="..."/>
            for child in node:
                if local(child.tag) == "link" and child.get("href"):
                    if child.get("rel") in (None, "alternate"):
                        url = child.get("href")
                        break
        date = parse_date(child_text(node, "pubDate", "published", "updated", "date"))
        if title and url.startswith(("http://", "https://")):
            items.append({"title": title, "url": url, "date": date})
    return items


def fetch_bytes(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(MAX_BYTES)


def try_feed(url):
    """Renvoie la liste d'éléments si l'adresse est un flux lisible, sinon None."""
    try:
        items = parse_feed(fetch_bytes(url))
    except Exception:
        return None
    return items or None


def discover_feeds(site):
    """Adresses de flux possibles pour un site : annoncées dans la page, puis usuelles."""
    try:
        page = fetch_bytes(site).decode("utf-8", "replace")
    except Exception:
        page = ""
    found = []
    for tag in LINK_TAG_RE.findall(page):
        attrs = {k.lower(): (a or b) for k, a, b in ATTR_RE.findall(tag)}
        kind = attrs.get("type", "").lower()
        if ("alternate" in attrs.get("rel", "").lower() and attrs.get("href")
                and ("rss" in kind or "atom" in kind or "xml" in kind)):
            found.append(urllib.parse.urljoin(site, html.unescape(attrs["href"])))
    for path in GENERIC_PATHS:
        found.append(urllib.parse.urljoin(site, path))
    unique = list(dict.fromkeys(found))
    return unique[:MAX_CANDIDATES]


def load_site(entry):
    """Renvoie (items, adresse_du_flux, flux_trouvé_automatiquement)."""
    given = entry.get("feed")
    tried = set()
    if given:
        tried.add(given)
        items = try_feed(given)
        if items:
            return items, given, False
    for url in discover_feeds(entry["site"]):
        if url in tried:
            continue
        tried.add(url)
        items = try_feed(url)
        if items:
            return items, url, True
    return None, None, False


# ------------------------------------------------------------------- secours GDELT

def fetch_gdelt(info):
    lang = info.get("lang", "spanish")
    params = urllib.parse.urlencode({
        "query": f'"{info["name"]}" sourcelang:{lang} sourcecountry:{info["fips"]}',
        "mode": "artlist", "format": "json", "maxrecords": "60",
        "sort": "datedesc", "timespan": f"{MAX_AGE_DAYS}d",
    })
    data = json.loads(fetch_bytes(f"{GDELT}?{params}", timeout=40).decode("utf-8", "replace"))
    items = []
    for a in data.get("articles", []):
        title = clean_text(a.get("title"))
        url = a.get("url") or ""
        if title and url.startswith(("http://", "https://")):
            items.append({"title": title, "url": url, "gdelt_seen": a.get("seendate"),
                          "date": None, "name": domain_of(url)})
    return items


# ------------------------------------------------------------------- assemblage

def normalize_entry(raw):
    """Accepte {'name','site','feed'} ou simplement une adresse (texte)."""
    if isinstance(raw, str):
        raw = {"site": raw}
    site = (raw.get("site") or raw.get("feed") or "").strip()
    if not site:
        return None
    if not site.startswith(("http://", "https://")):
        site = "https://" + site
    return {"name": raw.get("name") or domain_of(site), "site": site, "feed": raw.get("feed")}


def collect_country(iso, info):
    """Renvoie (articles, nb_journaux_ok, nb_journaux)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    oldest = now - datetime.timedelta(days=MAX_AGE_DAYS)
    entries = [e for e in (normalize_entry(r) for r in SOURCES.get(iso, [])) if e]
    raw, ok = [], 0

    for entry in entries:
        items, used, auto = load_site(entry)
        if items:
            ok += 1
            note = " (flux trouvé automatiquement)" if auto else ""
            print(f"[{iso}] OK     {len(items):3d} articles  {entry['name']}  <- {used}{note}")
            for it in items:
                it["name"] = entry["name"]
            raw.extend(items)
        else:
            print(f"[{iso}] ÉCHEC  {entry['name']}  : aucun flux lisible trouvé pour {entry['site']}")
        time.sleep(SITE_DELAY)

    if not raw:
        try:
            print(f"[{iso}] aucun journal utilisable : secours GDELT")
            time.sleep(GDELT_DELAY)
            raw = fetch_gdelt(info)
            print(f"[{iso}] GDELT : {len(raw)} articles")
        except Exception as exc:
            print(f"[{iso}] GDELT en échec ({type(exc).__name__}: {exc})")

    articles, seen = [], set()
    for it in raw:
        key = fold(it["title"])
        if key in seen:
            continue
        seen.add(key)
        if it.get("gdelt_seen"):
            seendate = it["gdelt_seen"]
            when = (datetime.datetime.strptime(seendate, "%Y%m%dT%H%M%SZ")
                    .replace(tzinfo=datetime.timezone.utc)
                    if re.fullmatch(r"\d{8}T\d{6}Z", seendate) else None)
        else:
            when = it["date"]
            if when is not None and when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
            if when is not None and when > now:
                when = now  # date dans le futur : ramenée à maintenant
            seendate = to_seendate(when) if when else ""
        if when is not None and when < oldest:
            continue
        articles.append({"title": it["title"], "url": it["url"],
                         "domain": it["name"], "seendate": seendate})

    articles.sort(key=lambda a: a["seendate"], reverse=True)
    return articles[:MAX_PER_COUNTRY], ok, len(entries)


def main():
    old = {}
    if NEWS_FILE.exists():
        try:
            old = json.loads(NEWS_FILE.read_text(encoding="utf-8")).get("countries", {})
        except json.JSONDecodeError:
            pass

    result, summary = {}, []
    for iso, info in COUNTRIES.items():
        articles, ok, total = collect_country(iso, info)
        if articles:
            result[iso] = {"articles": articles}
        else:
            result[iso] = old.get(iso, {"articles": []})
            print(f"[{iso}] rien de nouveau : anciennes données conservées")
        summary.append((iso, len(articles), ok, total))

    print("\nRésumé : pays / articles / journaux OK")
    for iso, n, ok, total in summary:
        print(f"  {iso}  {n:3d} articles   journaux {ok}/{total}")

    fresh = sum(n for _, n, _, _ in summary)
    if fresh == 0:
        print("Aucun article récupéré : news.json n'est pas modifié.")
        sys.exit(1)

    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "countries": result,
    }
    NEWS_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"news.json écrit ({fresh} articles frais)")


if __name__ == "__main__":
    main()
