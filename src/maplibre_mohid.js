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
  meshOverlay: document.getElementById("mesh-overlay-check"),
  currentOverlay: document.getElementById("current-overlay-check"),
  particleDensity: document.getElementById("particle-density-select")
};

let map = null;
let meta = null;
let grid = null;
let currentVar = "temperature";
let currentFrame = 0;
let timer = null;
let scalarCache = new Map();

let currentU = null;
let currentV = null;

let particles = [];
let particleRunning = false;
let lastParticleTime = 0;
let isMapInteracting = false;

let particleCanvas = null;
let particleCtx = null;
let particleAnimId = null;


let particleCanvas = null;
let particleCtx = null;
let particleAnimId = null;

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

async function fetchInt32(url, expectedLen = null) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const arr = new Int32Array(buf);
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

const PARTICLE_VS = `
precision highp float;
attribute vec2 a_pos;
attribute vec4 a_color;
uniform mat4 u_matrix;
varying vec4 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_color = a_color;
}
`;

const PARTICLE_FS = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
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

  const lon = await fetchFloat32(DATA_ROOT + meta.grid.lon_file, n);
  const lat = await fetchFloat32(DATA_ROOT + meta.grid.lat_file, n);
  const mask = await fetchFloat32(DATA_ROOT + meta.grid.mask_file, n);
  const lonCorner = await fetchFloat32(DATA_ROOT + meta.grid.lon_corner_file, nc);
  const latCorner = await fetchFloat32(DATA_ROOT + meta.grid.lat_corner_file, nc);

  let particleLookupCell = null;
  if (meta.grid.particle_lookup_file) {
    const lookupN =
      Number(meta.grid.particle_lookup_nx) *
      Number(meta.grid.particle_lookup_ny);

    particleLookupCell = await fetchInt32(
      DATA_ROOT + meta.grid.particle_lookup_file,
      lookupN
    );
  }

  const triPositions = [];
  const cornerIndexForVertex = [];
  const edgePositions = [];
  const validCellIndices = [];

  function cornerIndex(j, i) {
    return j * cnx + i;
  }

  function pushCorner(out, ci) {
    const qlon = lonCorner[ci];
    const qlat = latCorner[ci];

    if (!Number.isFinite(qlon) || !Number.isFinite(qlat)) {
      out.push(0, 0);
      return;
    }

    const mc = maplibregl.MercatorCoordinate.fromLngLat({
      lng: qlon,
      lat: qlat
    });

    out.push(mc.x, mc.y);
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
      validCellIndices.push(cell);

      // quad -> two triangles
      pushCorner(triPositions, c00); cornerIndexForVertex.push(c00);
      pushCorner(triPositions, c10); cornerIndexForVertex.push(c10);
      pushCorner(triPositions, c11); cornerIndexForVertex.push(c11);

      pushCorner(triPositions, c00); cornerIndexForVertex.push(c00);
      pushCorner(triPositions, c11); cornerIndexForVertex.push(c11);
      pushCorner(triPositions, c01); cornerIndexForVertex.push(c01);

      // mesh overlay edges
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
    lon,
    lat,
    mask,
    particleLookupCell,
    particleLookupNx: Number(meta.grid.particle_lookup_nx || 0),
    particleLookupNy: Number(meta.grid.particle_lookup_ny || 0),
    validCells,
    validCellIndices,
    triPositions: new Float32Array(triPositions),
    cornerIndexForVertex: new Uint32Array(cornerIndexForVertex),
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


function cellValuesToCornerValues(values) {
  const nx = grid.nx;
  const ny = grid.ny;
  const cnx = grid.cnx;
  const cny = grid.cny;

  const sum = new Float32Array(cnx * cny);
  const count = new Float32Array(cnx * cny);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cell = j * nx + i;
      const v = values[cell];

      if (!Number.isFinite(v)) continue;

      const c00 = j * cnx + i;
      const c10 = j * cnx + (i + 1);
      const c11 = (j + 1) * cnx + (i + 1);
      const c01 = (j + 1) * cnx + i;

      sum[c00] += v; count[c00] += 1.0;
      sum[c10] += v; count[c10] += 1.0;
      sum[c11] += v; count[c11] += 1.0;
      sum[c01] += v; count[c01] += 1.0;
    }
  }

  const cornerValues = new Float32Array(cnx * cny);
  for (let k = 0; k < cornerValues.length; k++) {
    if (count[k] > 0.0) {
      cornerValues[k] = sum[k] / count[k];
    } else {
      cornerValues[k] = NaN;
    }
  }

  return cornerValues;
}

