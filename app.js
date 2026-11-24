'use strict';
/* =========================================================
 * 原付ナビ (プロトタイプ)
 *  - ルート検索: Valhalla motor_scooter (高速・自動車専用道路を回避)
 *  - 二段階右折の推定: 進入路の車線数 >= 3 の右折
 *  - GPS ナビ / 音声案内 / 速度超過警告 / オートリルート
 *  - 近くのガソリンスタンド (Overpass) / 走行ログ
 * ========================================================= */

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const VEHICLES = {
  class1: { short: '一種', limit: 30, topSpeed: 30, twoStage: true },
  class2: { short: '二種', limit: 60, topSpeed: 60, twoStage: false },
};

const OFF_ROUTE_M = 40;        // ルート逸脱判定距離
const ARRIVE_M = 25;           // 到着判定距離
const REROUTE_INTERVAL = 10000;

const $ = (id) => document.getElementById(id);

/* ---------- 設定 ---------- */
const DEFAULT_SETTINGS = { vehicle: 'class1', usePrimary: 0.3, useHills: 0.5, voice: true, speedWarn: true, simMul: 4 };
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('gn.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() { localStorage.setItem('gn.settings', JSON.stringify(state.settings)); }
const vehicle = () => VEHICLES[state.settings.vehicle];

const state = {
  settings: loadSettings(),
  pos: null,          // 最新の現在地 {lat, lon, speed(m/s), heading, acc, t}
  origin: null,       // 明示的に指定された出発地 (null = 現在地)
  dest: null,         // {lat, lon, name}
  route: null,
  follow: true,
  nav: null,          // ナビ中の状態
};

/* ---------- 地図 ---------- */
// 大阪周辺 (関西中心部) をメインに使う前提の設定
const HOME_AREA = { center: [34.7025, 135.4959], // 大阪駅
  // 検索対象範囲: 神戸〜京都〜奈良〜和歌山北部
  viewbox: { west: 134.95, north: 35.10, east: 136.10, south: 34.20 } };

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(HOME_AREA.center, 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  updateWhenIdle: true, keepBuffer: 1, // 移動中のタイル読み込みを減らして通信量を節約
}).addTo(map);

const layers = {
  route: L.layerGroup().addTo(map),
  marks: L.layerGroup().addTo(map),
  fuel: L.layerGroup().addTo(map),
  track: L.polyline([], { color: '#ff7a00', weight: 4, opacity: 0.7 }).addTo(map),
};
let userMarker = null;

function pinIcon(emoji) { return L.divIcon({ className: '', html: `<div class="pin">${emoji}</div>`, iconSize: [30, 30], iconAnchor: [15, 28] }); }

function updateUserMarker(p) {
  const hasHeading = p.heading != null && !isNaN(p.heading);
  const html = hasHeading
    ? `<div class="user-arrow" style="transform:rotate(${p.heading}deg)"><div></div></div>`
    : '<div class="user-dot"></div>';
  const icon = L.divIcon({ className: '', html, iconSize: hasHeading ? [34, 34] : [18, 18] });
  if (!userMarker) userMarker = L.marker([p.lat, p.lon], { icon, zIndexOffset: 1000, interactive: false }).addTo(map);
  else { userMarker.setLatLng([p.lat, p.lon]); userMarker.setIcon(icon); }
}

map.on('dragstart', () => { if (state.nav) { state.follow = false; $('btnLocate').classList.add('off'); } });

