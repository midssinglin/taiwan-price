// Build the static site: copy the page and turn store/ into small JSON files the page reads.
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, STORE, DAY, JIN, todayTW, iso, fromIso, readJSON, r1, nameId,
  FARM_MARKET_CITY, FISH_MARKET_CITY, cityOf, POULTRY_ITEMS, RETAIL_ITEMS, POULTRY_APIS} from './lib.mjs';

const SITE = path.join(ROOT, 'site');
const DATA = path.join(SITE, 'data');
const KEEP_DAYS = +(process.env.KEEP_DAYS || 400);
const TODAY = todayTW();
const T0 = TODAY - KEEP_DAYS*DAY;
const off = t => Math.round((t - T0)/DAY);
const log = (...a) => console.log('[build]', ...a);

fs.rmSync(SITE, {recursive:true, force:true});
fs.mkdirSync(path.join(DATA,'items'), {recursive:true});
for (const f of ['index.html','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png','.nojekyll'])
  if (fs.existsSync(path.join(ROOT,f))) fs.copyFileSync(path.join(ROOT,f), path.join(SITE,f));
const out = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));

function listFiles(dir){ const res=[]; if(!fs.existsSync(dir)) return res; for (const y of fs.readdirSync(dir)){ const p=path.join(dir,y); if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) if (f.endsWith('.json')) res.push(path.join(p,f)); } return res.sort(); }

/* ---------- stats for the catalog (all prices 元/公斤) ---------- */
function summarize(ts, vs, qs){
  // ts: ascending timestamps, vs: prices
  const n = ts.length; if (!n) return null;
  const last = ts[n-1], p = vs[n-1];
  const p1 = n>1 ? vs[n-2] : null;
  let p7 = null; for (let i=n-1;i>=0;i--) if (ts[i] <= last-7*DAY){ if (ts[i] >= last-11*DAY) p7 = vs[i]; break; }
  const mean = (a,b) => { let s=0,c=0; for (let i=0;i<n;i++) if (ts[i]>a && ts[i]<=b && vs[i]>0){ s+=vs[i]; c++; } return c ? s/c : null; };
  const a30 = mean(last-30*DAY, last);
  const ly = mean(last-373*DAY, last-357*DAY);
  let q = null, q30 = null;
  if (qs){ q = qs[n-1]; let s=0,c=0; for (let i=0;i<n;i++) if (ts[i]>last-30*DAY){ s+=qs[i]; c++; } q30 = c ? s/c : null; }
  return {d: iso(last), p: r1(p), p1: r1(p1), p7: r1(p7), a30: r1(a30), ly: r1(ly), q: q==null?null:Math.round(q), q30: q30==null?null:Math.round(q30)};
}

