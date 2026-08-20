
/* ======== 데이터 ======== */
const SB_URL='https://vvyqldyljajlmtydtqdf.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2eXFsZHlsamFqbG10eWR0cWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Nzc4NTQsImV4cCI6MjA5NzI1Mzg1NH0.YakWHeL5ZZK7RZ9K6fwxNECy02uwikoHYdRT-rSpLKc';
const SB_REST=SB_URL+'/rest/v1/app_store';
/* ── 접속 인증 (Supabase Auth · 공용 계정) ── */
const AUTH_EMAIL='nicehehe@soosan.co.kr';
const GM_SESSION='gm_session';
function gmGetSession(){ try{ return JSON.parse(localStorage.getItem(GM_SESSION)||'null'); }catch(e){ return null; } }
function gmSetSession(d){ try{ localStorage.setItem(GM_SESSION, JSON.stringify({access_token:d.access_token, refresh_token:d.refresh_token})); }catch(e){} }
function gmToken(){ const s=gmGetSession(); return (s&&s.access_token)||''; }
function gmAuthHeaders(){ const t=gmToken(); return { apikey:SB_KEY, Authorization:'Bearer '+t, 'Content-Type':'application/json' }; }
async function gmSignIn(password){
  const r=await fetch(SB_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:AUTH_EMAIL,password})});
  const d=await r.json().catch(()=>({})); if(!d.access_token) throw new Error(d.error_description||d.msg||d.error||'로그인 실패'); gmSetSession(d); return true;
}
async function gmRefresh(){
  const s=gmGetSession(); if(!s||!s.refresh_token) return false;
  const r=await fetch(SB_URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:s.refresh_token})});
  const d=await r.json().catch(()=>({})); if(d.access_token){ gmSetSession(d); return true; } try{localStorage.removeItem(GM_SESSION);}catch(e){} return false;
}

async function sbGet(key){ try{ const url=`${SB_REST}?key=eq.${encodeURIComponent(key)}&select=value`; let r=await fetch(url,{headers:gmAuthHeaders()}); if(r.status===401 && await gmRefresh()) r=await fetch(url,{headers:gmAuthHeaders()}); const d=await r.json(); return d&&d[0]?d[0].value:null; }catch(e){ return null; } }
async function sbSet(key,val){ try{ const body=JSON.stringify({key,value:val,updated_at:new Date().toISOString()}); const opts=()=>({method:'POST',headers:{...gmAuthHeaders(),'Prefer':'resolution=merge-duplicates'},body}); let r=await fetch(SB_REST,opts()); if(r.status===401 && await gmRefresh()) r=await fetch(SB_REST,opts()); }catch(e){} }

/* ======== 상태 ======== */
let CARDS = [];     // [{id,name,no,owner,color}]
let VOUCHERS = [];  // [{id,cardId,date,merchant,amount,vat,acct,cc,note}]
let activeCardId = 'all';
let pendingFiles = [];
let editingId = null;

/* Gemini API 키 — 한 번만 입력하면 공용 클라우드에 '암호화'되어 저장, 모든 PC에서 자동 적용 */
const GEMINI_CLOUD_KEY = 'gemini_api_key_enc';   // 클라우드엔 암호문만 저장
const GEMINI_LEGACY_KEY = 'gemini_api_key';      // 구버전 평문 저장본(자동 마이그레이션)
const GEMINI_MODEL = 'gemini-3.6-flash';         // 무료 티어, 비전(이미지·PDF) 지원
const RATE_PASS_LS = 'gm_voucher_rate_pass';     // 전표생성기 적용률과 동일 암호(공유)
let GEMINI_KEY = localStorage.getItem('gm_gemini_key') || '';
// --- AES-256-GCM (적용률·사원명부와 동일 방식) ---
function _b64(b){ let s=''; const a=new Uint8Array(b); for(let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); }
function _unb64(s){ return Uint8Array.from(atob(s), c=>c.charCodeAt(0)); }
async function _deriveKey(pass, salt){ const base=await crypto.subtle.importKey('raw', new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']); return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']); }
async function _enc(obj, pass){ const salt=crypto.getRandomValues(new Uint8Array(16)); const iv=crypto.getRandomValues(new Uint8Array(12)); const key=await _deriveKey(pass,salt); const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(obj))); return {v:1, salt:_b64(salt), iv:_b64(iv), ct:_b64(ct)}; }
async function _dec(blob, pass){ const key=await _deriveKey(pass,_unb64(blob.salt)); const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:_unb64(blob.iv)},key,_unb64(blob.ct)); return JSON.parse(new TextDecoder().decode(pt)); }
function _apiPass(promptIfMissing){
  let p=(localStorage.getItem(RATE_PASS_LS)||'').trim();
  if(!p && promptIfMissing){ p=(prompt('키를 암호화 저장할 암호를 입력하세요.\n(전표생성기 적용률과 동일한 암호 — 집·회사 PC 공통)')||'').trim(); if(p) localStorage.setItem(RATE_PASS_LS,p); }
  return p;
}
function hasApiKey(){ return GEMINI_KEY.length>=20; }
async function saveApiKey(k){
  GEMINI_KEY=k.trim();
  try{ localStorage.setItem('gm_gemini_key', GEMINI_KEY); }catch(e){}   // 이 PC 로컬 작업본(즉시 적용)
  const pass=_apiPass(false);   // 프롬프트 없이 캐시된 암호만 사용(있으면 클라우드 암호화 저장, 없으면 로컬만)
  try{ if(pass && GEMINI_KEY){ const blob=await _enc({key:GEMINI_KEY}, pass); await sbSet(GEMINI_CLOUD_KEY, blob); await sbSet(GEMINI_LEGACY_KEY, ''); } }catch(e){}
}
async function clearApiKey(){   // 옛 키를 로컬·클라우드에서 완전히 제거
  GEMINI_KEY='';
  try{ localStorage.removeItem('gm_gemini_key'); }catch(e){}
  try{ await sbSet(GEMINI_CLOUD_KEY, ''); await sbSet(GEMINI_LEGACY_KEY, ''); }catch(e){}
  if(typeof updateApiKeyStatus==='function') updateApiKeyStatus();
}
async function loadCloudApiKey(){
  if(GEMINI_KEY.length>=20){ if(typeof updateApiKeyStatus==='function') updateApiKeyStatus(); return; }  // 로컬 키가 있으면 클라우드로 덮어쓰지 않음
  try{
    const blob=await sbGet(GEMINI_CLOUD_KEY);
    if(blob && blob.ct){                       // 암호화 저장본 → 캐시된 암호로만 자동 복호화
      const pass=_apiPass(false);
      if(pass){ try{ const d=await _dec(blob, pass); if(d && d.key && d.key.length>=20){ GEMINI_KEY=d.key; try{localStorage.setItem('gm_gemini_key',d.key);}catch(e){} } }catch(e){} }
    } else {                                   // 구버전 평문키 → 읽어서 즉시 암호화 재저장(마이그레이션)
      const legacy=await sbGet(GEMINI_LEGACY_KEY);
      if(typeof legacy==='string' && legacy.length>=20){
        GEMINI_KEY=legacy; try{localStorage.setItem('gm_gemini_key',legacy);}catch(e){}
        const pass=_apiPass(false);
        if(pass){ try{ const blob2=await _enc({key:legacy}, pass); await sbSet(GEMINI_CLOUD_KEY, blob2); await sbSet(GEMINI_LEGACY_KEY, ''); }catch(e){} }
      }
    }
    if(typeof updateApiKeyStatus==='function') updateApiKeyStatus();
  }catch(e){}
}