function buildVertexValues(values) {
  const cornerValues = cellValuesToCornerValues(values);
  const out = new Float32Array(grid.cornerIndexForVertex.length);

  for (let k = 0; k < out.length; k++) {
    out[k] = cornerValues[grid.cornerIndexForVertex[k]];
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
      gl.bufferData(gl.ARRAY_BUFFER, grid.cornerIndexForVertex.length * 4, gl.DYNAMIC_DRAW);

      GLState.meshPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.meshPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.edgePositions, gl.STATIC_DRAW);

      GLState.vertexCount = grid.triPositions.length / 2;
      GLState.meshVertexCount = grid.edgePositions.length / 2;

      GLState.particleProgram = makeProgram(gl, PARTICLE_VS, PARTICLE_FS);
      GLState.particleAPos = gl.getAttribLocation(GLState.particleProgram, "a_pos");
      GLState.particleAColor = gl.getAttribLocation(GLState.particleProgram, "a_color");
      GLState.particleUMatrix = gl.getUniformLocation(GLState.particleProgram, "u_matrix");
      GLState.particlePosBuffer = gl.createBuffer();
      GLState.particleColorBuffer = gl.createBuffer();
      GLState.particleVertexCount = 0;

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

      // Particles are drawn on a screen-space canvas, Windy/SCHISM style.
    }
  };
}

async function setFrame(i) {
  const n = frameCount();
  if (n <= 0 || !GLState.ready) return;

  currentFrame = Math.max(0, Math.min(n - 1, Number(i)));
  els.frameSlider.value = String(currentFrame);

  const [values, u, v] = await Promise.all([
    loadFrame(currentVar, currentFrame),
    loadFrame("current_u", currentFrame),
    loadFrame("current_v", currentFrame)
  ]);

  currentU = u;
  currentV = v;

  const vertexValues = buildVertexValues(values);

  const gl = GLState.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.valBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexValues);

  GLState.valuesReady = true;

  updateTimeLabel();
  updateLegend();

  setStatus(`MOHID ${meta.cycle}\n${currentVar} frame ${currentFrame + 1}/${frameCount()}`);

  map.triggerRepaint();

  if (particleCanvas) {
    resetParticles();
    clearParticleCanvas();
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

  if (els.currentOverlay) {
    els.currentOverlay.addEventListener("change", () => {
      if (els.currentOverlay.checked) {
        resetParticles();
      } else {
        clearParticleCanvas();
      }
    });
  }

  if (els.particleDensity) {
    els.particleDensity.addEventListener("change", () => {
      resetParticles();
      clearParticleCanvas();
    });
  }

  if (map) {
    map.on("moveend", () => {
      resetParticles();
      clearParticleCanvas();
    });
    map.on("zoomend", () => {
      resetParticles();
      clearParticleCanvas();
    });
  }

  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener("change", () => setBasemap(r.value));
  });


  if (map && !map.__mohidScreenParticleBound) {
    map.__mohidScreenParticleBound = true;

    map.on("moveend", () => {
      resetParticles();
    });

    map.on("zoomend", () => {
      resetParticles();
    });
  }

  if (map && !map.__mohidParticleInteractionBound) {
    map.__mohidParticleInteractionBound = true;

    const beginInteraction = () => {
      isMapInteracting = true;
      map.triggerRepaint();
    };

    const endInteraction = () => {
      isMapInteracting = false;
      map.triggerRepaint();
    };

    map.on("movestart", beginInteraction);
    map.on("zoomstart", beginInteraction);
    map.on("moveend", endInteraction);
    map.on("zoomend", endInteraction);
  }
}



function vectorAt(lon, lat) {
  if (!currentU || !currentV || !grid || !grid.particleLookupCell) return null;

  const nx = grid.particleLookupNx;
  const ny = grid.particleLookupNy;

  if (!nx || !ny) return null;

  const lonMin = meta.grid.lon_min;
  const lonMax = meta.grid.lon_max;
  const latMin = meta.grid.lat_min;
  const latMax = meta.grid.lat_max;

  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return null;

  let ix = Math.floor((lon - lonMin) / (lonMax - lonMin) * nx);
  let iy = Math.floor((lat - latMin) / (latMax - latMin) * ny);

  ix = Math.max(0, Math.min(nx - 1, ix));
  iy = Math.max(0, Math.min(ny - 1, iy));

  const cell = grid.particleLookupCell[iy * nx + ix];

  if (cell == null || cell < 0 || cell >= grid.n) return null;

  const u = currentU[cell];
  const v = currentV[cell];

  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (Math.abs(u) > 20 || Math.abs(v) > 20) return null;

  const speed = Math.hypot(u, v);
  if (!Number.isFinite(speed)) return null;

  return { u, v, speed };
}

