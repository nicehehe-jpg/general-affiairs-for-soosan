/* =====================================================================
 *  shared.js — 총무관리시스템 공통 모듈 (인증 · 클라우드 동기화 · 유틸)
 *  사용법: 다른 스크립트보다 먼저 <script src="shared.js"></script>
 *
 *  이 모듈은 페이지마다 복붙돼 있던 Supabase 설정/인증/동기화/게이트를
 *  한곳으로 모읍니다. 핵심 보안 변경:
 *   - 데이터 호출은 "로그인 토큰만" 사용(익명키 fallback 제거) → RLS 전제.
 *   - 페이지 진입 시 Supabase Auth 로그인 게이트를 강제(미로그인 시 차단).
 *   - anon 키는 "로그인 요청" 자체에만 쓰임(공개돼도 되는 값).
 * ===================================================================== */
(function () {
  'use strict';

  var SB_URL = 'https://vvyqldyljajlmtydtqdf.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2eXFsZHlsamFqbG10eWR0cWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2Nzc4NTQsImV4cCI6MjA5NzI1Mzg1NH0.YakWHeL5ZZK7RZ9K6fwxNECy02uwikoHYdRT-rSpLKc';
  var SB_REST = SB_URL + '/rest/v1/app_store';
  var AUTH_EMAIL = 'nicehehe@soosan.co.kr';   // 일반(공용) 계정
  var ADMIN_EMAIL = 'admin@soosan.co.kr';      // 관리자 계정 — 명부 편집·일정 추가 권한
  var GM_SESSION = 'gm_session';

  /* ── 세션/인증 ─────────────────────────────────────────────── */
  function gmGetSession() { try { return JSON.parse(localStorage.getItem(GM_SESSION) || 'null'); } catch (e) { return null; } }
  function gmSetSession(d) { try { localStorage.setItem(GM_SESSION, JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token })); } catch (e) {} }
  function gmClearSession() { try { localStorage.removeItem(GM_SESSION); } catch (e) {} }
  function gmToken() { var s = gmGetSession(); return (s && s.access_token) || ''; }

  /* JWT payload 디코드 → 현재 로그인 이메일/역할 판별 */
  function gmDecode(tok) {
    try { var p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); while (p.length % 4) p += '='; return JSON.parse(atob(p)); }
    catch (e) { return {}; }
  }
  function gmEmail() { var t = gmToken(); return t ? (gmDecode(t).email || '') : ''; }
  function gmIsAdmin() { return gmEmail().toLowerCase() === ADMIN_EMAIL.toLowerCase(); }

  /* 데이터 호출 헤더: 로그인 토큰만(anon fallback 없음). 토큰 없으면 401 → 게이트. */
  function gmAuthHeaders() { return { apikey: SB_KEY, Authorization: 'Bearer ' + gmToken(), 'Content-Type': 'application/json' }; }

  async function gmSignIn(password, email) {
    var r = await fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email || AUTH_EMAIL, password: password })
    });
    var d = await r.json().catch(function () { return {}; });
    if (!d.access_token) throw new Error(d.error_description || d.msg || d.error || '로그인 실패');
    gmSetSession(d); return true;
  }
  async function gmRefresh() {
    var s = gmGetSession(); if (!s || !s.refresh_token) return false;
    var r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    var d = await r.json().catch(function () { return {}; });
    if (d.access_token) { gmSetSession(d); return true; }
    gmClearSession(); return false;
  }
  async function gmChangePassword(newPassword) {
    var call = function () {
      return fetch(SB_URL + '/auth/v1/user', {
        method: 'PUT', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + gmToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword })
      });
    };
    var r = await call();
    if (r.status === 401 && await gmRefresh()) r = await call();
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error_description || d.msg || d.error || ('변경 실패(' + r.status + ')'));
    return true;
  }
  function gmSignOut() { gmClearSession(); location.reload(); }

  /* ── 동기화 상태 배지 ──────────────────────────────────────── */
  function setSyncStatus(state) {
    var b = document.getElementById('syncBadge'); if (!b) return;
    var map = { online: ['online', '☁ 연결됨'], saving: ['saving', '💾 저장 중…'], loading: ['loading', '☁ 연결 중…'], offline: ['offline', '⚠ 오프라인(로컬)'] };
    var v = map[state] || map.loading;
    b.className = 'sync-badge ' + v[0]; b.textContent = v[1];
  }

  /* ── app_store key-value 동기화 ────────────────────────────── */
  async function sbGet(key) {
    try {
      var url = SB_REST + '?key=eq.' + encodeURIComponent(key) + '&select=value';
      var r = await fetch(url, { headers: gmAuthHeaders() });
      if (r.status === 401 && await gmRefresh()) r = await fetch(url, { headers: gmAuthHeaders() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var rows = await r.json();
      return rows.length ? rows[0].value : null;
    } catch (e) { return undefined; }
  }
  async function sbSet(key, value) {
    try {
      var url = SB_REST + '?on_conflict=key';
      var body = JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() });
      var opts = function () { return { method: 'POST', headers: Object.assign({}, gmAuthHeaders(), { Prefer: 'resolution=merge-duplicates' }), body: body }; };
      var r = await fetch(url, opts());
      if (r.status === 401 && await gmRefresh()) r = await fetch(url, opts());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    } catch (e) { return false; }
  }
  var _pushTimers = {};
  function sbPush(key, value) {
    setSyncStatus('saving');
    clearTimeout(_pushTimers[key]);
    _pushTimers[key] = setTimeout(async function () {
      var ok = await sbSet(key, value);
      setSyncStatus(ok ? 'online' : 'offline');
    }, 600);
  }

  /* ── HTML 이스케이프 유틸(XSS 방지) ────────────────────────── */
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }

  /* ── 로그인 게이트(Supabase Auth) ──────────────────────────── */
  function injectGate() {
    if (document.getElementById('gmGate')) return;
    var g = document.createElement('div');
    g.id = 'gmGate';
    g.setAttribute('style', "position:fixed;inset:0;z-index:99999;background:#F2F4F6;display:flex;align-items:center;justify-content:center;font-family:'Pretendard',-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;");
    g.innerHTML =
      '<div style="background:#fff;border-radius:22px;padding:40px 32px;width:340px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;">' +
      '<div style="font-size:38px;margin-bottom:10px;">🔐</div>' +
      '<div style="font-size:19px;font-weight:800;color:#191F28;margin-bottom:4px;">총무 관리 시스템</div>' +
      '<div id="gmGateSub" style="font-size:12.5px;color:#8B95A1;margin-bottom:22px;">수산이앤에스 · 접근하려면 비밀번호를 입력하세요</div>' +
      '<input id="gmGatePw" type="password" placeholder="비밀번호 입력" style="width:100%;padding:13px 14px;border:1.5px solid #E5E8EB;border-radius:12px;font-size:15px;font-family:inherit;text-align:center;margin-bottom:8px;box-sizing:border-box;outline:none;">' +
      '<div id="gmGateErr" style="font-size:12px;color:#F04452;font-weight:700;height:18px;margin-bottom:8px;"></div>' +
      '<button id="gmGateBtn" style="width:100%;padding:13px;background:#3182F6;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">들어가기</button>' +
      '<div id="gmGateToggle" style="margin-top:14px;font-size:12px;color:#8B95A1;cursor:pointer;user-select:none;">🔧 관리자로 로그인</div>';
    document.body.appendChild(g);
    var pw = g.querySelector('#gmGatePw');
    var err = g.querySelector('#gmGateErr');
    var btn = g.querySelector('#gmGateBtn');
    var sub = g.querySelector('#gmGateSub');
    var toggle = g.querySelector('#gmGateToggle');
    var busy = false, asAdmin = false;
    toggle.addEventListener('click', function () {
      asAdmin = !asAdmin;
      if (asAdmin) {
        sub.innerHTML = '<b style="color:#3182F6">관리자 로그인</b> · ' + ADMIN_EMAIL;
        btn.style.background = '#191F28';
        toggle.textContent = '↩ 일반 로그인으로';
      } else {
        sub.textContent = '수산이앤에스 · 접근하려면 비밀번호를 입력하세요';
        btn.style.background = '#3182F6';
        toggle.textContent = '🔧 관리자로 로그인';
      }
      err.textContent = ''; pw.value = ''; pw.focus();
    });
    async function submit() {
      var v = (pw.value || '').trim(); if (!v || busy) return;
      busy = true; btn.textContent = '확인 중…'; err.textContent = '';
      try {
        await gmSignIn(v, asAdmin ? ADMIN_EMAIL : AUTH_EMAIL);
        location.reload();                 // 로그인 성공 → 토큰 보유 상태로 재로딩(데이터 정상 로드)
      } catch (e) {
        busy = false; btn.textContent = '들어가기';
        err.textContent = '비밀번호가 올바르지 않습니다';
        pw.value = ''; pw.focus();
        setTimeout(function () { err.textContent = ''; }, 2500);
      }
    }
    btn.addEventListener('click', submit);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    setTimeout(function () { pw.focus(); }, 100);
  }
  function ensureGate() {
    if (gmToken()) return;   // 세션 있으면 통과(만료는 데이터 호출 401→gmRefresh로 처리)
    injectGate();
  }

  /* ── 전역 노출(기존 페이지 코드가 전역 이름으로 호출) ─────────── */
  var api = { SB_URL: SB_URL, SB_KEY: SB_KEY, SB_REST: SB_REST, AUTH_EMAIL: AUTH_EMAIL, ADMIN_EMAIL: ADMIN_EMAIL,
    gmGetSession: gmGetSession, gmSetSession: gmSetSession, gmClearSession: gmClearSession, gmToken: gmToken,
    gmEmail: gmEmail, gmIsAdmin: gmIsAdmin,
    gmAuthHeaders: gmAuthHeaders, gmSignIn: gmSignIn, gmRefresh: gmRefresh, gmChangePassword: gmChangePassword, gmSignOut: gmSignOut,
    setSyncStatus: setSyncStatus, sbGet: sbGet, sbSet: sbSet, sbPush: sbPush, esc: esc, escAttr: escAttr };
  window.GM = api;
  Object.keys(api).forEach(function (n) { if (typeof window[n] === 'undefined') window[n] = api[n]; });

  // body가 이미 있으면(스크립트가 body 안에 위치) 즉시 게이트 → 콘텐츠 깜빡임 최소화
  if (document.body) ensureGate();
  else document.addEventListener('DOMContentLoaded', ensureGate);
})();