const PUSH_KEY_CARDS    = 'card_cards_v1';
const PUSH_KEY_VOUCHERS = 'card_vouchers_v1';
const LS_CARDS    = 'gm_card_cards';
const LS_VOUCHERS = 'gm_card_vouchers';

/* ── 저장: localStorage(즉시) + Supabase(800ms 디바운스) ── */
let pushTimer = null;
function saveLocal(){
  try{
    localStorage.setItem(LS_CARDS,    JSON.stringify(CARDS));
    localStorage.setItem(LS_VOUCHERS, JSON.stringify(VOUCHERS));
  }catch(e){}
}
function schedulePush(){
  saveLocal();                                   // ① 즉시 로컬 저장
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushAll, 800);          // ② 클라우드는 디바운스
}
async function pushAll(){
  try{ await sbSet(PUSH_KEY_CARDS,    CARDS);    } catch(e){}
  try{ await sbSet(PUSH_KEY_VOUCHERS, VOUCHERS); } catch(e){}
  setSyncBadge('saved');
}

/* ── 동기화 배지 ── */
function setSyncBadge(state){
  const el=document.getElementById('syncBadge'); if(!el) return;
  const map={ saved:['☁️ 저장됨','var(--green)'], saving:['⏳ 저장 중','var(--orange)'], offline:['📴 오프라인','var(--t3)'] };
  const [txt,col]=map[state]||map.saved;
  el.textContent=txt; el.style.color=col;
}