function initParticleCanvas() {
  if (particleCanvas) return;

  particleCanvas = document.createElement("canvas");
  particleCanvas.id = "particle-canvas";
  document.body.appendChild(particleCanvas);

  particleCtx = particleCanvas.getContext("2d");

  resizeParticleCanvas();

  window.addEventListener("resize", resizeParticleCanvas);
  if (map) map.on("resize", resizeParticleCanvas);
}

function resizeParticleCanvas() {
  if (!particleCanvas || !particleCtx) return;

  const rect = map ? map.getContainer().getBoundingClientRect() : {
    width: window.innerWidth,
    height: window.innerHeight
  };

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  particleCanvas.width = Math.max(1, Math.round(w * dpr));
  particleCanvas.height = Math.max(1, Math.round(h * dpr));
  particleCanvas.style.width = w + "px";
  particleCanvas.style.height = h + "px";
  particleCanvas.style.left = "0";
  particleCanvas.style.top = "0";

  particleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearParticleCanvas();
}

function clearParticleCanvas() {
  if (!particleCtx || !map) return;
  const rect = map.getContainer().getBoundingClientRect();
  particleCtx.clearRect(0, 0, rect.width, rect.height);
}

function effectiveParticleCount() {
  const base = Number(els.particleDensity ? els.particleDensity.value : 1300);
  const z = map ? map.getZoom() : 6;

  let mul = 1.0;
  if (z <= 5) mul = 0.50;
  else if (z < 9) mul = 0.50 + (z - 5) * (0.50 / 4.0);

  return Math.max(250, Math.round(base * mul));
}

function randomValidPoint() {
  if (!grid || !grid.validCellIndices || !grid.validCellIndices.length) return null;

  let bounds = null;
  if (map) bounds = map.getBounds();

  for (let i = 0; i < 1000; i++) {
    const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
    const lon = grid.lon[cell];
    const lat = grid.lat[cell];

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    if (bounds) {
      if (
        lon < bounds.getWest() || lon > bounds.getEast() ||
        lat < bounds.getSouth() || lat > bounds.getNorth()
      ) {
        continue;
      }
    }

    if (vectorAt(lon, lat)) return { lon, lat };
  }

  const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
  return { lon: grid.lon[cell], lat: grid.lat[cell] };
}

function resetParticle(p) {
  const pos = randomValidPoint();

  if (!pos) {
    p.lon = 125.0;
    p.lat = 36.0;
  } else {
    p.lon = pos.lon;
    p.lat = pos.lat;
  }

  p.age = Math.floor(Math.random() * 80);
  p.maxAge = 150 + Math.floor(Math.random() * 130);
  p.fadeAge = Math.floor(Math.random() * 10);
  p.trail = [{ lon: p.lon, lat: p.lat }];
}

function resetParticles() {
  particles = [];

  if (!currentU || !currentV || !grid) return;

  const n = effectiveParticleCount();

  for (let i = 0; i < n; i++) {
    const p = {};
    resetParticle(p);
    particles.push(p);
  }
}

function speedToColor(s) {
  const vm = meta.variables.current_speed || { vmin: 0, vmax: 1 };

  let t = (s - vm.vmin) / Math.max(1e-12, vm.vmax - vm.vmin);
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, Math.min(1, t));

  const stops = [
    [0.05, 0.18, 0.95],
    [0.05, 0.62, 1.00],
    [0.10, 0.78, 0.42],
    [0.92, 0.86, 0.22],
    [0.95, 0.55, 0.10],
    [0.82, 0.12, 0.08]
  ];

  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.max(0, Math.floor(x)));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];

  const r = Math.round(255 * (a[0] * (1 - f) + b[0] * f));
  const g = Math.round(255 * (a[1] * (1 - f) + b[1] * f));
  const bb = Math.round(255 * (a[2] * (1 - f) + b[2] * f));

  return `rgba(${r},${g},${bb},0.72)`;
}