/* ---------- 汎用 ---------- */
const R = 6371000;
const toRad = (d) => d * Math.PI / 180;
function dist(a, b) { // a,b = [lat, lon]
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// 点 p から線分 a-b への投影 (平面近似)
function project(p, a, b) {
  const k = Math.cos(toRad(p[0]));
  const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, q, d: dist(p, q) };
}
function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0; const out = [];
  while (index < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push([lat / factor, lng / factor]);
  }
  return out;
}
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + 'km' : (Math.round(m / 10) * 10) + 'm'; }
function fmtDur(sec) { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`; }
function fmtClock(d) { return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- 音声 ---------- */
let jaVoice = null;
function pickVoice() { jaVoice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('ja')) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, interrupt = false) {
  if (!state.settings.voice || !('speechSynthesis' in window) || !text) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP'; if (jaVoice) u.voice = jaVoice; u.rate = 1.05;
  speechSynthesis.speak(u);
}

/* ---------- 画面スリープ防止 ---------- */
let wakeLock = null;
async function lockScreen() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 非対応 */ } }
document.addEventListener('visibilitychange', () => { if (state.nav && document.visibilityState === 'visible') lockScreen(); });

/* ---------- 位置情報 ---------- */
let lastFix = null;
function handleGeo(gp) {
  const c = gp.coords;
  const p = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, t: gp.timestamp };
  // speed/heading が取れない端末向けに前回位置から算出
  // 精度の良い位置を取得済みなら、後から届いた粗い位置 (Wi-Fi/基地局測位) で上書きしない
  if (lastFix && p.acc > 100 && p.acc > lastFix.acc * 2 && p.t - lastFix.t < 15000) return;
  if (lastFix && p.acc < 50 && lastFix.acc < 50) { // 粗い位置同士の比較は誤差が大きいので使わない
    const d = dist([lastFix.lat, lastFix.lon], [p.lat, p.lon]);
    const dt = (p.t - lastFix.t) / 1000;
    if ((p.speed == null || isNaN(p.speed)) && dt > 0) p.speed = d / dt;
    if ((p.heading == null || isNaN(p.heading)) && d > 3) p.heading = bearing([lastFix.lat, lastFix.lon], [p.lat, p.lon]);
  }
  lastFix = p;
  if (p.acc < 200 && Date.now() - lastSaved > 30000) { // 次回起動時にすぐ表示するため保存
    lastSaved = Date.now();
    localStorage.setItem('gn.lastpos', JSON.stringify({ lat: p.lat, lon: p.lon, t: Date.now() }));
  }
  onPosition(p);
}
let lastSaved = 0;
let geoWatch = null;
function startGeo() {
  if (!('geolocation' in navigator)) { toast('この端末は位置情報に対応していません'); return; }
  if (geoWatch != null) return;
  $('btnLocate').classList.add('seeking');
  // ① まず速い測位 (Wi-Fi・基地局、または端末が直近に測った位置) で即座に表示
  navigator.geolocation.getCurrentPosition(handleGeo, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 });
  // ② 並行して GPS の高精度測位を開始し、届き次第置き換える
  geoWatch = navigator.geolocation.watchPosition(handleGeo, (e) => {
    if (e.code === e.TIMEOUT && state.pos) return; // 粗い位置は取れているので黙って待つ
    $('btnLocate').classList.remove('seeking');
    toast('現在地を取得できません: ' + e.message + '（地図をタップして出発地を指定できます）', 4000);
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
}
let centeredOnce = false;

// 前回の位置を起動直後に表示 (測位が終わるまでの仮表示)
(function showLastKnown() {
  try {
    const lp = JSON.parse(localStorage.getItem('gn.lastpos') || 'null');
    if (lp && Date.now() - lp.t < 7 * 86400000) map.setView([lp.lat, lp.lon], 16);
  } catch { /* 無視 */ }
})();

let accCircle = null;
function onPosition(p) {
  state.pos = p;
  updateUserMarker(p);
  // 精度の円 (粗い位置のときだけ表示)
  const coarse = p.acc != null && p.acc > 30;
  $('btnLocate').classList.toggle('seeking', coarse);
  if (coarse) {
    if (!accCircle) accCircle = L.circle([p.lat, p.lon], { radius: p.acc, color: '#2f9bff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    else accCircle.setLatLng([p.lat, p.lon]).setRadius(p.acc);
  } else if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
  updateSpeed(p.speed);
  if (!centeredOnce) { centeredOnce = true; if (!state.route) map.setView([p.lat, p.lon], 16); }
  if (state.nav) navStep(p);
}

/* ---------- 速度計 ---------- */
let lastOverSpeak = 0;
function updateSpeed(mps) {
  const kmh = mps == null || isNaN(mps) ? null : mps * 3.6;
  $('speedVal').textContent = kmh == null ? '--' : Math.round(kmh);
  const over = kmh != null && kmh > vehicle().limit + 2;
  $('speedo').classList.toggle('over', over && state.settings.speedWarn);
  if (over && state.settings.speedWarn && state.nav && Date.now() - lastOverSpeak > 30000) {
    lastOverSpeak = Date.now();
    speak(`速度超過です。法定速度は${vehicle().limit}キロです。`);
  }
  if (state.nav && kmh != null) {
    state.nav.log.max = Math.max(state.nav.log.max, kmh);
  }
}

/* ---------- 検索 (Nominatim) ---------- */
function recentList() { try { return JSON.parse(localStorage.getItem('gn.recent') || '[]'); } catch { return []; } }
function addRecent(place) {
  const list = recentList().filter((r) => !(Math.abs(r.lat - place.lat) < 1e-5 && Math.abs(r.lon - place.lon) < 1e-5));
  list.unshift({ name: place.name, sub: place.sub || '', lat: place.lat, lon: place.lon });
  localStorage.setItem('gn.recent', JSON.stringify(list.slice(0, 10)));
}
function showResults(items, head) {
  const box = $('results');
  box.innerHTML = (head ? `<div class="head">${esc(head)}</div>` : '') +
    items.map((r, i) => `<div class="item" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.sub)}</span></div>`).join('');
  box.classList.toggle('hidden', !items.length && !head);
  box.querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => {
    const r = items[+el.dataset.i];
    box.classList.add('hidden'); $('q').blur();
    pickPlace(r);
  }));
}
/* ---------- 自宅・お気に入り ---------- */
function favs() { try { return JSON.parse(localStorage.getItem('gn.favs') || '[]'); } catch { return []; } }
function saveFavs(list) { localStorage.setItem('gn.favs', JSON.stringify(list)); renderFavs(); }
const favLabel = (f) => (f.home ? '🏠 ' : '⭐ ') + f.name;
const samePlace = (a, b) => dist([a.lat, a.lon], [b.lat, b.lon]) < 30;

function setHome(place) {
  saveFavs([{ name: '自宅', home: true, lat: place.lat, lon: place.lon }, ...favs().filter((f) => !f.home)]);
  toast('🏠 自宅を登録しました');
}
function addFavorite(place) {
  const name = (prompt('登録名を入力してください', place.name && place.name !== '指定地点' ? place.name : '') || '').trim();
  if (!name) return false;
  saveFavs([...favs().filter((f) => f.home || !samePlace(f, place)), { name, lat: place.lat, lon: place.lon }]);
  toast(`⭐「${name}」を登録しました`);
  return true;
}
function goFav(f) { setDestination({ name: f.home ? '自宅' : f.name, lat: f.lat, lon: f.lon, fav: true }); }

function renderFavs() {
  const list = favs(), home = list.find((f) => f.home), others = list.filter((f) => !f.home);
  // 検索欄の下のショートカット
  const bar = $('favbar'); bar.innerHTML = '';
  const homeBtn = document.createElement('button');
  homeBtn.textContent = '🏠 自宅';
  if (!home) homeBtn.classList.add('unset');
  homeBtn.onclick = () => home ? goFav(home) : toast('地図で自宅の場所をタップし「🏠 自宅に設定」を選んでください', 4000);
  bar.appendChild(homeBtn);
  for (const f of others) {
    const b = document.createElement('button'); b.textContent = favLabel(f); b.onclick = () => goFav(f); bar.appendChild(b);
  }
  // 設定画面の管理リスト
  const m = $('favManage');
  m.innerHTML = list.length ? '' : '<p class="muted small">まだ登録がありません</p>';
  list.forEach((f) => {
    const row = document.createElement('div'); row.className = 'favrow';
    row.innerHTML = `<span>${esc(favLabel(f))}</span>${f.home ? '' : '<button data-a="ren">名前変更</button>'}<button data-a="del">削除</button>`;
    row.querySelector('[data-a=del]').onclick = () => {
      if (confirm(`「${f.home ? '自宅' : f.name}」を削除しますか？`)) saveFavs(favs().filter((x) => !samePlace(x, f) || x.home !== f.home));
    };
    const ren = row.querySelector('[data-a=ren]');
    if (ren) ren.onclick = () => {
      const name = (prompt('新しい名前', f.name) || '').trim();
      if (name) saveFavs(favs().map((x) => (!x.home && samePlace(x, f) ? { ...x, name } : x)));
    };
    m.appendChild(row);
  });
  updateFavStar();
}
function updateFavStar() {
  const on = !!state.dest && favs().some((f) => samePlace(f, state.dest));
  $('btnFavRoute').textContent = on ? '★' : '☆';
  $('btnFavRoute').classList.toggle('on', on);
}
$('btnFavRoute').onclick = () => {
  if (!state.dest) return;
  const hit = favs().find((f) => samePlace(f, state.dest));
  if (hit) { if (!hit.home && confirm(`「${hit.name}」の登録を解除しますか？`)) saveFavs(favs().filter((f) => f.home || !samePlace(f, hit))); }
  else addFavorite(state.dest);
  updateFavStar();
};

// 検索欄を選んだときは 登録地点 → 最近の目的地 を表示
function quickList() {
  const fl = favs().map((f) => ({ name: favLabel(f), sub: '登録地点', lat: f.lat, lon: f.lon, fav: true, realName: f.home ? '自宅' : f.name }));
  const rl = recentList().filter((r) => !fl.some((f) => samePlace(f, r)));
  return [...fl, ...rl];
}
function showQuick() {
  if (pickingOrigin) { showOriginChoices(); return; }
  const l = quickList(); showResults(l, l.length ? '登録地点・最近の目的地' : '');
}
$('q').addEventListener('focus', () => { if (!$('q').value) showQuick(); });
$('q').addEventListener('input', () => { if (!$('q').value) showQuick(); });

/* ---------- 出発地の指定 ---------- */
let pickingOrigin = false;
function showOriginChoices() {
  showResults([{ name: '📍 現在地', sub: 'GPSの位置から出発', current: true }, ...quickList()], '出発地を選択（または上の欄で検索）');
}
function beginPickOrigin() {
  pickingOrigin = true;
  document.body.classList.add('picking-origin');
  $('q').value = ''; $('q').placeholder = '出発地を検索';
  showOriginChoices();
}
function endPickOrigin() {
  pickingOrigin = false;
  document.body.classList.remove('picking-origin');
  $('q').placeholder = '目的地を検索（施設名・住所）';
  $('q').value = state.dest ? state.dest.name : '';
}
function setOrigin(place) {
  endPickOrigin();
  if (place.current) state.origin = null;
  else state.origin = { name: place.realName || place.name, lat: place.lat, lon: place.lon };
  updateOriginLabel();
  if (state.dest) planRoute(); else { drawEndpoints(); toast('出発地を設定しました。次に目的地を選んでください'); }
}
function updateOriginLabel() { $('originName').textContent = state.origin ? state.origin.name : '現在地'; }
function pickPlace(r) { if (pickingOrigin) setOrigin(r); else setDestination(r); }
$('btnOrigin').onclick = beginPickOrigin;
map.on('click', () => { if (pickingOrigin) endPickOrigin(); });
map.on('click', () => $('results').classList.add('hidden'));

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  showResults([], '検索中…');
  try {
    const vb = HOME_AREA.viewbox;
    const search = async (bounded) => {
      const params = new URLSearchParams({
        format: 'jsonv2', q, countrycodes: 'jp', limit: '8', 'accept-language': 'ja',
        viewbox: `${vb.west},${vb.north},${vb.east},${vb.south}`, bounded: bounded ? '1' : '0',
      });
      return (await fetch(`${NOMINATIM}?${params}`)).json();
    };
    // まず関西圏内だけで検索し、見つからなければ全国へ広げる
    let data = await search(true);
    if (!data.length) data = await search(false);
    const items = data.map((d) => {
      const parts = d.display_name.split(',').map((s) => s.trim());
      return { name: d.name || parts[0], sub: parts.slice(1, 5).reverse().join(' '), lat: +d.lat, lon: +d.lon };
    });
    showResults(items, items.length ? '' : '見つかりませんでした');
  } catch (err) {
    showResults([], '検索に失敗しました: ' + err.message);
  }
});

/* 地図タップで出発地/目的地を指定 */
map.on('contextmenu click', (e) => {
  if (state.nav) return;
  const ll = e.latlng;
  const div = document.createElement('div');
  div.innerHTML = '<b>この地点</b><div class="popup-btns"><button data-a="dest">🏁 ここへ行く</button><button data-a="orig">🛵 ここから出発</button>' +
    '<button data-a="home">🏠 自宅に設定</button><button data-a="fav">⭐ お気に入りに追加</button></div>';
  const popup = L.popup().setLatLng(ll).setContent(div).openOn(map);
  div.querySelector('[data-a=home]').onclick = () => {
    map.closePopup(popup);
    if (!favs().some((f) => f.home) || confirm('自宅の場所をここに変更しますか？')) setHome({ lat: ll.lat, lon: ll.lng });
  };
  div.querySelector('[data-a=fav]').onclick = () => { map.closePopup(popup); addFavorite({ name: '指定地点', lat: ll.lat, lon: ll.lng }); };
  div.querySelector('[data-a=dest]').onclick = () => { map.closePopup(popup); setDestination({ name: '指定地点', lat: ll.lat, lon: ll.lng }); };
  div.querySelector('[data-a=orig]').onclick = () => {
    map.closePopup(popup);
    endPickOrigin();
    state.origin = { name: '指定した出発地', lat: ll.lat, lon: ll.lng };
    updateOriginLabel();
    toast('出発地を設定しました');
    if (state.dest) planRoute(); else drawEndpoints();
  };
});

function setDestination(place) {
  if (place.realName) place = { ...place, name: place.realName };
  state.dest = place;
  if (place.name !== '指定地点' && !place.fav) addRecent(place);
  $('q').value = place.name;
  updateFavStar();
  if (state.nav) { reroute(state.pos, true); return; }
  planRoute();
}

/* ---------- ルート探索 (Valhalla) ---------- */
async function valhalla(endpoint, body) {
  // text/plain で送ると CORS プリフライト不要
  const res = await fetch(`${VALHALLA}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchRoute(from, to) {
  const v = vehicle();
  const start = { lat: from.lat, lon: from.lon, type: 'break' };
  if (from.heading != null && !isNaN(from.heading)) { start.heading = Math.round(from.heading); start.heading_tolerance = 60; }
  const data = await valhalla('route', {
    locations: [start, { lat: to.lat, lon: to.lon, type: 'break' }],
    costing: 'motor_scooter',
    costing_options: { motor_scooter: { top_speed: v.topSpeed, use_primary: +state.settings.usePrimary, use_hills: +state.settings.useHills } },
    directions_options: { language: 'ja-JP', units: 'kilometers' },
  });
  const leg = data.trip.legs[0];
  const coords = decodePolyline(leg.shape);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  const route = {
    shape: leg.shape, coords, cum,
    length: cum[cum.length - 1],
    time: data.trip.summary.time,
    maneuvers: leg.maneuvers.map((m) => ({
      ...m,
      instruction: cleanText(m.instruction),
      verbal_pre_transition_instruction: cleanText(m.verbal_pre_transition_instruction),
      verbal_transition_alert_instruction: cleanText(m.verbal_transition_alert_instruction),
      at: cum[m.begin_shape_index], twoStage: false,
    })),
    twoStageChecked: false,
  };
  if (v.twoStage) {
    try { await annotateTwoStage(route); route.twoStageChecked = true; }
    catch (e) { console.warn('二段階右折の判定に失敗', e); }
  }
  return route;
}