/* ======== 계정과목 자동분류 ======== */
/* ===== 실데이터(2026년 288건 전표) 학습 규칙 ===== */
const CAR_PLATE = '아반떼 16저4837';           // 업무용차량(적요 자동생성용) — 필요시 수정
const DEFAULT_CC = '경영지원팀';                // 총무 카드 기본 코스트센터
// 자주 쓰는 코스트센터(편집 드롭다운용)
const COST_CENTERS = ['경영지원팀','재무기획팀','IT팀','품질안전본부','사업본부','마케팅본부','엔지니어링본부','경영지원본부','신사옥건축경비','기술연구소','기술연구원','시스템연구소'];
// 대분류 결정: 코스트센터 → 판관비 / 경상연구개발비 / 제조비용
const HQ_PANGWAN = ['경영지원팀','재무기획팀','IT팀','경영지원본부','신사옥건축경비','기술연구소','안전보건팀'];
function deptDaebun(cc){
  const c=(cc||'').trim();
  if(!c) return '판관비';
  if(HQ_PANGWAN.some(d=>c===d||c.startsWith(d))) return '판관비';
  if(c.includes('시스템연구소')) return '경상연구개발비';
  return '제조비용';                            // 본부·사업소·프로젝트코드(2025xxx-…) 등
}
// 거래처(상호) → 중분류_소분류 (실데이터 매핑)
const SUB_ACCT_RULES = [
  { keys:['이마트','설 ','추석','명절','기념품','선물세트'], sub:'복리후생비_기념품지급' },
  { keys:['우체국','우편','등기','소포발송'], sub:'통신비_우편료' },
  { keys:['하이패스','통행료','비씨카드정산','톨게이트','후불하이패스'], sub:'차량유지비_기타' },
  { keys:['엔진오일','현대자동차','카센터','정비소','와이퍼','타이어'], sub:'차량유지비_수선비' },
  { keys:['주유','유류','알뜰주유','gs칼텍스','sk에너지','s-oil','오일뱅크','셀프주유','세차'], sub:'차량유지비_유류비' },
  { keys:['알라딘','교보문고','영풍문고','서점','단행본','도서'], sub:'도서인쇄비_단행본구입' },
  { keys:['삼성전자서비스','노트북','배터리','전산','pc수리','키보드','마우스'], sub:'소모품비_전산용품' },
  { keys:['프린트박스','소포상자','택배상자','칠판닷컴','화이트보드','박스','상자'], sub:'소모품비_기타' },
  { keys:['손해보험','보험','재해보장','kb손해','현대해상','삼성화재'], sub:'보험료_종업원재해보장' },
  { keys:['제증명','실적증명','증명서 발급','실적 증명'], sub:'지급수수료_제증명발급수수료' },
  { keys:['anthropic','claude','구독','소프트웨어','유지보수','saas','라이선스'], sub:'지급수수료_소프트웨어유지보수비' },
  { keys:['협회','수수료','신청','발급'], sub:'지급수수료_기타' },
  { keys:['롯데마트','롯데쇼핑','리앙빈','원두','커피','간식','다과','생수'], sub:'복리후생비_기타복리후생비' },
  { keys:['돈까스','반점','식당','도시락','식대','회의','뷔페','한식','중식'], sub:'회의비_일반' },
  { keys:['호텔','객실료','연회장','소노','행사','워크숍','소장단'], sub:'복리후생비_행사지원비' },
];
function subAcct(merchant, note){
  const t=((merchant||'')+' '+(note||'')).toLowerCase();
  for(const r of SUB_ACCT_RULES){ if(r.keys.some(k=>t.includes(k.toLowerCase()))) return r.sub; }
  return '복리후생비_기타복리후생비';           // 총무 카드 기본값
}
// 최종 계정과목 = 대분류_중분류_소분류
function guessAcct(merchant, note, cc){
  return deptDaebun(cc||DEFAULT_CC) + '_' + subAcct(merchant, note);
}
// 적요 자동생성 (실데이터 포맷 학습)
function guessNote(merchant, rawNote){
  const m=(merchant||''), t=(m+' '+(rawNote||'')).toLowerCase();
  if(t.includes('우체국')||t.includes('우편')) return '우편발송';
  if(t.includes('하이패스')||t.includes('통행료')||t.includes('비씨카드정산')) return `업무용차량 (${CAR_PLATE}) 고속도로통행료`;
  if(t.includes('세차')) return `업무용차량 (${CAR_PLATE}) 세차비`;
  if(t.includes('주유')||t.includes('유류')) return `업무용차량 (${CAR_PLATE}) 유류비`;
  if(t.includes('엔진오일')||t.includes('현대자동차')||t.includes('정비')) return `${CAR_PLATE} 엔진오일 등 교체`;
  if(t.includes('롯데마트')||t.includes('롯데쇼핑')) return '사무실 커피등 구입';
  if(t.includes('리앙빈')||t.includes('원두')) return '본사 커피머신용 원두 구입';
  if(t.includes('이마트')||t.includes('명절')||t.includes('선물')) return '명절 선물 구매';
  if(t.includes('보험')||t.includes('재해보장')) return '근로자재해보장보험 가입';
  if(t.includes('알라딘')||t.includes('도서')) return '도서 구입';
  if(t.includes('claude')||t.includes('anthropic')) return 'Claude 구독료';
  return rawNote||'';
}

