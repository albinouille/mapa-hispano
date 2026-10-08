const GEOJSON_URL =
  "https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const REFRESH_MS = 5 * 60 * 1000; // la page relit news.json toutes les 5 minutes

const map = L.map("map", { worldCopyJump: true }).setView([10, -60], 3);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 8
}).addTo(map);

const style = (selected) => ({
  color: "#7a2e0e",
  weight: selected ? 3 : 1,
  fillColor: selected ? "#e8590c" : "#f4a261",
  fillOpacity: selected ? 0.7 : 0.45
});

const $ = (id) => document.getElementById(id);

let newsData = null;      // contenu de news.json
let currentLayer = null;
let currentIso = null;
let lastLiveRequest = 0;

// "20261008T101500Z" -> Date
function parseSeen(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || "");
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

function timeAgo(date) {
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

function renderArticles(articles) {
  const list = $("news");
  const status = $("status");
  list.innerHTML = "";
  if (!articles.length) {
    status.textContent = "Sin noticias en este periodo.";
    return;
  }
  status.textContent = "";
  for (const a of articles) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = a.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = a.title;
    const meta = document.createElement("small");
    const seen = parseSeen(a.seendate);
    meta.textContent = seen ? `${a.domain} · ${timeAgo(seen)}` : a.domain;
    li.append(link, meta);
    list.appendChild(li);
  }
}

// Secours : appel direct à GDELT si news.json n'existe pas encore
async function loadLive(iso) {
  const c = COUNTRIES[iso];
  $("status").textContent = "Cargando noticias…";
  const wait = Math.max(0, 5200 - (Date.now() - lastLiveRequest));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastLiveRequest = Date.now();
  const params = new URLSearchParams({
    query: `"${c.name}" sourcelang:spanish sourcecountry:${c.fips}`,
    mode: "artlist",
    format: "json",
    maxrecords: "20",
    sort: "datedesc",
    timespan: `${$("timespan").value}d`
  });
  try {
    const res = await fetch(`${GDELT}?${params}`);
    const data = await res.json();
    renderArticles(data.articles || []);
  } catch (e) {
    $("status").textContent = "No se pudieron cargar las noticias. Inténtalo de nuevo.";
    console.error(e);
  }
}

function showCountry(iso) {
  if (!newsData) return loadLive(iso);
  const days = +$("timespan").value;
  const cutoff = Date.now() - days * 86400000;
  const all = (newsData.countries[iso] || {}).articles || [];
  renderArticles(
    all.filter((a) => {
      const d = parseSeen(a.seendate);
      return !d || d.getTime() >= cutoff;
    })
  );
}

function updateBadge() {
  if (!newsData || !newsData.updated) {
    $("updated").textContent = "Modo directo";
    return;
  }
  $("updated").textContent = `Actualizado ${timeAgo(new Date(newsData.updated))}`;
}

async function refreshData() {
  try {
    const res = await fetch(`news.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    newsData = await res.json();
  } catch (e) {
    console.warn("news.json no disponible, modo directo", e);
    newsData = null;
  }
  updateBadge();
  if (currentIso) showCountry(currentIso);
}

function select(iso, layer) {
  if (currentLayer) currentLayer.setStyle(style(false));
  currentLayer = layer;
  currentIso = iso;
  layer.setStyle(style(true));
  $("country-name").textContent = COUNTRIES[iso].name;
  $("controls").hidden = false;
  showCountry(iso);
}

fetch(GEOJSON_URL)
  .then((r) => r.json())
  .then((geo) => {
    L.geoJSON(geo, {
      filter: (f) => f.id in COUNTRIES,
      style: () => style(false),
      onEachFeature: (f, layer) => {
        layer.bindTooltip(COUNTRIES[f.id].name, { sticky: true });
        layer.on("click", () => select(f.id, layer));
      }
    }).addTo(map);
  });

$("timespan").addEventListener("change", () => currentIso && showCountry(currentIso));

refreshData();
setInterval(refreshData, REFRESH_MS);
setInterval(updateBadge, 60 * 1000);
