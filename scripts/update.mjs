// Fetch new data from the Ministry of Agriculture open-data API into store/.
// Newest days first; stops when the time budget is used up and resumes next run.
import fs from 'node:fs';
import path from 'node:path';
import {STORE, BASE, DAY, todayTW, iso, rocDot, rocCompact, slash, parseRoc, parseSlash, mondayOf,
  readJSON, writeJSON, makeFetcher, FISH_MARKETS, POULTRY_APIS} from './lib.mjs';

const DAYS_BACK = +(process.env.DAYS_BACK || 400);
const BUDGET_MS = +(process.env.TIME_BUDGET_MIN || 45) * 60000;
const RECENT = 3;            // always refetch the last few days (late or corrected data)
const T0 = Date.now();
const TODAY = todayTW();
const {getJSON, stats} = makeFetcher({concurrency: +(process.env.CONCURRENCY || 4)});
const outOfTime = () => Date.now() - T0 > BUDGET_MS;
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const num = v => { const x = +v; return isFinite(x) ? x : 0; };
let written = 0;
const save = (f, d) => { if (writeJSON(f, d)) written++; };
const exists = f => fs.existsSync(f);

/* ---------- 蔬果批發：one request per day ---------- */
async function farmDay(t){
  const url = `${BASE}/Service/OpenData/FromM/FarmTransData.aspx?StartDate=${rocDot(t)}&EndDate=${rocDot(t)}&$top=20000`;
  const j = await getJSON(url);
  if (!Array.isArray(j) || (j.length === 1 && !j[0]['交易日期'])) throw new Error('unexpected farm response');
  const rows = j.filter(r => r['作物名稱'] && r['作物名稱'] !== '休市' && (r['種類代碼']==='N04' || r['種類代碼']==='N05') && parseRoc(r['交易日期'])===t)
    .map(r => [r['作物名稱'], r['種類代碼']==='N04'?4:5, r['市場名稱'], num(r['上價']), num(r['中價']), num(r['下價']), num(r['平均價']), num(r['交易量'])]);
  if (!rows.length && t >= TODAY - RECENT*DAY) return; // not published yet — try again next run
  save(path.join(STORE,'farm',iso(t).slice(0,4),iso(t)+'.json'), {d: iso(t), rows});
}

/* ---------- 毛豬：one request per day ---------- */
async function porkDay(t){
  const j = await getJSON(`${BASE}/api/v1/PorkTransType/?TransDate=${rocCompact(t)}`);
  if (!j || j.RS !== 'OK' || !Array.isArray(j.Data)) throw new Error('unexpected pork response');
  const rows = j.Data.filter(r => parseRoc(r.TransDate)===t && num(r.TransNum_Total) > 0).map(r => [r.MarketName, num(r.TransNum_Total), num(r.TransNum_AvgPrice)]);
  if (!rows.length && t >= TODAY - RECENT*DAY) return;
  save(path.join(STORE,'pork',iso(t).slice(0,4),iso(t)+'.json'), {d: iso(t), rows});
}

/* ---------- 漁產：per market per week (non-members only get the first 1,000 rows) ---------- */
async function fishRange(market, a, b){
  const j = await getJSON(`${BASE}/api/v1/FisheryProductsTransType/?Start_time=${rocCompact(a)}&End_time=${rocCompact(b)}&MarketName=${encodeURIComponent(market)}`);
  if (!j || j.RS !== 'OK') throw new Error('fish: '+(j && (j.MSG||j.RS)));
  if (j.Next && b > a){ const mid = a + Math.floor((b-a)/DAY/2)*DAY; return [...await fishRange(market, a, mid), ...await fishRange(market, mid+DAY, b)]; }
  return (j.Data||[]).filter(r => r.SeafoodProdName && r.SeafoodProdName !== '休市' && num(r.Trans_Quantity) > 0)
    .map(r => [iso(parseRoc(r.TransDate)), r.SeafoodProdName.trim(), r.MarketName, num(r.Upper_Price), num(r.Middle_Price), num(r.Lower_Price), num(r.Avg_Price), num(r.Trans_Quantity)]);
}
async function fishWeek(w){
  const end = Math.min(w + 6*DAY, TODAY);
  const parts = await Promise.all(FISH_MARKETS.map(m => fishRange(m, w, end).catch(e => { log('fish', m, iso(w), e.message); return null; })));
  if (parts.some(p => p === null)) throw new Error('fish week incomplete');
  save(path.join(STORE,'fish',iso(w).slice(0,4),iso(w)+'.json'), {from: iso(w), to: iso(end), rows: parts.flat()});
}