/* ---------- generic day-row aggregation ---------- */
// rows: {t, key, sub, market, hi, lo, avg, q}; returns per key structures
function aggregate(rows, cityMap, isDomestic){
  const items = new Map();
  for (const r of rows){
    if (!(r.q>0) || !(r.avg>0) || r.t < T0) continue;
    let it = items.get(r.key); if (!it) items.set(r.key, it = {key:r.key, cat:r.cat, vars:new Map()});
    let v = it.vars.get(r.sub); if (!v) it.vars.set(r.sub, v = {q:0, rows:[]});
    v.q += r.q; v.rows.push(r);
  }
  const res = [];
  for (const it of items.values()){
    const allVars = [...it.vars.keys()];
    const dom = allVars.filter(isDomestic);
    const sel = new Set(dom.length ? dom : allVars);
    const series = (rs, withCity) => {
      const day = new Map(), city = new Map();
      for (const r of rs){
        let a = day.get(r.t); if (!a) day.set(r.t, a = {q:0,s:0,qh:0,sh:0,ql:0,sl:0});
        a.q+=r.q; a.s+=r.avg*r.q; if (r.hi>0){a.qh+=r.q;a.sh+=r.hi*r.q;} if (r.lo>0){a.ql+=r.q;a.sl+=r.lo*r.q;}
        if (withCity){ const c = cityOf(r.market, cityMap); let m = city.get(c); if (!m) city.set(c, m = new Map()); let b = m.get(r.t); if (!b) m.set(r.t, b = {q:0,s:0}); b.q+=r.q; b.s+=r.avg*r.q; }
      }
      const ts = [...day.keys()].sort((a,b)=>a-b);
      const o = {t: ts.map(off), avg: ts.map(t=>r1(day.get(t).s/day.get(t).q)), hi: ts.map(t=>{const a=day.get(t); return a.qh?r1(a.sh/a.qh):null;}), lo: ts.map(t=>{const a=day.get(t); return a.ql?r1(a.sl/a.ql):null;}), q: ts.map(t=>Math.round(day.get(t).q))};
      let cities = null;
      if (withCity){ cities = {}; for (const [c,m] of city){ const k=[...m.keys()].sort((a,b)=>a-b); cities[c] = {t:k.map(off), v:k.map(t=>r1(m.get(t).s/m.get(t).q)), q:k.map(t=>Math.round(m.get(t).q))}; } }
      return {o, ts, cities};
    };
    const main = series([...it.vars.entries()].filter(([k])=>sel.has(k)).flatMap(([,v])=>v.rows), true);
    const vars = {};
    if (allVars.length > 1) for (const [k,v] of [...it.vars.entries()].sort((a,b)=>b[1].q-a[1].q)) vars[k] = series(v.rows, false).o;
    res.push({key: it.key, cat: it.cat, nat: main.o, ts: main.ts, cities: main.cities, vars, dom: [...sel], tradingDays: main.ts.length});
  }
  return res;
}

/* ---------- 蔬果 ---------- */
const farmRows = [];
let farmLatest = null, farmDays = 0;
for (const f of listFiles(path.join(STORE,'farm'))){
  const j = readJSON(f); if (!j) continue; const t = fromIso(j.d); if (t < T0) continue;
  if (j.rows.length){ farmDays++; if (!farmLatest || t > farmLatest) farmLatest = t; }
  for (const [name, type, market, hi, mid, lo, avg, q] of j.rows)
    farmRows.push({t, key: name.split('-')[0].trim(), sub: name, cat: type===4?'蔬菜':'水果', market, hi, lo, avg, q});
}
// 產地價 (national daily average by product)
const origin = new Map();
for (const f of fs.existsSync(path.join(STORE,'origin')) ? fs.readdirSync(path.join(STORE,'origin')).filter(x=>/^\d{4}-\d{2}\.json$/.test(x)) : []){
  for (const [d, n, v] of readJSON(path.join(STORE,'origin',f), {rows:[]}).rows){ const t = fromIso(d); if (t < T0) continue; if (!origin.has(n)) origin.set(n, []); origin.get(n).push([t, v]); }
}
for (const a of origin.values()) a.sort((x,y)=>x[0]-y[0]);
function originFor(base){
  const strip = n => String(n).split('(')[0].trim();
  let cands = [...origin.keys()].filter(n => strip(n) === base);
  if (!cands.length) cands = [...origin.keys()].filter(n => n.startsWith(base));
  let best = null; for (const n of cands) if (!best || origin.get(n).length > origin.get(best).length) best = n;
  if (!best) return null; const pts = origin.get(best);
  return {n: best, t: pts.map(p=>off(p[0])), v: pts.map(p=>r1(p[1]))};
}

const catalog = {updated: new Date().toISOString(), t0: iso(T0), items: []};
function emitDaily(list, kind, minDays){
  let n = 0;
  for (const it of list){
    if (it.tradingDays < minDays) continue;
    const id = (kind==='farm'?'f':'s') + nameId(it.key);
    const o = kind==='farm' ? originFor(it.key) : null;
    const item = {n: it.key, k: kind, c: it.cat, t0: iso(T0), nat: it.nat, cities: it.cities, vars: it.vars, dom: it.dom};
    if (o) item.origin = o;
    fs.writeFileSync(path.join(DATA,'items',id+'.json'), JSON.stringify(item));
    const s = summarize(it.ts, it.nat.avg, it.nat.q);
    if (o && o.v.length) s.o = o.v[o.v.length-1];
    catalog.items.push({id, n: it.key, k: kind, c: it.cat, ...s});
    n++;
  }
  return n;
}
const farmItems = aggregate(farmRows, FARM_MARKET_CITY, n => !/進口/.test(n));
log('farm items', emitDaily(farmItems, 'farm', 5), 'from', farmDays, 'days');
farmRows.length = 0;