/* ======== 유틸 ======== */
const esc = s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function fmtAmt(n){ return Number(n||0).toLocaleString('ko-KR'); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function today(){ return new Date().toISOString().slice(0,10); }
function ym(){ return new Date().toISOString().slice(0,7); }

/* ======== 초기화 ======== */
async function init(){
  // ① localStorage에서 즉시 불러오기 (새로고침해도 바로 표시)
  try{
    const lsCards    = localStorage.getItem(LS_CARDS);
    const lsVouchers = localStorage.getItem(LS_VOUCHERS);
    if(lsCards)    CARDS    = JSON.parse(lsCards);
    if(lsVouchers) VOUCHERS = JSON.parse(lsVouchers);
  }catch(e){}

  // 초기 카드 없으면 기본값
  if(!CARDS.length){
    CARDS = [
      {id:uid(), name:'신한 법인카드 1', no:'', owner:'', color:'#3182F6'},
      {id:uid(), name:'신한 법인카드 2', no:'', owner:'', color:'#1DB67F'},
    ];
    saveLocal();
  }

  // 계정과목·코스트센터 자동완성(datalist) 채우기
  const acctDL=document.getElementById('acctDL');
  const daebun=['판관비','제조비용','경상연구개발비'];
  const subs=[...new Set(SUB_ACCT_RULES.map(r=>r.sub))];
  daebun.forEach(d=>subs.forEach(s=>{ const o=document.createElement('option'); o.value=d+'_'+s; acctDL.appendChild(o); }));
  const ccDL=document.getElementById('ccDL');
  COST_CENTERS.forEach(c=>{ const o=document.createElement('option'); o.value=c; ccDL.appendChild(o); });
  updateApiKeyStatus();
  renderAll();   // ← 로컬 데이터로 바로 화면 표시

  // ② 백그라운드에서 Supabase와 동기화 (더 최신 데이터가 있으면 덮어씀)
  setSyncBadge('saving');
  try{
    const [sbCards, sbVouchers] = await Promise.all([
      sbGet(PUSH_KEY_CARDS), sbGet(PUSH_KEY_VOUCHERS)
    ]);
    let updated = false;
    if(sbCards && Array.isArray(sbCards) && sbCards.length >= CARDS.length){
      CARDS = sbCards; updated = true;
    }
    if(sbVouchers && Array.isArray(sbVouchers) && sbVouchers.length >= VOUCHERS.length){
      VOUCHERS = sbVouchers; updated = true;
    }
    if(updated){ saveLocal(); renderAll(); }
    setSyncBadge('saved');
  }catch(e){ setSyncBadge('offline'); }

  // 공용 클라우드에 저장된 Gemini 키 불러오기(다른 PC/관리자가 설정했으면 자동 적용)
  await loadCloudApiKey();
  updateApiKeyStatus();

  // 키 미설정 시 안내(최초 1회만 설정하면 됨)
  if(!hasApiKey()){
    setTimeout(()=>{ if(confirm('영수증 자동인식에 쓸 Gemini 키가 없습니다.\n무료 키를 한 번만 설정하면 모든 PC에 공유됩니다.\n지금 설정하시겠어요?')){ openApiKeyModal(); } }, 1000);
  }
}

function renderAll(){
  renderSidebar();
  renderStats();
  renderVouchers();
}

/* ======== 사이드바 ======== */
function renderSidebar(){
  const all = VOUCHERS.filter(v=> v.date && v.date.startsWith(ym())).length;
  let html = `<div class="sb-card ${activeCardId==='all'?'active':''}" onclick="setActive('all')">
    <span>📋 전체 보기</span><span class="cnt">${all}</span></div>`;
  CARDS.forEach(c=>{
    const cnt = VOUCHERS.filter(v=>v.cardId===c.id && v.date && v.date.startsWith(ym())).length;
    html+=`<div class="sb-card-wrap" style="display:flex;align-items:center;gap:4px;position:relative;">
      <div class="sb-card ${activeCardId===c.id?'active':''}" style="flex:1;min-width:0;" onclick="setActive('${c.id}')">
        <span style="display:flex;align-items:center;gap:5px;overflow:hidden;"><span class="color-dot" style="background:${c.color};flex-shrink:0;"></span><span style="overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</span></span>
        <span class="cnt">${cnt}</span>
      </div>
      <button class="sb-edit-btn" onclick="openEditCard('${c.id}')" title="카드 수정">✏️</button>
    </div>`;
  });
  document.getElementById('cardList').innerHTML=html;
  // targetCard 옵션
  const sel=document.getElementById('targetCard');
  sel.innerHTML=CARDS.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function setActive(id){
  activeCardId=id;
  renderAll();
}

/* ======== 통계 ======== */
function renderStats(){
  const thisMonth = VOUCHERS.filter(v=>v.date&&v.date.startsWith(ym()));
  const total = thisMonth.reduce((s,v)=>s+Number(v.amount||0),0);
  const vat   = thisMonth.reduce((s,v)=>s+Number(v.vat||0),0);
  document.getElementById('st-total').textContent = VOUCHERS.length;
  document.getElementById('st-amt').textContent   = fmtAmt(total);
  document.getElementById('st-vat').textContent   = fmtAmt(vat);
  document.getElementById('st-cards').textContent = CARDS.length;
}

/* ======== 전표 테이블 ======== */
function getVisible(){
  if(activeCardId==='all') return VOUCHERS;
  return VOUCHERS.filter(v=>v.cardId===activeCardId);
}
function renderVouchers(){
  const list = getVisible();
  const card = CARDS.find(c=>c.id===activeCardId);
  document.getElementById('voucherTitle').textContent = card ? card.name+' 전표' : '전체 전표';
  const thisM = list.filter(v=>v.date&&v.date.startsWith(ym()));
  document.getElementById('voucherMeta').textContent = `이번 달 ${thisM.length}건`;
  const tbody = document.getElementById('voucherBody');
  if(!list.length){
    tbody.innerHTML=`<tr><td colspan="10"><div class="empty"><div class="ic">🧾</div><p>등록된 전표가 없습니다</p><div class="sub">영수증을 올리면 AI가 자동으로 전표를 만들어 드립니다</div></div></td></tr>`;
    document.getElementById('sumBar').innerHTML='';
    return;
  }
  const sorted=[...list].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  tbody.innerHTML = sorted.map((v,i)=>{
    const c=CARDS.find(x=>x.id===v.cardId);
    return `<tr>
      <td style="color:var(--t3); font-size:11px;">${i+1}</td>
      <td>${esc(v.date)}</td>
      <td><span class="color-dot" style="background:${c?c.color:'#ccc'};"></span>${esc(c?c.name:'')}</td>
      <td>${esc(v.merchant)}</td>
      <td class="amt">${fmtAmt(v.amount)}</td>
      <td class="amt" style="color:var(--t3);">${fmtAmt(v.vat)}</td>
      <td><span class="acct-tag">${esc(v.acct)}</span></td>
      <td style="color:var(--t2);">${esc(v.cc)}</td>
      <td style="color:var(--t2); max-width:160px; overflow:hidden; text-overflow:ellipsis;">${esc(v.note)}</td>
      <td style="display:flex; gap:4px;">
        <button class="del-btn" onclick="openEdit('${v.id}')" title="수정">✏️</button>
        <button class="del-btn" onclick="deleteVoucher('${v.id}')" title="삭제">🗑</button>
      </td>
    </tr>`;
  }).join('');
  // 합계
  const sumAmt = list.reduce((s,v)=>s+Number(v.amount||0),0);
  const sumVat = list.reduce((s,v)=>s+Number(v.vat||0),0);
  document.getElementById('sumBar').innerHTML=`
    <div class="sum-item"><span class="l">건수</span><span class="v blue">${list.length}건</span></div>
    <div class="sum-item"><span class="l">공급가액 합계</span><span class="v blue">${fmtAmt(sumAmt)}원</span></div>
    <div class="sum-item"><span class="l">부가세 합계</span><span class="v">${fmtAmt(sumVat)}원</span></div>
    <div class="sum-item"><span class="l">총액 (공급가+부가세)</span><span class="v blue">${fmtAmt(sumAmt+sumVat)}원</span></div>`;
}

/* ======== 업로드 ======== */
function showUpload(){
  document.getElementById('uploadZone').style.display='block';
  document.getElementById('cardSelectBar').style.display='none';
  document.getElementById('ocrProgress').classList.remove('show');
  pendingFiles=[];
}
function onDrag(e,over){ e.preventDefault(); document.getElementById('uploadZone').classList.toggle('drag',over); }
function onDrop(e){ e.preventDefault(); document.getElementById('uploadZone').classList.remove('drag'); handleFiles(e.dataTransfer.files); }
function handleFiles(files){
  if(!files||!files.length) return;
  pendingFiles=[...files];
  document.getElementById('cardSelectBar').style.display='flex';
  document.getElementById('uploadZone').style.display='none';
}
function cancelUpload(){
  pendingFiles=[]; document.getElementById('cardSelectBar').style.display='none'; document.getElementById('uploadZone').style.display='block';
  document.getElementById('ocrProgress').classList.remove('show');
}

/* ======== OCR (Claude API) ======== */
async function fileToBase64(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>res(e.target.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(file); });
}
async function ocrOneFile(file){
  const isPDF = file.type==='application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const b64 = await fileToBase64(file);
  const mimeType = isPDF ? 'application/pdf' : (file.type||'image/jpeg');

  const prompt = `이 영수증(또는 카드 매출전표) 이미지에서 정보를 추출해 JSON으로만 답하라. 설명·다른 말 금지.
{
  "date": "YYYY-MM-DD",
  "merchant": "실제 가맹점(상호명)",
  "amount": 공급가액 숫자(부가세 제외),
  "vat": 부가세 숫자,
  "item": "구매 품목/용도 (예: 커피 원두, 우편발송, 유류비, 명절선물, 도서 등)",
  "note": "적요(용도 간단히)"
}
상호 규칙: 실제로 물건·서비스를 판 가맹점 이름만. 결제대행사/PG(이니시스·KG·나이스페이·토스페이먼츠·다날·스마트로·~페이), 구매자(수산이앤에스), 문서제목(매출전표·영수증·신용카드·온라인 등)은 상호가 아니다. 브랜드가 잘못 적혔으면 정식 명칭으로 교정. 확신 없으면 빈 문자열.
자주 나오는 가맹점(있으면 이 표기로 통일): 이마트, 우체국, 롯데마트, 리앙빈 커피컨설팅, 농소농협알뜰주유소, 더케이주유소, 비씨카드정산(후불하이패스), 알라딘, 프린트박스, KB손해보험, 삼성전자서비스.
부가세가 명시돼 있으면 그 값, 없으면 총액의 1/11을 반올림. amount는 부가세를 뺀 공급가액. 날짜가 없으면 ${today()}.`;

  if(!hasApiKey()) throw new Error('API_KEY_MISSING');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const resp = await fetch(url,{
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({
      contents:[{ parts:[ {inline_data:{mime_type:mimeType, data:b64}}, {text:prompt} ] }],
      generationConfig:{ temperature:0, responseMimeType:'application/json', maxOutputTokens:600 }
    })
  });
  if(!resp.ok){ const e=await resp.json().catch(()=>({})); throw new Error((e&&e.error&&e.error.message)||('Gemini API 오류 '+resp.status)); }
  const data = await resp.json();
  const cand = (data.candidates||[])[0]||{};
  const text = (((cand.content||{}).parts)||[]).map(p=>p.text||'').join('').trim();
  if(!text){ throw new Error(cand.finishReason ? ('응답 없음('+cand.finishReason+')') : '응답이 비어 있습니다'); }
  const clean = text.replace(/```json|```/g,'').trim();
  return JSON.parse(clean);
}

async function startOCR(){
  if(!pendingFiles.length) return;
  if(!hasApiKey()){ openApiKeyModal(); return; }
  const cardId = document.getElementById('targetCard').value;
  document.getElementById('cardSelectBar').style.display='none';
  const prog = document.getElementById('ocrProgress');
  prog.classList.add('show');
  const listEl = document.getElementById('ocrList');

  // 파일별 상태 초기화
  const items = pendingFiles.map((f,i)=>({file:f, id:'ocr'+i, status:'wait'}));
  listEl.innerHTML = items.map(it=>`<div class="ocr-item" id="${it.id}">
    <span class="name">${esc(it.file.name)}</span>
    <span class="status status-wait" id="${it.id}-s">대기</span></div>`).join('');

  for(const it of items){
    document.getElementById(it.id+'-s').className='status status-ing';
    document.getElementById(it.id+'-s').innerHTML='<span class="spin">⏳</span> 읽는 중…';
    try{
      const result = await ocrOneFile(it.file);
      const card = CARDS.find(c=>c.id===cardId);
      const cc0 = DEFAULT_CC;                    // 총무 카드 기본 코스트센터(대분류 자동결정)
      const hint = (result.item||'')+' '+(result.note||'');   // 품목+메모로 계정·적요 추론
      const v = {
        id:uid(), cardId,
        date: result.date||today(),
        merchant: result.merchant||'',
        amount: Math.round(Number(result.amount)||0),
        vat:    Math.round(Number(result.vat)||0),
        acct:   guessAcct(result.merchant||'', hint, cc0),
        cc:     cc0,
        note:   guessNote(result.merchant||'', result.item||result.note||'')
      };
      VOUCHERS.push(v);
      document.getElementById(it.id+'-s').className='status status-done';
      document.getElementById(it.id+'-s').textContent='✓ 완료';
    }catch(e){
      document.getElementById(it.id+'-s').className='status status-err';
      const msg = (e&&e.message||String(e))||'';
      const authFail = /API_?KEY|credential|authentication|not valid|PERMISSION|invalid.?auth|OAuth/i.test(msg);
      if(msg==='API_KEY_MISSING'){
        document.getElementById(it.id+'-s').textContent='🔑 API 키 필요';
        openApiKeyModal(); break;
      } else if(authFail){
        document.getElementById(it.id+'-s').textContent='🔑 키 거부됨 — 새 키 필요';
        await clearApiKey();                    // 거부된 옛 키 자동 제거(로컬+클라우드)
        openApiKeyModal();
        document.getElementById('ak-status').textContent='이 키가 거부되었습니다. 새 키를 입력하세요.';
        document.getElementById('ak-status').style.color='var(--red,#d33)';
        break;
      } else {
        document.getElementById(it.id+'-s').textContent='⚠ 실패: '+msg;
      }
      console.error(e);
    }
  }
  pendingFiles=[];
  schedulePush();
  renderAll();
  setTimeout(()=>{ prog.classList.remove('show'); },2500);
}

/* ======== 수정 / 삭제 ======== */
function openEdit(id){
  const v=VOUCHERS.find(x=>x.id===id); if(!v) return;
  editingId=id;
  document.getElementById('ea-date').value=v.date||'';
  document.getElementById('ea-merchant').value=v.merchant||'';
  document.getElementById('ea-amt').value=v.amount||'';
  document.getElementById('ea-vat').value=v.vat||'';
  document.getElementById('ea-acct').value=v.acct||'';
  document.getElementById('ea-cc').value=v.cc||DEFAULT_CC;
  document.getElementById('ea-note').value=v.note||'';
  document.getElementById('editAcctModal').classList.remove('hide');
}
// 코스트센터 변경 시 계정과목 대분류(판관비/제조비용/경상연구개발비) 자동 갱신
function onEditCcChange(){
  const cc=document.getElementById('ea-cc').value;
  const acct=document.getElementById('ea-acct').value;
  const parts=(acct||'').split('_');
  if(parts.length>=2){                         // 대분류 교체(중분류_소분류 유지)
    const rest=(['판관비','제조비용','경상연구개발비'].includes(parts[0])) ? parts.slice(1).join('_') : acct;
    document.getElementById('ea-acct').value = deptDaebun(cc)+'_'+rest;
  }
}
function saveEdit(){
  const v=VOUCHERS.find(x=>x.id===editingId); if(!v) return;
  v.date=document.getElementById('ea-date').value;
  v.merchant=document.getElementById('ea-merchant').value;
  v.amount=Math.round(Number(document.getElementById('ea-amt').value)||0);
  v.vat=Math.round(Number(document.getElementById('ea-vat').value)||0);
  v.acct=document.getElementById('ea-acct').value;
  v.cc=document.getElementById('ea-cc').value;
  v.note=document.getElementById('ea-note').value;
  closeModal('editAcctModal');
  schedulePush(); renderAll();
}
function deleteVoucher(id){
  if(!confirm('이 전표를 삭제할까요?')) return;
  VOUCHERS=VOUCHERS.filter(v=>v.id!==id);
  schedulePush(); renderAll();
}

/* ======== 카드 관리 ======== */
let editingCardId = null;

function getSelectedColor(){
  const checked = document.querySelector('input[name="mc-color"]:checked');
  return checked ? checked.value : '#3182F6';
}
function setSelectedColor(val){
  const radio = document.querySelector(`input[name="mc-color"][value="${val}"]`);
  if(radio) radio.checked = true;
  else document.querySelector('input[name="mc-color"]').checked = true;
}

/* 카드 추가 */
function openAddCard(){
  editingCardId = null;
  document.getElementById('mc-title').textContent = '💳 카드 추가';
  document.getElementById('mc-name').value = '';
  document.getElementById('mc-no').value = '';
  document.getElementById('mc-owner').value = '';
  setSelectedColor('#3182F6');
  document.getElementById('mc-del-btn').style.display = 'none';
  document.getElementById('addCardModal').classList.remove('hide');
  setTimeout(()=>document.getElementById('mc-name').focus(), 100);
}

/* 카드 수정 */
function openEditCard(id){
  const c = CARDS.find(x=>x.id===id); if(!c) return;
  editingCardId = id;
  document.getElementById('mc-title').textContent = '✏️ 카드 수정';
  document.getElementById('mc-name').value = c.name;
  document.getElementById('mc-no').value = c.no||'';
  document.getElementById('mc-owner').value = c.owner||'';
  setSelectedColor(c.color||'#3182F6');
  document.getElementById('mc-del-btn').style.display = 'flex';
  document.getElementById('addCardModal').classList.remove('hide');
  setTimeout(()=>document.getElementById('mc-name').focus(), 100);
}

/* 카드 저장 (추가 or 수정) */
function saveCard(){
  const name = document.getElementById('mc-name').value.trim();
  if(!name){ alert('카드명을 입력해 주세요.'); return; }
  const color = getSelectedColor();
  const no    = document.getElementById('mc-no').value.trim();
  const owner = document.getElementById('mc-owner').value.trim();
  if(editingCardId){
    const c = CARDS.find(x=>x.id===editingCardId);
    if(c){ c.name=name; c.no=no; c.owner=owner; c.color=color; }
  } else {
    CARDS.push({ id:uid(), name, no, owner, color });
  }
  closeModal('addCardModal'); schedulePush(); renderAll();
}

/* 카드 삭제 */
function deleteCard(){
  if(!editingCardId) return;
  const c = CARDS.find(x=>x.id===editingCardId);
  if(!c) return;
  const cnt = VOUCHERS.filter(v=>v.cardId===editingCardId).length;
  if(cnt>0){
    if(!confirm(`"${c.name}"에 등록된 전표가 ${cnt}건 있습니다.\n카드를 삭제하면 해당 전표도 모두 삭제됩니다.\n정말 삭제할까요?`)) return;
    VOUCHERS = VOUCHERS.filter(v=>v.cardId!==editingCardId);
  } else {
    if(!confirm(`"${c.name}" 카드를 삭제할까요?`)) return;
  }
  CARDS = CARDS.filter(x=>x.id!==editingCardId);
  if(activeCardId===editingCardId) activeCardId='all';
  editingCardId=null;
  closeModal('addCardModal'); schedulePush(); renderAll();
}

/* ======== 엑셀 내보내기 ======== */
const XF='맑은 고딕';
const BDR={top:{style:'thin',color:{rgb:'E5E8EB'}},bottom:{style:'thin',color:{rgb:'E5E8EB'}},left:{style:'thin',color:{rgb:'E5E8EB'}},right:{style:'thin',color:{rgb:'E5E8EB'}}};
function hStyle(){ return {font:{name:XF,sz:10,bold:true,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'3182F6'}},alignment:{horizontal:'center',vertical:'center'},border:BDR}; }
function cStyle(alt,isRight){ return {font:{name:XF,sz:9.5,color:{rgb:'191F28'}},fill:{fgColor:{rgb:alt?'FAFBFC':'FFFFFF'}},alignment:{horizontal:isRight?'right':'left',vertical:'center'},border:BDR}; }
function numStyle(alt){ const s=cStyle(alt,true); s.numFmt='#,##0'; return s; }

