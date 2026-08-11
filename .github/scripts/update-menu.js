// 매곡테크노파크(울산테크노매곡) 주간 식단표 자동 업데이트
// STX푸드 목록에서 '울산테크노매곡' 최신 주차를 찾아 index.html의 MEAL_WEEK_IMAGES 맨 앞에 추가.
// 이미 반영된 주차면 아무것도 하지 않음(멱등). 외부 의존성 없음(Node 내장 https).
const https = require('https');
const fs = require('fs');

const BASE = 'https://www.stxfood.com';
const SITE = '울산테크노매곡';
const FILE = 'index.html';

function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (menu-update-bot)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(new URL(res.headers.location, url).href, depth + 1).then(resolve, reject);
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  // 1) 목록에서 울산테크노매곡 최신 항목(리스트는 최신순 → 첫 매칭)
  const list = await get(BASE + '/archives/menu/list');
  const re = /<a[^>]+href="(\/archives\/menu\/detail\/(\d+)[^"]*)"[^>]*>([^<]*)<\/a>/g;
  let m, found = null;
  while ((m = re.exec(list))) {
    const text = m[3].replace(/\s+/g, ' ').trim();
    if (text.includes(SITE) && text.includes('식단표')) {
      found = { href: m[1].replace(/&amp;/g, '&'), id: m[2], text };
      break;
    }
  }
  if (!found) { console.log('SKIP: ' + SITE + ' 항목을 찾지 못함'); return; }

  // 2) 이미 반영된 주차면 종료(멱등)
  const html = fs.readFileSync(FILE, 'utf8');
  if (html.includes('/detail/' + found.id + '?')) {
    console.log('SKIP: 이미 최신(detail ' + found.id + ') 반영됨 — ' + found.text);
    return;
  }

  // 3) 상세 페이지에서 주간 식단표 이미지 URL 추출
  const detail = await get(BASE + found.href);
  const im = detail.match(/_data\/archives\/\d+\/\d+\/[a-z0-9]+_thumb_720x720\.png/i);
  if (!im) { console.log('SKIP: 상세 이미지 URL을 찾지 못함 — ' + found.text); return; }
  const imgUrl = BASE + '/' + im[0];
  const detailUrl = BASE + '/archives/menu/detail/' + found.id + '?row=10&block=10';
  const wm = found.text.match(/\d+\s*월\s*\d+\s*주/);
  const label = wm ? wm[0].replace(/\s+/g, ' ').trim() : found.text.replace(/\[[^\]]*\]/, '').replace('식단표', '').trim();

  // 4) MEAL_WEEK_IMAGES 배열 맨 앞에 새 주차 삽입
  const anchor = 'const MEAL_WEEK_IMAGES = [\n';
  const idx = html.indexOf(anchor);
  if (idx < 0) { console.log('SKIP: MEAL_WEEK_IMAGES 앵커를 찾지 못함'); return; }
  const entry = "  {\n    label:'" + label + "',\n    url:'" + imgUrl + "',\n    detailUrl:'" + detailUrl + "'\n  },\n";
  const out = html.slice(0, idx + anchor.length) + entry + html.slice(idx + anchor.length);
  fs.writeFileSync(FILE, out);
  console.log('UPDATED: ' + label + ' / detail ' + found.id + ' / ' + imgUrl);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(1); });
