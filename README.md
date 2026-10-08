# 🌎 Mapa Hispano · Actualidad

Tableau de bord léger du monde hispanophone (Espagne, Amérique latine) et du Brésil, inspiré de [World Monitor](https://www.worldmonitor.app/) mais volontairement beaucoup plus simple. Tout est gratuit, sans clé d'API, et se met à jour automatiquement.

## Ce que fait la page

- **Carte** des 21 pays, colorée selon l'**activité médiatique** (plus un pays a de titres récents, plus il est foncé)
- **Fil de titres en direct** de tous les pays, ou d'un seul pays au clic
- **Filtres par thème** : Política, Economía, Seguridad, Protestas, Naturaleza (classement approximatif par mots-clés, qui agit aussi sur les couleurs de la carte)
- **Calques activables** : actividad mediática, sismos M2.5+ (USGS), eventos naturales (NASA EONET : incendies, volcans, tempêtes…)
- **Période** au choix : 24 h, 3 jours, 7 jours
- Indicateur « Actualizado hace… » en haut à droite

## Fonctionnement

- **Carte** : [Leaflet](https://leafletjs.com/) + fond OpenStreetMap
- **Pays** : `countries.js` (côté page) et `countries.json` (côté robot). Le Brésil est interrogé en portugais, les autres en espagnol
- **Titres** : un robot GitHub Actions (`.github/workflows/update-news.yml`) lance `scripts/fetch_news.py` **toutes les 30 minutes**. Il interroge l'API ouverte [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) et enregistre le résultat dans `news.json`
- **Sismos et événements naturels** : la page interroge directement l'USGS et la NASA EONET, et les relit toutes les 15 minutes
- La page relit `news.json` toutes les 5 minutes, sans rechargement
- **Secours** : tant que `news.json` n'existe pas, la page interroge GDELT directement
- 100 % statique, aucun serveur à gérer

## Premier lancement du robot

1. Onglet **Actions** → si GitHub le demande, activer les workflows
2. Choisir « Actualizar noticias » → **Run workflow** pour ne pas attendre 30 minutes
3. Après 4 à 8 minutes, `news.json` est mis à jour dans le dépôt

Si le dépôt reste inactif 60 jours, GitHub met les tâches planifiées en pause : il suffit de les réactiver dans l'onglet Actions.

## Lancer en local

```bash
python3 scripts/fetch_news.py      # génère news.json (quelques minutes)
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Déployer sur GitHub Pages

Settings → Pages → Source : `main` / `(root)`.

## Limites connues

- Le classement par thème est basé sur des mots-clés dans les titres : il se trompe parfois
- Les sismos et événements naturels couvrent les Amériques, l'Espagne (Canaries comprises) et la Guinée équatoriale
- GDELT impose environ une requête toutes les 5 secondes, d'où un passage du robot de plusieurs minutes

## Pistes d'amélioration

- Autres calques : conflits (ACLED), marchés, alertes météo nationales
- Recherche par mot-clé
- Porto Rico, États-Unis hispaniques, Philippines
- Flux RSS de médias nationaux en complément de GDELT
- Mode multilingue (FR / EN / ES)

## Licence

MIT