function particleColor(speed) {
  if (currentVar === "current_speed") return speedToColor(speed);
  return "rgba(235,235,235,0.55)";
}

function particleFlowScale() {
  const base = 0.005;
  if (!map) return base;

  const z = map.getZoom();
  const factor = Math.pow(0.75, Math.max(0, z - 7.0));

  return Math.max(base * 0.20, base * factor);
}

function particleTrailLength() {
  return 3;
}

function speedBasedParticleDrawLength(spd) {
  const vm = meta.variables.current_speed || { vmin: 0, vmax: 1 };

  let t = (spd - vm.vmin) / Math.max(1e-12, vm.vmax - vm.vmin);
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, Math.min(1, t));
  t = Math.pow(t, 0.75);

  let minLen = 3.5;
  let maxLen = 18.0;

  if (map) {
    const z = map.getZoom();
    let f = 1.0;
    if (z <= 5.0) f = 0.50;
    else if (z < 9.0) f = 0.50 + (z - 5.0) * (0.50 / 4.0);

    minLen *= f;
    maxLen *= f;
  }

  return minLen + (maxLen - minLen) * t;
}

function startParticles() {
  if (particleAnimId !== null) {
    cancelAnimationFrame(particleAnimId);
    particleAnimId = null;
  }

  particleRunning = true;
  resetParticles();

  function step() {
    if (!particleRunning) return;

    particleAnimId = requestAnimationFrame(step);

    if (!particleCtx || !map || !currentU || !currentV) return;

    if (els.currentOverlay && !els.currentOverlay.checked) {
      clearParticleCanvas();
      return;
    }

    const rect = map.getContainer().getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    particleCtx.globalCompositeOperation = "destination-out";
    particleCtx.fillStyle = "rgba(0,0,0,0.10)";
    particleCtx.fillRect(0, 0, width, height);

    particleCtx.globalCompositeOperation = "source-over";
    particleCtx.lineCap = "round";

    if (particles.length < effectiveParticleCount() * 0.60) {
      resetParticles();
    }

    const trailLen = particleTrailLength();

    for (const p of particles) {
      if (!p || p.age > p.maxAge) {
        resetParticle(p);
        continue;
      }

      const vec = vectorAt(p.lon, p.lat);

      if (!vec) {
        resetParticle(p);
        continue;
      }

      const latRad = p.lat * Math.PI / 180.0;
      let coslat = Math.cos(latRad);
      if (Math.abs(coslat) < 1e-6) coslat = 1e-6;

      const dt = particleFlowScale();
      const newLon = p.lon + (vec.u * dt) / coslat;
      const newLat = p.lat + vec.v * dt;

      if (!vectorAt(newLon, newLat)) {
        resetParticle(p);
        continue;
      }

      p.lon = newLon;
      p.lat = newLat;
      p.age += 1;

      if (!p.trail) p.trail = [];
      p.trail.push({ lon: p.lon, lat: p.lat });

      if (p.trail.length > trailLen) {
        p.trail.shift();
      }

      const head = map.project([p.lon, p.lat]);

      if (
        head.x < -80 || head.x > width + 80 ||
        head.y < -80 || head.y > height + 80
      ) {
        resetParticle(p);
        continue;
      }

      if (p.trail.length < 2) continue;

      const nTrail = p.trail.length;
      const qHead = p.trail[nTrail - 1];
      const qPrev = p.trail[Math.max(0, nTrail - 2)];

      const ptHead = map.project([qHead.lon, qHead.lat]);
      const ptPrev = map.project([qPrev.lon, qPrev.lat]);

      let dx = ptHead.x - ptPrev.x;
      let dy = ptHead.y - ptPrev.y;
      let len = Math.sqrt(dx * dx + dy * dy);

      if (!Number.isFinite(len) || len < 0.05) {
        const latRad2 = p.lat * Math.PI / 180.0;
        let coslat2 = Math.cos(latRad2);
        if (Math.abs(coslat2) < 1e-6) coslat2 = 1e-6;

        dx = vec.u / coslat2;
        dy = vec.v;
        len = Math.sqrt(dx * dx + dy * dy);
      }

      if (!Number.isFinite(len) || len <= 0.0) continue;

      dx /= len;
      dy /= len;

      const segLen = Math.max(2.0, speedBasedParticleDrawLength(vec.speed) * 0.65);

      const x0 = ptHead.x - dx * segLen;
      const y0 = ptHead.y - dy * segLen;
      const x1 = ptHead.x;
      const y1 = ptHead.y;

      p.fadeAge = (p.fadeAge || 0) + 1;
      const fadeFactor = Math.min(1.0, p.fadeAge / 18.0);

      particleCtx.strokeStyle = particleColor(vec.speed);
      particleCtx.globalAlpha = fadeFactor;
      particleCtx.lineWidth = currentVar === "current_speed" ? 1.25 : 1.05;

      particleCtx.beginPath();
      particleCtx.moveTo(x0, y0);
      particleCtx.lineTo(x1, y1);
      particleCtx.stroke();

      particleCtx.globalAlpha = 1.0;
    }
  }

  particleAnimId = requestAnimationFrame(step);
}