// 「東京駅南口/Tokyo Station South Exit」のような多言語併記や路線番号を日本語名だけに整える
function cleanText(t) {
  if (!t) return t;
  return t
    .replace(/\/[^をにでへ。、]*?(?=を|に|で|へ|です|。|、|$)/g, '')
    .replace(/,\s*[^をにでへ。、]*?[A-Za-zāīūēō][^をにでへ。、]*?(?=を|に|で|へ|です|。|、|$)/g, '')
    .replace(/。+/g, '。')
    .trim();
}

const RIGHT_TURNS =new Set([10, 11]); // Valhalla: 10=右折, 11=鋭角右折
/* ルート上の各エッジの車線数を取得し、右折地点の進入路が3車線以上なら二段階右折とみなす */
async function annotateTwoStage(route) {
  const turns = route.maneuvers.filter((m) => RIGHT_TURNS.has(m.type));
  if (!turns.length) return;
  const data = await valhalla('trace_attributes', {
    encoded_polyline: route.shape,
    costing: 'motor_scooter',
    shape_match: 'edge_walk',
    filters: { attributes: ['edge.lane_count', 'edge.road_class', 'edge.names', 'edge.end_shape_index', 'shape'], action: 'include' },
  });
  const tshape = decodePolyline(data.shape);
  const ends = data.edges.map((e) => ({ e, p: tshape[e.end_shape_index] })).filter((x) => x.p);
  for (const m of turns) {
    const P = route.coords[m.begin_shape_index];
    let best = null, bestD = Infinity;
    for (const x of ends) { const d = dist(P, x.p); if (d < bestD) { bestD = d; best = x.e; } }
    if (best && bestD < 15) {
      m.inLanes = best.lane_count || 1;
      m.inRoad = (best.names || [])[0] || '';
      m.twoStage = m.inLanes >= 3;
    }
  }
}