function exportExcel(){
  if(!VOUCHERS.length){ alert('내보낼 전표가 없습니다.'); return; }
  const wb=XLSX.utils.book_new();
  const COLS=['날짜','카드명','사용처','금액(공급가액)','부가세','계정과목','코스트센터','적요'];
  const WIDTHS=[12,18,20,16,12,14,16,24];

  // 카드별 시트
  CARDS.forEach(card=>{
    const rows=VOUCHERS.filter(v=>v.cardId===card.id).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    if(!rows.length) return;
    const aoa=[];
    // 타이틀
    aoa.push([{v:`${card.name} 법인카드 전표`,s:{font:{name:XF,sz:14,bold:true},alignment:{horizontal:'left',vertical:'center'}}},...Array(COLS.length-1).fill({v:'',s:{}})]);
    // 헤더
    aoa.push(COLS.map(h=>({v:h,s:hStyle()})));
    // 데이터
    rows.forEach((v,i)=>{
      const alt=i%2===1;
      aoa.push([
        {v:v.date,s:cStyle(alt,false)},
        {v:card.name,s:cStyle(alt,false)},
        {v:v.merchant,s:cStyle(alt,false)},
        {v:Number(v.amount||0),s:numStyle(alt)},
        {v:Number(v.vat||0),s:numStyle(alt)},
        {v:v.acct,s:cStyle(alt,false)},
        {v:v.cc,s:cStyle(alt,false)},
        {v:v.note,s:cStyle(alt,false)},
      ]);
    });
    // 합계
    const sumAmt=rows.reduce((s,v)=>s+Number(v.amount||0),0);
    const sumVat=rows.reduce((s,v)=>s+Number(v.vat||0),0);
    const sRow=Array(COLS.length).fill({v:'',s:{}});
    const sBase={font:{name:XF,sz:10,bold:true},fill:{fgColor:{rgb:'EBF2FF'}},alignment:{horizontal:'right',vertical:'center'},border:BDR,numFmt:'#,##0'};
    aoa.push([
      {v:'합계',s:{...sBase,alignment:{horizontal:'left',vertical:'center'}}},
      {v:'',s:sBase},{v:'',s:sBase},
      {v:sumAmt,s:sBase},{v:sumVat,s:sBase},
      {v:'',s:sBase},{v:'',s:sBase},{v:'',s:sBase},
    ]);

    const ws=XLSX.utils.aoa_to_sheet(aoa.map(r=>r.map(c=>c.v)));
    aoa.forEach((r,ri)=>r.forEach((c,ci)=>{ const ref=XLSX.utils.encode_cell({r:ri,c:ci}); if(!ws[ref]) ws[ref]={v:c.v}; ws[ref].s=c.s; ws[ref].t=typeof c.v==='number'?'n':'s'; }));
    ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:COLS.length-1}}];
    ws['!cols']=WIDTHS.map(w=>({wch:w}));
    ws['!rows']=[{hpt:24},{hpt:20}];
    const sheetName=card.name.slice(0,31);
    XLSX.utils.book_append_sheet(wb,ws,sheetName);
  });

  // 전체 합산 시트
  const allRows=VOUCHERS.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  if(allRows.length){
    const aoa=[];
    aoa.push([{v:'법인카드 전표 전체 합산',s:{font:{name:XF,sz:14,bold:true},alignment:{horizontal:'left',vertical:'center'}}},...Array(COLS.length-1).fill({v:'',s:{}})]);
    aoa.push(COLS.map(h=>({v:h,s:hStyle()})));
    allRows.forEach((v,i)=>{
      const alt=i%2===1; const c=CARDS.find(x=>x.id===v.cardId);
      aoa.push([
        {v:v.date,s:cStyle(alt,false)},{v:c?c.name:'',s:cStyle(alt,false)},{v:v.merchant,s:cStyle(alt,false)},
        {v:Number(v.amount||0),s:numStyle(alt)},{v:Number(v.vat||0),s:numStyle(alt)},
        {v:v.acct,s:cStyle(alt,false)},{v:v.cc,s:cStyle(alt,false)},{v:v.note,s:cStyle(alt,false)},
      ]);
    });
    const ws=XLSX.utils.aoa_to_sheet(aoa.map(r=>r.map(c=>c.v)));
    aoa.forEach((r,ri)=>r.forEach((c,ci)=>{ const ref=XLSX.utils.encode_cell({r:ri,c:ci}); if(!ws[ref]) ws[ref]={v:c.v}; ws[ref].s=c.s; ws[ref].t=typeof c.v==='number'?'n':'s'; }));
    ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:COLS.length-1}}];
    ws['!cols']=WIDTHS.map(w=>({wch:w}));
    ws['!rows']=[{hpt:24},{hpt:20}];
    XLSX.utils.book_append_sheet(wb,ws,'전체합산');
  }
  const mon=ym().replace('-','');
  XLSX.writeFile(wb,`법인카드전표_${mon}.xlsx`);
}

