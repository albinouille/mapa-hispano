const GEOJSON_URL =
  "https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const QUAKES_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson";
const EONET_URL =
  "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=300";
const REFRESH_MS = 5 * 60 * 1000;         // relit news.json toutes les 5 minutes
const EXTRA_REFRESH_MS = 15 * 60 * 1000;  // relit sismos et événements toutes les 15 minutes

// Zones gardées pour les sismos et événements naturels (Amériques, Espagne + Canaries, Guinée équatoriale)
const REGIONS = [
  { latMin: -57, latMax: 33, lonMin: -120, lonMax: -30 },
  { latMin: 27, latMax: 44.5, lonMin: -19, lonMax: 5 },
  { latMin: -2, latMax: 4, lonMin: 5, lonMax: 12 }
];
const inRegion = (lat, lon) =>
  REGIONS.some((r) => lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax);

const map = L.map("map", { worldCopyJump: true }).setView([5, -65], 3);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 8
}).addTo(map);

const $ = (id) => document.getElementById(id);
const days = () => +$("timespan").value;

const layers = { quakes: L.layerGroup(), events: L.layerGroup() };
const countryLayers = {};   // iso -> couche Leaflet
let newsData = null;        // contenu de news.json
let quakeData = [];
let eventData = [];
let currentIso = null;
let activeTopic = "todas";
let activity = { counts: {}, max: 0 };
let lastLiveRequest = 0;
const toolErrors = {};

/* ---------- Utilitaires ---------- */

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

const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function popupEl(title, lines, url) {
  const div = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  div.appendChild(strong);
  for (const line of lines) {
    const p = document.createElement("div");
    p.textContent = line;
    div.appendChild(p);
  }
  if (url && /^https?:\/\//.test(url)) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Más información";
    div.appendChild(a);
  }
  return div;
}

function setToolError(key, message) {
  if (message) toolErrors[key] = message;
  else delete toolErrors[key];
  $("toolstatus").textContent = Object.values(toolErrors).join(" · ");
}

/* ---------- Thèmes (classement approximatif par mots-clés) ---------- */

const TOPICS = {
  todas: { label: "Todas" },
  politica: {
    label: "Política",
    re: /gobiern|president|congres|senad|eleccion|ministr|parlament|partido|politic|legisl|diputad|candidat|govern|eleicao|eleicoes|camara|canciller/
  },
  economia: {
    label: "Economía",
    re: /econom|inflaci|inflacao|dolar|banco|mercado|bolsa|\bpib\b|empleo|precio|petrole|comercio|arancel|deuda|inversi|export|import|salario|impuesto|tarifa|juros/
  },
  seguridad: {
    label: "Seguridad",
    re: /asesin|homicid|narco|crimen|crime|violenc|ataque|polic|detenid|armad|balacera|secuestr|cartel|pandilla|terror|militar|guerra|conflicto|tiroteo|trafico|prision|muert|fallecid/
  },
  protestas: {
    label: "Protestas",
    re: /protest|manifest|marcha|huelga|\bparo\b|bloqueo|disturbio|greve|movilizaci/
  },
  naturaleza: {
    label: "Naturaleza",
    re: /sismo|terremoto|temblor|huracan|tormenta|inundaci|incendio|volcan|erupci|lluvia|sequia|ola de calor|tsunami|ciclon|clima|chuva|enchente|queimada/
  }
};

function classify(title) {
  const t = norm(title);
  return Object.keys(TOPICS).filter((k) => TOPICS[k].re && TOPICS[k].re.test(t));
}

function filterTopic(items) {
  if (activeTopic === "todas") return items;
  return items.filter((a) => classify(a.title).includes(activeTopic));
}

/* ---------- Actualités ---------- */

function articlesOf(iso) {
  const cutoff = Date.now() - days() * 86400000;
  const all = ((newsData && newsData.countries[iso]) || {}).articles || [];
  return all.filter((a) => {
    const d = parseSeen(a.seendate);
    return !d || d.getTime() >= cutoff;
  });
}

function renderItems(items) {
  const list = $("news");
  const status = $("status");
  list.innerHTML = "";
  if (!items.length) {
    status.textContent = "Sin noticias para este filtro y periodo.";
    return;
  }
  status.textContent = "";
  for (const a of items) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = /^https?:\/\//.test(a.url || "") ? a.url : "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = a.title;
    li.append(link);
    if (!currentIso && a.iso && COUNTRIES[a.iso]) {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.textContent = COUNTRIES[a.iso].name;
      tag.addEventListener("click", () => selectIso(a.iso, true));
      li.append(tag);
    }
    const meta = document.createElement("small");
    const seen = parseSeen(a.seendate);
    meta.textContent = seen ? `${a.domain} · ${timeAgo(seen)}` : a.domain;
    li.append(meta);
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
    query: `"${c.name}" sourcelang:${c.lang || "spanish"} sourcecountry:${c.fips}`,
    mode: "artlist",
    format: "json",
    maxrecords: "30",
    sort: "datedesc",
    timespan: `${days()}d`
  });
  try {
    const res = await fetch(`${GDELT}?${params}`);
    const data = await res.json();
    if (currentIso !== iso) return;
    renderItems(filterTopic((data.articles || []).map((a) => ({ ...a, iso }))));
  } catch (e) {
    $("status").textContent = "No se pudieron cargar las noticias. Inténtalo de nuevo.";
    console.error(e);
  }
}

