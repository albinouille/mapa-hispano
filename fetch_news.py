#!/usr/bin/env python3
"""Récupère les actualités de chaque pays hispanophone via GDELT et écrit news.json.

Lancé automatiquement par GitHub Actions (voir .github/workflows/update-news.yml).
GDELT limite à ~1 requête toutes les 5 secondes : le script espace donc les appels.

Robustesse :
- chaque pays est essayé avec plusieurs variantes de requête (avec / sans accents) ;
- chaque requête est retentée plusieurs fois en cas d'erreur ;
- si tout échoue, on garde les anciennes données du pays pour ne rien perdre.
"""
import datetime
import json
import pathlib
import time
import unicodedata
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
COUNTRIES = json.loads((ROOT / "countries.json").read_text(encoding="utf-8"))
NEWS_FILE = ROOT / "news.json"
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
DELAY = 6      # secondes entre deux requêtes
ATTEMPTS = 3   # essais par variante de requête


def fold(text):
    """Retire les accents : España -> Espana."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    )


def query_variants(info):
    base = f"sourcelang:spanish sourcecountry:{info['fips']}"
    variants = [f'"{info["name"]}" {base}']
    ascii_name = fold(info["name"])
    if ascii_name != info["name"]:
        variants.append(f'"{ascii_name}" {base}')
    return variants


def run_query(query):
    params = urllib.parse.urlencode({
        "query": query,
        "mode": "artlist",
        "format": "json",
        "maxrecords": "60",
        "sort": "datedesc",
        "timespan": "7d",
    })
    req = urllib.request.Request(f"{GDELT}?{params}", headers={"User-Agent": "mapa-hispano/1.0"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw)  # lève une erreur si GDELT répond autre chose que du JSON
    seen, articles = set(), []
    for a in data.get("articles", []):
        title = (a.get("title") or "").strip()
        if not title or title in seen:
            continue
        seen.add(title)
        articles.append({
            "title": title,
            "url": a.get("url"),
            "domain": a.get("domain"),
            "seendate": a.get("seendate"),
        })
    return articles


def fetch_country(iso, info):
    """Renvoie une liste d'articles (éventuellement vide), ou None si tout a échoué."""
    got_valid_answer = False
    for query in query_variants(info):
        for attempt in range(1, ATTEMPTS + 1):
            try:
                articles = run_query(query)
                got_valid_answer = True
                time.sleep(DELAY)
                if articles:
                    print(f"[{iso}] {len(articles)} articles avec : {query}")
                    return articles
                print(f"[{iso}] 0 article avec : {query}")
                break  # réponse valide mais vide : on passe à la variante suivante
            except Exception as exc:  # réponse non JSON, timeout, limite de débit...
                print(f"[{iso}] essai {attempt}/{ATTEMPTS} échoué ({exc}) avec : {query}")
                time.sleep(10 * attempt)
    return [] if got_valid_answer else None


def main():
    old = {}
    if NEWS_FILE.exists():
        try:
            old = json.loads(NEWS_FILE.read_text(encoding="utf-8")).get("countries", {})
        except json.JSONDecodeError:
            pass

    result = {}
    for iso, info in COUNTRIES.items():
        articles = fetch_country(iso, info)
        if articles is None:
            result[iso] = old.get(iso, {"articles": []})
            print(f"[{iso}] échec total : anciennes données conservées")
        else:
            result[iso] = {"articles": articles}

    total = sum(len(v.get("articles", [])) for v in result.values())
    print(f"Total : {total} articles")

    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "countries": result,
    }
    NEWS_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("news.json écrit")


if __name__ == "__main__":
    main()
