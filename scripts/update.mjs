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
  const TS = `${BASE}/Service/OpenData/TransService.aspx?UnitId=WVOiWSdDjWxx&IsTransData=1`;
  const avgName = encodeURIComponent('當日平均價');
  const [bulkAvg, bulkAll] = await Promise.all([getJSON(`${TS}&ORGNAME=${avgName}`).catch(()=>null), getJSON(TS).catch(()=>null)]);
  if (!Array.isArray(bulkAvg) && !Array.isArray(bulkAll)) throw new Error('unexpected origin response');
  const bulks = [bulkAvg, bulkAll].filter(Array.isArray);
  bulks.forEach(j => add(j.filter(r => r.ORGNAME === '當日平均價')));
  const state = readJSON(path.join(dir,'state.json'), {});
  const done = new Set(state.done || []);
  const names = [...new Set(bulks.flat().map(r => r.PRODUCTNAME).filter(Boolean))].filter(n => !done.has(n));
  if (names.length){
    const batch = names.slice(0, 60);
    log('origin backfill', batch.length, 'of', names.length, 'products');
    const res = await Promise.all(batch.map(n => getJSON(`${TS}&PRODUCTNAME=${encodeURIComponent(n)}&ORGNAME=${avgName}`).then(j => [n,j]).catch(()=>[n,null])));
    for (const [n, j] of res) if (Array.isArray(j)){ add(j.filter(r => r.ORGNAME === '當日平均價' && r.PRODUCTNAME === n)); done.add(n); }
  }
  state.done = [...done].sort();
  for (const [k, m] of byMonth){
    const f = path.join(dir, k+'.json');
    const old = readJSON(f, {rows:[]});
    const merged = new Map(old.rows.map(r => [r[0]+'|'+r[1], r]));
    for (const [kk, r] of m) merged.set(kk, r);
    save(f, {month: k, rows: [...merged.values()].sort((a,b)=> a[0]<b[0]?-1:a[0]>b[0]?1:(a[1]<b[1]?-1:1))});
  }
  save(path.join(dir,'state.json'), {done: state.done});
}