let planSeq = 0;
async function planRoute() {
  const from = state.origin || state.pos;
  if (!from) {
    toast('現在地が未取得です。出発地を選んでください', 4000); drawEndpoints();
    beginPickOrigin(); return;
  }
  const seq = ++planSeq;
  toast('ルート探索中…', 10000);
  try {
    const route = await fetchRoute(from, state.dest);
    if (seq !== planSeq) return;
    state.route = route;
    $('toast').classList.add('hidden');
    drawRoute(true);
    showRoutePanel();
  } catch (e) {
    toast('ルートが見つかりません: ' + e.message, 4000);
  }
}

function drawEndpoints() {
  layers.marks.clearLayers();
  if (state.origin) L.marker([state.origin.lat, state.origin.lon], { icon: pinIcon('🛵') }).addTo(layers.marks);
  if (state.dest) L.marker([state.dest.lat, state.dest.lon], { icon: pinIcon('🏁') }).addTo(layers.marks);
}

function drawRoute(fit) {
  layers.route.clearLayers();
  drawEndpoints();
  const r = state.route; if (!r) return;
  L.polyline(r.coords, { color: '#0d3b73', weight: 11, opacity: 0.9 }).addTo(layers.route);
  L.polyline(r.coords, { color: '#3fa9ff', weight: 6 }).addTo(layers.route);
  for (const m of r.maneuvers) {
    if (!m.twoStage) continue;
    const p = r.coords[m.begin_shape_index];
    L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="ts-marker">2段階</div>', iconSize: [44, 18], iconAnchor: [22, 9] }) })
      .bindPopup(`<b>二段階右折</b><br>${esc(m.inRoad)}（${m.inLanes}車線）<br>${esc(m.instruction)}`).addTo(layers.route);
  }
  if (fit) map.fitBounds(L.latLngBounds(r.coords), { paddingTopLeft: [20, 80], paddingBottomRight: [20, window.innerHeight * 0.55] });
}