function render() {
  $("back").hidden = !currentIso;
  $("country-name").textContent = currentIso ? COUNTRIES[currentIso].name : "Titulares en directo";
  if (!newsData) {
    if (currentIso) {
      loadLive(currentIso);
    } else {
      $("news").innerHTML = "";
      $("status").textContent = "Datos aún no disponibles. Haz clic en un país para cargar sus noticias.";
    }
    return;
  }
  let items;
  if (currentIso) {
    items = articlesOf(currentIso).map((a) => ({ ...a, iso: currentIso }));
  } else {
    items = [];
    for (const iso of Object.keys(COUNTRIES)) {
      for (const a of articlesOf(iso)) items.push({ ...a, iso });
    }
    items.sort((a, b) => (b.seendate || "").localeCompare(a.seendate || ""));
  }
  items = filterTopic(items);
  if (!currentIso) items = items.slice(0, 80);
  renderItems(items);
}

/* ---------- Carte : pays et actividad mediática ---------- */

const RAMP = ["#fde8d4", "#f9c49a", "#f4a261", "#e8590c", "#a63a08"];

function computeActivity() {
  const counts = {};
  let max = 0;
  for (const iso of Object.keys(COUNTRIES)) {
    counts[iso] = filterTopic(articlesOf(iso)).length;
    if (counts[iso] > max) max = counts[iso];
  }
  activity = { counts, max };
}

function styleFor(iso) {
  const selected = iso === currentIso;
  let fill = "#f4a261";
  let opacity = 0.4;
  if ($("toggle-activity").checked && newsData) {
    const n = activity.counts[iso] || 0;
    if (n === 0 || activity.max === 0) {
      fill = "#e9ecef";
    } else {
      const idx = Math.min(RAMP.length - 1, Math.ceil((n / activity.max) * RAMP.length) - 1);
      fill = RAMP[idx];
    }
    opacity = 0.75;
  }
  return {
    color: "#7a2e0e",
    weight: selected ? 3 : 1,
    fillColor: fill,
    fillOpacity: selected ? 0.9 : opacity
  };
}

function restyle() {
  computeActivity();
  for (const [iso, layer] of Object.entries(countryLayers)) {
    layer.setStyle(styleFor(iso));
  }
  if (currentIso && countryLayers[currentIso]) countryLayers[currentIso].bringToFront();
}

function tooltipText(iso) {
  const name = COUNTRIES[iso].name;
  if ($("toggle-activity").checked && newsData) {
    return `${name} · ${activity.counts[iso] || 0} titulares`;
  }
  return name;
}

function selectIso(iso, fit) {
  currentIso = iso;
  restyle();
  render();
  const layer = countryLayers[iso];
  if (fit && layer) map.fitBounds(layer.getBounds(), { maxZoom: 5, padding: [30, 30] });
}

function clearSelection() {
  currentIso = null;
  restyle();
  render();
  map.setView([5, -65], 3);
}

const legend = L.control({ position: "bottomleft" });
legend.onAdd = () => {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML =
    "<span>Menos</span>" +
    RAMP.map((c) => `<i style="background:${c}"></i>`).join("") +
    "<span>Más titulares</span>";
  return div;
};
legend.addTo(map);

function updateLegend() {
  const c = legend.getContainer();
  if (c) c.style.display = $("toggle-activity").checked ? "flex" : "none";
}

/* ---------- Sismos (USGS) ---------- */

function drawQuakes() {
  layers.quakes.clearLayers();
  const cutoff = Date.now() - days() * 86400000;
  let n = 0;
  for (const f of quakeData) {
    const coords = (f.geometry || {}).coordinates;
    if (!coords) continue;
    const [lon, lat] = coords;
    const p = f.properties || {};
    if (!(p.time >= cutoff) || !inRegion(lat, lon)) continue;
    const m = p.mag || 0;
    L.circleMarker([lat, lon], {
      radius: 3 + m * 1.8,
      color: "#7a0c0c",
      weight: 1,
      fillColor: m >= 5 ? "#c92a2a" : m >= 4 ? "#e8590c" : "#f59f00",
      fillOpacity: 0.6
    })
      .bindPopup(
        popupEl(`Sismo M${m.toFixed(1)}`, [p.place || "", new Date(p.time).toLocaleString("es-ES")], p.url)
      )
      .addTo(layers.quakes);
    n++;
  }
  $("count-quakes").textContent = `(${n})`;
}

async function loadQuakes() {
  try {
    const res = await fetch(QUAKES_URL);
    if (!res.ok) throw new Error(res.status);
    quakeData = (await res.json()).features || [];
    setToolError("quakes", null);
  } catch (e) {
    console.warn("Sismos no disponibles", e);
    setToolError("quakes", "Sismos no disponibles");
  }
  drawQuakes();
}

