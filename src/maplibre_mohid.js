"use strict";

const APP_DATA_VERSION = "smooth_model_switch_01";

const MODEL_DEFS = {
  mohid: {
    label: "MOHID",
    dataRoot: "data/mohid/",
    defaultVar: "temperature",
    variables: [
      ["temperature", "Temperature"],
      ["salinity", "Salinity"],
      ["ssh", "Elevation"],
      ["current_speed", "Current Speed"],
      ["current_particles", "Current Speed (Particles)"]
    ]
  },
  swan: {
    label: "SWAN",
    dataRoot: "data/swan/",
    defaultVar: "hs",
    variables: [
      ["hs", "Significant Wave Height"],
      ["tp", "Peak Wave Period"]
    ]
  },
  wrf: {
    label: "WRF",
    dataRoot: "data/wrf/",
    defaultVar: "wind_speed",
    variables: [
      ["wind_speed", "Wind"],
      ["wind_particles", "Wind (Particles)"],
      ["t2", "2m Temperature"],
      ["slp", "Sea Level Pressure"]
    ]
  }
};

window.localStorage.removeItem("koos_forecast_model");
const urlParams = new URLSearchParams(window.location.search);
let currentModel = urlParams.get("model") || "mohid";

if (!MODEL_DEFS[currentModel]) currentModel = "mohid";

let DATA_ROOT = MODEL_DEFS[currentModel].dataRoot;

const els = {
  modelSelect: document.getElementById("model-select"),
  varSelect: document.getElementById("var-select"),
  opacitySlider: document.getElementById("opacity-slider"),
  playBtn: document.getElementById("play-btn"),
  frameSlider: document.getElementById("frame-slider"),
  timeLabel: document.getElementById("time-label"),
  statusLine: document.getElementById("status-line"),
  legendBox: document.getElementById("legend-box"),
  meshOverlay: document.getElementById("mesh-overlay-check"),
  currentOverlay: document.getElementById("current-overlay-check"),
  particleDensity: document.getElementById("particle-density-select"),
  tsPanel: document.getElementById("timeseries-panel"),
  tsTitle: document.getElementById("timeseries-title"),
  tsInfo: document.getElementById("timeseries-info"),
  tsCanvas: document.getElementById("timeseries-canvas"),
  tsClose: document.getElementById("timeseries-close")
};

let map = null;
let meta = null;
let grid = null;

let currentVar = MODEL_DEFS[currentModel].defaultVar;
let currentFrame = 0;
let playTimer = null;

let scalarCache = new Map();
let timeseriesCache = new Map();
let pointTimeseriesFullCache = new Map();
let currentU = null;
let currentV = null;

let particles = [];
let particleRunning = false;
let lastParticleUpdateMs = 0;

let sampleClickDown = null;
let sampleRequestId = 0;
let particleDrawVertexCount = 0;

let pressureLabelContainer = null;
let pressureLabelFeatures = [];

const GLState = {
  gl: null,

  scalarProgram: null,
  meshProgram: null,
  particleProgram: null,

  scalarPosBuffer: null,
  scalarValBuffer: null,
  meshPosBuffer: null,

  particleColorBuffer: null,
  particleStartBuffer: null,
  particleEndBuffer: null,
  particleSideBuffer: null,
  particleTBuffer: null,

  scalarAPos: null,
  scalarAVal: null,
  scalarUMatrix: null,
  scalarUVmin: null,
  scalarUVmax: null,
  scalarUOpacity: null,
  scalarUCmap: null,

  meshAPos: null,
  meshUMatrix: null,
  meshUColor: null,

  particleAColor: null,
  particleUMatrix: null,


  scalarVertexCount: 0,
  meshVertexCount: 0,
  particleVertexCount: 0,

  ready: false,
  valuesReady: false
};

function configureModelControls() {
  const def = MODEL_DEFS[currentModel];

  DATA_ROOT = def.dataRoot;
  currentVar = def.defaultVar;

  if (els.modelSelect) {
    els.modelSelect.value = currentModel;
  }

  if (els.varSelect) {
    els.varSelect.innerHTML = "";
    for (const [value, label] of def.variables) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      els.varSelect.appendChild(opt);
    }
    els.varSelect.value = currentVar;
  }

  const title = document.querySelector("#top-panel .title");
  if (title) title.textContent = "KOOS Forecast Viewer";

  const meshLabel = document.getElementById("mesh-overlay-label");
  if (meshLabel) meshLabel.textContent = "Mesh overlay";

  const particleLabel = document.getElementById("particle-overlay-label");
  if (particleLabel) particleLabel.textContent = "Particle animation";
}

function isSwanModel() {
  return currentModel === "swan" || currentModel === "wrf";
}


function setStatus(_) {
  /*
   * Status box is hidden in the compact UI.
   */
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
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "v=" + APP_DATA_VERSION, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const arr = new Float32Array(buf);
  if (expectedLen !== null && arr.length !== expectedLen) {
    throw new Error(`${url}: ${arr.length} != ${expectedLen}`);
  }
  return arr;
}

async function fetchInt32(url, expectedLen = null) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "v=" + APP_DATA_VERSION, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const arr = new Int32Array(buf);
  if (expectedLen !== null && arr.length !== expectedLen) {
    throw new Error(`${url}: ${arr.length} != ${expectedLen}`);
  }
  return arr;
}

async function fetchFloat32Range(url, startFloat, count) {
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = url + sep + "v=" + APP_DATA_VERSION;

  const byteStart = startFloat * 4;
  const byteEnd = byteStart + count * 4 - 1;

  const res = await fetch(fullUrl, {
    headers: {
      Range: `bytes=${byteStart}-${byteEnd}`
    },
    cache: "force-cache"
  });

  if (!res.ok && res.status !== 206) {
    throw new Error(`${url}: ${res.status}`);
  }

  const buf = await res.arrayBuffer();
  const arr = new Float32Array(buf);

  /*
   * If the server honors Range, arr.length == count.
   * If it ignores Range and returns the full file, slice the requested part.
   */
  if (arr.length === count) return arr;

  if (arr.length > startFloat + count) {
    return arr.slice(startFloat, startFloat + count);
  }

  return arr.slice(0, Math.min(arr.length, count));
}

async function fetchFloat32Full(url) {
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = url + sep + "v=" + APP_DATA_VERSION;

  const res = await fetch(fullUrl, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);

  const buf = await res.arrayBuffer();
  return new Float32Array(buf);
}