const ICONS = { 1: '🛵', 2: '🛵', 3: '🛵', 4: '🏁', 5: '🏁', 6: '🏁', 7: '↑', 8: '↑', 9: '↗', 10: '➡', 11: '↘', 12: '↶', 13: '↶', 14: '↙', 15: '⬅', 16: '↖',
  17: '↑', 18: '↗', 19: '↖', 20: '↗', 21: '↖', 22: '↑', 23: '↗', 24: '↖', 25: '⤵', 26: '⟳', 27: '⟳', 28: '⛴', 29: '⛴', 37: '↗', 38: '↖' };
const iconFor = (m) => ICONS[m.type] || '↑';

function showRoutePanel() {
  updateOriginLabel();
  const r = state.route, v = vehicle();
  const ts = r.maneuvers.filter((m) => m.twoStage).length;
  $('routeSummary').textContent = `${fmtDur(r.time)}  ${fmtDist(r.length)}`;
  $('routeSub').textContent = `${state.origin ? state.origin.name : '現在地'} → ${state.dest.name}　（${v.short}・最高${v.topSpeed}km/h想定）`;
  let warn = '<div class="infobox">🛣 高速道路・自動車専用道路を通らないルートです</div>';
  if (v.twoStage) {
    warn += r.twoStageChecked
      ? (ts ? `<div class="warnbox">⚠ 二段階右折の可能性がある交差点：${ts}か所（地図上の「2段階」）</div>` : '<div class="infobox">✓ 二段階右折が必要そうな交差点はありません</div>')
      : '<div class="warnbox">⚠ 二段階右折の判定ができませんでした。3車線以上の道路での右折に注意してください</div>';
  }
  $('routeWarn').innerHTML = warn;
  const list = $('maneuverList');
  list.innerHTML = r.maneuvers.map((m, i) => `<li data-i="${i}"><span class="mi">${iconFor(m)}</span><span>${esc(m.instruction)}${m.twoStage ? '<br><span class="ts">⚠ 二段階右折</span>' : ''}</span><span class="md">${m.length ? fmtDist(m.length * 1000) : ''}</span></li>`).join('');
  list.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    map.setView(r.coords[r.maneuvers[+li.dataset.i].begin_shape_index], 18);
  }));
  $('routePanel').classList.remove('hidden');
  document.body.classList.add('routing');
}
function hideRoutePanel() { $('routePanel').classList.add('hidden'); document.body.classList.remove('routing'); }