function vectorAt(lon, lat) {
  if (!currentU || !currentV || !grid || !grid.particleLookupCell) return null;

  const nx = grid.particleLookupNx;
  const ny = grid.particleLookupNy;

  if (!nx || !ny) return null;

  const lonMin = meta.grid.lon_min;
  const lonMax = meta.grid.lon_max;
  const latMin = meta.grid.lat_min;
  const latMax = meta.grid.lat_max;

  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return null;

  let ix = Math.floor((lon - lonMin) / (lonMax - lonMin) * nx);
  let iy = Math.floor((lat - latMin) / (latMax - latMin) * ny);

  ix = Math.max(0, Math.min(nx - 1, ix));
  iy = Math.max(0, Math.min(ny - 1, iy));

  const cell = grid.particleLookupCell[iy * nx + ix];

  if (cell == null || cell < 0 || cell >= grid.n) return null;

  const u = currentU[cell];
  const v = currentV[cell];

  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (Math.abs(u) > 20 || Math.abs(v) > 20) return null;

  const speed = Math.hypot(u, v);
  if (!Number.isFinite(speed)) return null;

  return { u, v, speed };
}

function particleTargetCount() {
  const base = Number(els.particleDensity ? els.particleDensity.value : 900);
  const z = map ? map.getZoom() : 6.0;

  let mul = 1.0;
  if (z <= 5.0) mul = 0.50;
  else if (z < 9.0) mul = 0.50 + (z - 5.0) * (0.50 / 4.0);

  return Math.max(180, Math.round(base * mul));
}

function randomValidParticlePoint() {
  if (!grid || !grid.validCellIndices || !grid.validCellIndices.length) return null;

  const b = map ? map.getBounds() : null;

  for (let k = 0; k < 1000; k++) {
    const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
    const lon = grid.lon[cell];
    const lat = grid.lat[cell];

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    if (b) {
      if (lon < b.getWest() || lon > b.getEast() || lat < b.getSouth() || lat > b.getNorth()) {
        continue;
      }
    }

    if (vectorAt(lon, lat)) return { lon, lat };
  }

  const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
  return { lon: grid.lon[cell], lat: grid.lat[cell] };
}

function resetOneParticle(p) {
  const q = randomValidParticlePoint();

  if (!q) {
    p.lon = 125.0;
    p.lat = 36.0;
  } else {
    p.lon = q.lon;
    p.lat = q.lat;
  }

  p.age = Math.floor(Math.random() * 60);
  p.maxAge = 140 + Math.floor(Math.random() * 120);
  p.fadeAge = Math.floor(Math.random() * 12);
  p.trail = [{ lon: p.lon, lat: p.lat, speed: 0.0 }];
}

function resetParticles() {
  particles = [];

  if (!currentU || !currentV || !grid) return;

  const n = particleTargetCount();

  for (let i = 0; i < n; i++) {
    const p = {};
    resetOneParticle(p);
    particles.push(p);
  }
}

function particleFlowScale() {
  const base = 0.005;
  if (!map) return base;

  const z = map.getZoom();
  const factor = Math.pow(0.75, Math.max(0, z - 7.0));

  return Math.max(base * 0.20, base * factor);
}