/* ---------- 產地價：bulk latest rows daily, per-product backfill once ---------- */
async function originUpdate(){
  const dir = path.join(STORE,'origin');
  const byMonth = new Map();
  const add = rows => { for (const r of rows){ const t = Date.UTC(+r.YEAR, +r.MONTH-1, +r.PERIOD); const v = num(r.AVGPRICE); if (!(v>0) || !isFinite(t) || t < TODAY - (DAYS_BACK+40)*DAY) continue;
    const k = iso(t).slice(0,7); if (!byMonth.has(k)) byMonth.set(k, new Map()); byMonth.get(k).set(iso(t)+'|'+r.PRODUCTNAME, [iso(t), r.PRODUCTNAME, v]); } };
  const bulk = await getJSON(`${BASE}/Service/OpenData/TransService.aspx?UnitId=WVOiWSdDjWxx&IsTransData=1&ORGNAME=${encodeURIComponent('當日平均價')}`);
  if (!Array.isArray(bulk)) throw new Error('unexpected origin response');
  add(bulk);
  const state = readJSON(path.join(dir,'state.json'), {backfilled:false});
  if (!state.backfilled){
    const names = [...new Set(bulk.map(r => r.PRODUCTNAME))];
    log('origin backfill for', names.length, 'products');
    const res = await Promise.all(names.map(n => getJSON(`${BASE}/Service/OpenData/TransService.aspx?UnitId=WVOiWSdDjWxx&IsTransData=1&PRODUCTNAME=${encodeURIComponent(n)}&ORGNAME=${encodeURIComponent('當日平均價')}`).catch(()=>null)));
    res.forEach(j => Array.isArray(j) && add(j.filter(r => r.ORGNAME === '當日平均價')));
    if (res.every(Boolean)) state.backfilled = true;
  }
  for (const [k, m] of byMonth){
    const f = path.join(dir, k+'.json');
    const old = readJSON(f, {rows:[]});
    const merged = new Map(old.rows.map(r => [r[0]+'|'+r[1], r]));
    for (const [kk, r] of m) merged.set(kk, r);
    save(f, {month: k, rows: [...merged.values()].sort((a,b)=> a[0]<b[0]?-1:a[0]>b[0]?1:(a[1]<b[1]?-1:1))});
  }
  save(path.join(dir,'state.json'), state);
}

/* ---------- 家禽與蛋：one range request per API ---------- */
async function poultryUpdate(api){
  const j = await getJSON(`${BASE}/api/v1/${api}/?Start_time=${slash(TODAY-(DAYS_BACK+10)*DAY)}&End_time=${slash(TODAY)}`);
  if (!j || j.RS !== 'OK' || !Array.isArray(j.Data)) throw new Error('unexpected poultry response');
  const f = path.join(STORE,'poultry',api+'.json');
  const old = readJSON(f, {days:{}});
  const acc = {};
  for (const r of j.Data){ const t = parseSlash(r.TransDate); if (!t) continue; const d = iso(t);
    for (const [k,v] of Object.entries(r)){ if (k==='TransDate'||k==='LunarCalendar') continue; const x = parseFloat(v); if (!(x>0)) continue;
      const a = ((acc[d] ||= {})[k] ||= [0,0]); a[0]+=x; a[1]++; } }
  const days = {...old.days};
  for (const [d, o] of Object.entries(acc)) days[d] = Object.fromEntries(Object.entries(o).map(([k,[s,n]]) => [k, Math.round(s/n*100)/100]));
  for (const d of Object.keys(days)) if (fromIsoSafe(d) < TODAY - (DAYS_BACK+40)*DAY) delete days[d];
  save(f, {api, days: Object.fromEntries(Object.entries(days).sort())});
}
const fromIsoSafe = d => { const [y,m,dd] = d.split('-').map(Number); return Date.UTC(y,m-1,dd); };

/* ---------- 畜產都市零售（月） ---------- */
async function retailUpdate(){
  const rows = await getJSON(`${BASE}/service/opendata/agrstatUnit.aspx?item_code=CH1130&dimension_group_code_1=CH07&IsTransData=1&UnitId=615`);
  if (!Array.isArray(rows)) throw new Error('unexpected retail response');
  const out = {};
  for (const r of rows){ const d = String(r.date||''); if (!/^\d{5}$/.test(d)) continue; const y = +d.slice(0,3)+1911; if (y < 2016) continue; const v = num(r.value); if (!(v>0)) continue;
    (out[r.dname1] ||= {unit: r.unit, m: []}).m.push([`${y}-${d.slice(3)}`, v]); }
  for (const o of Object.values(out)) o.m.sort((a,b)=> a[0]<b[0]?-1:1);
  save(path.join(STORE,'retail.json'), out);
}

/* ---------- main ---------- */
async function main(){
  log('start; today', iso(TODAY), 'days back', DAYS_BACK, 'base', BASE);
  const small = [originUpdate(), retailUpdate(), ...POULTRY_APIS.map(poultryUpdate)].map(p => p.catch(e => log('small task failed:', e.message)));
  // daily tasks, newest first; skip days already stored unless recent
  const tasks = [];
  for (let i = 0; i < DAYS_BACK; i++){
    const t = TODAY - i*DAY; const y = iso(t).slice(0,4);
    const recent = i < RECENT;
    if (recent || !exists(path.join(STORE,'farm',y,iso(t)+'.json'))) tasks.push(['farm', t]);
    if (recent || !exists(path.join(STORE,'pork',y,iso(t)+'.json'))) tasks.push(['pork', t]);
    if (t === mondayOf(t) || i === 0){ const w = mondayOf(t); const wy = iso(w).slice(0,4);
      if (w >= TODAY - 13*DAY || !exists(path.join(STORE,'fish',wy,iso(w)+'.json'))) tasks.push(['fish', w]); }
  }
  log('queued', tasks.length, 'tasks');
  let done = 0, failed = 0, skipped = 0;
  const workers = Array.from({length: 4}, async () => {
    while (tasks.length){
      if (outOfTime()){ skipped += tasks.length; tasks.length = 0; break; }
      const [kind, t] = tasks.shift();
      try { await ({farm: farmDay, pork: porkDay, fish: fishWeek})[kind](t); done++; }
      catch(e){ failed++; log(kind, iso(t), 'failed:', e.message); }
      if ((done+failed) % 25 === 0) log(`progress ${done} ok, ${failed} failed, ${tasks.length} left`);
    }
  });
  await Promise.all([...workers, ...small]);
  log(`finished: ${done} ok, ${failed} failed, ${skipped} left for next run; ${written} files changed; requests ok ${stats.ok} fail ${stats.fail}`);
  if (stats.ok === 0) { console.error('No request succeeded — the API may be unreachable from this runner.'); process.exitCode = 1; }
}
main();
