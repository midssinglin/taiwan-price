// Shared helpers for the data pipeline (Node 20+, no dependencies).
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const STORE = path.join(ROOT, 'store');
export const BASE = process.env.MOA_BASE || 'https://data.moa.gov.tw';
export const DAY = 86400000;
export const JIN = 0.6; // 1 台斤 = 0.6 kg

/** Today in Taiwan as a UTC-midnight timestamp. */
export function todayTW(){
  if (process.env.TODAY) { const [y,m,d] = process.env.TODAY.split('-').map(Number); return Date.UTC(y,m-1,d); }
  const t = new Date(Date.now() + 8*3600*1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
export const pad = n => String(n).padStart(2,'0');
export const ymd = t => { const d = new Date(t); return [d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate()]; };
export const iso = t => { const [y,m,d] = ymd(t); return `${y}-${pad(m)}-${pad(d)}`; };
export const fromIso = s => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y,m-1,d); };
export const rocDot = t => { const [y,m,d] = ymd(t); return `${y-1911}.${pad(m)}.${pad(d)}`; };
export const rocCompact = t => { const [y,m,d] = ymd(t); return `${y-1911}${pad(m)}${pad(d)}`; };
export const slash = t => { const [y,m,d] = ymd(t); return `${y}/${pad(m)}/${pad(d)}`; };
export function parseRoc(s){
  s = String(s||'').trim();
  let m = s.match(/^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/) || s.match(/^(\d{3})(\d{2})(\d{2})$/);
  return m ? Date.UTC(+m[1]+1911, +m[2]-1, +m[3]) : null;
}
export function parseSlash(s){ const m = String(s||'').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/); return m ? Date.UTC(+m[1],+m[2]-1,+m[3]) : null; }
export const mondayOf = t => { const wd = (new Date(t).getUTCDay()+6)%7; return t - wd*DAY; };

export function readJSON(file, fallback=null){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
/** Write only when the content changed, so git history stays small. Returns true if written. */
export function writeJSON(file, data){
  const s = JSON.stringify(data);
  try { if (fs.readFileSync(file,'utf8') === s) return false; } catch {}
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, s);
  return true;
}
export const r1 = v => v==null || !isFinite(v) ? null : Math.round(v*10)/10;

/** Small fetch pool with retries and timeout. */
export function makeFetcher({concurrency=4, timeoutMs=90000, retries=2}={}){
  let active = 0; const q = [];
  const stats = {ok:0, fail:0};
  const pump = () => { while (active < concurrency && q.length){ const [fn,res,rej] = q.shift(); active++; fn().then(res,rej).finally(()=>{active--; pump();}); } };
  const run = fn => new Promise((res,rej)=>{ q.push([fn,res,rej]); pump(); });
  async function getJSON(url){
    return run(async () => {
      let err;
      for (let i=0; i<=retries; i++){
        const ctl = new AbortController(); const to = setTimeout(()=>ctl.abort(), timeoutMs);
        try {
          const r = await fetch(url, {signal: ctl.signal, headers: {'user-agent':'taiwan-price-bot (+github.com)'}});
          if (!r.ok) throw new Error('HTTP '+r.status);
          const j = await r.json(); stats.ok++; return j;
        } catch(e){ err = e; await new Promise(r=>setTimeout(r, 2000*(i+1))); }
        finally { clearTimeout(to); }
      }
      stats.fail++; throw err;
    });
  }
  return {getJSON, stats};
}

/* ---------- domain constants shared by build + alerts ---------- */
export const FARM_MARKET_CITY = {'台北一':'台北','台北二':'台北','台北市場':'台北','板橋區':'新北','三重區':'新北','桃農':'桃園','台中市':'台中','台中市場':'台中','豐原區':'台中','東勢鎮':'台中','永靖鄉':'彰化','溪湖鎮':'彰化','彰化市場':'彰化','南投市':'南投','西螺鎮':'雲林','嘉義市':'嘉義','台南市場':'台南','台南市':'台南','高雄市':'高雄','高雄市場':'高雄','鳳山區':'高雄','屏東市':'屏東','宜蘭市':'宜蘭','花蓮市':'花蓮','台東市':'台東'};
export const FISH_MARKET_CITY = {'台北':'台北','三重':'新北','基隆':'基隆','桃園':'桃園','新竹':'新竹','苗栗':'苗栗','台中':'台中','彰化':'彰化','埔心':'彰化','斗南':'雲林','嘉義':'嘉義','新營':'台南','佳里':'台南','台南':'台南','岡山':'高雄','梓官':'高雄','興達港':'高雄','高雄':'高雄','花蓮':'花蓮','澎湖':'澎湖','宜蘭':'宜蘭','南方澳':'宜蘭','屏東':'屏東','東港':'屏東','台東':'台東'};
export const FISH_MARKETS = ['台北','三重','基隆','桃園','新竹','苗栗','台中','彰化','埔心','斗南','嘉義','新營','佳里','台南','岡山','梓官','興達港','高雄','花蓮','澎湖'];
const CITY_ORDER = ['台北','新北','基隆','桃園','新竹','苗栗','台中','彰化','南投','雲林','嘉義','台南','高雄','屏東','宜蘭','花蓮','台東','澎湖'];
export function cityOf(name, map){
  name = String(name||'').replace(/臺/g,'台').trim();
  if (map[name]) return map[name];
  for (const c of CITY_ORDER) if (name.startsWith(c)) return c;
  return name.slice(0,2);
}
export const POULTRY_APIS = ['PoultryTransType_BoiledChicken_Eggs','PoultryTransType_RedFeather','PoultryTransType_BlackFeather','PoultryTransType_Goose_Duck_Duckegg'];
// id, name, cat, api, main field(s); prices in the API are 元/台斤
export const POULTRY_ITEMS = [
  {id:'egg', name:'雞蛋', cat:'蛋品', api:'PoultryTransType_BoiledChicken_Eggs', main:['egg_Price']},
  {id:'broiler', name:'白肉雞', cat:'肉品', api:'PoultryTransType_BoiledChicken_Eggs', main:['TaijinPrice_2.0kgup']},
  {id:'red', name:'紅羽土雞', cat:'肉品', api:'PoultryTransType_RedFeather', main:['RedFeather_N_M','RedFeather_C_M','RedFeather_S_M']},
  {id:'black', name:'黑羽土雞', cat:'肉品', api:'PoultryTransType_BlackFeather', main:['BlackFeather_S_M']},
  {id:'duckegg', name:'鴨蛋', cat:'蛋品', api:'PoultryTransType_Goose_Duck_Duckegg', main:['Duckegg_TNN_TaijinPrice']},
  {id:'duck', name:'番鴨', cat:'肉品', api:'PoultryTransType_Goose_Duck_Duckegg', main:['Duck_75D_TaijinPrice']},
  {id:'goose', name:'鵝', cat:'肉品', api:'PoultryTransType_Goose_Duck_Duckegg', main:['Goose_WR_TaijinPrice']},
];
export const RETAIL_ITEMS = [
  {id:'beef', name:'牛肉', cat:'肉品', retail:'國產牛肉(牛腩)'},
  {id:'lamb', name:'羊肉', cat:'肉品', retail:'國產羊肉(中肉)'},
];
/** Stable short id for a name (FNV-1a 32-bit, hex). */
export function nameId(s){ let h = 0x811c9dc5; for (const ch of String(s)){ h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8,'0'); }