$('btnCloseRoute').onclick = () => {
  hideRoutePanel(); state.route = null; state.dest = null; state.origin = null;
  layers.route.clearLayers(); layers.marks.clearLayers(); $('q').value = '';
};

/* ---------- ナビゲーション ---------- */
function startNav(sim) {
  if (!state.route) return;
  if (!sim && state.origin) {
    const near = state.pos && dist([state.pos.lat, state.pos.lon], [state.origin.lat, state.origin.lon]) < 200;
    if (!near) {
      // 出発地が現在地と離れている → 現在地からのルートに引き直して案内
      if (!state.pos) { toast('現在地が取得できていません。出発地で確認するには「シミュレーション」を使ってください', 4000); return; }
      if (!confirm('指定した出発地は現在地から離れています。現在地からのルートで案内を始めますか？')) return;
      state.origin = null;
      planRoute().then(() => { if (state.route && !state.origin) startNav(false); });
      return;
    }
  }
  hideRoutePanel();
  $('topbar').classList.add('hidden'); $('results').classList.add('hidden');
  document.body.classList.add('navigating');
  $('navBanner').classList.remove('hidden'); $('navBottom').classList.remove('hidden');
  state.follow = true; $('btnLocate').classList.remove('off');
  state.nav = { sim, idx: 0, offCount: 0, lastReroute: 0, announced: new Set(), rerouting: false,
    log: { start: Date.now(), dist: 0, max: 0, last: null, points: [] } };
  layers.track.setLatLngs([]);
  lockScreen();
  map.setZoom(17);
  const first = state.route.maneuvers[0];
  speak('ナビを開始します。' + (first.verbal_pre_transition_instruction || first.instruction || ''), true);
  if (sim) startSim(); else { startGeo(); if (state.pos) navStep(state.pos); }
}

function stopNav(arrived) {
  const nav = state.nav; if (!nav) return;
  if (nav.simTimer) clearInterval(nav.simTimer);
  state.nav = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('navBanner').classList.add('hidden'); $('navBottom').classList.add('hidden'); $('topbar').classList.remove('hidden');
  document.body.classList.remove('navigating');
  $('speedo').classList.remove('over');
  if (arrived) speak('目的地に到着しました。お疲れさまでした。', true); else speechSynthesis?.cancel();
  saveLog(nav.log, arrived);
  layers.route.clearLayers(); layers.marks.clearLayers();
  state.route = null; state.origin = null;
  if (nav.sim) {
    $('speedVal').textContent = '--';
    // シミュレーション後は実際の現在地 (取得済みなら) に戻す
    if (lastFix) onPosition(lastFix);
    else if (userMarker) { map.removeLayer(userMarker); userMarker = null; state.pos = null; }
  }
}

// 現在位置をルートにスナップし、進行距離を求める
function snap(p) {
  const r = state.route, nav = state.nav, P = [p.lat, p.lon];
  const search = (from, to) => {
    let best = { d: Infinity };
    for (let i = from; i < to; i++) {
      const pr = project(P, r.coords[i], r.coords[i + 1]);
      if (pr.d < best.d) best = { d: pr.d, i, s: r.cum[i] + (r.cum[i + 1] - r.cum[i]) * pr.t, q: pr.q };
    }
    return best;
  };
  const n = r.coords.length - 1;
  let best = search(Math.max(0, nav.idx - 3), Math.min(n, nav.idx + 400));
  if (best.d > OFF_ROUTE_M) { const g = search(0, n); if (g.d < best.d) best = g; }
  return best;
}

