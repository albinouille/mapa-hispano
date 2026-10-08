# 🌎 Mapa Hispano · Actualidad

Carte interactive du monde hispanophone : cliquez sur un pays pour afficher ses dernières actualités (en espagnol, issues de médias du pays). Les données se mettent à jour automatiquement.

## Fonctionnement

- **Carte** : [Leaflet](https://leafletjs.com/) + fond CARTO
- **Pays** : GeoJSON mondial filtré sur 20 pays hispanophones (`countries.js` côté page, `countries.json` côté robot)
- **Collecte** : un robot GitHub Actions (`.github/workflows/update-news.yml`) lance `scripts/fetch_news.py` **toutes les 30 minutes**. Il interroge l'API ouverte [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) (sans clé) et enregistre le résultat dans `news.json`
- **Affichage** : la page relit `news.json` toutes les 5 minutes et met à jour la liste sans rechargement. Un indicateur « Actualizado hace… » est affiché en haut à droite
- **Secours** : tant que `news.json` n'existe pas (premier lancement), la page interroge GDELT directement
- 100 % statique, aucun serveur à gérer

## Premier lancement du robot

Après avoir poussé le projet sur GitHub :

1. Onglet **Actions** → si GitHub le demande, cliquer sur « I understand my workflows, go ahead and enable them »
2. Choisir « Actualizar noticias » → **Run workflow** pour ne pas attendre les 30 minutes
3. Après 3 à 4 minutes, un fichier `news.json` apparaît dans le dépôt

Si le dépôt reste inactif pendant 60 jours, GitHub met les tâches planifiées en pause : il suffit de les réactiver dans l'onglet Actions. Les exécutions programmées peuvent aussi avoir quelques minutes de retard.

## Lancer en local

```bash
python3 scripts/fetch_news.py      # génère news.json (environ 3 min)
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Déployer sur GitHub Pages

Settings → Pages → Source : `main` / `(root)`.

## Pistes d'amélioration

- Ajouter Porto Rico, les États-Unis hispaniques, les Philippines
- Recherche par mot-clé et filtres par thème (politique, économie, sport)
- Flux RSS de médias nationaux en complément de GDELT
- Marqueurs « actualité chaude » selon le volume d'articles
- Mode multilingue (FR / EN / ES)

## Licence

MIT
