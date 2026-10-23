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

// Les repères (sismos, événements) vivent sur un calque au-dessus des pays,
// pour qu'un pays sélectionné ne les recouvre jamais.
map.createPane("markers");
map.getPane("markers").style.zIndex = 450;

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
    const meta = document.createElement("div");
    meta.className = "meta";
    if (!currentIso && a.iso && COUNTRIES[a.iso]) {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "tag";
      tag.textContent = COUNTRIES[a.iso].name;
      tag.addEventListener("click", () => selectIso(a.iso, true));
      meta.appendChild(tag);
    }
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = a.domain || "";
    meta.appendChild(src);
    const seen = parseSeen(a.seendate);
    if (seen) {
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = timeAgo(seen);
      meta.appendChild(when);
    }
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

/* ---------- Fiche pays : PIB, inflation (Banque mondiale), dirigeant (Wikidata) ---------- */

const WB_URL = "https://api.worldbank.org/v2/country/";
const WIKIDATA_URL = "https://query.wikidata.org/sparql";
const FACTS_REFRESH_MS = 6 * 60 * 60 * 1000;
let facts = null;   // { ISO3: { gdp, infl, leader } } ; null tant que rien n'est arrivé

// Espagne : le pouvoir exécutif est exercé par le chef du gouvernement (P6), ailleurs par le chef de l'État (P35).
function leaderQuery() {
  const rows = Object.keys(COUNTRIES)
    .map((iso) => (iso === "ESP" ? `("${iso}" p:P6 ps:P6)` : `("${iso}" p:P35 ps:P35)`))
    .join(" ");
  return `SELECT ?iso ?personLabel ?partyLabel ?start WHERE {
  VALUES (?iso ?p ?ps) { ${rows} }
  ?c wdt:P298 ?iso . ?c ?p ?st . ?st ?ps ?person .
  FILTER NOT EXISTS { ?st pq:P582 ?end }
  OPTIONAL { ?st pq:P580 ?start }
  OPTIONAL { ?person p:P102 ?m . ?m ps:P102 ?party . FILTER NOT EXISTS { ?m pq:P582 ?pe } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
}`;
}

async function wbIndicator(code) {
  const isos = Object.keys(COUNTRIES).join(";");
  const res = await fetch(`${WB_URL}${isos}/indicator/${code}?format=json&mrnev=1&per_page=100`);
  if (!res.ok) throw new Error(res.status);
  const rows = (await res.json())[1] || [];
  const out = {};
  for (const r of rows) {
    if (r.value != null && r.countryiso3code in COUNTRIES) out[r.countryiso3code] = { value: +r.value, year: r.date };
  }
  return out;
}

async function wikidataLeaders() {
  const res = await fetch(`${WIKIDATA_URL}?format=json&query=${encodeURIComponent(leaderQuery())}`, {
    headers: { Accept: "application/sparql-results+json" }
  });
  if (!res.ok) throw new Error(res.status);
  const rows = ((await res.json()).results || {}).bindings || [];
  const best = {};
  for (const r of rows) {
    const iso = r.iso.value;
    const name = (r.personLabel || {}).value;
    if (!name || /^Q\d+$/.test(name)) continue;
    const start = r.start ? r.start.value : "";
    const cur = best[iso];
    if (!cur || (name !== cur.name && start > cur.start)) best[iso] = { name, start, parties: [] };
    if (best[iso].name === name && r.partyLabel && r.partyLabel.value && !best[iso].parties.includes(r.partyLabel.value)) {
      best[iso].parties.push(r.partyLabel.value);
    }
  }
  return best;
}

async function loadFacts() {
  const [gdp, infl, leaders] = await Promise.allSettled([
    wbIndicator("NY.GDP.MKTP.CD"),
    wbIndicator("FP.CPI.TOTL.ZG"),
    wikidataLeaders()
  ]);
  if (gdp.status === "rejected" && infl.status === "rejected" && leaders.status === "rejected") {
    console.warn("Datos de país no disponibles");
    return;
  }
  const val = (s) => (s.status === "fulfilled" ? s.value : {});
  facts = {};
  for (const iso of Object.keys(COUNTRIES)) {
    facts[iso] = { gdp: val(gdp)[iso], infl: val(infl)[iso], leader: val(leaders)[iso] };
  }
  renderFicha();
}