function navStep(p) {
  const nav = state.nav, r = state.route;
  if (!nav || !r || nav.rerouting) return;

  // 走行ログ
  const log = nav.log;
  if (log.last) log.dist += dist(log.last, [p.lat, p.lon]);
  log.last = [p.lat, p.lon];
  if (!log.points.length || dist(log.points[log.points.length - 1], log.last) > 15) { log.points.push(log.last); layers.track.addLatLng(log.last); }

  const s = snap(p);
  if (s.d > OFF_ROUTE_M && (p.acc == null || p.acc < 60)) nav.offCount++;
  else { nav.offCount = 0; nav.idx = s.i; }

  if (nav.offCount >= 3 && Date.now() - nav.lastReroute > REROUTE_INTERVAL) { reroute(p); return; }

  const along = nav.offCount ? r.cum[nav.idx] : s.s;
  const remain = Math.max(0, r.length - along);
  if (remain < ARRIVE_M || dist([p.lat, p.lon], [state.dest.lat, state.dest.lon]) < ARRIVE_M) { stopNav(true); return; }

  // 次の案内
  const mi = r.maneuvers.findIndex((m, i) => i > 0 && m.at > along + 3);
  const m = r.maneuvers[mi] || r.maneuvers[r.maneuvers.length - 1];
  const to = m.at - along;
  $('navIcon').textContent = iconFor(m);
  $('navDist').textContent = fmtDist(Math.max(0, to));
  $('navText').textContent = m.instruction || '';
  $('navTwoStage').classList.toggle('hidden', !m.twoStage);
  $('navRemain').textContent = fmtDist(remain);
  const speed = vehicle().topSpeed / 3.6 * 0.6; // 信号待ち等を考慮した平均速度
  $('navEta').textContent = fmtClock(new Date(Date.now() + remain / speed * 1000));

  announce(mi, m, to);

  if (state.follow) map.panTo([p.lat, p.lon], { animate: true, duration: 0.5 });
}

const TWO_STAGE_MSG = '二段階右折です。交差点の左端を直進し、向きを変えて信号に従ってください。';
function announce(mi, m, to) {
  const a = state.nav.announced;
  const prevGap = mi > 0 ? m.at - state.route.maneuvers[mi - 1].at : Infinity;
  if (to <= 300 && to > 150 && prevGap > 350 && !a.has(mi + 'f')) {
    a.add(mi + 'f');
    speak(`およそ300メートル先、${m.verbal_transition_alert_instruction || m.instruction}` + (m.twoStage ? '。' + TWO_STAGE_MSG : ''));
  }
  if (to <= 80 && !a.has(mi + 'n')) {
    a.add(mi + 'n'); a.add(mi + 'f');
    speak((m.twoStage ? 'まもなく' + TWO_STAGE_MSG : '') + (m.verbal_pre_transition_instruction || m.instruction), true);
  }
}

async function reroute(p, manual) {
  const nav = state.nav; if (!nav || !p) return;
  nav.rerouting = true; nav.lastReroute = Date.now();
  $('navBanner').classList.add('reroute'); $('navText').textContent = 'ルートを再探索しています…'; $('navTwoStage').classList.add('hidden');
  if (!manual) speak('ルートを外れました。再探索します。', true);
  try {
    state.route = await fetchRoute(p, state.dest);
    nav.idx = 0; nav.offCount = 0; nav.announced = new Set();
    drawRoute(false);
  } catch (e) {
    toast('再探索に失敗しました: ' + e.message, 4000);
  } finally {
    nav.rerouting = false;
    $('navBanner').classList.remove('reroute');
    if (state.nav) navStep(p);
  }
}

/* シミュレーション: ルートに沿って仮想走行 */
function pointAt(s) {
  const r = state.route; let lo = 0, hi = r.cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= s) lo = mid; else hi = mid; }
  const seg = r.cum[hi] - r.cum[lo] || 1, t = Math.min(1, Math.max(0, (s - r.cum[lo]) / seg));
  const a = r.coords[lo], b = r.coords[hi];
  return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, heading: bearing(a, b) };
}
function startSim() {
  const nav = state.nav, TICK = 500;
  let s = 0, route = state.route;
  nav.simTimer = setInterval(() => {
    if (!state.nav) return;
    if (state.route !== route) { route = state.route; s = 0; }
    const v = vehicle().topSpeed / 3.6;
    // カーブ手前は減速する簡易モデル
    const next = route.maneuvers.find((m, i) => i > 0 && m.at > s);
    const slow = next && next.at - s < 40 && next.type >= 9 && next.type <= 16 ? 0.45 : 1;
    s = Math.min(route.length, s + v * slow * (TICK / 1000) * state.settings.simMul);
    const pt = pointAt(s);
    onPosition({ ...pt, speed: v * slow, acc: 5, t: Date.now() });
  }, TICK);
}

$('btnStart').onclick = () => startNav(false);
$('btnSim').onclick = () => startNav(true);
$('btnStop').onclick = () => stopNav(false);

/* ---------- 現在地ボタン ---------- */
$('btnLocate').onclick = () => {
  state.follow = true; $('btnLocate').classList.remove('off');
  if (state.pos) map.setView([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 16));
  else startGeo();
};