function speedToRgb01(spd) {
  const vm = meta.variables.current_speed || { vmin: 0.0, vmax: 1.0 };

  let t = (spd - vm.vmin) / Math.max(1e-12, vm.vmax - vm.vmin);
  if (!Number.isFinite(t)) t = 0.0;
  t = Math.max(0.0, Math.min(1.0, t));

  const stops = [
    [0.05, 0.18, 0.95],
    [0.05, 0.62, 1.00],
    [0.10, 0.78, 0.42],
    [0.92, 0.86, 0.22],
    [0.95, 0.55, 0.10],
    [0.82, 0.12, 0.08]
  ];

  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.max(0, Math.floor(x)));
  const f = x - i;

  const a = stops[i];
  const b = stops[i + 1];

  return [
    a[0] * (1 - f) + b[0] * f,
    a[1] * (1 - f) + b[1] * f,
    a[2] * (1 - f) + b[2] * f
  ];
}

function particleColor01(speed, alpha) {
  if (currentVar === "current_speed") {
    const c = speedToRgb01(speed);
    return [c[0], c[1], c[2], alpha];
  }

  return [0.92, 0.92, 0.92, alpha];
}

function updateWebglParticles() {
  if (!particleRunning || !currentU || !currentV || !grid) return;

  if (els.currentOverlay && !els.currentOverlay.checked) {
    particles = [];
    return;
  }

  /*
   * Keep trails fixed to the map during pan/zoom.
   * We still render the existing lon/lat trail with the current MapLibre matrix,
   * but we do not advect particles while the map camera is changing.
   */
  if (isMapInteracting) {
    return;
  }

  const target = particleTargetCount();

  if (particles.length < target * 0.75 || particles.length > target * 1.25) {
    resetParticles();
  }

  const dt = particleFlowScale();

  for (const p of particles) {
    if (!p || p.age > p.maxAge) {
      resetOneParticle(p);
      continue;
    }

    const vec = vectorAt(p.lon, p.lat);

    if (!vec) {
      resetOneParticle(p);
      continue;
    }

    const latRad = p.lat * Math.PI / 180.0;
    let coslat = Math.cos(latRad);
    if (Math.abs(coslat) < 1e-6) coslat = 1e-6;

    const newLon = p.lon + (vec.u * dt) / coslat;
    const newLat = p.lat + vec.v * dt;

    if (!vectorAt(newLon, newLat)) {
      resetOneParticle(p);
      continue;
    }

    p.lon = newLon;
    p.lat = newLat;
    p.age += 1;
    p.fadeAge = (p.fadeAge || 0) + 1;

    if (!p.trail) p.trail = [];
    p.trail.push({ lon: p.lon, lat: p.lat, speed: vec.speed });

    const trailMax = 5;
    while (p.trail.length > trailMax) p.trail.shift();
  }
}

function pushParticleVertex(posOut, colOut, q, color) {
  const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: q.lon, lat: q.lat });
  posOut.push(mc.x, mc.y);
  colOut.push(color[0], color[1], color[2], color[3]);
}

function buildParticleBuffers() {
  const pos = [];
  const col = [];

  for (const p of particles) {
    if (!p || !p.trail || p.trail.length < 2) continue;

    const n = p.trail.length;

    for (let k = 1; k < n; k++) {
      const q0 = p.trail[k - 1];
      const q1 = p.trail[k];

      if (
        !Number.isFinite(q0.lon) || !Number.isFinite(q0.lat) ||
        !Number.isFinite(q1.lon) || !Number.isFinite(q1.lat)
      ) {
        continue;
      }

      const segT = k / Math.max(1, n - 1);
      const fade = Math.min(1.0, (p.fadeAge || 0) / 18.0);

      let alpha = (0.08 + 0.44 * segT) * fade;
      if (currentVar === "current_speed") alpha = (0.12 + 0.58 * segT) * fade;

      const c0 = particleColor01(q1.speed || 0.0, alpha * 0.65);
      const c1 = particleColor01(q1.speed || 0.0, alpha);

      pushParticleVertex(pos, col, q0, c0);
      pushParticleVertex(pos, col, q1, c1);
    }
  }

  return {
    pos: new Float32Array(pos),
    col: new Float32Array(col),
    count: pos.length / 2
  };
}

function drawWebglParticles(gl, matrix) {
  if (!GLState.ready || !GLState.particleProgram) return;
  if (!particleRunning) return;
  if (els.currentOverlay && !els.currentOverlay.checked) return;
  if (!currentU || !currentV) return;

  updateWebglParticles();

  const b = buildParticleBuffers();

  if (b.count <= 0) {
    map.triggerRepaint();
    return;
  }

  gl.useProgram(GLState.particleProgram);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particlePosBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAPos);
  gl.vertexAttribPointer(GLState.particleAPos, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.col, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAColor);
  gl.vertexAttribPointer(GLState.particleAColor, 4, gl.FLOAT, false, 0, 0);

  gl.uniformMatrix4fv(GLState.particleUMatrix, false, matrix);

  gl.lineWidth(1.0);
  gl.drawArrays(gl.LINES, 0, b.count);

  map.triggerRepaint();
}

