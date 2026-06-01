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
let imageCache = new Map();

function setStatus(msg) {
  if (els.statusLine) els.statusLine.textContent = msg;
}

function pad4(i) {
  return String(i).padStart(4, "0");
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

function mercatorProject(lon, lat) {
  const x = (lon + 180.0) / 360.0;
  const sin = Math.sin((lat * Math.PI) / 180.0);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  els.canvas.width = Math.round(w * dpr);
  els.canvas.height = Math.round(h * dpr);
  els.canvas.style.width = w + "px";
  els.canvas.style.height = h + "px";

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
  return [
    mix(c0[0], c1[0], t),
    mix(c0[1], c1[1], t),
    mix(c0[2], c1[2], t)
  ];
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
  if (!Number.isFinite(t)) return [0, 0, 0, 0];

  let c;
  if (vm.cmap === "ylgnbu") c = ylgnbu(t);
  else if (vm.cmap === "bwr") c = blueWhiteRed(t);
  else c = smoothJet(t);

  return [
    Math.round(c[0] * 255),
    Math.round(c[1] * 255),
    Math.round(c[2] * 255),
    Math.round(255 * Number(els.opacitySlider.value || 0.82))
  ];
}

function frameUrl(variable, frameIndex) {
  const frame = meta.frames[frameIndex];
  if (!frame) return null;
  return DATA_ROOT + frame.files[variable];
}

async function loadGrid() {
  const n = meta.grid.nx * meta.grid.ny;
  const lon = await fetchFloat32(DATA_ROOT + meta.grid.lon_file, n);
  const lat = await fetchFloat32(DATA_ROOT + meta.grid.lat_file, n);
  const mask = await fetchFloat32(DATA_ROOT + meta.grid.mask_file, n);

  const merc = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = mercatorProject(lon[i], lat[i]);
    merc[i * 2] = p.x;
    merc[i * 2 + 1] = p.y;
  }

  grid = {
    nx: meta.grid.nx,
    ny: meta.grid.ny,
    n,
    lon,
    lat,
    mask,
    merc
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

function makeRasterImage(variable, values) {
  const key = `${variable}:${currentFrame}:op${els.opacitySlider.value}`;
  if (imageCache.has(key)) return imageCache.get(key);

  const nx = grid.nx;
  const ny = grid.ny;
  const image = new ImageData(nx, ny);
  const data = image.data;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const src = j * nx + i;
      const dst = src * 4;
      const rgba = colorForValue(values[src], variable);

      data[dst] = rgba[0];
      data[dst + 1] = rgba[1];
      data[dst + 2] = rgba[2];
      data[dst + 3] = grid.mask[src] > 0 ? rgba[3] : 0;
    }
  }

  imageCache.set(key, image);
  return image;
}

function drawImageProjected(image) {
  const ctx = els.canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);

  if (!grid || !map) return;

  const nx = grid.nx;
  const ny = grid.ny;

  const off = document.createElement("canvas");
  off.width = nx;
  off.height = ny;
  const offCtx = off.getContext("2d");
  offCtx.putImageData(image, 0, 0);

  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;

  const bounds = [
    [meta.grid.lon_min, meta.grid.lat_min],
    [meta.grid.lon_max, meta.grid.lat_max]
  ];

  const sw = map.project([bounds[0][0], bounds[0][1]]);
  const ne = map.project([bounds[1][0], bounds[1][1]]);

  const x = sw.x * dpr;
  const y = ne.y * dpr;
  const w = (ne.x - sw.x) * dpr;
  const h = (sw.y - ne.y) * dpr;

  ctx.drawImage(off, x, y, w, h);
}

async function drawCurrentFrame() {
  if (!meta || !grid || !map || !els.canvas) return;

  try {
    const values = await loadFrame(currentVar, currentFrame);
    const img = makeRasterImage(currentVar, values);
    drawImageProjected(img);
    updateTimeLabel();
    updateLegend();
    setStatus(
      `MOHID ${meta.cycle}\n` +
      `${currentVar} frame ${currentFrame + 1}/${frameCount()}`
    );
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
  if (!f) {
    els.timeLabel.textContent = "--";
    return;
  }
  els.timeLabel.textContent = f.label || f.time_utc || "--";
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
    const next = (currentFrame + 1) % n;
    setFrame(next);
  }, 700);
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
        {
          id: "carto-light",
          type: "raster",
          source: "carto-light",
          layout: { visibility: "visible" }
        },
        {
          id: "esri-satellite",
          type: "raster",
          source: "esri-satellite",
          layout: { visibility: "none" }
        }
      ]
    }
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");

  map.on("load", () => {
    drawCurrentFrame();
  });

  map.on("move", () => {
    drawCurrentFrame();
  });

  map.on("zoom", () => {
    drawCurrentFrame();
  });

  map.on("resize", () => {
    resizeCanvas();
  });
}

function bindEvents() {
  els.varSelect.addEventListener("change", () => {
    currentVar = els.varSelect.value;
    imageCache.clear();
    drawCurrentFrame();
  });

  els.opacitySlider.addEventListener("input", () => {
    imageCache.clear();
    drawCurrentFrame();
  });

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

    setStatus(
      `MOHID ${meta.cycle}\n` +
      `${meta.forecast_start_utc} ~ ${meta.forecast_end_utc}`
    );
  } catch (err) {
    console.error(err);
    setStatus("Initialization failed:\n" + err.message);
  }
}

init();
