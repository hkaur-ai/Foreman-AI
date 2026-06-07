// roasterSim.js
// Deterministic coffee-roaster telemetry generator for the Foreman demo.
// No randomness by default (demo-safe). Field names match the app's telemetry tiles.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (x, lo, hi) => { const t = clamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

const BT_ANCHORS = [
  [0, 200],
  [75, 98],
  [180, 128],
  [330, 152],
  [480, 178],
  [555, 196],
  [640, 202],
  [690, 205],
];

function beanBase(t) {
  t = clamp(t, 0, 690);
  for (let i = 0; i < BT_ANCHORS.length - 1; i++) {
    const [t0, v0] = BT_ANCHORS[i], [t1, v1] = BT_ANCHORS[i + 1];
    if (t >= t0 && t <= t1) return lerp(v0, v1, smooth(t, t0, t1));
  }
  return 205;
}

function normalBurner(t) {
  if (t < 330) return 80;
  if (t < 555) return lerp(80, 60, smooth(t, 330, 555));
  return lerp(60, 48, smooth(t, 555, 690));
}

function phaseOf(bean) { return bean < 150 ? 'drying' : bean < 196 ? 'maillard' : 'development'; }

export function createRoasterSim(opts = {}) {
  const timeScale = opts.timeScale ?? 4;
  const startSec = opts.startSec ?? 540;
  const FAULT_SLOPE = 0.28;

  const s = {
    t: startSec, running: true,
    faultActive: false, faultType: null, faultStart: null, faultLatched: false, fixed: false,
    btOffset: 0,
    setAirflow: 55, setBurner: null,
    scorch: 38,
    status: 'NORMAL', hist: [],
  };

  function beanAt(tq) {
    for (let i = s.hist.length - 1; i >= 0; i--) if (s.hist[i].t <= tq) return s.hist[i].bean;
    return beanBase(clamp(tq, 0, 690));
  }

  function controls() {
    let airflow = s.setAirflow;
    let burner = s.setBurner ?? normalBurner(s.t);
    let etBoost = 0;
    if (s.faultActive && !s.fixed && s.faultType === 'scorch') {
      const fe = s.t - s.faultStart;
      airflow = lerp(s.setAirflow, 18, smooth(fe, 0, 12));
      burner = Math.max(burner, 80);
      etBoost = smooth(fe, 0, 10) * 32;
    }
    return { airflow, burner, etBoost };
  }

  function read() {
    const bean = beanBase(s.t) + s.btOffset;
    const { airflow, burner, etBoost } = controls();
    const grad = lerp(40, 14, smooth(s.t, 75, 690));
    const drum = bean + grad + etBoost;
    const ror = (bean - beanAt(s.t - 25)) / 25 * 60;
    return {
      bean_temp_c: +bean.toFixed(1),
      drum_temp_c: +drum.toFixed(1),
      exhaust_temp_c: +(bean + grad * 0.7 + etBoost).toFixed(1),
      airflow_pct: Math.round(airflow),
      burner_pct: Math.round(burner),
      drum_rpm: 60,
      ror_c_per_min: +ror.toFixed(1),
      roast_phase: phaseOf(bean),
      elapsed_s: Math.round(s.t),
      scorch_index: Math.round(s.scorch),
      status: s.status,
    };
  }

  function tick(realDt = 1) {
    if (!s.running) return read();
    const dt = realDt * timeScale;
    s.t = clamp(s.t + dt, 0, 690);

    if (s.faultActive && !s.fixed && s.faultType === 'scorch') s.btOffset += FAULT_SLOPE * dt;

    s.hist.push({ t: s.t, bean: beanBase(s.t) + s.btOffset });
    if (s.hist.length > 600) s.hist.shift();

    const r = read();

    const over = Math.max(0, r.drum_temp_c - 228);
    const lowAir = r.airflow_pct < 30 ? 1 : 0.2;
    s.scorch = clamp(s.scorch + dt * (0.018 + over * 0.06 * lowAir), 0, 100);

    if (!s.faultActive) s.status = 'NORMAL';
    else if (!s.fixed) { if (isAnomalous(r)) s.faultLatched = true; s.status = s.faultLatched ? 'FAULT' : 'WARNING'; }
    else s.status = (r.ror_c_per_min < 8 && r.airflow_pct > 40) ? 'RECOVERED' : 'RECOVERING';

    return read();
  }

  function injectFault(type = 'scorch') {
    s.faultActive = true; s.faultType = type; s.faultStart = s.t; s.fixed = false; s.faultLatched = false;
  }

  function applyFix({ airflow = 60, burner = 46 } = {}) {
    s.setAirflow = airflow; s.setBurner = burner; s.fixed = true;
  }

  return { tick, read, injectFault, applyFix, _state: s };
}

export function isAnomalous(r) {
  return r.airflow_pct < 30 && r.ror_c_per_min > 20;
}