/* ---------- 家禽與蛋：one range request per API ---------- */
async function poultryUpdate(api){
  const j = await getJSON(`${BASE}/api/v1/${api}/?Start_time=${slash(TODAY-(DAYS_BACK+10)*DAY)}&End_time=${slash(TODAY)}`);
  if (!j || j.RS !== 'OK' || !Array.isArray(j.Data)) throw new Error('unexpected poultry response');
  const f = path.join(STORE,'poultry',api+'.json');
  const old = readJSON(f, {days:{}});
  // The API sometimes returns two rows for a date (e.g. one with egg_Price only and a different value).
  // Keep the most complete row for each date instead of averaging them.
  const best = {};
  for (const r of j.Data){ const t = parseSlash(r.TransDate); if (!t) continue; const d = iso(t);
    const vals = {}; for (const [k,v] of Object.entries(r)){ if (k==='TransDate'||k==='LunarCalendar') continue; const x = parseFloat(v); if (x>0) vals[k] = x; }
    const n = Object.keys(vals).length; if (!best[d] || n > best[d].n) best[d] = {n, vals}; }
  const days = {...old.days};
  for (const [d, o] of Object.entries(best)) days[d] = o.vals;
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

/* ---------- 台北市公有零售市場行情（月，元/台斤）：data.taipei ---------- */
const TPE_BASE = process.env.TPE_BASE || 'https://data.taipei';
const TPE_DATASET = '54d9d492-1e2e-40d1-ae7b-fbce6f271bf1';
async function tpeUpdate(){
  const v = await getJSON(`${TPE_BASE}/api/frontstage/tpeod/dataset.view?id=${TPE_DATASET}`);
  const res = (v && v.payload && v.payload.resources) || [];
  for (const r of res){
    const m = String(r.name||'').match(/(\d{2,3})年(\d{1,2})月/); if (!m) continue;
    const ym = `${+m[1]+1911}-${pad2(m[2])}`;
    const f = path.join(STORE,'tpe',ym+'.json');
    if (exists(f)) continue;
    const ctl = new AbortController(); const to = setTimeout(()=>ctl.abort(), 60000);
    try {
      const resp = await fetch(`${TPE_BASE}/api/dataset/${TPE_DATASET}/resource/${r.rid}/download`, {signal: ctl.signal});
      if (!resp.ok) throw new Error('HTTP '+resp.status);
      const text = (await resp.text()).replace(/^﻿/, '');
      const rows = [];
      for (const line of text.split(/\r?\n/).slice(1)){
        const c = line.split(','); if (c.length < 5) continue;
        const item = c[3].trim(), price = parseFloat(c[c.length-1]);
        if (item && price > 0) rows.push([item, price]);
      }
      if (rows.length) save(f, {m: ym, unit: '元/台斤', rows});
    } catch(e){ log('tpe', ym, e.message); } finally { clearTimeout(to); }
  }
}
const pad2 = n => String(n).padStart(2,'0');

/* ---------- 國發會物價資訊看板：15項民生必需品賣場價格（月） ---------- */
const NDC_BASE = process.env.NDC_BASE || 'https://price.ndc.gov.tw';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let ndcCookie = null;
async function ndcSession(){
  // the site expects a normal browser session: load the page first and reuse its cookies
  const r = await fetch(`${NDC_BASE}/p/zh_tw/necessities`, {headers: {'user-agent': BROWSER_UA, 'accept-language': 'zh-TW,zh;q=0.9'}, signal: AbortSignal.timeout(60000)});
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  ndcCookie = set.map(c => c.split(';')[0]).join('; ');
  if (!r.ok) log('NDC page HTTP', r.status, '(continuing without session)');
}
async function ndcPost(body){
  if (ndcCookie === null) await ndcSession();
  const r = await fetch(`${NDC_BASE}/p/zh_tw/necessities_action`, {method:'POST', signal: AbortSignal.timeout(60000),
    headers: {'content-type':'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with':'XMLHttpRequest', 'user-agent': BROWSER_UA,
      'origin': NDC_BASE, 'referer': `${NDC_BASE}/p/zh_tw/necessities`, 'accept': 'application/json, text/javascript, */*; q=0.01', ...(ndcCookie ? {cookie: ndcCookie} : {})},
    body: new URLSearchParams(body).toString()});
  if (!r.ok) throw new Error('NDC HTTP '+r.status);
  return await r.json();
}
async function ndcUpdate(){
  const cls = await ndcPost({action:'get_class_list', class_id:''});
  const classes = (cls && Array.isArray(cls.msg)) ? cls.msg : [];
  if (!classes.length) throw new Error('no NDC classes');
  const [ty, tm] = iso(TODAY).split('-').map(Number);
  const months = [];
  for (let i = 1; i <= 30; i++){ let y = ty, m = tm - i; while (m <= 0){ m += 12; y--; } months.push(`${y}-${pad2(m)}`); }
  for (const ym of months){
    const f = path.join(STORE,'ndc',ym+'.json');
    const recent = months.indexOf(ym) < 2;          // the last two months may still be filled in
    if (exists(f) && !recent) continue;
    if (outOfTime()) break;
    const rows = [];
    for (const c of classes){
      const j = await ndcPost({action:'get_price_list', class_id: c.class_id, start_date: ym, end_date: ym}).catch(()=>null);
      if (!j || j.error !== 0 || !Array.isArray(j.msg)) continue;
      for (const p of j.msg){ const v = parseFloat(p.last_month_price); if (v > 0) rows.push([c.name, p.product_name, p.specification, v]); }
    }
    save(f, {m: ym, rows});
  }
}

/* ---------- main ---------- */
async function main(){
  log('start; today', iso(TODAY), 'days back', DAYS_BACK, 'base', BASE);
  const named = {origin: originUpdate(), retail: retailUpdate(), tpe: tpeUpdate(), ndc: ndcUpdate(), ...Object.fromEntries(POULTRY_APIS.map(a => [a, poultryUpdate(a)]))};
  const small = Object.entries(named).map(([k,p]) => p.catch(e => log(`${k} failed:`, e.message)));
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
