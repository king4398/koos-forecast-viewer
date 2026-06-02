"use strict";

const DATA_ROOT = "data/mohid/";

const els = {
  varSelect: document.getElementById("var-select"),
  opacitySlider: document.getElementById("opacity-slider"),
  playBtn: document.getElementById("play-btn"),
  frameSlider: document.getElementById("frame-slider"),
  timeLabel: document.getElementById("time-label"),
  statusLine: document.getElementById("status-line"),
  legendBox: document.getElementById("legend-box"),
  meshOverlay: document.getElementById("mesh-overlay-check")
};

let map = null;
let meta = null;
let grid = null;
let currentVar = "temperature";
let currentFrame = 0;
let timer = null;
let scalarCache = new Map();

const GLState = {
  gl: null,
  scalarProgram: null,
  meshProgram: null,
  posBuffer: null,
  valBuffer: null,
  meshPosBuffer: null,
  aPos: null,
  aVal: null,
  uMatrix: null,
  uVmin: null,
  uVmax: null,
  uOpacity: null,
  uCmap: null,
  meshAPos: null,
  meshUMatrix: null,
  meshUColor: null,
  vertexCount: 0,
  meshVertexCount: 0,
  ready: false,
  valuesReady: false
};

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

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

function makeProgram(gl, vs, fs) {
  const p = gl.createProgram();
  const a = compileShader(gl, gl.VERTEX_SHADER, vs);
  const b = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a);
  gl.attachShader(p, b);
  gl.linkProgram(p);
  gl.deleteShader(a);
  gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log);
  }
  return p;
}

const SCALAR_VS = `
precision highp float;
attribute vec2 a_pos;
attribute float a_value;
uniform mat4 u_matrix;
varying float v_value;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_value = a_value;
}
`;

const SCALAR_FS = `
precision highp float;
varying float v_value;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_opacity;
uniform int u_cmap;

vec3 mix3(vec3 a, vec3 b, float t) {
  return a * (1.0 - t) + b * t;
}

vec3 smoothJet(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.05, 0.18, 0.95);
  vec3 c1 = vec3(0.05, 0.62, 1.00);
  vec3 c2 = vec3(0.10, 0.78, 0.42);
  vec3 c3 = vec3(0.92, 0.86, 0.22);
  vec3 c4 = vec3(0.95, 0.55, 0.10);
  vec3 c5 = vec3(0.82, 0.12, 0.08);
  if (t < 0.20) return mix3(c0, c1, t / 0.20);
  if (t < 0.40) return mix3(c1, c2, (t - 0.20) / 0.20);
  if (t < 0.60) return mix3(c2, c3, (t - 0.40) / 0.20);
  if (t < 0.80) return mix3(c3, c4, (t - 0.60) / 0.20);
  return mix3(c4, c5, (t - 0.80) / 0.20);
}

vec3 ylgnbu(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(1.000, 1.000, 0.800);
  vec3 c1 = vec3(0.780, 0.914, 0.706);
  vec3 c2 = vec3(0.498, 0.804, 0.733);
  vec3 c3 = vec3(0.255, 0.714, 0.769);
  vec3 c4 = vec3(0.173, 0.498, 0.722);
  vec3 c5 = vec3(0.145, 0.204, 0.580);
  if (t < 0.20) return mix3(c0, c1, t / 0.20);
  if (t < 0.40) return mix3(c1, c2, (t - 0.20) / 0.20);
  if (t < 0.60) return mix3(c2, c3, (t - 0.40) / 0.20);
  if (t < 0.80) return mix3(c3, c4, (t - 0.60) / 0.20);
  return mix3(c4, c5, (t - 0.80) / 0.20);
}

vec3 blueWhiteRed(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 blue  = vec3(0.05, 0.18, 0.95);
  vec3 white = vec3(0.98, 0.98, 0.96);
  vec3 red   = vec3(0.82, 0.12, 0.08);
  if (t < 0.5) return mix3(blue, white, t / 0.5);
  return mix3(white, red, (t - 0.5) / 0.5);
}

void main() {
  if (v_value != v_value) discard;

  float den = max(abs(u_vmax - u_vmin), 1e-12);
  float t = clamp((v_value - u_vmin) / den, 0.0, 1.0);

  vec3 c;
  if (u_cmap == 1) c = blueWhiteRed(t);
  else if (u_cmap == 2) c = ylgnbu(t);
  else c = smoothJet(t);

  gl_FragColor = vec4(c, u_opacity);
}
`;