async function preloadPointTimeseriesFiles() {
  if (!meta || !meta.timeseries || !meta.timeseries.variables) return;

  const vars = timeseriesVariablesForModel();

  for (const [name] of vars) {
    const ts = meta.timeseries.variables[name];
    if (!ts || !ts.file) continue;

    const key = `${currentModel}:${name}:${APP_DATA_VERSION}`;
    if (pointTimeseriesFullCache.has(key)) continue;

    fetchFloat32Full(DATA_ROOT + ts.file)
      .then(arr => {
        pointTimeseriesFullCache.set(key, arr);
      })
      .catch(err => {
        console.warn("point timeseries preload failed:", name, err);
      });
  }
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

vec3 slpPressure(float t) {
  t = clamp(t, 0.0, 1.0);

  vec3 c0 = vec3(0.09, 0.47, 0.55);  // 990 hPa: teal
  vec3 c1 = vec3(0.25, 0.68, 0.67);  // 1000 hPa
  vec3 c2 = vec3(0.88, 0.84, 0.66);  // 1010 hPa: light beige
  vec3 c3 = vec3(0.70, 0.47, 0.30);  // 1020 hPa: brown
  vec3 c4 = vec3(0.64, 0.20, 0.12);  // 1030 hPa: reddish brown

  if (t < 0.25) return mix3(c0, c1, t / 0.25);
  if (t < 0.50) return mix3(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix3(c2, c3, (t - 0.50) / 0.25);
  return mix3(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  if (v_value != v_value) discard;

  float den = max(abs(u_vmax - u_vmin), 1.0e-12);
  float t = clamp((v_value - u_vmin) / den, 0.0, 1.0);

  vec3 c;
  if (u_cmap == 1) c = blueWhiteRed(t);
  else if (u_cmap == 2) c = ylgnbu(t);
  else if (u_cmap == 4) c = slpPressure(t);
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

attribute vec2 a_start;
attribute vec2 a_end;
attribute float a_side;
attribute float a_t;
attribute vec4 a_color;

uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_width;

varying vec4 v_color;
varying float v_side;
varying float v_t;
varying float v_len;

void main() {
  vec4 c0 = u_matrix * vec4(a_start, 0.0, 1.0);
  vec4 c1 = u_matrix * vec4(a_end, 0.0, 1.0);

  vec2 p0 = c0.xy / c0.w;
  vec2 p1 = c1.xy / c1.w;

  vec2 dirPx = (p1 - p0) * u_viewport;
  float lenPx = length(dirPx);

  if (lenPx < 1.0e-6) {
    dirPx = vec2(1.0, 0.0);
    lenPx = 1.0;
  } else {
    dirPx = dirPx / lenPx;
  }

  vec2 normal = vec2(-dirPx.y, dirPx.x);
  vec2 p = mix(p0, p1, a_t);

  /*
   * Expand by a little more than width to allow smooth antialias edge.
   */
  float expand = u_width + 1.25;
  vec2 offset = normal * a_side * expand / u_viewport * 2.0;

  gl_Position = vec4(p + offset, 0.0, 1.0);

  v_color = a_color;
  v_side = a_side;
  v_t = a_t;
  v_len = lenPx;
}
`;

const PARTICLE_FS = `
precision highp float;

uniform float u_width;

varying vec4 v_color;
varying float v_side;
varying float v_t;
varying float v_len;

void main() {
  /*
   * Pixel-space rounded capsule:
   * x = along segment in pixels
   * y = across segment in pixels
   */
  float radius = max(0.5, u_width);
  float expand = radius + 1.25;

  float x = v_t * v_len;
  float y = abs(v_side) * expand;

  float d;

  if (x < radius) {
    d = length(vec2(x - radius, y)) - radius;
  } else if (x > v_len - radius) {
    d = length(vec2(x - (v_len - radius), y)) - radius;
  } else {
    d = y - radius;
  }

  float aa = 1.0 - smoothstep(0.0, 1.35, d);

  if (aa <= 0.01) discard;

  gl_FragColor = vec4(v_color.rgb, v_color.a * aa);
}
`;


function cmapCode(name) {
  const c = String(name || "").toLowerCase();

  if (c === "bwr" || c === "rdbu" || c === "bluewhitered") return 1;
  if (c === "ylgnbu") return 2;
  if (c === "viridis") return 3;
  if (c === "slp" || c === "pressure" || c === "sea_level_pressure") return 4;
  if (c === "turbo") return 0;

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

    const p = mercatorXY(qlon, qlat);
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
      validCellIndices.push(cell);

      pushCorner(triPositions, c00); cornerIndexForVertex.push(c00);
      pushCorner(triPositions, c10); cornerIndexForVertex.push(c10);
      pushCorner(triPositions, c11); cornerIndexForVertex.push(c11);

      pushCorner(triPositions, c00); cornerIndexForVertex.push(c00);
      pushCorner(triPositions, c11); cornerIndexForVertex.push(c11);
      pushCorner(triPositions, c01); cornerIndexForVertex.push(c01);

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

function scalarVariableForCurrentView() {
  if (currentModel === "mohid" && currentVar === "current_particles") return "current_speed";
  if (currentModel === "wrf" && currentVar === "wind_particles") return "wind_speed";
  return currentVar;
}

function particlesColoredBySpeed() {
  if (currentModel === "mohid") {
    return currentVar === "current_speed" || currentVar === "current_particles";
  }

  /*
   * WRF:
   *   Wind              -> white particles over scalar wind map
   *   Wind (Particles)  -> colored particles using Wind colorbar
   */
  if (currentModel === "wrf") {
    return currentVar === "wind_particles";
  }

  return false;
}

function particleColorVariableForCurrentView() {
  if (currentModel === "wrf") return "wind_speed";
  if (currentModel === "mohid") return "current_speed";
  return null;
}

function scalarVisibleForCurrentView() {
  if (currentModel === "mohid" && currentVar === "current_particles") return false;
  if (currentModel === "wrf" && currentVar === "wind_particles") return false;
  return true;
}

function legendVariableForCurrentView() {
  if (currentModel === "wrf" && currentVar === "wind_particles") return "wind_speed";
  if (currentModel === "mohid" && currentVar === "current_particles") return "current_speed";
  if (!scalarVisibleForCurrentView()) return null;
  return scalarVariableForCurrentView();
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
    cornerValues[k] = count[k] > 0.0 ? sum[k] / count[k] : NaN;
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


function vectorAt(lon, lat) {
  if (!currentU || !currentV || !grid) return null;

  const lonMin = meta.grid.lon_min;
  const lonMax = meta.grid.lon_max;
  const latMin = meta.grid.lat_min;
  const latMax = meta.grid.lat_max;

  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return null;

  /*
   * WRF particles need a fast lookup.
   * Do NOT use bruteForceNearestSampleCell here; it is only for click sampling.
   */
  if (currentModel === "wrf") {
    const cell = fastStructuredCellAt(lon, lat);

    if (cell < 0 || cell >= grid.n) return null;
    if (grid.mask && grid.mask[cell] <= 0.0) return null;

    const u = currentU[cell];
    const v = currentV[cell];

    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

    const speed = Math.hypot(u, v);
    if (!Number.isFinite(speed) || speed <= 0.0) return null;

    return { u, v, speed };
  }

  /*
   * SWAN is a regular grid. Use direct nearest-cell lookup.
   * This avoids MOHID lookup smoothing issues and makes wave particles robust.
   */
  if (currentModel === "swan") {
    const nx = grid.nx;
    const ny = grid.ny;

    let ix = Math.round((lon - lonMin) / Math.max(1.0e-12, lonMax - lonMin) * (nx - 1));
    let iy = Math.round((lat - latMin) / Math.max(1.0e-12, latMax - latMin) * (ny - 1));

    ix = Math.max(0, Math.min(nx - 1, ix));
    iy = Math.max(0, Math.min(ny - 1, iy));

    const cell = iy * nx + ix;

    if (cell < 0 || cell >= grid.n) return null;
    if (grid.mask && grid.mask[cell] <= 0.0) return null;

    const u = currentU[cell];
    const v = currentV[cell];

    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

    const speed = Math.hypot(u, v);
    if (!Number.isFinite(speed) || speed <= 0.0) return null;

    return { u, v, speed };
  }

  if (!grid.particleLookupCell) return null;

  const lnx = grid.particleLookupNx;
  const lny = grid.particleLookupNy;

  if (!lnx || !lny) return null;

  let ix = Math.floor((lon - lonMin) / (lonMax - lonMin) * lnx);
  let iy = Math.floor((lat - latMin) / (latMax - latMin) * lny);

  ix = Math.max(0, Math.min(lnx - 1, ix));
  iy = Math.max(0, Math.min(lny - 1, iy));

  /*
   * Smooth vector sampling:
   * Old version used only one nearest cell, which makes particles look blocky.
   * This samples unique nearby cells from the particle lookup grid and
   * blends u/v with inverse-distance weights.
   */
  const coslat = Math.max(0.2, Math.cos(lat * Math.PI / 180.0));
  const seen = new Set();

  let sw = 0.0;
  let su = 0.0;
  let sv = 0.0;

  let bestCell = -1;
  let bestD2 = 1.0e30;

  const radius = 1;

  for (let dy = -radius; dy <= radius; dy++) {
    const yy = iy + dy;
    if (yy < 0 || yy >= lny) continue;

    for (let dx = -radius; dx <= radius; dx++) {
      const xx = ix + dx;
      if (xx < 0 || xx >= lnx) continue;

      const cell = grid.particleLookupCell[yy * lnx + xx];

      if (cell == null || cell < 0 || cell >= grid.n) continue;
      if (seen.has(cell)) continue;
      seen.add(cell);

      const cl0 = grid.lon[cell];
      const ct0 = grid.lat[cell];
      const u = currentU[cell];
      const v = currentV[cell];

      if (!Number.isFinite(cl0) || !Number.isFinite(ct0)) continue;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (Math.abs(u) > 20.0 || Math.abs(v) > 20.0) continue;

      const dlon = (cl0 - lon) * coslat;
      const dlat = ct0 - lat;
      const d2 = dlon * dlon + dlat * dlat;

      if (d2 < bestD2) {
        bestD2 = d2;
        bestCell = cell;
      }

      /*
       * Small epsilon prevents a single exact lookup from dominating too hard,
       * but still strongly favors close cells.
       */
      const w = 1.0 / (d2 + 1.0e-7);

      sw += w;
      su += u * w;
      sv += v * w;
    }
  }

  if (sw > 0.0) {
    const u = su / sw;
    const v = sv / sw;
    const speed = Math.hypot(u, v);

    if (!Number.isFinite(speed)) return null;

    return { u, v, speed };
  }

  if (bestCell >= 0) {
    const u = currentU[bestCell];
    const v = currentV[bestCell];

    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

    const speed = Math.hypot(u, v);

    if (!Number.isFinite(speed)) return null;

    return { u, v, speed };
  }

  return null;
}


function particleTargetCount() {
  /*
   * Fixed Mid density.
   * UI particle density selector was removed.
   */
  const base = currentModel === "swan" || currentModel === "wrf" ? 1700 : 1200;
  const z = map ? map.getZoom() : 6.0;

  let mul = 1.0;

  if (z <= 5.0) mul = 0.82;
  else if (z < 9.0) mul = 0.82 + (z - 5.0) * (0.18 / 4.0);

  return Math.max(520, Math.round(base * mul));
}

function jitterParticlePoint(lon, lat) {
  /*
   * Light jitter to avoid obvious cell-center seeding.
   * Performance-friendly: no extra lookup radius, only one validation.
   */
  if (!grid || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { lon, lat };
  }

  const dx = (meta.grid.lon_max - meta.grid.lon_min) / Math.max(1, grid.nx);
  const dy = (meta.grid.lat_max - meta.grid.lat_min) / Math.max(1, grid.ny);

  const qlon = lon + (Math.random() - 0.5) * dx * 0.75;
  const qlat = lat + (Math.random() - 0.5) * dy * 0.75;

  if (vectorAt(qlon, qlat)) {
    return { lon: qlon, lat: qlat };
  }

  return { lon, lat };
}


function randomValidParticlePoint() {
  if (!grid || !grid.validCellIndices || grid.validCellIndices.length === 0) {
    return null;
  }

  const b = map ? map.getBounds() : null;

  for (let k = 0; k < 1000; k++) {
    const cell = grid.validCellIndices[
      Math.floor(Math.random() * grid.validCellIndices.length)
    ];

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

    if (vectorAt(lon, lat)) return jitterParticlePoint(lon, lat);
  }

  const cell = grid.validCellIndices[
    Math.floor(Math.random() * grid.validCellIndices.length)
  ];

  return jitterParticlePoint(grid.lon[cell], grid.lat[cell]);
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
  p.maxAge = 220 + Math.floor(Math.random() * 160);
  p.fadeAge = Math.floor(Math.random() * 10);
  p.spawnedReplacement = false;
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

  lastParticleUpdateMs = performance.now();
}



function particleTrailMax() {
  const z = map ? map.getZoom() : 6.0;

  /*
   * WRF wind vectors are much faster than ocean current vectors.
   * Use shorter trails for wind.
   */
  if (currentModel === "wrf") {
    if (z <= 4.8) return 42;
    if (z <= 5.5) return 38;
    if (z <= 6.5) return 32;
    if (z <= 7.5) return 27;
    if (z <= 8.5) return 23;
    return 20;
  }

  /*
   * MOHID/SWAN particle trail scaling.
   */
  if (z <= 4.8) return 90;
  if (z <= 5.5) return 80;
  if (z <= 6.5) return 68;
  if (z <= 7.5) return 56;
  if (z <= 8.5) return 48;

  return 40;
}

function particleFlowScale() {
  const z = map ? map.getZoom() : 6.0;

  /*
   * WRF U10/V10 are m/s and are much larger than ocean currents.
   * Use a smaller advection scale so wind particles do not shoot across the map.
   */
  if (currentModel === "wrf") {
    if (z <= 4.8) return 0.00085;
    if (z <= 5.5) return 0.00078;
    if (z <= 6.5) return 0.00070;
    if (z <= 7.5) return 0.00062;
    if (z <= 8.5) return 0.00056;
    return 0.00050;
  }

  /*
   * MOHID/SWAN particle advection scale.
   */
  if (z <= 4.8) return 0.0084;
  if (z <= 5.5) return 0.0078;
  if (z <= 6.5) return 0.0072;
  if (z <= 7.5) return 0.0067;
  if (z <= 8.5) return 0.0063;

  return 0.0060;
}

function updateParticles() {
  if (!particleRunning || !currentU || !currentV || !grid) return;
  if (els.currentOverlay && !els.currentOverlay.checked) return;

  const target = particleTargetCount();

  if (particles.length < target * 0.75) {
    resetParticles();
    return;
  }

  if (particles.length > target * 1.15) {
    /*
     * Keep mature particles with visible trails.
     * New replacement particles are pushed at the end and have almost no trail yet.
     */
    particles = particles.slice(0, Math.round(target * 1.03));
  }

  const now = performance.now();

  if (!lastParticleUpdateMs) lastParticleUpdateMs = now;

  const elapsed = Math.min(50.0, Math.max(0.0, now - lastParticleUpdateMs));
  lastParticleUpdateMs = now;

  const stepScale = elapsed / 16.667;
  const dt = particleFlowScale() * stepScale;

  for (const p of particles) {
    if (!p || p.age > p.maxAge) {
      resetOneParticle(p);
      continue;
    }

    /*
     * Pre-spawn replacement before this particle dies.
     * This keeps the field continuous without making particles live too long.
     */
    if (!p.spawnedReplacement && p.age > p.maxAge - 45 && particles.length < target * 1.08) {
      const np = {};
      resetOneParticle(np);
      np.fadeAge = 0;
      particles.push(np);
      p.spawnedReplacement = true;
    }

    const vec = vectorAt(p.lon, p.lat);

    if (!vec) {
      resetOneParticle(p);
      continue;
    }

    const latRad = p.lat * Math.PI / 180.0;
    let coslat = Math.cos(latRad);

    if (Math.abs(coslat) < 1.0e-6) coslat = 1.0e-6;

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

    p.trail.push({
      lon: p.lon,
      lat: p.lat,
      speed: vec.speed
    });

    const maxTrail = particleTrailMax();

    while (p.trail.length > maxTrail) {
      p.trail.shift();
    }
  }
}

function speedToRgb01(speed) {
  const varName = particleColorVariableForCurrentView();
  const vm = varName && meta && meta.variables && meta.variables[varName]
    ? meta.variables[varName]
    : { vmin: 0.0, vmax: 1.0 };

  let t = (speed - Number(vm.vmin)) / Math.max(1.0e-12, Number(vm.vmax) - Number(vm.vmin));

  if (!Number.isFinite(t)) t = 0.0;
  t = Math.max(0.0, Math.min(1.0, t));

  /*
   * Same visual ramp as Wind scalar map / turbo-like legend.
   */
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
    a[0] * (1.0 - f) + b[0] * f,
    a[1] * (1.0 - f) + b[1] * f,
    a[2] * (1.0 - f) + b[2] * f
  ];
}


function particleColor01(speed, alpha) {
  if (particlesColoredBySpeed()) {
    const c = speedToRgb01(speed);
    return [c[0], c[1], c[2], alpha];
  }

  return [235.0 / 255.0, 235.0 / 255.0, 235.0 / 255.0, alpha];
}

function pushParticleVertex(pos, col, q, color) {
  const mc = maplibregl.MercatorCoordinate.fromLngLat({
    lng: q.lon,
    lat: q.lat
  });

  pos.push(mc.x, mc.y);
  col.push(color[0], color[1], color[2], color[3]);
}




function buildParticleBuffers() {
  const starts = [];
  const ends = [];
  const sides = [];
  const ts = [];
  const colors = [];

  const z = map ? map.getZoom() : 6.0;

  /*
   * Optimized curved trail:
   * - not one straight long dash
   * - not every tiny segment
   * - sample only a few segments from the trail history
   */
  let zoomAlphaBoost = 1.0;
  if (z <= 4.8) zoomAlphaBoost = 1.70;
  else if (z <= 5.5) zoomAlphaBoost = 1.55;
  else if (z <= 6.5) zoomAlphaBoost = 1.35;
  else if (z <= 7.5) zoomAlphaBoost = 1.15;

  function pushQuad(q0, q1, c0, c1) {
    const p0 = mercatorXY(q0.lon, q0.lat);
    const p1 = mercatorXY(q1.lon, q1.lat);

    const sideVals = [-1, 1, 1, -1, 1, -1];
    const tVals = [0, 0, 1, 0, 1, 1];

    for (let m = 0; m < 6; m++) {
      starts.push(p0[0], p0[1]);
      ends.push(p1[0], p1[1]);
      sides.push(sideVals[m]);
      ts.push(tVals[m]);

      const t = tVals[m];

      colors.push(
        c0[0] * (1.0 - t) + c1[0] * t,
        c0[1] * (1.0 - t) + c1[1] * t,
        c0[2] * (1.0 - t) + c1[2] * t,
        c0[3] * (1.0 - t) + c1[3] * t
      );
    }
  }

  for (const p of particles) {
    if (!p || !p.trail || p.trail.length < 2) continue;

    const n = p.trail.length;
    const fadeFactor = Math.min(1.0, (p.fadeAge || 0) / 12.0);

    /*
     * Segment count by zoom.
     * Low zoom needs enough segments to avoid straight-line artifacts.
     */
    let segCount = 6;
    if (z <= 5.5) segCount = 12;
    else if (z <= 6.5) segCount = 10;
    else if (z <= 7.5) segCount = 8;
    else segCount = 6;

    segCount = Math.min(segCount, n - 1);

    for (let sidx = 0; sidx < segCount; sidx++) {
      const f0 = sidx / segCount;
      const f1 = (sidx + 1) / segCount;

      const i0 = Math.max(0, Math.min(n - 1, Math.floor(f0 * (n - 1))));
      const i1 = Math.max(0, Math.min(n - 1, Math.floor(f1 * (n - 1))));

      if (i1 <= i0) continue;

      const q0 = p.trail[i0];
      const q1 = p.trail[i1];

      if (
        !Number.isFinite(q0.lon) || !Number.isFinite(q0.lat) ||
        !Number.isFinite(q1.lon) || !Number.isFinite(q1.lat)
      ) {
        continue;
      }

      /*
       * Strong tail-to-head contrast.
       * Tail is visible but dim; head is clearly stronger.
       */
      const t0 = f0;
      const t1 = f1;
      const speed0 = Number.isFinite(q0.speed) ? q0.speed : 0.0;
      const speed1 = Number.isFinite(q1.speed) ? q1.speed : speed0;

      let a0 = (0.10 + 0.28 * Math.pow(t0, 1.25)) * fadeFactor * zoomAlphaBoost;
      let a1 = (0.16 + 0.54 * Math.pow(t1, 1.10)) * fadeFactor * zoomAlphaBoost;

      if (particlesColoredBySpeed()) {
        a0 = (0.14 + 0.34 * Math.pow(t0, 1.20)) * fadeFactor * zoomAlphaBoost;
        a1 = (0.22 + 0.68 * Math.pow(t1, 1.05)) * fadeFactor * zoomAlphaBoost;
      }

      a0 = Math.min(a0, particlesColoredBySpeed() ? 0.55 : 0.40);
      a1 = Math.min(a1, particlesColoredBySpeed() ? 0.90 : 0.65);

      const c0 = particleColor01(speed0, a0);
      const c1 = particleColor01(speed1, a1);

      pushQuad(q0, q1, c0, c1);
    }
  }

  return {
    starts: new Float32Array(starts),
    ends: new Float32Array(ends),
    sides: new Float32Array(sides),
    ts: new Float32Array(ts),
    colors: new Float32Array(colors),
    count: sides.length
  };
}

function uploadAndDrawParticles(gl, matrix) {
  if (!GLState.ready || !GLState.particleProgram) return;
  if (!particleRunning) return;
  if (els.currentOverlay && !els.currentOverlay.checked) return;
  if (!currentU || !currentV || !grid) return;

  updateParticles();

  const b = buildParticleBuffers();
  particleDrawVertexCount = b.count;

  if (b.count <= 0) {
    map.triggerRepaint();
    return;
  }

  const rect = map.getContainer().getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const viewportW = Math.max(1, rect.width * dpr);
  const viewportH = Math.max(1, rect.height * dpr);

  const z = map ? map.getZoom() : 6.0;

  /*
   * Quad-line particle width in screen pixels.
   * Wider than GL_LINES, but still natural.
   */
  let widthPx = particlesColoredBySpeed() ? 0.68 : 0.58;

  if (currentModel === "wrf") {
    widthPx = 0.50;
  }

  /*
   * Thin particle dashes across zoom levels.
   */
  if (z <= 4.8) widthPx *= 0.30;
  else if (z <= 5.5) widthPx *= 0.36;
  else if (z <= 6.5) widthPx *= 0.42;
  else if (z <= 8.5) widthPx *= 0.46;
  else widthPx *= 0.50;

  gl.useProgram(GLState.particleProgram);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleStartBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.starts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAStart);
  gl.vertexAttribPointer(GLState.particleAStart, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleEndBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.ends, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAEnd);
  gl.vertexAttribPointer(GLState.particleAEnd, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleSideBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.sides, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleASide);
  gl.vertexAttribPointer(GLState.particleASide, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleTBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.ts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAT);
  gl.vertexAttribPointer(GLState.particleAT, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.particleColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, b.colors, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(GLState.particleAColor);
  gl.vertexAttribPointer(GLState.particleAColor, 4, gl.FLOAT, false, 0, 0);

  gl.uniformMatrix4fv(GLState.particleUMatrix, false, matrix);
  gl.uniform2f(GLState.particleUViewport, viewportW, viewportH);
  gl.uniform1f(GLState.particleUWidth, widthPx);

  gl.drawArrays(gl.TRIANGLES, 0, b.count);

  map.triggerRepaint();
}

function replenishParticlesForView() {
  if (!currentU || !currentV || !grid) return;

  const target = particleTargetCount();

  /*
   * Do not clear all old particles after pan/zoom.
   * Keep existing particles so they fade naturally,
   * then add new particles for the current view.
   */
  const maxKeep = Math.round(target * 1.15);

  if (particles.length > maxKeep) {
    particles = particles.slice(particles.length - maxKeep);
  }

  while (particles.length < target) {
    const p = {};
    resetOneParticle(p);
    p.fadeAge = Math.floor(Math.random() * 10);
    particles.push(p);
  }

  map.triggerRepaint();
}


function startParticles() {
  particleRunning = true;

  if (!particles.length) resetParticles();

  lastParticleUpdateMs = performance.now();

  map.triggerRepaint();
}

function stopParticles() {
  particleRunning = false;
  particles = [];
  map.triggerRepaint();
}

function removeModelLayers() {
  if (!map) return;

  try {
    if (map.getLayer("mohid-custom-layer")) {
      map.removeLayer("mohid-custom-layer");
    }
  } catch (err) {
    console.warn("remove mohid custom layer failed:", err);
  }

  clearPressureContours();
  clearSamplePointMarker();
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
      GLState.particleProgram = makeProgram(gl, PARTICLE_VS, PARTICLE_FS);

      GLState.scalarAPos = gl.getAttribLocation(GLState.scalarProgram, "a_pos");
      GLState.scalarAVal = gl.getAttribLocation(GLState.scalarProgram, "a_value");
      GLState.scalarUMatrix = gl.getUniformLocation(GLState.scalarProgram, "u_matrix");
      GLState.scalarUVmin = gl.getUniformLocation(GLState.scalarProgram, "u_vmin");
      GLState.scalarUVmax = gl.getUniformLocation(GLState.scalarProgram, "u_vmax");
      GLState.scalarUOpacity = gl.getUniformLocation(GLState.scalarProgram, "u_opacity");
      GLState.scalarUCmap = gl.getUniformLocation(GLState.scalarProgram, "u_cmap");

      GLState.meshAPos = gl.getAttribLocation(GLState.meshProgram, "a_pos");
      GLState.meshUMatrix = gl.getUniformLocation(GLState.meshProgram, "u_matrix");
      GLState.meshUColor = gl.getUniformLocation(GLState.meshProgram, "u_color");

      GLState.particleAStart = gl.getAttribLocation(GLState.particleProgram, "a_start");
      GLState.particleAEnd = gl.getAttribLocation(GLState.particleProgram, "a_end");
      GLState.particleASide = gl.getAttribLocation(GLState.particleProgram, "a_side");
      GLState.particleAT = gl.getAttribLocation(GLState.particleProgram, "a_t");
      GLState.particleAColor = gl.getAttribLocation(GLState.particleProgram, "a_color");
      GLState.particleUMatrix = gl.getUniformLocation(GLState.particleProgram, "u_matrix");
      GLState.particleUViewport = gl.getUniformLocation(GLState.particleProgram, "u_viewport");
      GLState.particleUWidth = gl.getUniformLocation(GLState.particleProgram, "u_width");

      GLState.scalarPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.scalarPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.triPositions, gl.STATIC_DRAW);

      GLState.scalarValBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.scalarValBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        grid.cornerIndexForVertex.length * 4,
        gl.DYNAMIC_DRAW
      );

      GLState.meshPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLState.meshPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.edgePositions, gl.STATIC_DRAW);

      GLState.particleStartBuffer = gl.createBuffer();
      GLState.particleEndBuffer = gl.createBuffer();
      GLState.particleSideBuffer = gl.createBuffer();
      GLState.particleTBuffer = gl.createBuffer();
      GLState.particleColorBuffer = gl.createBuffer();

      GLState.scalarVertexCount = grid.triPositions.length / 2;
      GLState.meshVertexCount = grid.edgePositions.length / 2;

      GLState.ready = true;
    },

    render: function(gl, matrix) {
      if (!GLState.ready) return;

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (GLState.valuesReady && scalarVisibleForCurrentView()) {
        const vm = meta.variables[scalarVariableForCurrentView()];

        gl.useProgram(GLState.scalarProgram);

        gl.bindBuffer(gl.ARRAY_BUFFER, GLState.scalarPosBuffer);
        gl.enableVertexAttribArray(GLState.scalarAPos);
        gl.vertexAttribPointer(GLState.scalarAPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, GLState.scalarValBuffer);
        gl.enableVertexAttribArray(GLState.scalarAVal);
        gl.vertexAttribPointer(GLState.scalarAVal, 1, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(GLState.scalarUMatrix, false, matrix);
        gl.uniform1f(GLState.scalarUVmin, vm.vmin);
        gl.uniform1f(GLState.scalarUVmax, vm.vmax);
        gl.uniform1f(
          GLState.scalarUOpacity,
          Number(els.opacitySlider.value || 0.82)
        );
        gl.uniform1i(GLState.scalarUCmap, cmapCode(vm.cmap));

        gl.drawArrays(gl.TRIANGLES, 0, GLState.scalarVertexCount);
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

      uploadAndDrawParticles(gl, matrix);
    }
  };
}

async function setFrame(i) {
  const n = frameCount();

  if (n <= 0 || !GLState.ready) return;

  currentFrame = Math.max(0, Math.min(n - 1, Number(i)));
  els.frameSlider.value = String(currentFrame);

  const scalarVar = scalarVariableForCurrentView();

  const [values, u, v] = await Promise.all([
    loadFrame(scalarVar, currentFrame),
    loadFrame("current_u", currentFrame),
    loadFrame("current_v", currentFrame)
  ]);

  currentU = u;
  currentV = v;

  const vertexValues = buildVertexValues(values);
  const gl = GLState.gl;

  gl.bindBuffer(gl.ARRAY_BUFFER, GLState.scalarValBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexValues);

  GLState.valuesReady = true;

  updateTimeLabel();
  updateLegend();
  updatePressureContours(values);

  resetParticles();
  startParticles();

  setStatus(
    `${MODEL_DEFS[currentModel].label} ${meta.cycle}
` +
    `${currentVar} frame ${currentFrame + 1}/${frameCount()}
` +
    `particles ${particles.length} / vertices ${particleDrawVertexCount}`
  );

  map.triggerRepaint();
}

function fmtLegendNumber(x, digits = 1) {
  const n = Number(x);

  if (!Number.isFinite(n)) return String(x);
  if (Math.abs(n - Math.round(n)) < 1.0e-9) return String(Math.round(n));

  return n.toFixed(digits).replace(/\.?0+$/, "");
}



function timeseriesVariablesForModel() {
  if (!meta || !meta.variables) return [];

  if (currentModel === "swan") {
    return [
      ["hs", "Hs"],
      ["tp", "Tp"]
    ].filter(([v]) => meta.variables[v]);
  }

  if (currentModel === "wrf") {
    return [
      ["wind_speed", "Wind"],
      ["t2", "2m Temp"],
      ["slp", "Sea Level Pressure"]
    ].filter(([v]) => meta.variables[v]);
  }

  return [
    ["temperature", "Temp"],
    ["salinity", "Salinity"],
    ["ssh", "Elevation"],
    ["current_speed", "Current Speed"]
  ].filter(([v]) => meta.variables[v]);
}

function isValidSampleCell(cell) {
  if (!grid || cell == null || cell < 0 || cell >= grid.n) return false;
  if (!Number.isFinite(grid.lon[cell]) || !Number.isFinite(grid.lat[cell])) return false;
  if (grid.mask && grid.mask[cell] <= 0.0) return false;
  return true;
}

function bruteForceNearestSampleCell(lon, lat) {
  let best = -1;
  let bestD2 = 1.0e30;
  const coslat = Math.max(0.2, Math.cos(lat * Math.PI / 180.0));

  for (const c of grid.validCellIndices || []) {
    if (!isValidSampleCell(c)) continue;

    const dlon = (grid.lon[c] - lon) * coslat;
    const dlat = grid.lat[c] - lat;
    const d2 = dlon * dlon + dlat * dlat;

    if (d2 < bestD2) {
      bestD2 = d2;
      best = c;
    }
  }

  return best;
}

function fastStructuredCellAt(lon, lat) {
  /*
   * Fast lookup for animation.
   * WRF click sampling uses brute-force, but particles cannot.
   */
  if (!grid || !meta || !meta.grid) return -1;

  const nx = grid.nx;
  const ny = grid.ny;

  const lonMin = meta.grid.lon_min;
  const lonMax = meta.grid.lon_max;
  const latMin = meta.grid.lat_min;
  const latMax = meta.grid.lat_max;

  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return -1;

  let ix = Math.round((lon - lonMin) / Math.max(1.0e-12, lonMax - lonMin) * (nx - 1));
  let iy = Math.round((lat - latMin) / Math.max(1.0e-12, latMax - latMin) * (ny - 1));

  ix = Math.max(0, Math.min(nx - 1, ix));
  iy = Math.max(0, Math.min(ny - 1, iy));

  let best = -1;
  let bestD2 = 1.0e30;
  const coslat = Math.max(0.2, Math.cos(lat * Math.PI / 180.0));

  /*
   * Small local search only. This fixes most curvilinear offset
   * without scanning the whole 360x360 grid.
   */
  const rmax = currentModel === "wrf" ? 2 : 1;

  for (let dy = -rmax; dy <= rmax; dy++) {
    const yy = iy + dy;
    if (yy < 0 || yy >= ny) continue;

    for (let dx = -rmax; dx <= rmax; dx++) {
      const xx = ix + dx;
      if (xx < 0 || xx >= nx) continue;

      const c = yy * nx + xx;
      if (!isValidSampleCell(c)) continue;

      const dlon = (grid.lon[c] - lon) * coslat;
      const dlat = grid.lat[c] - lat;
      const d2 = dlon * dlon + dlat * dlat;

      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
  }

  return best;
}


function findNearestSampleCell(lon, lat) {
  if (!grid || !meta || !meta.grid) return -1;

  const lonMin = meta.grid.lon_min;
  const lonMax = meta.grid.lon_max;
  const latMin = meta.grid.lat_min;
  const latMax = meta.grid.lat_max;

  if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return -1;

  /*
   * WRF XLAT/XLON can be curvilinear. Use true nearest lon/lat search.
   */
  if (currentModel === "wrf") {
    return bruteForceNearestSampleCell(lon, lat);
  }

  /*
   * SWAN regular grid: direct lookup first, then small radius search.
   */
  if (currentModel === "swan") {
    const nx = grid.nx;
    const ny = grid.ny;

    let ix = Math.round((lon - lonMin) / Math.max(1.0e-12, lonMax - lonMin) * (nx - 1));
    let iy = Math.round((lat - latMin) / Math.max(1.0e-12, latMax - latMin) * (ny - 1));

    ix = Math.max(0, Math.min(nx - 1, ix));
    iy = Math.max(0, Math.min(ny - 1, iy));

    const direct = iy * nx + ix;
    if (isValidSampleCell(direct)) return direct;

    for (let r = 1; r <= 8; r++) {
      let best = -1;
      let bestD2 = 1.0e30;

      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;

          const xx = ix + dx;
          const yy = iy + dy;
          if (xx < 0 || xx >= nx || yy < 0 || yy >= ny) continue;

          const c = yy * nx + xx;
          if (!isValidSampleCell(c)) continue;

          const dlon = grid.lon[c] - lon;
          const dlat = grid.lat[c] - lat;
          const d2 = dlon * dlon + dlat * dlat;

          if (d2 < bestD2) {
            bestD2 = d2;
            best = c;
          }
        }
      }

      if (best >= 0) return best;
    }

    return -1;
  }

  /*
   * MOHID: use lookup grid first if available.
   */
  if (grid.particleLookupCell && grid.particleLookupNx && grid.particleLookupNy) {
    const lnx = grid.particleLookupNx;
    const lny = grid.particleLookupNy;

    let ix = Math.floor((lon - lonMin) / Math.max(1.0e-12, lonMax - lonMin) * lnx);
    let iy = Math.floor((lat - latMin) / Math.max(1.0e-12, latMax - latMin) * lny);

    ix = Math.max(0, Math.min(lnx - 1, ix));
    iy = Math.max(0, Math.min(lny - 1, iy));

    for (let r = 0; r <= 3; r++) {
      let best = -1;
      let bestD2 = 1.0e30;

      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = ix + dx;
          const yy = iy + dy;
          if (xx < 0 || xx >= lnx || yy < 0 || yy >= lny) continue;

          const c = grid.particleLookupCell[yy * lnx + xx];
          if (!isValidSampleCell(c)) continue;

          const dlon = grid.lon[c] - lon;
          const dlat = grid.lat[c] - lat;
          const d2 = dlon * dlon + dlat * dlat;

          if (d2 < bestD2) {
            bestD2 = d2;
            best = c;
          }
        }
      }

      if (best >= 0) return best;
    }
  }

  /*
   * Fallback: brute-force valid cells.
   * Click only, so this is acceptable.
   */
  let best = -1;
  let bestD2 = 1.0e30;
  const coslat = Math.max(0.2, Math.cos(lat * Math.PI / 180.0));

  for (const c of grid.validCellIndices || []) {
    if (!isValidSampleCell(c)) continue;

    const dlon = (grid.lon[c] - lon) * coslat;
    const dlat = grid.lat[c] - lat;
    const d2 = dlon * dlon + dlat * dlat;

    if (d2 < bestD2) {
      bestD2 = d2;
      best = c;
    }
  }

  return best;
}

function ensureSamplePointLayer() {
  if (!map) return;

  const empty = {
    type: "FeatureCollection",
    features: []
  };

  if (!map.getSource("sample-point")) {
    map.addSource("sample-point", {
      type: "geojson",
      data: empty
    });
  }

  if (!map.getLayer("sample-point-circle")) {
    map.addLayer({
      id: "sample-point-circle",
      type: "circle",
      source: "sample-point",
      paint: {
        "circle-radius": 6,
        "circle-color": "#ffffff",
        "circle-stroke-color": "#0b1f33",
        "circle-stroke-width": 2
      }
    });
  }
}

function setSamplePointMarker(lon, lat) {
  ensureSamplePointLayer();

  const src = map.getSource("sample-point");
  if (!src) return;

  src.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lon, lat]
      },
      properties: {}
    }]
  });
}

function clearSamplePointMarker() {
  if (!map) return;

  const src = map.getSource("sample-point");
  if (!src) return;

  src.setData({
    type: "FeatureCollection",
    features: []
  });
}

function closePointTimeseriesPanel() {
  sampleRequestId += 1;

  if (els.tsPanel) {
    els.tsPanel.classList.add("hidden");
  }

  if (els.tsTitle) {
    els.tsTitle.textContent = "";
  }

  if (els.tsInfo) {
    els.tsInfo.textContent = "";
  }

  clearSamplePointMarker();
}

function resetViewTransientState() {
  /*
   * Clear model-specific transient UI when switching model/variable.
   */
  closePointTimeseriesPanel();
  clearPressureContours();
}

function resetModelRuntimeState() {
  stopPlay();
  stopParticles();

  resetViewTransientState();

  frameCache.clear();
  timeseriesCache.clear();
  pointTimeseriesFullCache.clear();

  particles = [];
  particleDrawVertexCount = 0;

  currentU = null;
  currentV = null;

  GLState.ready = false;
  GLState.valuesReady = false;

  grid = null;
}

async function loadPointTimeseriesVariable(name, cell) {
  const ts = meta && meta.timeseries && meta.timeseries.variables
    ? meta.timeseries.variables[name]
    : null;

  const nt = frameCount();

  if (ts && ts.file && meta.timeseries.layout === "cell_major") {
    const count = Number(ts.count || nt);
    const startFloat = cell * count;

    const fullKey = `${currentModel}:${name}:${APP_DATA_VERSION}`;
    const cellKey = `${currentModel}:${name}:${cell}:${APP_DATA_VERSION}`;

    if (timeseriesCache.has(cellKey)) {
      return timeseriesCache.get(cellKey);
    }

    try {
      let arr;

      if (pointTimeseriesFullCache.has(fullKey)) {
        const full = pointTimeseriesFullCache.get(fullKey);
        arr = full.slice(startFloat, startFloat + count);
      } else {
        arr = await fetchFloat32Range(DATA_ROOT + ts.file, startFloat, count);
      }

      const values = Array.from(arr.slice(0, nt), v =>
        Number.isFinite(v) ? Number(v) : NaN
      );

      timeseriesCache.set(cellKey, values);
      return values;
    } catch (err) {
      console.warn("range timeseries failed, fallback to frame files:", name, err);
    }
  }

  /*
   * Fallback for models without dedicated point-time-series files.
   * This is slower because it reads full frame rasters.
   */
  const values = [];

  for (let i = 0; i < nt; i++) {
    const arr = await loadFrame(name, i);
    const val = arr && cell >= 0 && cell < arr.length ? arr[cell] : NaN;
    values.push(Number.isFinite(val) ? Number(val) : NaN);
  }

  return values;
}

async function extractPointTimeseries(cell, requestId) {
  const vars = timeseriesVariablesForModel();
  const out = [];

  for (const [name, shortLabel] of vars) {
    if (requestId !== sampleRequestId) return null;

    const vm = meta.variables[name];
    const values = await loadPointTimeseriesVariable(name, cell);

    if (requestId !== sampleRequestId) return null;

    out.push({
      name,
      label: vm && vm.label ? vm.label : shortLabel,
      shortLabel,
      unit: vm && vm.unit ? vm.unit : "",
      vmin: vm && Number.isFinite(vm.vmin) ? Number(vm.vmin) : null,
      vmax: vm && Number.isFinite(vm.vmax) ? Number(vm.vmax) : null,
      values
    });
  }

  return out;
}

function clearPointTimeseriesCanvas(message = "") {
  const canvas = els.tsCanvas;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const width = Math.max(320, Math.round(rect.width * dpr));
  const height = Math.max(220, Math.round(rect.height * dpr));

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(4, 15, 26, 0.96)";
  ctx.fillRect(0, 0, width, height);

  if (message) {
    ctx.fillStyle = "rgba(245,247,251,0.72)";
    ctx.font = `${13 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, width * 0.5, height * 0.5);
  }
}

function drawPointTimeseries(series) {
  const canvas = els.tsCanvas;
  if (!canvas || !series || series.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const width = Math.max(520, Math.round(rect.width * dpr));
  const height = Math.max(360, Math.round(rect.height * dpr));

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "rgba(4, 15, 26, 0.96)";
  ctx.fillRect(0, 0, width, height);

  const nPanel = series.length;
  const padL = 58 * dpr;
  const padR = 18 * dpr;
  const padT = 8 * dpr;
  const padB = 30 * dpr;
  const labelH = 18 * dpr;
  const gap = 14 * dpr;

  const panelH = (height - padT - padB - gap * (nPanel - 1) - labelH * nPanel) / Math.max(1, nPanel);

  const colorByName = {
    temperature: "rgba(110, 210, 255, 1.0)",
    salinity: "rgba(255, 205, 75, 1.0)",
    ssh: "rgba(145, 255, 165, 1.0)",
    current_speed: "rgba(255, 120, 125, 1.0)",
    hs: "rgba(90, 190, 255, 1.0)",
    tp: "rgba(255, 210, 95, 1.0)",
    wind_speed: "rgba(120, 210, 255, 1.0)",
    t2: "rgba(255, 170, 95, 1.0)",
    slp: "rgba(220, 220, 170, 1.0)"
  };

  const fallbackColors = [
    "rgba(110, 210, 255, 1.0)",
    "rgba(255, 205, 75, 1.0)",
    "rgba(145, 255, 165, 1.0)",
    "rgba(255, 120, 125, 1.0)"
  ];

  const n = frameCount();

  ctx.font = `${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.lineWidth = 1 * dpr;

  for (let pidx = 0; pidx < nPanel; pidx++) {
    const s = series[pidx];
    const blockY = padT + pidx * (panelH + labelH + gap);
    const labelY = blockY;
    const y0 = blockY + labelH;
    const x0 = padL;
    const x1 = width - padR;
    const y1 = y0 + panelH;

    /*
     * Use the same range as the map colorbar.
     * This makes point time series visually consistent with the scalar overlay.
     */
    /*
     * Auto-scale y-axis from this point's time series.
     * This is only for the popup graph, not the map colorbar.
     */
    const finite = s.values.filter(Number.isFinite);

    let vmin = finite.length ? Math.min(...finite) : 0.0;
    let vmax = finite.length ? Math.max(...finite) : 1.0;

    if (Math.abs(vmax - vmin) < 1.0e-12) {
      const base = Math.max(1.0, Math.abs(vmin));
      vmin -= base * 0.05;
      vmax += base * 0.05;
    } else {
      const margin = (vmax - vmin) * 0.10;
      vmin -= margin;
      vmax += margin;
    }

    ctx.fillStyle = "rgba(245,247,251,0.94)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${10.5 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(`${s.shortLabel} [${s.unit}]`, x0, labelY + 1 * dpr);

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1 * dpr;

    for (let gy = 0; gy <= 2; gy++) {
      const yy = y0 + panelH * gy / 2;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.72)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect(x0, y0, x1 - x0, panelH);

    ctx.fillStyle = "rgba(245,247,251,0.78)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = `${9.5 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(fmtLegendNumber(vmax, 2), x0 - 7 * dpr, y0 + 8 * dpr);
    ctx.fillText(fmtLegendNumber(vmin, 2), x0 - 7 * dpr, y1 - 8 * dpr);

    ctx.strokeStyle = colorByName[s.name] || fallbackColors[pidx % fallbackColors.length];
    ctx.lineWidth = 2.0 * dpr;

    /*
     * Clip each line to its own plot box.
     * Prevents one variable from drawing into neighboring panels.
     */
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, panelH);
    ctx.clip();

    ctx.beginPath();

    let started = false;

    for (let i = 0; i < n; i++) {
      const v = s.values[i];

      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }

      const x = x0 + (x1 - x0) * (n <= 1 ? 0 : i / (n - 1));
      const y = y1 - (y1 - y0) * ((v - vmin) / (vmax - vmin));

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = "rgba(245,247,251,0.62)";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  const f0 = meta.frames[0];
  const f1 = meta.frames[frameCount() - 1];

  ctx.fillText(f0 ? (f0.label || f0.time_utc || "") : "", padL, height - 4 * dpr);
  ctx.textAlign = "right";
  ctx.fillText(f1 ? (f1.label || f1.time_utc || "") : "", width - padR, height - 4 * dpr);
}

async function showPointTimeseries(lon, lat) {
  if (!map || !grid || !meta) return;

  const cell = findNearestSampleCell(lon, lat);

  if (cell < 0) {
    clearSamplePointMarker();

    if (els.tsPanel) els.tsPanel.classList.remove("hidden");
    if (els.tsTitle) els.tsTitle.textContent = "No data";
    if (els.tsInfo) {
      els.tsInfo.textContent =
        `lon/lat: ${lon.toFixed(5)}, ${lat.toFixed(5)}`;
    }

    clearPointTimeseriesCanvas("No data");
    return;
  }

  const sampleLon = grid.lon[cell];
  const sampleLat = grid.lat[cell];

  setSamplePointMarker(sampleLon, sampleLat);

  const requestId = ++sampleRequestId;

  if (els.tsPanel) els.tsPanel.classList.remove("hidden");
  if (els.tsTitle) {
    els.tsTitle.textContent =
      `${MODEL_DEFS[currentModel].label} point time series`;
  }
  if (els.tsInfo) {
    els.tsInfo.textContent =
      `lon/lat: ${sampleLon.toFixed(5)}, ${sampleLat.toFixed(5)}
` +
      `loading...`;
  }

  let series = null;

  try {
    series = await extractPointTimeseries(cell, requestId);
  } catch (err) {
    console.error("point timeseries failed:", err);
  }

  if (!series || requestId !== sampleRequestId) {
    if (els.tsTitle) els.tsTitle.textContent = "No data";
    if (els.tsInfo) {
      els.tsInfo.textContent =
        `lon/lat: ${sampleLon.toFixed(5)}, ${sampleLat.toFixed(5)}`;
    }
    clearPointTimeseriesCanvas("No data");
    return;
  }

  if (els.tsInfo) {
    els.tsInfo.textContent =
      `lon/lat: ${sampleLon.toFixed(5)}, ${sampleLat.toFixed(5)}`;
  }

  drawPointTimeseries(series);
}

function bindPressureLabelEvents() {
  if (!map || map.__pressureLabelEventsBound) return;

  map.__pressureLabelEventsBound = true;

  map.on("move", () => {
    if (currentModel === "wrf" && scalarVariableForCurrentView() === "slp") {
      renderPressureDomLabels();
    }
  });

  map.on("zoom", () => {
    if (currentModel === "wrf" && scalarVariableForCurrentView() === "slp") {
      renderPressureDomLabels();
    }
  });

  map.on("resize", () => {
    if (currentModel === "wrf" && scalarVariableForCurrentView() === "slp") {
      renderPressureDomLabels();
    }
  });
}

function bindPointTimeseriesEvents() {
  if (!map || map.__pointTimeseriesEventsBound) return;

  map.__pointTimeseriesEventsBound = true;

  const canvas = map.getCanvas();

  canvas.addEventListener("mousedown", ev => {
    if (ev.button !== 0) {
      sampleClickDown = null;
      return;
    }

    sampleClickDown = {
      x: ev.clientX,
      y: ev.clientY,
      t: performance.now()
    };
  });

  map.on("click", ev => {
    if (!sampleClickDown) return;

    const oe = ev.originalEvent;
    const dx = oe.clientX - sampleClickDown.x;
    const dy = oe.clientY - sampleClickDown.y;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - sampleClickDown.t;

    sampleClickDown = null;

    /*
     * Ignore map drag / long press.
     */
    if (dist > 5 || dt > 650) return;

    showPointTimeseries(ev.lngLat.lng, ev.lngLat.lat);
  });

  if (els.tsClose) {
    els.tsClose.addEventListener("click", () => {
      closePointTimeseriesPanel();
    });
  }

  window.addEventListener("resize", () => {
    if (!els.tsPanel || els.tsPanel.classList.contains("hidden")) return;
    /*
     * Redraw is skipped here because series is not stored globally.
     * The next click redraws at the new size.
     */
  });
}


function legendGradientCss(cmap) {
  const c = String(cmap || "").toLowerCase();

  if (c === "slp" || c === "pressure" || c === "sea_level_pressure") {
    return "linear-gradient(to right, " +
      "rgb(23,120,140) 0%, " +
      "rgb(64,173,171) 25%, " +
      "rgb(224,214,168) 50%, " +
      "rgb(179,120,77) 75%, " +
      "rgb(163,51,31) 100%)";
  }

  if (c === "bwr" || c === "rdbu" || c === "bluewhitered") {
    return "linear-gradient(to right, rgb(13,46,242), rgb(250,250,245), rgb(209,31,20))";
  }

  if (c === "ylgnbu") {
    return "linear-gradient(to right, rgb(255,255,204), rgb(199,233,180), rgb(127,205,187), rgb(65,182,196), rgb(44,127,184), rgb(37,52,148))";
  }

  return "linear-gradient(to right, rgb(13,46,242), rgb(13,158,255), rgb(26,199,107), rgb(235,219,56), rgb(242,140,26), rgb(209,31,20))";
}


function ensurePressureLabelDom() {
  if (!map) return null;

  if (pressureLabelContainer) return pressureLabelContainer;

  const parent = map.getContainer();

  pressureLabelContainer = document.createElement("div");
  pressureLabelContainer.id = "pressure-label-dom-layer";
  pressureLabelContainer.className = "pressure-label-dom-layer";

  parent.appendChild(pressureLabelContainer);

  return pressureLabelContainer;
}

function clearPressureDomLabels() {
  pressureLabelFeatures = [];

  if (pressureLabelContainer) {
    pressureLabelContainer.innerHTML = "";
    pressureLabelContainer.style.display = "none";
  }
}

function lerp01(a, b, t) {
  return a * (1.0 - t) + b * t;
}

function pressureLabelRgb(level) {
  const vmin = 990.0;
  const vmax = 1030.0;

  let t = (Number(level) - vmin) / Math.max(1.0e-12, vmax - vmin);
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.max(0.0, Math.min(1.0, t));

  const stops = [
    [23, 120, 140],   // 990
    [64, 173, 171],   // 1000
    [224, 214, 168],  // 1010
    [179, 120, 77],   // 1020
    [163, 51, 31]     // 1030
  ];

  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.max(0, Math.floor(x)));
  const f = x - i;

  const a = stops[i];
  const b = stops[i + 1];

  return [
    Math.round(lerp01(a[0], b[0], f)),
    Math.round(lerp01(a[1], b[1], f)),
    Math.round(lerp01(a[2], b[2], f))
  ];
}

function pressureLabelBackground(level) {
  const c = pressureLabelRgb(level);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.92)`;
}

function pressureLabelTextColor(level) {
  const c = pressureLabelRgb(level);
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return lum > 150 ? "#10222c" : "#f7fbff";
}

function pressureLabelAngleDeg(feature) {
  if (!map || !feature || !feature.properties) return 0.0;

  const p0 = feature.properties.p0;
  const p1 = feature.properties.p1;

  if (!Array.isArray(p0) || !Array.isArray(p1)) return 0.0;

  const a = map.project({ lng: p0[0], lat: p0[1] });
  const b = map.project({ lng: p1[0], lat: p1[1] });

  let deg = Math.atan2(b.y - a.y, b.x - a.x) * 180.0 / Math.PI;

  /*
   * Keep text readable: avoid upside-down labels.
   */
  if (deg > 90.0) deg -= 180.0;
  if (deg < -90.0) deg += 180.0;

  return deg;
}

function renderPressureDomLabels() {
  if (!map || !pressureLabelFeatures || pressureLabelFeatures.length <= 0) {
    if (pressureLabelContainer) pressureLabelContainer.style.display = "none";
    return;
  }

  const container = ensurePressureLabelDom();
  if (!container) return;

  const rect = map.getContainer().getBoundingClientRect();

  container.innerHTML = "";
  container.style.display = "block";

  for (const f of pressureLabelFeatures) {
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue;

    const coord = f.geometry.coordinates;
    const label = f.properties && f.properties.label ? String(f.properties.label) : "";

    if (!label) continue;

    const pt = map.project({ lng: coord[0], lat: coord[1] });

    if (pt.x < -40 || pt.x > rect.width + 40 || pt.y < -30 || pt.y > rect.height + 30) {
      continue;
    }

    const level = f.properties && Number.isFinite(Number(f.properties.level))
      ? Number(f.properties.level)
      : Number(label);

    const angle = pressureLabelAngleDeg(f);

    const el = document.createElement("div");
    el.className = "pressure-label-dom";
    el.textContent = label;
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;

    el.style.setProperty("background", pressureLabelBackground(level), "important");
    el.style.setProperty("color", pressureLabelTextColor(level), "important");
    el.style.setProperty(
      "transform",
      `translate(-50%, -50%) rotate(${angle.toFixed(2)}deg)`,
      "important"
    );

    container.appendChild(el);
  }
}


function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: []
  };
}

function ensurePressureContourLayers() {
  if (!map) return;

  /*
   * Use separate sources for contour lines and contour labels.
   * Mixed geometry source + filter was unreliable for label rendering.
   */
  if (!map.getSource("pressure-contours-line-src")) {
    map.addSource("pressure-contours-line-src", {
      type: "geojson",
      data: emptyFeatureCollection()
    });
  }

  if (!map.getSource("pressure-contours-label-src")) {
    map.addSource("pressure-contours-label-src", {
      type: "geojson",
      data: emptyFeatureCollection()
    });
  }

  if (!map.getLayer("pressure-contours-line")) {
    map.addLayer({
      id: "pressure-contours-line",
      type: "line",
      source: "pressure-contours-line-src",
      paint: {
        "line-color": "rgba(245,255,235,0.88)",
        "line-width": 1.15,
        "line-opacity": 0.86
      }
    });
  }

  if (!map.getLayer("pressure-contours-label")) {
    map.addLayer({
      id: "pressure-contours-label",
      type: "symbol",
      source: "pressure-contours-label-src",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-anchor": "center"
      },
      paint: {
        "text-color": "#0b2430",
        "text-halo-color": "rgba(245,250,255,0.92)",
        "text-halo-width": 2.6
      }
    });
  }
}

function clearPressureContours() {
  if (!map) return;

  const lineSrc = map.getSource("pressure-contours-line-src");
  if (lineSrc) lineSrc.setData(emptyFeatureCollection());

  const labelSrc = map.getSource("pressure-contours-label-src");
  if (labelSrc) labelSrc.setData(emptyFeatureCollection());

  clearPressureDomLabels();
}

function contourInterp(p0, p1, v0, v1, level) {
  const den = v1 - v0;
  const t = Math.abs(den) < 1.0e-12 ? 0.5 : (level - v0) / den;

  return [
    p0[0] + (p1[0] - p0[0]) * t,
    p0[1] + (p1[1] - p0[1]) * t
  ];
}

function contourPointKey(p) {
  /*
   * Quantize lon/lat for stitching marching-square segments.
   * 1e-5 degree is enough for this WRF grid.
   */
  return `${p[0].toFixed(5)}:${p[1].toFixed(5)}`;
}

function stitchContourSegments(segments) {
  /*
   * Convert many short marching-square segments into longer polylines.
   * segments: [{p0:[lon,lat], p1:[lon,lat]}]
   */
  const endpointMap = new Map();

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const k0 = contourPointKey(seg.p0);
    const k1 = contourPointKey(seg.p1);

    if (!endpointMap.has(k0)) endpointMap.set(k0, []);
    if (!endpointMap.has(k1)) endpointMap.set(k1, []);

    endpointMap.get(k0).push({ idx, end: 0 });
    endpointMap.get(k1).push({ idx, end: 1 });
  }

  const used = new Uint8Array(segments.length);
  const lines = [];

  function extend(line, forward) {
    while (true) {
      const p = forward ? line[line.length - 1] : line[0];
      const key = contourPointKey(p);
      const hits = endpointMap.get(key) || [];

      let found = null;

      for (const h of hits) {
        if (used[h.idx]) continue;
        found = h;
        break;
      }

      if (!found) break;

      used[found.idx] = 1;

      const seg = segments[found.idx];
      const nextPoint = found.end === 0 ? seg.p1 : seg.p0;

      if (forward) line.push(nextPoint);
      else line.unshift(nextPoint);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;

    used[i] = 1;

    const seg = segments[i];
    const line = [seg.p0, seg.p1];

    extend(line, true);
    extend(line, false);

    if (line.length >= 2) {
      lines.push(line);
    }
  }

  return lines;
}

function screenLengthOfPolyline(line) {
  if (!map || !line || line.length < 2) return 0.0;

  let len = 0.0;

  for (let i = 1; i < line.length; i++) {
    const a = map.project({ lng: line[i - 1][0], lat: line[i - 1][1] });
    const b = map.project({ lng: line[i][0], lat: line[i][1] });

    len += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return len;
}

function labelCandidatesFromPolyline(line, level) {
  if (!map || !line || line.length < 2) return [];

  let total = 0.0;
  const segLens = [];

  for (let i = 1; i < line.length; i++) {
    const a = map.project({ lng: line[i - 1][0], lat: line[i - 1][1] });
    const b = map.project({ lng: line[i][0], lat: line[i][1] });
    const d = Math.hypot(b.x - a.x, b.y - a.y);

    segLens.push(d);
    total += d;
  }

  /*
   * Too-short contours should not get labels.
   */
  if (total < 130.0) return [];

  /*
   * Long isobars can have more than one label.
   * This is based on screen length, so a very long contour line gets 2~3 labels.
   */
  let fractions = [0.52];

  if (total >= 520.0) {
    fractions = [0.33, 0.68];
  }

  if (total >= 900.0) {
    fractions = [0.25, 0.52, 0.78];
  }

  const candidates = [];

  for (const frac of fractions) {
    const target = total * frac;
    let acc = 0.0;

    for (let i = 1; i < line.length; i++) {
      const d = segLens[i - 1];

      if (acc + d >= target) {
        const f = d > 0.0 ? (target - acc) / d : 0.5;

        const p0 = line[i - 1];
        const p1 = line[i];

        const lon = p0[0] * (1.0 - f) + p1[0] * f;
        const lat = p0[1] * (1.0 - f) + p1[1] * f;

        const pt = map.project({ lng: lon, lat });

        candidates.push({
          feature: {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [lon, lat]
            },
            properties: {
              level,
              label: String(level),
              p0,
              p1
            }
          },
          x: pt.x,
          y: pt.y,
          screenLength: total
        });

        break;
      }

      acc += d;
    }
  }

  return candidates;
}


function selectPressureLabels(labelCandidates) {
  /*
   * Big contours first. If a new label is too close to an existing one,
   * skip it. Distance threshold is intentionally moderate so labels are
   * not too sparse.
   */
  const selected = [];

  if (!map || !labelCandidates || labelCandidates.length <= 0) return selected;

  const z = map.getZoom ? map.getZoom() : 6.0;

  /*
   * Minimum label spacing in screen pixels.
   * Reduced from the previous conservative setting.
   */
  let minDist = 95.0;
  if (z >= 7.5) minDist = 75.0;
  else if (z <= 5.0) minDist = 115.0;

  /*
   * Allow a few more labels, but still avoid clutter.
   */
  const rect = map.getContainer().getBoundingClientRect();
  const maxLabels = Math.max(
    8,
    Math.min(34, Math.round((rect.width * rect.height) / 62000))
  );

  const sorted = labelCandidates.slice().sort((a, b) => {
    /*
     * Large polyline first.
     * Slightly prefer 4 hPa contours only when lengths are similar.
     */
    const la = a.screenLength || 0.0;
    const lb = b.screenLength || 0.0;

    const majorA = Number(a.feature.properties.level) % 4 === 0 ? 1 : 0;
    const majorB = Number(b.feature.properties.level) % 4 === 0 ? 1 : 0;

    return (lb + majorB * 25.0) - (la + majorA * 25.0);
  });

  for (const cand of sorted) {
    let ok = true;

    for (const old of selected) {
      const d = Math.hypot(cand.x - old.x, cand.y - old.y);

      if (d < minDist) {
        ok = false;
        break;
      }
    }

    if (!ok) continue;

    selected.push(cand);

    if (selected.length >= maxLabels) break;
  }

  return selected.map(c => c.feature);
}


function buildPressureContourGeoJSON(values) {
  const lineFeatures = [];
  const labelFeatures = [];

  if (!grid || !values) {
    return {
      lines: emptyFeatureCollection(),
      labels: emptyFeatureCollection()
    };
  }

  const nx = grid.nx;
  const ny = grid.ny;

  const levels = [];
  for (let lv = 990; lv <= 1030; lv += 2) levels.push(lv);

  const segmentsByLevel = {};

  for (const level of levels) {
    segmentsByLevel[level] = [];

    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const c00 = j * nx + i;
        const c10 = j * nx + i + 1;
        const c11 = (j + 1) * nx + i + 1;
        const c01 = (j + 1) * nx + i;

        const v00 = values[c00];
        const v10 = values[c10];
        const v11 = values[c11];
        const v01 = values[c01];

        if (
          !Number.isFinite(v00) || !Number.isFinite(v10) ||
          !Number.isFinite(v11) || !Number.isFinite(v01)
        ) {
          continue;
        }

        const p00 = [grid.lon[c00], grid.lat[c00]];
        const p10 = [grid.lon[c10], grid.lat[c10]];
        const p11 = [grid.lon[c11], grid.lat[c11]];
        const p01 = [grid.lon[c01], grid.lat[c01]];

        const pts = [];

        function cross(a, b) {
          return (a <= level && b > level) || (a > level && b <= level);
        }

        if (cross(v00, v10)) pts.push(contourInterp(p00, p10, v00, v10, level));
        if (cross(v10, v11)) pts.push(contourInterp(p10, p11, v10, v11, level));
        if (cross(v11, v01)) pts.push(contourInterp(p11, p01, v11, v01, level));
        if (cross(v01, v00)) pts.push(contourInterp(p01, p00, v01, v00, level));

        if (pts.length === 2) {
          segmentsByLevel[level].push({ p0: pts[0], p1: pts[1] });
        } else if (pts.length === 4) {
          segmentsByLevel[level].push({ p0: pts[0], p1: pts[1] });
          segmentsByLevel[level].push({ p0: pts[2], p1: pts[3] });
        }
      }
    }
  }

  const labelCandidates = [];

  for (const level of levels) {
    const segments = segmentsByLevel[level] || [];
    const polylines = stitchContourSegments(segments);

    for (const line of polylines) {
      if (!line || line.length < 2) continue;

      lineFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: line
        },
        properties: {
          level,
          label: String(level)
        }
      });

      const cands = labelCandidatesFromPolyline(line, level);

      for (const cand of cands) {
        if (cand) labelCandidates.push(cand);
      }
    }
  }

  for (const f of selectPressureLabels(labelCandidates)) {
    labelFeatures.push(f);
  }

  return {
    lines: {
      type: "FeatureCollection",
      features: lineFeatures
    },
    labels: {
      type: "FeatureCollection",
      features: labelFeatures
    }
  };
}

function updatePressureContours(values) {
  if (currentModel !== "wrf" || scalarVariableForCurrentView() !== "slp" || !scalarVisibleForCurrentView()) {
    clearPressureContours();
    return;
  }

  ensurePressureContourLayers();

  const lineSrc = map.getSource("pressure-contours-line-src");
  const labelSrc = map.getSource("pressure-contours-label-src");

  if (!lineSrc || !labelSrc) return;

  const geo = buildPressureContourGeoJSON(values);

  lineSrc.setData(geo.lines);
  labelSrc.setData(geo.labels);

  /*
   * Render labels as DOM elements.
   * MapLibre symbol text can fail when the style has no glyphs.
   */
  pressureLabelFeatures = geo.labels && geo.labels.features ? geo.labels.features : [];
  renderPressureDomLabels();

  try {
    if (map.getLayer("pressure-contours-line")) {
      map.moveLayer("pressure-contours-line");
    }
    if (map.getLayer("pressure-contours-label")) {
      map.moveLayer("pressure-contours-label");
    }
  } catch (err) {
    console.warn("pressure contour layer ordering failed:", err);
  }
}

function updateLegend() {
  if (!els.legendBox || !meta || !meta.variables) return;

  const varName = legendVariableForCurrentView();

  if (!varName) {
    els.legendBox.style.display = "none";
    return;
  }

  const vm = meta.variables[varName];

  if (!vm) {
    els.legendBox.style.display = "none";
    return;
  }

  els.legendBox.style.display = "block";

  const vmin = Number(vm.vmin);
  const vmax = Number(vm.vmax);
  const vmid = 0.5 * (vmin + vmax);
  const unit = vm.unit ? ` [${vm.unit}]` : "";

  els.legendBox.innerHTML =
    `<div class="legend-title">${vm.label}${unit}</div>` +
    `<div style="height:16px;border-radius:5px;margin:8px 0 5px;background:${legendGradientCss(vm.cmap)};"></div>` +
    `<div class="legend-ticks">` +
    `<span>${fmtLegendNumber(vmin, 1)}</span>` +
    `<span>${fmtLegendNumber(vmid, 1)}</span>` +
    `<span>${fmtLegendNumber(vmax, 1)}</span>` +
    `</div>`;
}

function updateTimeLabel() {
  const f = meta.frames[currentFrame];
  els.timeLabel.textContent = f ? (f.label || f.time_utc || "--") : "--";
}

function stopPlay() {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }

  els.playBtn.textContent = "Play";
}

function startPlay() {
  stopPlay();

  els.playBtn.textContent = "Pause";

  playTimer = setInterval(() => {
    const n = frameCount();

    if (n <= 0) return;

    setFrame((currentFrame + 1) % n);
  }, 700);
}

function togglePlay() {
  if (playTimer === null) startPlay();
  else stopPlay();
}

function setBasemap(name) {
  if (!map) return;

  if (name === "satellite") {
    if (map.getLayer("carto-light")) {
      map.setLayoutProperty("carto-light", "visibility", "none");
    }
    if (map.getLayer("esri-satellite")) {
      map.setLayoutProperty("esri-satellite", "visibility", "visible");
    }
  } else {
    if (map.getLayer("carto-light")) {
      map.setLayoutProperty("carto-light", "visibility", "visible");
    }
    if (map.getLayer("esri-satellite")) {
      map.setLayoutProperty("esri-satellite", "visibility", "none");
    }
  }

  try {
    if (map.getLayer("mohid-custom-layer")) {
      map.moveLayer("mohid-custom-layer");
    }
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
  const viewLon = Number(urlParams.get("lon"));
  const viewLat = Number(urlParams.get("lat"));
  const viewZoom = Number(urlParams.get("z"));

  const hasUrlView =
    Number.isFinite(viewLon) &&
    Number.isFinite(viewLat) &&
    Number.isFinite(viewZoom);

  map = new maplibregl.Map({
    container: "map",
    style: makeMapStyle(),
    center: hasUrlView ? [viewLon, viewLat] : [125.2, 36.2],
    zoom: hasUrlView ? viewZoom : 5.4,
    minZoom: 3,
    maxZoom: 12,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    attributionControl: true
  });

  /*
   * First entry: fit to default/current model.
   * Model switch: no page reload, so this does not run again.
   */
  if (!hasUrlView) {
    map.fitBounds(
      [
        [meta.grid.lon_min, meta.grid.lat_min],
        [meta.grid.lon_max, meta.grid.lat_max]
      ],
      { padding: 30, duration: 0 }
    );
  }
}

function bindEvents() {
  if (els.modelSelect) {
    els.modelSelect.addEventListener("change", () => {
      const model = els.modelSelect.value || "mohid";
      switchModel(model);
    });
  }

  els.varSelect.addEventListener("change", () => {
    currentVar = els.varSelect.value;
    resetViewTransientState();
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
        startParticles();
      } else {
        stopParticles();
      }
    });
  }


  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener("change", () => setBasemap(r.value));
  });

  if (map && !map.__mohidParticleViewEventsBound) {
    map.__mohidParticleViewEventsBound = true;

    const refreshParticlesForView = () => {
      if (!currentU || !currentV || !grid) return;
      if (els.currentOverlay && !els.currentOverlay.checked) return;

      /*
       * Recalculate particles after pan/zoom.
       * This clears old view particles and reseeds particles inside the new map bounds.
       */
      resetParticles();
      startParticles();
      map.triggerRepaint();
    };

    map.on("moveend", refreshParticlesForView);
    map.on("zoomend", refreshParticlesForView);
  }
}

async function boot() {
  try {
    configureModelControls();
    setStatus("Loading metadata...");

    meta = await fetchJson(DATA_ROOT + "meta.json");

    els.frameSlider.max = String(frameCount() - 1);
    els.frameSlider.value = "0";

    initMap();

    map.on("load", async () => {
      setStatus(`Loading ${MODEL_DEFS[currentModel].label} grid...`);

      await loadGrid();

      map.addLayer(makeMohidLayer());
      ensureSamplePointLayer();

      bindEvents();
      bindPointTimeseriesEvents();
      bindPressureLabelEvents();
      updateLegend();
      updateTimeLabel();

      await setFrame(0);
      preloadPointTimeseriesFiles();

      setStatus(
        `Ready
` +
        `${MODEL_DEFS[currentModel].label} ${meta.cycle}
` +
        `${grid.validCells} cells
` +
        `particles ${particles.length} / vertices ${particleDrawVertexCount}`
      );
    });
  } catch (err) {
    console.error(err);
    setStatus("ERROR:\n" + err.message);
  }
}

boot();
