// Price alerts: compare alerts.json against the freshly built catalog and notify via a GitHub issue
// (GitHub emails / pushes it to the repo owner) and optionally Telegram.
import path from 'node:path';
import {ROOT, STORE, DAY, fromIso, readJSON, writeJSON} from './lib.mjs';

const cfg = readJSON(path.join(ROOT,'alerts.json'), {alerts:[]});
const catalog = readJSON(path.join(ROOT,'site','data','catalog.json'));
const STATE_FILE = path.join(STORE,'alerts-state.json');
const state = readJSON(STATE_FILE, {items:{}, digest:null});
const repo = process.env.GITHUB_REPOSITORY || '';
const [owner, name] = repo.split('/');
const pageUrl = owner ? `https://${owner}.github.io/${name}/` : '';
const today = new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
if (!catalog){ console.log('no catalog; skip'); process.exit(0); }

const latest = Math.max(...catalog.items.filter(i=>!i.monthly).map(i => fromIso(i.d)));
const fresh = i => i.monthly || fromIso(i.d) >= latest - 4*DAY;
const pct = (a,b) => (a && b) ? (a/b - 1)*100 : null;

/** Same rules as the page's 今日划算 list. */
export function recommend(items){
  const ok = items.filter(i => !i.monthly && fresh(i) && i.p > 0 && (i.m30||i.a30) > 0 && (i.cv==null || i.cv <= 0.3) && !/其他|雜/.test(i.n)
    && (i.k !== 'farm' || (i.q30||0) >= 3000) && (i.k !== 'fish' || (i.q30||0) >= 800));
  const withR = ok.map(i => ({...i, r: pct(i.p3||i.p, i.m30||i.a30), ry: pct(i.p3||i.p, i.ly)})).filter(i => Math.abs(i.r) <= 70);
  return {cheap: withR.filter(i => i.r <= -12).sort((a,b)=>a.r-b.r), dear: withR.filter(i => i.r >= 20).sort((a,b)=>b.r-a.r)};
}

const hits = [];
for (const a of cfg.alerts || []){
  const it = catalog.items.find(i => i.n === a.name && (!a.kind || i.k === a.kind));
  if (!it || !fresh(it) || !(it.p > 0)) continue;
  if (it.p <= a.below){
    const prev = state.items[a.name];
    // notify once, then again only after 7 days or another 5% drop
    if (!prev || fromIso(today) - fromIso(prev.date) >= 7*DAY || it.p <= prev.price*0.95){ hits.push({a, it}); state.items[a.name] = {date: today, price: it.p}; }
  } else delete state.items[a.name];
}

let body = '';
if (hits.length){
  body += `## 到價提醒\n\n| 品項 | 最新價格（元/公斤） | 你的門檻 | 資料日期 |\n|---|---|---|---|\n`;
  for (const {a,it} of hits) body += `| ${it.n} | **${it.p}** | ${a.below} | ${it.d} |\n`;
  body += '\n';
}
let digest = false;
if (cfg.dailyDigest && state.digest !== today){
  const {cheap, dear} = recommend(catalog.items);
  if (cheap.length || dear.length){
    digest = true; state.digest = today;
    body += `## 今日划算\n\n` + cheap.slice(0,10).map(i => `- ${i.n}：${i.p} 元/公斤，近 3 日均價比近 30 天低 ${Math.abs(i.r).toFixed(0)}%${i.ry!=null&&i.ry<0?`，比去年同期低 ${Math.abs(i.ry).toFixed(0)}%`:''}`).join('\n') + '\n';
    if (dear.length) body += `\n## 近期偏貴\n\n` + dear.slice(0,6).map(i => `- ${i.n}：${i.p} 元/公斤，近 3 日均價比近 30 天高 ${i.r.toFixed(0)}%`).join('\n') + '\n';
  }
}
if (!body){ console.log('no alerts today'); writeJSON(STATE_FILE, state); process.exit(0); }
if (pageUrl) body += `\n[打開台灣菜價通](${pageUrl})\n`;
const title = (hits.length ? `到價提醒：${hits.map(h=>h.it.n).join('、')}` : '今日划算') + `（${today}）`;

async function notify(){
  if (process.env.GITHUB_TOKEN && repo){
    const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {method:'POST', headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`, accept:'application/vnd.github+json', 'content-type':'application/json'}, body: JSON.stringify({title, body})});
    console.log('issue', r.status);
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID){
    const text = `${title}\n\n${body.replace(/\|/g,' ').replace(/[#*]/g,'').replace(/\n-+\s*\n/g,'\n')}`;
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true})});
    console.log('telegram', r.status);
  }
}
await notify().catch(e => console.log('notify failed', e.message));
writeJSON(STATE_FILE, state);
console.log(title, digest ? '(with digest)' : '');