function startWebglParticles() {
  particleRunning = true;
  if (!particles.length) resetParticles();
  map.triggerRepaint();
}



function initScreenParticleCanvas() {
  if (particleCanvas) return;

  particleCanvas = document.createElement("canvas");
  particleCanvas.id = "particle-canvas";
  document.body.appendChild(particleCanvas);

  particleCtx = particleCanvas.getContext("2d");

  resizeScreenParticleCanvas();

  window.addEventListener("resize", resizeScreenParticleCanvas);
  if (map) map.on("resize", resizeScreenParticleCanvas);
}

function resizeScreenParticleCanvas() {
  if (!particleCanvas || !particleCtx) return;

  const rect = map
    ? map.getContainer().getBoundingClientRect()
    : { width: window.innerWidth, height: window.innerHeight };

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  particleCanvas.width = Math.max(1, Math.round(w * dpr));
  particleCanvas.height = Math.max(1, Math.round(h * dpr));

  particleCanvas.style.width = w + "px";
  particleCanvas.style.height = h + "px";
  particleCanvas.style.left = "0";
  particleCanvas.style.top = "0";

  particleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearScreenParticles();
}

function clearScreenParticles() {
  if (!particleCtx || !map) return;
  const rect = map.getContainer().getBoundingClientRect();
  particleCtx.clearRect(0, 0, rect.width, rect.height);
}

function resetParticles() {
  particles = [];

  if (!currentU || !currentV || !grid || !grid.validCellIndices) return;

  const n = particleTargetCount();

  for (let i = 0; i < n; i++) {
    const p = {};
    resetOneParticle(p);
    particles.push(p);
  }
}

function resetOneParticle(p) {
  const q = randomValidParticlePoint();

  if (!q) {
    p.lon = 125.0;
    p.lat = 36.0;
  } else {
    p.lon = q.lon;
    p.lat = q.lat;
  }

  p.age = Math.floor(Math.random() * 80);
  p.maxAge = 140 + Math.floor(Math.random() * 140);
  p.fadeAge = Math.floor(Math.random() * 10);
}

function randomValidParticlePoint() {
  if (!grid || !grid.validCellIndices || grid.validCellIndices.length === 0) return null;

  const b = map ? map.getBounds() : null;

  for (let k = 0; k < 800; k++) {
    const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
    const lon = grid.lon[cell];
    const lat = grid.lat[cell];

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    if (b) {
      if (
        lon < b.getWest() || lon > b.getEast() ||
        lat < b.getSouth() || lat > b.getNorth()
      ) {
        continue;
      }
    }

    if (vectorAt(lon, lat)) {
      return { lon, lat };
    }
  }

  const cell = grid.validCellIndices[Math.floor(Math.random() * grid.validCellIndices.length)];
  return { lon: grid.lon[cell], lat: grid.lat[cell] };
}

function particleTargetCount() {
  const base = Number(els.particleDensity ? els.particleDensity.value : 800);
  const z = map ? map.getZoom() : 6.0;

  let mul = 1.0;
  if (z <= 5.0) mul = 0.50;
  else if (z < 9.0) mul = 0.50 + (z - 5.0) * 0.125;

  return Math.max(180, Math.round(base * mul));
}

function particleFlowScale() {
  const base = 0.005;
  if (!map) return base;

  const z = map.getZoom();
  const factor = Math.pow(0.75, Math.max(0, z - 7.0));

  return Math.max(base * 0.20, base * factor);
}