/* ======== API 키 모달 ======== */
function openApiKeyModal(){
  document.getElementById('ak-input').value = GEMINI_KEY ? '••••••••••••••••' : '';
  document.getElementById('ak-status').textContent = '';
  document.getElementById('apiKeyModal').classList.remove('hide');
  setTimeout(()=>{ const el=document.getElementById('ak-input'); if(el){ el.value=''; el.focus(); } },100);
}
function confirmApiKey(){
  const v=document.getElementById('ak-input').value.trim();
  const st=document.getElementById('ak-status');
  if(!v){ st.style.color='var(--red)'; st.textContent='키를 입력해 주세요'; return; }
  if(v.length<20){ st.style.color='var(--red)'; st.textContent='올바른 Gemini API 키가 아닙니다 (AIza… 로 시작)'; return; }
  saveApiKey(v);
  updateApiKeyStatus();
  st.style.color='var(--green)';
  st.textContent='✓ 저장 완료! (모든 PC에 자동 공유됩니다)';
  setTimeout(()=>closeModal('apiKeyModal'),900);
}
async function resetApiKey(){
  const st=document.getElementById('ak-status');
  await clearApiKey();
  document.getElementById('ak-input').value='';
  st.style.color='var(--t3)';
  st.textContent='기존 키를 삭제했습니다. 새 키를 붙여넣고 저장하세요.';
}
function updateApiKeyStatus(){
  const el=document.getElementById('apiKeyCnt');
  if(!el) return;
  if(hasApiKey()){ el.textContent='설정됨'; el.style.background='var(--green-bg)'; el.style.color='var(--green)'; }
  else { el.textContent='미설정'; el.style.background='var(--red-bg)'; el.style.color='var(--red)'; }
}

/* ======== 모달 ======== */
function closeModal(id){ document.getElementById(id).classList.add('hide'); editingId=null; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ document.querySelectorAll('.modal-bg:not(.hide)').forEach(m=>m.classList.add('hide')); } });

/* ======== 시작 ======== */
init();
