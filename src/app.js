"use strict";

const DATA_ROOT = "data/mohid/";

const els = {
  canvas: document.getElementById("raster-canvas"),
  varSelect: document.getElementById("var-select"),
  opacitySlider: document.getElementById("opacity-slider"),
  playBtn: document.getElementById("play-btn"),
  frameSlider: document.getElementById("frame-slider"),
  timeLabel: document.getElementById("time-label"),
  statusLine: document.getElementById("status-line"),
  legendBox: document.getElementById("legend-box")
};

let map;
let meta;
let grid = null;
let currentVar = "temperature";
let currentFrame = 0;
let timer = null;
let cache = new Map();

function setStatus(msg) {
  if (els.statusLine) els.statusLine.textContent = msg;
}

function frameCount() {
  return meta && meta.frames ? meta.frames.length : 0;
}

async function fetchJson(url) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "v=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return await res.json();
}

async function fetchFloat32(url, expectedLen = null) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const arr = new Float32Array(buf);
  if (expectedLen !== null && arr.length !== expectedLen) {
    throw new Error(`${url}: ${arr.length} != ${expectedLen}`);
  }
  return arr;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.round(window.innerWidth * dpr);
  els.canvas.height = Math.round(window.innerHeight * dpr);
  els.canvas.style.width = window.innerWidth + "px";
  els.canvas.style.height = window.innerHeight + "px";
  drawCurrentFrame();
}