function speedToCanvasColor(spd, alpha) {
  const vm = meta.variables.current_speed || { vmin: 0.0, vmax: 1.0 };

  let t = (spd - vm.vmin) / Math.max(1e-12, vm.vmax - vm.vmin);
  if (!Number.isFinite(t)) t = 0.0;
  t = Math.max(0.0, Math.min(1.0, t));

  const stops = [
    [0.05, 0.18, 0.95],
    [0.05, 0.62, 1.00],
    [0.10, 0.78, 0.42],
    [0.92, 0.86, 0.22],
    [0.95, 0.55, 0.10],
    [0.82, 0.12, 0.08]
  ];

  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.max(0, Math.floor(x)));
  const f = x - i;

  const a = stops[i];
  const b = stops[i + 1];

  const r = Math.round(255 * (a[0] * (1 - f) + b[0] * f));
  const g = Math.round(255 * (a[1] * (1 - f) + b[1] * f));
  const bb = Math.round(255 * (a[2] * (1 - f) + b[2] * f));

  return `rgba(${r},${g},${bb},${alpha})`;
}

function particleCanvasColor(spd) {
  if (currentVar === "current_speed") {
    return speedToCanvasColor(spd, 0.68);
  }
  return "rgba(235,235,235,0.48)";
}

function startScreenParticles() {
  if (particleAnimId !== null) {
    cancelAnimationFrame(particleAnimId);
    particleAnimId = null;
  }

  particleRunning = true;
  resetParticles();

  function step() {
    particleAnimId = requestAnimationFrame(step);

    if (!particleRunning || !particleCtx || !map || !currentU || !currentV) return;

    const rect = map.getContainer().getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (els.currentOverlay && !els.currentOverlay.checked) {
      clearScreenParticles();
      return;
    }

    /*
     * Windy-like screen-space tail:
     * Previous segments stay on the screen and fade out.
     * They are not reprojected with the map.
     */
    particleCtx.globalCompositeOperation = "destination-out";
    particleCtx.fillStyle = "rgba(0,0,0,0.10)";
    particleCtx.fillRect(0, 0, width, height);

    particleCtx.globalCompositeOperation = "source-over";
    particleCtx.lineCap = "round";

    const target = particleTargetCount();
    if (particles.length < target * 0.60 || particles.length > target * 1.35) {
      resetParticles();
    }

    const dt = particleFlowScale();

    for (const p of particles) {
      if (!p || p.age > p.maxAge) {
        resetOneParticle(p);
        continue;
      }

      const vec = vectorAt(p.lon, p.lat);

      if (!vec) {
        resetOneParticle(p);
        continue;
      }

      const oldLon = p.lon;
      const oldLat = p.lat;

      const latRad = p.lat * Math.PI / 180.0;
      let coslat = Math.cos(latRad);
      if (Math.abs(coslat) < 1e-6) coslat = 1e-6;

      const newLon = p.lon + (vec.u * dt) / coslat;
      const newLat = p.lat + vec.v * dt;

      if (!vectorAt(newLon, newLat)) {
        resetOneParticle(p);
        continue;
      }

      p.lon = newLon;
      p.lat = newLat;
      p.age += 1;

      const a = map.project([oldLon, oldLat]);
      const b = map.project([newLon, newLat]);

      if (
        b.x < -80 || b.x > width + 80 ||
        b.y < -80 || b.y > height + 80
      ) {
        resetOneParticle(p);
        continue;
      }

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let len = Math.sqrt(dx * dx + dy * dy);

      if (!Number.isFinite(len) || len < 0.05) {
        dx = vec.u;
        dy = vec.v;
        len = Math.sqrt(dx * dx + dy * dy);
      }

      if (!Number.isFinite(len) || len <= 0.0) continue;

      dx /= len;
      dy /= len;

      const tSpeed = Math.max(0.0, Math.min(1.0, vec.speed / 1.0));
      const segLen = 2.0 + 13.0 * Math.pow(tSpeed, 0.75);

      const x1 = b.x;
      const y1 = b.y;
      const x0 = x1 - dx * segLen;
      const y0 = y1 - dy * segLen;

      p.fadeAge = (p.fadeAge || 0) + 1;
      const fade = Math.min(1.0, p.fadeAge / 18.0);

      particleCtx.strokeStyle = particleCanvasColor(vec.speed);
      particleCtx.globalAlpha = fade;
      particleCtx.lineWidth = currentVar === "current_speed"
        ? 1.15 + 0.55 * tSpeed
        : 1.0 + 0.35 * tSpeed;

      particleCtx.beginPath();
      particleCtx.moveTo(x0, y0);
      particleCtx.lineTo(x1, y1);
      particleCtx.stroke();

      particleCtx.globalAlpha = 1.0;
    }
  }

  particleAnimId = requestAnimationFrame(step);
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

      initParticleCanvas();
      await setFrame(0);
      startParticles();

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