/* ---------- Événements naturels (NASA EONET) ---------- */

const EVENT_COLORS = {
  wildfires: "#e8590c",
  volcanoes: "#c92a2a",
  severeStorms: "#1c7ed6",
  floods: "#0b7285",
  drought: "#a67c00",
  landslides: "#6f4e37",
  earthquakes: "#c92a2a",
  seaLakeIce: "#74c0fc",
  dustHaze: "#868e96",
  snow: "#74c0fc",
  tempExtremes: "#f03e3e",
  waterColor: "#12b886",
  manmade: "#495057"
};
const EVENT_LABELS = {
  wildfires: "Incendio",
  volcanoes: "Volcán",
  severeStorms: "Tormenta severa",
  floods: "Inundación",
  drought: "Sequía",
  landslides: "Deslizamiento",
  earthquakes: "Sismo",
  seaLakeIce: "Hielo",
  dustHaze: "Polvo / bruma",
  snow: "Nieve",
  tempExtremes: "Temperaturas extremas",
  waterColor: "Color del agua",
  manmade: "Origen humano"
};

function eventPoint(ev) {
  const g = (ev.geometry || [])[(ev.geometry || []).length - 1];
  if (!g) return null;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1], date: g.date };
  if (g.type === "Polygon" && g.coordinates[0] && g.coordinates[0].length) {
    const ring = g.coordinates[0];
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    return { lon, lat, date: g.date };
  }
  return null;
}

function drawEvents() {
  layers.events.clearLayers();
  const cutoff = Date.now() - days() * 86400000;
  let n = 0;
  for (const ev of eventData) {
    const pt = eventPoint(ev);
    if (!pt || !inRegion(pt.lat, pt.lon)) continue;
    const when = new Date(pt.date);
    if (!(when.getTime() >= cutoff)) continue;
    const cat = (ev.categories || [])[0] || {};
    L.circleMarker([pt.lat, pt.lon], {
      radius: 7,
      color: "#222",
      weight: 1,
      fillColor: EVENT_COLORS[cat.id] || "#495057",
      fillOpacity: 0.85
    })
      .bindPopup(
        popupEl(
          ev.title || "Evento natural",
          [EVENT_LABELS[cat.id] || cat.title || "", when.toLocaleString("es-ES")],
          ev.link
        )
      )
      .addTo(layers.events);
    n++;
  }
  $("count-events").textContent = `(${n})`;
}

async function loadEvents() {
  try {
    const res = await fetch(EONET_URL);
    if (!res.ok) throw new Error(res.status);
    eventData = (await res.json()).events || [];
    setToolError("events", null);
  } catch (e) {
    console.warn("Eventos naturales no disponibles", e);
    setToolError("events", "Eventos naturales no disponibles");
  }
  drawEvents();
}

/* ---------- Données de news.json ---------- */

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
  restyle();
  render();
}

/* ---------- Interface ---------- */

function buildTopics() {
  const box = $("topics");
  for (const [key, t] of Object.entries(TOPICS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (key === activeTopic ? " active" : "");
    b.textContent = t.label;
    b.dataset.key = key;
    b.addEventListener("click", () => {
      activeTopic = key;
      for (const c of box.children) c.classList.toggle("active", c.dataset.key === key);
      restyle();
      render();
    });
    box.appendChild(b);
  }
}

function bindLayerToggle(id, group) {
  const box = $(id);
  const apply = () => (box.checked ? map.addLayer(group) : map.removeLayer(group));
  box.addEventListener("change", apply);
  apply();
}

$("toggle-activity").addEventListener("change", () => {
  restyle();
  updateLegend();
});
$("timespan").addEventListener("change", () => {
  restyle();
  render();
  drawQuakes();
  drawEvents();
});
$("back").addEventListener("click", clearSelection);

fetch(GEOJSON_URL)
  .then((r) => r.json())
  .then((geo) => {
    L.geoJSON(geo, {
      filter: (f) => f.id in COUNTRIES,
      style: () => ({ color: "#7a2e0e", weight: 1, fillColor: "#f4a261", fillOpacity: 0.4 }),
      onEachFeature: (f, layer) => {
        countryLayers[f.id] = layer;
        layer.bindTooltip(() => tooltipText(f.id), { sticky: true });
        layer.on("click", () => selectIso(f.id, true));
      }
    }).addTo(map);
    restyle();
  })
  .catch((e) => {
    console.error("No se pudo cargar el mapa de países", e);
    setToolError("geo", "No se pudo cargar el mapa de países");
  });

buildTopics();
bindLayerToggle("toggle-quakes", layers.quakes);
bindLayerToggle("toggle-events", layers.events);
updateLegend();
render();
refreshData();
loadQuakes();
loadEvents();
setInterval(refreshData, REFRESH_MS);
setInterval(updateBadge, 60 * 1000);
setInterval(() => {
  loadQuakes();
  loadEvents();
}, EXTRA_REFRESH_MS);