function fmtGdp(usd) {
  const nf = (d) => new Intl.NumberFormat("es-ES", { maximumFractionDigits: d, minimumFractionDigits: d });
  const bn = usd / 1e9;
  return bn >= 1000 ? `US$ ${nf(2).format(bn / 1000)} billones` : `US$ ${nf(0).format(bn)} mil millones`;
}

function fichaItem(label, value, sub, wide) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (value) {
    dd.textContent = value;
  } else {
    dd.className = "na";
    dd.textContent = "No disponible";
  }
  if (value && sub) {
    const s = document.createElement("small");
    s.textContent = sub;
    dd.appendChild(s);
  }
  const item = document.createElement("div");
  item.className = wide ? "wide" : "";
  item.append(dt, dd);
  return [item];
}

function renderFicha() {
  const box = $("ficha");
  box.innerHTML = "";
  if (!currentIso || !facts) {
    box.hidden = true;
    return;
  }
  const f = facts[currentIso] || {};
  const dl = document.createElement("dl");
  const leaderLabel = currentIso === "ESP" ? "Presidente del Gobierno" : "Presidente";
  const l = f.leader;
  const since = l && l.start ? `En el cargo desde ${new Date(l.start).getUTCFullYear()}` : "";
  dl.append(...fichaItem(leaderLabel, l && l.name, since, true));
  dl.append(...fichaItem("Partido", l && l.parties.length ? l.parties.slice(0, 2).join(" · ") : "", "", true));
  dl.append(...fichaItem("PIB", f.gdp && fmtGdp(f.gdp.value), f.gdp && `Dato de ${f.gdp.year}`));
  dl.append(
    ...fichaItem(
      "Inflación anual",
      f.infl && `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(f.infl.value)} %`,
      f.infl && `Dato de ${f.infl.year}`
    )
  );
  const src = document.createElement("p");
  src.className = "src";
  src.textContent = "Banco Mundial (PIB, inflación) · Wikidata (cargo y partido, pueden ir con retraso).";
  box.append(dl, src);
  box.hidden = false;
}

function render() {
  renderFicha();
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

const RAMP = ["#34322b", "#5f5438", "#8f7c52", "#b9a577", "#dccb9f"];
const EMPTY_FILL = "#26272d";

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
  let fill = "#cdb78a";
  let opacity = 0.22;
  if ($("toggle-activity").checked && newsData) {
    const n = activity.counts[iso] || 0;
    if (n === 0 || activity.max === 0) {
      fill = EMPTY_FILL;
    } else {
      const idx = Math.min(RAMP.length - 1, Math.ceil((n / activity.max) * RAMP.length) - 1);
      fill = RAMP[idx];
    }
    opacity = 0.9;
  }
  return {
    color: selected ? "#fffaf0" : "#8f7a4e",
    weight: selected ? 2.5 : 0.8,
    fillColor: fill,
    fillOpacity: selected ? 1 : opacity
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
  div.innerHTML = '<span>Menos</span><span class="bar"></span><span>Más titulares</span>';
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
      pane: "markers",
      radius: 3 + m * 1.8,
      color: "#f0b8a8",
      weight: 1,
      fillColor: m >= 5 ? "#e0583f" : m >= 4 ? "#d1745f" : "#b98778",
      fillOpacity: 0.8
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
  wildfires: "#d1745f",
  volcanoes: "#e0583f",
  severeStorms: "#8fb4c9",
  floods: "#6f9bb3",
  drought: "#b59a5f",
  landslides: "#9c8570",
  earthquakes: "#e0583f",
  seaLakeIce: "#b9d3e0",
  dustHaze: "#a8a294",
  snow: "#d6e3ea",
  tempExtremes: "#e0883f",
  waterColor: "#7fb3a4",
  manmade: "#8a8a90"
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
      pane: "markers",
      radius: 7,
      color: "#15161a",
      weight: 1.5,
      fillColor: EVENT_COLORS[cat.id] || "#8a8a90",
      fillOpacity: 0.9
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
      style: (f) => styleFor(f.id),
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
loadFacts();
setInterval(loadFacts, FACTS_REFRESH_MS);
setInterval(refreshData, REFRESH_MS);
setInterval(updateBadge, 60 * 1000);
setInterval(() => {
  loadQuakes();
  loadEvents();
}, EXTRA_REFRESH_MS);