const MESH_VS = `
precision highp float;
attribute vec2 a_pos;
uniform mat4 u_matrix;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;

const MESH_FS = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

function cmapCode(name) {
  const c = String(name || "").toLowerCase();
  if (c === "bwr" || c === "rdbu" || c === "bluewhitered") return 1;
  if (c === "ylgnbu") return 2;
  return 0;
}

function mercatorXY(lon, lat) {
  const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat: lat });
  return [mc.x, mc.y];
}

async function loadGrid() {
  const nx = meta.grid.nx;
  const ny = meta.grid.ny;
  const cnx = meta.grid.corner_nx;
  const cny = meta.grid.corner_ny;

  const n = nx * ny;
  const nc = cnx * cny;

  const mask = await fetchFloat32(DATA_ROOT + meta.grid.mask_file, n);
  const lonCorner = await fetchFloat32(DATA_ROOT + meta.grid.lon_corner_file, nc);
  const latCorner = await fetchFloat32(DATA_ROOT + meta.grid.lat_corner_file, nc);

  const triPositions = [];
  const cellIndexForVertex = [];
  const edgePositions = [];

  function cornerIndex(j, i) {
    return j * cnx + i;
  }

  function pushCorner(out, ci) {
    const lon = lonCorner[ci];
    const lat = latCorner[ci];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      out.push(0, 0);
      return;
    }
    const p = mercatorXY(lon, lat);
    out.push(p[0], p[1]);
  }

  let validCells = 0;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cell = j * nx + i;
      if (mask[cell] <= 0) continue;

      const c00 = cornerIndex(j, i);
      const c10 = cornerIndex(j, i + 1);
      const c11 = cornerIndex(j + 1, i + 1);
      const c01 = cornerIndex(j + 1, i);

      const lon00 = lonCorner[c00], lat00 = latCorner[c00];
      const lon10 = lonCorner[c10], lat10 = latCorner[c10];
      const lon11 = lonCorner[c11], lat11 = latCorner[c11];
      const lon01 = lonCorner[c01], lat01 = latCorner[c01];

      if (
        !Number.isFinite(lon00) || !Number.isFinite(lat00) ||
        !Number.isFinite(lon10) || !Number.isFinite(lat10) ||
        !Number.isFinite(lon11) || !Number.isFinite(lat11) ||
        !Number.isFinite(lon01) || !Number.isFinite(lat01)
      ) {
        continue;
      }

      validCells += 1;

      pushCorner(triPositions, c00); cellIndexForVertex.push(cell);
      pushCorner(triPositions, c10); cellIndexForVertex.push(cell);
      pushCorner(triPositions, c11); cellIndexForVertex.push(cell);

      pushCorner(triPositions, c00); cellIndexForVertex.push(cell);
      pushCorner(triPositions, c11); cellIndexForVertex.push(cell);
      pushCorner(triPositions, c01); cellIndexForVertex.push(cell);

      pushCorner(edgePositions, c00); pushCorner(edgePositions, c10);
      pushCorner(edgePositions, c10); pushCorner(edgePositions, c11);
      pushCorner(edgePositions, c11); pushCorner(edgePositions, c01);
      pushCorner(edgePositions, c01); pushCorner(edgePositions, c00);
    }
  }

  grid = {
    nx,
    ny,
    cnx,
    cny,
    n,
    validCells,
    triPositions: new Float32Array(triPositions),
    cellIndexForVertex: new Uint32Array(cellIndexForVertex),
    edgePositions: new Float32Array(edgePositions)
  };

  setStatus(
    `Grid loaded\n` +
    `cells: ${validCells}\n` +
    `vertices: ${grid.triPositions.length / 2}`
  );
}

async function loadFrame(variable, frameIndex) {
  const key = `${variable}:${frameIndex}`;
  if (scalarCache.has(key)) return scalarCache.get(key);

  const frame = meta.frames[frameIndex];
  const url = DATA_ROOT + frame.files[variable];
  const arr = await fetchFloat32(url, grid.n);
  scalarCache.set(key, arr);
  return arr;
}

function buildVertexValues(values) {
  const out = new Float32Array(grid.cellIndexForVertex.length);
  for (let k = 0; k < out.length; k++) {
    out[k] = values[grid.cellIndexForVertex[k]];
  }
  return out;
}

function makeMohidLayer() {
  return {
    id: "mohid-custom-layer",
    type: "custom",
    renderingMode: "2d",

    onAdd: function(m, gl) {
      GLState.gl = gl;
      GLState.scalarProgram = makeProgram(gl, SCALAR_VS, SCALAR_FS);
      GLState.meshProgram = makeProgram(gl, MESH_VS, MESH_FS);

      GLState.aPos = gl.getAttribLocation(GLState.scalarProgram, "a_pos");
      GLState.aVal = gl.getAttribLocation(GLState.scalarProgram, "a_value");
      GLState.uMatrix = gl.getUniformLocation(GLState.scalarProgram, "u_matrix");
      GLState.uVmin = gl.getUniformLocation(GLState.scalarProgram, "u_vmin");
      GLState.uVmax = gl.getUniformLocation(GLState.scalarProgram, "u_vmax");
      GLState.uOpacity = gl.getUniformLocation(GLState.scalarProgram, "u_opacity");
      GLState.uCmap = gl.getUniformLocation(GLState.scalarProgram, "u_cmap");

      GLState.meshAPos = gl.getAttribLocation(GLState.meshProgram, "a_pos");
      GLState.meshUMatrix = gl.getUniformLocation(GLState.meshProgram, "u_matrix");
      GLState.meshUColor = gl.getUniformLocation(GLState.meshProgram, "u_color");

      GLState.posBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.triPositions, gl.STATIC_DRAW);

      GLState.valBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.valBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.cellIndexForVertex.length * 4, gl.DYNAMIC_DRAW);

      GLState.meshPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.meshPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.edgePositions, gl.STATIC_DRAW);

      GLState.vertexCount = grid.triPositions.length / 2;
      GLState.meshVertexCount = grid.edgePositions.length / 2;
      GLState.ready = true;
    },

    render: function(gl, matrix) {
      if (!GLState.ready) return;

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (GLState.valuesReady) {
        const vm = meta.variables[currentVar];

        gl.useProgram(GLState.scalarProgram);

        gl.bindBuffer(gl.ARRAY_BUFFER, GLState.posBuffer);
        gl.enableVertexAttribArray(GLState.aPos);
        gl.vertexAttribPointer(GLState.aPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, GLState.valBuffer);
        gl.enableVertexAttribArray(GLState.aVal);
        gl.vertexAttribPointer(GLState.aVal, 1, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(GLState.uMatrix, false, matrix);
        gl.uniform1f(GLState.uVmin, vm.vmin);
        gl.uniform1f(GLState.uVmax, vm.vmax);
        gl.uniform1f(GLState.uOpacity, Number(els.opacitySlider.value || 0.82));
        gl.uniform1i(GLState.uCmap, cmapCode(vm.cmap));

        gl.drawArrays(gl.TRIANGLES, 0, GLState.vertexCount);
      }

      if (els.meshOverlay && els.meshOverlay.checked) {
        gl.useProgram(GLState.meshProgram);

        gl.bindBuffer(gl.ARRAY_BUFFER, GLState.meshPosBuffer);
        gl.enableVertexAttribArray(GLState.meshAPos);
        gl.vertexAttribPointer(GLState.meshAPos, 2, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(GLState.meshUMatrix, false, matrix);
        gl.uniform4f(GLState.meshUColor, 0.0, 0.0, 0.0, 0.32);

        gl.drawArrays(gl.LINES, 0, GLState.meshVertexCount);
      }
    }
  };
}

async function setFrame(i) {
  const n = frameCount();
  if (n <= 0 || !GLState.ready) return;

  currentFrame = Math.max(0, Math.min(n - 1, Number(i)));
  els.frameSlider.value = String(currentFrame);

  const values = await loadFrame(currentVar, currentFrame);
  const vertexValues = buildVertexValues(values);

  const gl = GLState.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.valBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexValues);

  GLState.valuesReady = true;

  updateTimeLabel();
  updateLegend();

  setStatus(`MOHID ${meta.cycle}\n${currentVar} frame ${currentFrame + 1}/${frameCount()}`);

  map.triggerRepaint();
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
  }, 700);
}

function togglePlay() {
  if (timer === null) startPlay();
  else stopPlay();
}

function setBasemap(name) {
  if (!map) return;

  if (name === "satellite") {
    if (map.getLayer("carto-light")) map.setLayoutProperty("carto-light", "visibility", "none");
    if (map.getLayer("esri-satellite")) map.setLayoutProperty("esri-satellite", "visibility", "visible");
  } else {
    if (map.getLayer("carto-light")) map.setLayoutProperty("carto-light", "visibility", "visible");
    if (map.getLayer("esri-satellite")) map.setLayoutProperty("esri-satellite", "visibility", "none");
  }

  try {
    if (map.getLayer("mohid-custom-layer")) map.moveLayer("mohid-custom-layer");
  } catch (e) {}

  map.triggerRepaint();
}

function makeMapStyle() {
  return {
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
        layout: { visibility: "none" }
      },
      {
        id: "esri-satellite",
        type: "raster",
        source: "esri-satellite",
        layout: { visibility: "visible" }
      }
    ]
  };
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: makeMapStyle(),
    center: [125.2, 36.2],
    zoom: 5.4,
    minZoom: 3,
    maxZoom: 12,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    attributionControl: true
  });

  map.fitBounds(
    [
      [meta.grid.lon_min, meta.grid.lat_min],
      [meta.grid.lon_max, meta.grid.lat_max]
    ],
    { padding: 30, duration: 0 }
  );
}

function bindEvents() {
  els.varSelect.addEventListener("change", () => {
    currentVar = els.varSelect.value;
    setFrame(currentFrame);
  });

  els.opacitySlider.addEventListener("input", () => {
    map.triggerRepaint();
  });

  els.frameSlider.addEventListener("input", () => {
    stopPlay();
    setFrame(Number(els.frameSlider.value));
  });

  els.playBtn.addEventListener("click", togglePlay);

  if (els.meshOverlay) {
    els.meshOverlay.addEventListener("change", () => {
      map.triggerRepaint();
    });
  }

  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener("change", () => setBasemap(r.value));
  });
}

async function boot() {
  try {
    setStatus("Loading metadata...");
    meta = await fetchJson(DATA_ROOT + "meta.json");

    els.frameSlider.max = String(frameCount() - 1);
    els.frameSlider.value = "0";

    initMap();

    map.on("load", async () => {
      setStatus("Loading MOHID grid...");
      await loadGrid();

      map.addLayer(makeMohidLayer());

      bindEvents();
      updateLegend();
      updateTimeLabel();

      await setFrame(0);

      setStatus(
        `Ready\n` +
        `MOHID ${meta.cycle}\n` +
        `${grid.validCells} cells`
      );
    });
  } catch (err) {
    console.error(err);
    setStatus("ERROR:\n" + err.message);
  }
}

boot();
