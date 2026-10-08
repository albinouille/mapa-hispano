#!/usr/bin/env python3
"""Récupère les actualités de chaque pays hispanophone via GDELT et écrit news.json.

Lancé automatiquement par GitHub Actions (voir .github/workflows/update-news.yml).
GDELT limite à ~1 requête toutes les 5 secondes : le script espace donc les appels.
Si un pays échoue, on garde ses anciennes données pour ne rien perdre.
"""
import datetime
import json
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
COUNTRIES = json.loads((ROOT / "countries.json").read_text(encoding="utf-8"))
NEWS_FILE = ROOT / "news.json"
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
DELAY = 6  # secondes entre deux requêtes


def fetch_country(info):
    params = urllib.parse.urlencode({
        "query": f'"{info["name"]}" sourcelang:spanish sourcecountry:{info["fips"]}',
        "mode": "artlist",
        "format": "json",
        "maxrecords": "60",
        "sort": "datedesc",
        "timespan": "7d",
    })
    req = urllib.request.Request(f"{GDELT}?{params}", headers={"User-Agent": "mapa-hispano/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
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


def main():
    old = {}
    if NEWS_FILE.exists():
        try:
            old = json.loads(NEWS_FILE.read_text(encoding="utf-8")).get("countries", {})
        except json.JSONDecodeError:
            pass

    result = {}
    for iso, info in COUNTRIES.items():
        articles = None
        for attempt in range(2):
            try:
                articles = fetch_country(info)
                break
            except Exception as exc:  # réponse non JSON, timeout, limite de débit...
                print(f"[{iso}] tentative {attempt + 1} échouée : {exc}")
                time.sleep(10)
        if articles is None:
            result[iso] = old.get(iso, {"articles": []})
            print(f"[{iso}] anciennes données conservées")
        else:
            result[iso] = {"articles": articles}
            print(f"[{iso}] {len(articles)} articles")
        time.sleep(DELAY)

    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "countries": result,
    }
    NEWS_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("news.json écrit")


if __name__ == "__main__":
    main()