/* ---------- 近くのガソリンスタンド (Overpass) ---------- */
$('btnFuel').onclick = async () => {
  if (layers.fuel.getLayers().length) { layers.fuel.clearLayers(); return; }
  const c = map.getCenter();
  toast('ガソリンスタンドを検索中…', 10000);
  const q = `[out:json][timeout:20];nwr["amenity"="fuel"](around:3000,${c.lat},${c.lng});out center 40;`;
  try {
    const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const data = await res.json();
    $('toast').classList.add('hidden');
    if (!data.elements.length) { toast('半径3km以内に見つかりませんでした'); return; }
    for (const el of data.elements) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const name = el.tags?.name || el.tags?.brand || 'ガソリンスタンド';
      const div = document.createElement('div');
      div.innerHTML = `<b>${esc(name)}</b>${el.tags?.opening_hours ? '<br><span>' + esc(el.tags.opening_hours) + '</span>' : ''}<div class="popup-btns"><button>⛽ ここへ行く</button></div>`;
      div.querySelector('button').onclick = () => { map.closePopup(); layers.fuel.clearLayers(); setDestination({ name, lat, lon }); };
      L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="fuel-marker">⛽</div>', iconSize: [24, 24] }) })
        .bindPopup(div).addTo(layers.fuel);
    }
    toast(`${data.elements.length}件見つかりました（もう一度押すと消えます）`);
  } catch (e) { toast('検索に失敗しました: ' + e.message, 4000); }
};

/* ---------- 走行ログ ---------- */
function saveLog(log, arrived) {
  const mins = (Date.now() - log.start) / 60000;
  const entry = { start: log.start, dist: log.dist, mins, max: log.max, dest: state.dest?.name || '', arrived };
  const logs = JSON.parse(localStorage.getItem('gn.logs') || '[]');
  logs.unshift(entry); localStorage.setItem('gn.logs', JSON.stringify(logs.slice(0, 30)));
  if (log.dist > 50) showLog(entry);
}
function statsHtml(e) {
  const avg = e.mins > 0 ? e.dist / 1000 / (e.mins / 60) : 0;
  return `<div class="stat"><div>走行距離<b>${(e.dist / 1000).toFixed(1)} km</b></div><div>走行時間<b>${Math.round(e.mins)} 分</b></div>
    <div>平均速度<b>${avg.toFixed(0)} km/h</b></div><div>最高速度<b>${e.max.toFixed(0)} km/h</b></div></div>`;
}
function showLog(entry) {
  $('logTitle').textContent = entry.arrived ? '到着しました 🏁' : 'ナビを終了しました';
  $('logBody').innerHTML = `<p>${esc(entry.dest)}</p>` + statsHtml(entry);
  $('logModal').classList.remove('hidden');
}
$('btnLogs').onclick = () => {
  const logs = JSON.parse(localStorage.getItem('gn.logs') || '[]');
  $('logTitle').textContent = '走行ログ';
  $('logBody').innerHTML = logs.length ? logs.map((e) => {
    const d = new Date(e.start);
    return `<div class="logrow"><b>${d.getMonth() + 1}/${d.getDate()} ${fmtClock(d)}</b> → ${esc(e.dest)}<br>${(e.dist / 1000).toFixed(1)}km・${Math.round(e.mins)}分・最高${e.max.toFixed(0)}km/h</div>`;
  }).join('') : '<p class="muted">まだ記録がありません</p>';
  $('settingsModal').classList.add('hidden'); $('logModal').classList.remove('hidden');
};
$('btnCloseLog').onclick = () => $('logModal').classList.add('hidden');

/* ---------- 設定画面 ---------- */
function applySettingsUI() {
  const s = state.settings, v = vehicle();
  $('setVehicle').value = s.vehicle; $('setPrimary').value = s.usePrimary; $('setHills').value = s.useHills;
  $('setVoice').checked = s.voice; $('setSpeedWarn').checked = s.speedWarn; $('setSim').value = String(s.simMul);
  $('vehicleChip').textContent = `${v.short} ${v.limit}`;
  $('speedLimit').textContent = v.limit;
}
$('btnSettings').onclick = () => $('settingsModal').classList.remove('hidden');
$('btnCloseSettings').onclick = () => {
  const s = state.settings, before = JSON.stringify([s.vehicle, s.usePrimary, s.useHills]);
  s.vehicle = $('setVehicle').value; s.usePrimary = +$('setPrimary').value; s.useHills = +$('setHills').value;
  s.voice = $('setVoice').checked; s.speedWarn = $('setSpeedWarn').checked; s.simMul = +$('setSim').value;
  saveSettings(); applySettingsUI();
  $('settingsModal').classList.add('hidden');
  if (state.route && !state.nav && before !== JSON.stringify([s.vehicle, s.usePrimary, s.useHills])) planRoute();
};
for (const id of ['settingsModal', 'logModal']) $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.add('hidden'); });

/* ---------- 起動 ---------- */
applySettingsUI();
renderFavs();
startGeo();
// アプリ本体と一度見た地図をスマホに保存し、2回目以降の通信量と表示時間を減らす
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