function valueToT(v, vmin, vmax) {
  if (!Number.isFinite(v)) return NaN;
  if (vmax <= vmin) return 0;
  return Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(c0, c1, t) {
  return [mix(c0[0], c1[0], t), mix(c0[1], c1[1], t), mix(c0[2], c1[2], t)];
}

function smoothJet(t) {
  t = Math.max(0, Math.min(1, t));
  const c0 = [0.05, 0.18, 0.95];
  const c1 = [0.05, 0.62, 1.00];
  const c2 = [0.10, 0.78, 0.42];
  const c3 = [0.92, 0.86, 0.22];
  const c4 = [0.95, 0.55, 0.10];
  const c5 = [0.82, 0.12, 0.08];

  if (t < 0.20) return mixColor(c0, c1, t / 0.20);
  if (t < 0.40) return mixColor(c1, c2, (t - 0.20) / 0.20);
  if (t < 0.60) return mixColor(c2, c3, (t - 0.40) / 0.20);
  if (t < 0.80) return mixColor(c3, c4, (t - 0.60) / 0.20);
  return mixColor(c4, c5, (t - 0.80) / 0.20);
}

function ylgnbu(t) {
  t = Math.max(0, Math.min(1, t));
  const c0 = [1.000, 1.000, 0.800];
  const c1 = [0.780, 0.914, 0.706];
  const c2 = [0.498, 0.804, 0.733];
  const c3 = [0.255, 0.714, 0.769];
  const c4 = [0.173, 0.498, 0.722];
  const c5 = [0.145, 0.204, 0.580];

  if (t < 0.20) return mixColor(c0, c1, t / 0.20);
  if (t < 0.40) return mixColor(c1, c2, (t - 0.20) / 0.20);
  if (t < 0.60) return mixColor(c2, c3, (t - 0.40) / 0.20);
  if (t < 0.80) return mixColor(c3, c4, (t - 0.60) / 0.20);
  return mixColor(c4, c5, (t - 0.80) / 0.20);
}

function blueWhiteRed(t) {
  t = Math.max(0, Math.min(1, t));
  const blue = [0.05, 0.18, 0.95];
  const white = [0.98, 0.98, 0.96];
  const red = [0.82, 0.12, 0.08];

  if (t < 0.5) return mixColor(blue, white, t / 0.5);
  return mixColor(white, red, (t - 0.5) / 0.5);
}

function colorForValue(v, variable) {
  const vm = meta.variables[variable];
  const t = valueToT(v, vm.vmin, vm.vmax);
  if (!Number.isFinite(t)) return null;

  let c;
  if (vm.cmap === "ylgnbu") c = ylgnbu(t);
  else if (vm.cmap === "bwr") c = blueWhiteRed(t);
  else c = smoothJet(t);

  const alpha = Number(els.opacitySlider.value || 0.82);
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha})`;
}

function frameUrl(variable, frameIndex) {
  const frame = meta.frames[frameIndex];
  if (!frame) return null;
  return DATA_ROOT + frame.files[variable];
}

async function loadGrid() {
  const n = meta.grid.nx * meta.grid.ny;
  const nc = meta.grid.corner_nx * meta.grid.corner_ny;

  const lon = await fetchFloat32(DATA_ROOT + meta.grid.lon_file, n);
  const lat = await fetchFloat32(DATA_ROOT + meta.grid.lat_file, n);
  const mask = await fetchFloat32(DATA_ROOT + meta.grid.mask_file, n);
  const lonCorner = await fetchFloat32(DATA_ROOT + meta.grid.lon_corner_file, nc);
  const latCorner = await fetchFloat32(DATA_ROOT + meta.grid.lat_corner_file, nc);

  grid = {
    nx: meta.grid.nx,
    ny: meta.grid.ny,
    cornerNx: meta.grid.corner_nx,
    cornerNy: meta.grid.corner_ny,
    n,
    lon,
    lat,
    mask,
    lonCorner,
    latCorner
  };
}

async function loadFrame(variable, frameIndex) {
  const key = `${variable}:${frameIndex}`;
  if (cache.has(key)) return cache.get(key);

  const url = frameUrl(variable, frameIndex);
  const arr = await fetchFloat32(url, grid.n);
  cache.set(key, arr);
  return arr;
}

function drawCurvilinearCells(values) {
  const ctx = els.canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.lineWidth = 0;

  const nx = grid.nx;
  const ny = grid.ny;
  const cnx = grid.cornerNx;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;

      if (grid.mask[idx] <= 0) continue;

      const val = values[idx];
      if (!Number.isFinite(val)) continue;

      const fill = colorForValue(val, currentVar);
      if (!fill) continue;

      const c00 = j * cnx + i;
      const c10 = j * cnx + (i + 1);
      const c11 = (j + 1) * cnx + (i + 1);
      const c01 = (j + 1) * cnx + i;

      const lon00 = grid.lonCorner[c00], lat00 = grid.latCorner[c00];
      const lon10 = grid.lonCorner[c10], lat10 = grid.latCorner[c10];
      const lon11 = grid.lonCorner[c11], lat11 = grid.latCorner[c11];
      const lon01 = grid.lonCorner[c01], lat01 = grid.latCorner[c01];

      if (
        !Number.isFinite(lon00) || !Number.isFinite(lat00) ||
        !Number.isFinite(lon10) || !Number.isFinite(lat10) ||
        !Number.isFinite(lon11) || !Number.isFinite(lat11) ||
        !Number.isFinite(lon01) || !Number.isFinite(lat01)
      ) {
        continue;
      }

      const p00 = map.project([lon00, lat00]);
      const p10 = map.project([lon10, lat10]);
      const p11 = map.project([lon11, lat11]);
      const p01 = map.project([lon01, lat01]);

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(p00.x * dpr, p00.y * dpr);
      ctx.lineTo(p10.x * dpr, p10.y * dpr);
      ctx.lineTo(p11.x * dpr, p11.y * dpr);
      ctx.lineTo(p01.x * dpr, p01.y * dpr);
      ctx.closePath();
      ctx.fill();
    }
  }
}

async function drawCurrentFrame() {
  if (!meta || !grid || !map || !els.canvas) return;

  try {
    const values = await loadFrame(currentVar, currentFrame);
    drawCurvilinearCells(values);
    updateTimeLabel();
    updateLegend();
    setStatus(`MOHID ${meta.cycle}\n${currentVar} frame ${currentFrame + 1}/${frameCount()}`);
  } catch (err) {
    console.error(err);
    setStatus("Draw failed:\n" + err.message);
  }
}

function fmtLegendNumber(x, digits = 1) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function updateLegend() {
  const v = meta.variables[currentVar];
  if (!v) return;

  const jetGrad = "linear-gradient(to right,#0d2ef2,#0d9eff,#19c76b,#ebe038,#f28c1a,#d11f14)";
  const elevGrad = "linear-gradient(to right,#0d2ef2,#fafaf5,#d11f14)";
  const ylgnbuGrad = "linear-gradient(to right,#ffffcc,#c7e9b4,#7fcdbb,#41b6c4,#2c7fb8,#253494)";

  let grad = jetGrad;
  if (v.cmap === "ylgnbu") grad = ylgnbuGrad;
  if (v.cmap === "bwr") grad = elevGrad;

  const mid = (v.vmin + v.vmax) / 2;
  const digits = currentVar === "ssh" ? 2 : 1;

  els.legendBox.innerHTML =
    `<div class="legend-title">${v.label} [${v.unit}]</div>` +
    `<div style="height:14px;width:100%;margin:7px 0 5px;border-radius:4px;background:${grad};"></div>` +
    `<div class="legend-ticks">` +
    `<span>${fmtLegendNumber(v.vmin, digits)}</span>` +
    `<span>${fmtLegendNumber(mid, digits)}</span>` +
    `<span>${fmtLegendNumber(v.vmax, digits)}</span>` +
    `</div>`;
}

function updateTimeLabel() {
  const f = meta.frames[currentFrame];
  els.timeLabel.textContent = f ? (f.label || f.time_utc || "--") : "--";
}

function setFrame(i) {
  currentFrame = Math.max(0, Math.min(frameCount() - 1, Number(i)));
  els.frameSlider.value = String(currentFrame);
  drawCurrentFrame();
}

function stopPlay() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  els.playBtn.textContent = "Play";
}

function startPlay() {
  stopPlay();
  els.playBtn.textContent = "Pause";
  timer = setInterval(() => {
    const n = frameCount();
    if (n <= 0) return;
    setFrame((currentFrame + 1) % n);
  }, 900);
}

function togglePlay() {
  if (timer === null) startPlay();
  else stopPlay();
}

function setBasemap(name) {
  if (!map) return;
  if (name === "satellite") {
    map.setLayoutProperty("carto-light", "visibility", "none");
    map.setLayoutProperty("esri-satellite", "visibility", "visible");
  } else {
    map.setLayoutProperty("carto-light", "visibility", "visible");
    map.setLayoutProperty("esri-satellite", "visibility", "none");
  }
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    center: [125.2, 36.2],
    zoom: 5.4,
    minZoom: 3,
    maxZoom: 12,
    style: {
      version: 8,
      sources: {
        "carto-light": {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
          ],
          tileSize: 256,
          attribution: "© OpenStreetMap © CARTO"
        },
        "esri-satellite": {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          ],
          tileSize: 256,
          attribution: "Tiles © Esri"
        }
      },
      layers: [
        { id: "carto-light", type: "raster", source: "carto-light", layout: { visibility: "none" } },
        { id: "esri-satellite", type: "raster", source: "esri-satellite", layout: { visibility: "visible" } }
      ]
    }
  });

  map.on("load", drawCurrentFrame);
  map.on("moveend", drawCurrentFrame);
  map.on("zoomend", drawCurrentFrame);
  map.on("resize", resizeCanvas);
}

function bindEvents() {
  els.varSelect.addEventListener("change", () => {
    currentVar = els.varSelect.value;
    drawCurrentFrame();
  });

  els.opacitySlider.addEventListener("input", drawCurrentFrame);

  els.frameSlider.addEventListener("input", () => {
    stopPlay();
    setFrame(Number(els.frameSlider.value));
  });

  els.playBtn.addEventListener("click", togglePlay);

  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener("change", () => setBasemap(r.value));
  });

  window.addEventListener("resize", resizeCanvas);
}

async function init() {
  try {
    setStatus("Loading metadata...");
    meta = await fetchJson(DATA_ROOT + "meta.json");

    initMap();

    setStatus("Loading grid...");
    await loadGrid();

    els.frameSlider.max = String(frameCount() - 1);
    els.frameSlider.value = "0";

    bindEvents();
    resizeCanvas();
    updateLegend();
    updateTimeLabel();

    setStatus(`MOHID ${meta.cycle}\n${meta.forecast_start_utc} ~ ${meta.forecast_end_utc}`);
  } catch (err) {
    console.error(err);
    setStatus("Initialization failed:\n" + err.message);
  }
}

init();