/* ---------- 漁產 ---------- */
const fishRows = []; let fishLatest = null;
for (const f of listFiles(path.join(STORE,'fish'))){
  for (const [d, name, market, hi, mid, lo, avg, q] of readJSON(f, {rows:[]}).rows){
    const t = fromIso(d); if (t < T0) continue; if (!fishLatest || t > fishLatest) fishLatest = t;
    fishRows.push({t, key: name, sub: name, cat: '漁產', market, hi, lo, avg, q});
  }
}
log('fish items', emitDaily(aggregate(fishRows, FISH_MARKET_CITY, ()=>true), 'fish', 5));

/* ---------- 毛豬 ---------- */
const porkDay = new Map(), porkCity = new Map(); let porkLatest = null;
for (const f of listFiles(path.join(STORE,'pork'))){
  const j = readJSON(f); if (!j) continue; const t = fromIso(j.d); if (t < T0 || !j.rows.length) continue;
  if (!porkLatest || t > porkLatest) porkLatest = t;
  for (const [market, n, p] of j.rows){ if (!(n>0&&p>0)) continue;
    const a = porkDay.get(t) || {q:0,s:0}; a.q+=n; a.s+=n*p; porkDay.set(t,a);
    const c = cityOf(market, {}); let m = porkCity.get(c); if (!m) porkCity.set(c, m = new Map()); const b = m.get(t) || {q:0,s:0}; b.q+=n; b.s+=n*p; m.set(t,b); }
}
{
  const ts = [...porkDay.keys()].sort((a,b)=>a-b);
  const nat = {t: ts.map(off), avg: ts.map(t=>r1(porkDay.get(t).s/porkDay.get(t).q)), q: ts.map(t=>porkDay.get(t).q)};
  const cities = {}; for (const [c,m] of porkCity){ const k=[...m.keys()].sort((a,b)=>a-b); cities[c] = {t:k.map(off), v:k.map(t=>r1(m.get(t).s/m.get(t).q)), q:k.map(t=>m.get(t).q)}; }
  out('pork.json', {t0: iso(T0), nat, cities});
  const s = summarize(ts, nat.avg, nat.q);
  if (s) catalog.items.push({id:'pork', n:'豬肉', k:'pork', c:'肉品', ...s});
}

/* ---------- 家禽與蛋 ---------- */
const poultry = {};
for (const api of POULTRY_APIS){
  const j = readJSON(path.join(STORE,'poultry',api+'.json')); if (!j) continue;
  const days = Object.keys(j.days).filter(d => fromIso(d) >= T0).sort();
  const fields = [...new Set(days.flatMap(d => Object.keys(j.days[d])))];
  poultry[api] = {t: days.map(d=>off(fromIso(d))), f: Object.fromEntries(fields.map(k => [k, days.map(d => j.days[d][k] ?? null)]))};
}
out('poultry.json', {t0: iso(T0), unit: '元/台斤', apis: poultry});
for (const it of POULTRY_ITEMS){
  const p = poultry[it.api]; if (!p) continue;
  const ts = [], vs = [];
  p.t.forEach((o,i) => { const vals = it.main.map(f => p.f[f]?.[i]).filter(v => v>0); if (vals.length){ ts.push(T0+o*DAY); vs.push(vals.reduce((a,b)=>a+b,0)/vals.length/JIN); } });
  const s = summarize(ts, vs, null); if (s) catalog.items.push({id: it.id, n: it.name, k: 'poultry', c: it.cat, ...s});
}

