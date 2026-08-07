/* ============================================================
   applog.js — 공통 로그 수집기 (오류 자동 수집)
   · 모든 앱 <head>에 <script src="applog.js"></script> 로 포함
   · 앱 이름: window.APP_LOG_NAME (없으면 파일명에서 추정)
   · window 오류 / unhandledrejection 을 잡아 Supabase app_store 의
     'error_log' 키(배열, 최근 CAP개)에 append. 인증 없으면 로컬에만 보관.
   · 로컬 폴백: localStorage 'applog_errors' (기기별, 최근 LCAP개)
   ============================================================ */
(function(){
  var SB_URL = 'https://vvyqldyljajlmtydtqdf.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2eXFsZHlsamFqbG10eWR0cWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Nzc4NTQsImV4cCI6MjA5NzI1Mzg1NH0.YakWHeL5ZZK7RZ9K6fwxNECy02uwikoHYdRT-rSpLKc';
  var REST  = SB_URL + '/rest/v1/app_store';
  var KEY   = 'error_log', CAP = 500;        // 클라우드 보관 최대 건수
  var LKEY  = 'applog_errors', LCAP = 200;   // 로컬 보관 최대 건수
  var recent = {};                            // 중복제거: msg -> 마지막 기록시각(ms)
  var queue  = [], pushing = false;

  function appName(){
    if(window.APP_LOG_NAME) return String(window.APP_LOG_NAME);
    try{ var p=(location.pathname.split('/').pop()||'index.html'); return p.replace(/\.html?$/i,'') || 'app'; }
    catch(e){ return 'app'; }
  }
  function token(){ try{ var s=JSON.parse(localStorage.getItem('gm_session')||'null'); return (s&&s.access_token)||''; }catch(e){ return ''; } }
  function nowISO(){ return new Date().toISOString(); }
  function headers(){ var h={ apikey:SB_KEY, 'Content-Type':'application/json' }; var t=token(); if(t) h.Authorization='Bearer '+t; return h; }

  function localSave(entry){
    try{ var a=JSON.parse(localStorage.getItem(LKEY)||'[]'); if(!Array.isArray(a)) a=[]; a.unshift(entry); if(a.length>LCAP) a=a.slice(0,LCAP); localStorage.setItem(LKEY, JSON.stringify(a)); }catch(e){}
  }
  function sbGet(k){
    return fetch(REST+'?key=eq.'+encodeURIComponent(k)+'&select=value',{ headers:headers() })
      .then(function(r){ return r.ok?r.json():[]; })
      .then(function(rows){ return (rows&&rows[0]&&rows[0].value)||null; })
      .catch(function(){ return null; });
  }
  function sbSet(k,v){
    var h=headers(); h.Prefer='resolution=merge-duplicates';
    return fetch(REST+'?on_conflict=key',{ method:'POST', headers:h, body:JSON.stringify({ key:k, value:v, updated_at:nowISO() }) })
      .then(function(r){ return r.ok; }).catch(function(){ return false; });
  }

  function flush(){
    if(pushing || !queue.length) return;
    if(!token()) return;                       // 미인증 → 로컬만 유지, 로그인 후 재시도
    pushing = true;
    var batch = queue.slice();
    sbGet(KEY).then(function(cur){
      var arr = Array.isArray(cur) ? cur : [];
      arr = batch.concat(arr);
      if(arr.length>CAP) arr = arr.slice(0,CAP);
      return sbSet(KEY, arr).then(function(ok){
        pushing=false;
        if(ok){ queue = queue.slice(batch.length); }
        if(queue.length) setTimeout(flush, 2000);
      });
    }).catch(function(){ pushing=false; });
  }

  function record(level, msg, stack, src){
    msg = String(msg==null?'':msg).slice(0,500);
    if(!msg || /ResizeObserver loop/i.test(msg)) return;   // 무해한 잡음 제외
    var now = Date.now();
    if(recent[msg] && (now-recent[msg])<10000) return;     // 10초 내 동일 메시지 억제
    recent[msg] = now;
    var entry = { ts:nowISO(), app:appName(), level:level||'error', msg:msg,
                  stack:String(stack||'').slice(0,1500), url:location.href.slice(0,300),
                  src:String(src||'').slice(0,200) };
    localSave(entry);
    queue.unshift(entry);
    setTimeout(flush, 600);
  }

  window.addEventListener('error', function(e){
    try{ record('error', (e&&e.message)||'스크립트 오류', (e&&e.error&&e.error.stack)||'', (e&&e.filename)||''); }catch(_){}
  });
  window.addEventListener('unhandledrejection', function(e){
    try{ var r=e&&e.reason; record('error', (r&&r.message)||String(r||'unhandledrejection'), (r&&r.stack)||''); }catch(_){}
  });
  window.addEventListener('load', function(){ setTimeout(flush, 1200); });   // 로그인된 상태면 초기 대기분 전송

  // 수동 기록 API
  window.AppLog = {
    error: function(msg, stack){ record('error', msg, stack); },
    warn:  function(msg){ record('warn', msg); },
    info:  function(msg){ record('info', msg); },
    flush: flush
  };
})();