/* ---------- 零售（月） ---------- */
const retailStore = readJSON(path.join(STORE,'retail.json'), {});
const retail = {};
for (const [name, o] of Object.entries(retailStore)){ const k = /台斤/.test(o.unit) ? 1/JIN : 1; if (/顆|個/.test(o.unit)) continue; retail[name] = o.m.map(([m,v]) => [m, r1(v*k)]); }
out('retail.json', retail);
for (const it of RETAIL_ITEMS){
  const m = retail[it.retail]; if (!m || !m.length) continue;
  const last = m[m.length-1], prev = m.length>1 ? m[m.length-2] : null;
  const yr = m.find(x => x[0] === `${+last[0].slice(0,4)-1}${last[0].slice(4)}`);
  catalog.items.push({id: it.id, n: it.name, k: 'retail', c: it.cat, d: last[0]+'-15', p: last[1], p1: prev && prev[1], ly: yr && yr[1], monthly: true});
}

/* ---------- 台北市公有零售市場（月）→ 元/公斤 ---------- */
const tpe = {};
if (fs.existsSync(path.join(STORE,'tpe'))) for (const f of fs.readdirSync(path.join(STORE,'tpe')).filter(x=>/^\d{4}-\d{2}\.json$/.test(x)).sort()){
  const j = readJSON(path.join(STORE,'tpe',f)); if (!j) continue;
  for (const [item, v] of j.rows) (tpe[item] ||= []).push([j.m, r1(v/JIN)]);
}
out('tpe.json', tpe);

/* ---------- 賣場價格（國發會 15 項民生必需品，月） ---------- */
const goods = {};
if (fs.existsSync(path.join(STORE,'ndc'))) for (const f of fs.readdirSync(path.join(STORE,'ndc')).filter(x=>/^\d{4}-\d{2}\.json$/.test(x)).sort()){
  const j = readJSON(path.join(STORE,'ndc',f)); if (!j) continue;
  for (const [cls, prod, spec, v] of j.rows){ const c = (goods[cls] ||= {}); const k = prod+'｜'+spec; (c[k] ||= {n: prod, spec, pts: []}).pts.push([j.m, v]); }
}
const goodsOut = Object.fromEntries(Object.entries(goods).map(([c, o]) => [c, Object.values(o)]));
out('goods.json', goodsOut);
for (const [cls, prods] of Object.entries(goodsOut)){
  const last = prods.flatMap(p => p.pts.map(x => x[0])).sort().pop(); if (!last) continue;
  const cur = prods.map(p => p.pts.find(x => x[0] === last)).filter(Boolean).map(x => x[1]);
  catalog.items.push({id: 'g'+nameId(cls), n: cls==='雞蛋'?'盒裝雞蛋':cls, cls, k: 'goods', c: '日用品', d: last+'-15', p: Math.min(...cur), n2: prods.length, monthly: true, raw: true});
}

/* ---------- events: typhoons (events.json) + national holidays ---------- */
const events = (readJSON(path.join(ROOT,'events.json'), {events:[]}).events || []).slice();
const y0 = new Date(T0).getUTCFullYear(), y1 = new Date(TODAY).getUTCFullYear();
for (let y = y0; y <= y1+1; y++){
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar@master/data/${y}.json`, {signal: AbortSignal.timeout(20000)});
    if (!r.ok) continue; const days = await r.json();
    let cur = null;
    for (const d of days){
      const name = (d.description||'').trim();
      if (d.isHoliday && name && !/^(補假|調整放假)/.test(name)){
        const date = `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`;
        if (cur && cur.name === name && fromIso(date) - fromIso(cur.end) <= 3*DAY) cur.end = date;
        else { cur = {type:'holiday', name, start: date, end: date}; events.push(cur); }
      }
    }
  } catch(e){ log('calendar', y, 'skipped:', e.message); }
}
out('events.json', events.filter(e => fromIso(e.end) >= T0 - 10*DAY));

/* ---------- county map ---------- */
try {
  const r = await fetch('https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/counties-10t.json', {signal: AbortSignal.timeout(30000)});
  if (r.ok) fs.writeFileSync(path.join(DATA,'tw-counties.json'), await r.text());
} catch(e){ log('map skipped:', e.message); }

out('catalog.json', catalog);
out('meta.json', {updated: catalog.updated, t0: iso(T0), farmLatest: farmLatest && iso(farmLatest), fishLatest: fishLatest && iso(fishLatest), porkLatest: porkLatest && iso(porkLatest), farmDays, items: catalog.items.length});
log('catalog', catalog.items.length, 'items; latest farm', farmLatest && iso(farmLatest));
