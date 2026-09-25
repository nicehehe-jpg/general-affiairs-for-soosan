// 카카오톡 개인 업무 비서 — 할 일(todos_v2) 스킬 서버 (Supabase Edge Function, Deno)
// 카카오톡 채널 챗봇(카카오 i 오픈빌더)에 보낸 메시지를 받아 총무관리시스템의 할 일을 조회·추가·완료·삭제한다.
//
// 배포: Supabase 대시보드 → Edge Functions → "kakao-todo" 생성 후 이 코드 붙여넣기 → Deploy
//       ※ 카카오는 Supabase JWT를 보내지 않으므로 함수 설정에서 "Enforce JWT verification"을 꺼야 한다.
//         (CLI: supabase functions deploy kakao-todo --no-verify-jwt)
// 환경변수(Settings → Edge Functions → Secrets):
//   KAKAO_SKILL_TOKEN = 임의의 긴 문자열. 오픈빌더 스킬 URL 끝에 ?key=<이 값> 으로 붙인다(외부 호출 차단).
//   KAKAO_OWNER_ID    = 나의 카카오 사용자 ID(botUserKey). 비워 두면 봇이 내 ID를 알려주는 "등록 모드"로 동작.
//   GEMINI_API_KEY    = (선택) 설정하면 자유 문장을 AI가 제목/기한/시간/우선순위로 정리. 없으면 규칙 기반 파싱.
//   GEMINI_MODEL      = (선택) 기본값 gemini-3.6-flash
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동 주입한다(RLS 우회용 service_role).
//
// 명령 예시: "할일" · "오늘" · "내일" · "이번주" · "완료 2" · "삭제 3" · "도움말"
//           그 외 문장은 할 일로 추가: "내일 오전 10시 회의 준비" → 기한 내일, 메모 ⏰ 10:00

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SKILL_TOKEN = Deno.env.get("KAKAO_SKILL_TOKEN") ?? "";
const OWNER_ID = Deno.env.get("KAKAO_OWNER_ID") ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const PRIORITY_LABEL: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

type Todo = {
  id: string;
  title: string;
  memo: string;
  priority: string;
  categoryId: string;
  dueDate: string;
  tags: string[];
  isCompleted: boolean;
  completedAt: string | null;
  subTasks: unknown[];
  createdAt: string;
  updatedAt: string;
};
type GongmuTask = { id: string | number; title: string; due?: string; status?: string; priority?: string };

/* ── 날짜 유틸 (KST 기준, YYYY-MM-DD 문자열로 다룸) ───────────────── */
function kstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowOf(ymd: string): number {
  return new Date(ymd + "T00:00:00Z").getUTCDay();
}
function fmtDue(ymd: string, today: string): string {
  if (!ymd) return "";
  if (ymd === today) return "오늘";
  if (ymd === addDays(today, 1)) return "내일";
  const [, m, d] = ymd.split("-").map(Number);
  const label = `${m}/${d}(${DAY[dowOf(ymd)]})`;
  return ymd < today ? `${label} 지남` : label;
}

/* ── app_store 읽기/쓰기 (service_role) ─────────────────────────── */
function sbHeaders(): Record<string, string> {
  return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };
}
async function sbGet<T>(key: string): Promise<T | null> {
  const r = await fetch(`${SB_URL}/rest/v1/app_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: sbHeaders(),
  });
  if (!r.ok) throw new Error(`app_store 읽기 실패(${r.status})`);
  const rows = await r.json();
  return rows.length ? rows[0].value as T : null;
}
async function sbSet(key: string, value: unknown): Promise<void> {
  const r = await fetch(`${SB_URL}/rest/v1/app_store?on_conflict=key`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`app_store 저장 실패(${r.status})`);
}
async function loadTodos(): Promise<Todo[]> {
  const v = await sbGet<Todo[]>("todos_v2");
  return Array.isArray(v) ? v : [];
}
async function loadGongmu(): Promise<GongmuTask[]> {
  try {
    const v = await sbGet<GongmuTask[]>("gongmu_tasks_v1");
    return Array.isArray(v) ? v : [];
  } catch (_e) {
    return [];
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ── 번호 매기기: 미완료 할 일을 기한순(기한 없음은 뒤)·생성순으로 정렬 ──
   목록에 보이는 번호와 "완료 N"/"삭제 N"의 번호가 항상 같은 규칙을 쓴다. */
function pendingSorted(todos: Todo[]): Todo[] {
  return todos
    .filter((t) => !t.isCompleted)
    .sort((a, b) => {
      const da = a.dueDate || "9999-12-31", db = b.dueDate || "9999-12-31";
      if (da !== db) return da < db ? -1 : 1;
      return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
    });
}

/* ── 자연어 → 할 일 (규칙 기반) ─────────────────────────────────── */
type Parsed = { title: string; dueDate: string; time: string; priority: string };

function parseRule(text: string, today: string): Parsed {
  let s = " " + text.trim() + " ";
  let dueDate = "";
  let time = "";
  let priority = "medium";

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (m) {
      fn(m);
      s = s.replace(re, " ");
    }
  };

  // 날짜
  take(/\s(오늘)\s/, () => (dueDate = today));
  if (!dueDate) take(/\s(내일)\s/, () => (dueDate = addDays(today, 1)));
  if (!dueDate) take(/\s(모레)\s/, () => (dueDate = addDays(today, 2)));
  if (!dueDate) take(/\s(\d{1,3})\s*일\s*(후|뒤)\s/, (m) => (dueDate = addDays(today, Number(m[1]))));
  if (!dueDate) {
    take(/\s(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*(?:월|[.\-/])\s*(\d{1,2})\s*일?\s/, (m) => {
      const y = m[1] ? Number(m[1]) : Number(today.slice(0, 4));
      const mo = Number(m[2]), d = Number(m[3]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        let ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (!m[1] && ymd < today) ymd = `${y + 1}${ymd.slice(4)}`; // 연도 생략 + 지난 날짜 → 내년
        dueDate = ymd;
      }
    });
  }
  if (!dueDate) {
    take(/\s(이번\s*주|다음\s*주|담주|차주)?\s*([월화수목금토일])요일\s/, (m) => {
      const target = DAY.indexOf(m[2]);
      const cur = dowOf(today);
      // 이번 주 월요일 기준으로 계산(한국식 주: 월~일)
      const monday = addDays(today, -((cur + 6) % 7));
      const offset = (target + 6) % 7;
      const next = m[1] && !/이번/.test(m[1]);
      let ymd = addDays(monday, offset + (next ? 7 : 0));
      if (!m[1] && ymd < today) ymd = addDays(ymd, 7); // "금요일"만 → 다가오는 금요일
      dueDate = ymd;
    });
  }

  // 시간
  take(/\s(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*(?:시|:)\s*(?:(\d{1,2})\s*분?|(반))?\s*(?:까지|에)?\s/, (m) => {
    let h = Number(m[2]);
    const min = m[4] ? 30 : m[3] ? Number(m[3]) : 0;
    if (m[1] && /오후|저녁|밤/.test(m[1]) && h < 12) h += 12;
    if (m[1] && /오전|아침/.test(m[1]) && h === 12) h = 0;
    if (h <= 23 && min <= 59) time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  });

  // 우선순위
  take(/\s(급함|긴급|중요|!{2,})\s/, () => (priority = "high"));

  // 끝맺음 정리: "~해야 해", "~하기" 등은 그대로 두되 불필요한 어미만 제거
  const title = s.replace(/\s+/g, " ").trim()
    .replace(/\s*(해야\s*(해|함|돼|됨|한다|합니다)|하기로\s*함|할\s*것)[.!~]*$/, " ")
    .replace(/^(추가|등록)\s*[:：]?\s*/, "")
    .trim() || text.trim();

  return { title, dueDate, time, priority };
}

/* ── 자연어 → 할 일 (Gemini, 선택) — 실패하거나 느리면 규칙 기반 결과 사용 ── */
async function parseAI(text: string, today: string, fallback: Parsed): Promise<Parsed> {
  if (!GEMINI_KEY) return fallback;
  const prompt =
    `오늘은 ${today}(${DAY[dowOf(today)]}요일, 한국시간)입니다. 아래 메시지를 할 일 하나로 정리해 JSON만 출력하세요.\n` +
    `형식: {"title":"간결한 할 일 제목","dueDate":"YYYY-MM-DD 또는 빈 문자열","time":"HH:MM 또는 빈 문자열","priority":"high|medium|low"}\n` +
    `메시지: ${text}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500); // 카카오 스킬 응답 제한(5초) 안에 끝내기
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: "application/json" },
        }),
      },
    );
    clearTimeout(timer);
    if (!r.ok) return fallback;
    const data = await r.json();
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());
    return {
      title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : fallback.title,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(j.dueDate ?? "") ? j.dueDate : fallback.dueDate,
      time: /^\d{2}:\d{2}$/.test(j.time ?? "") ? j.time : fallback.time,
      priority: ["high", "medium", "low"].includes(j.priority) ? j.priority : fallback.priority,
    };
  } catch (_e) {
    return fallback;
  }
}

/* ── 명령 처리 ──────────────────────────────────────────────────── */
function line(t: Todo, n: number, today: string): string {
  const due = fmtDue(t.dueDate, today);
  const time = (t.memo.match(/⏰\s*(\d{2}:\d{2})/) || [])[1];
  const meta = [due, time].filter(Boolean).join(" ");
  return `${n}. ${PRIORITY_LABEL[t.priority] ?? "🟡"} ${t.title}${meta ? ` — ${meta}` : ""}`;
}

async function cmdList(scope: "all" | "today" | "tomorrow" | "week"): Promise<string> {
  const today = kstToday();
  const [todos, gongmu] = await Promise.all([loadTodos(), loadGongmu()]);
  const pending = pendingSorted(todos);

  let until = "9999-12-31";
  let title = "📋 남은 할 일";
  if (scope === "today") (until = today), (title = `📅 오늘(${today.slice(5)}) 할 일`);
  if (scope === "tomorrow") (until = addDays(today, 1)), (title = "📅 내일까지 할 일");
  if (scope === "week") {
    until = addDays(today, 6 - ((dowOf(today) + 6) % 7)); // 이번 주 일요일
    title = "📅 이번 주 할 일";
  }

  // 번호는 전체 미완료 목록 기준 → "완료 N"이 어느 목록에서 보든 같은 항목을 가리킨다
  const rows = pending
    .map((t, i) => ({ t, n: i + 1 }))
    .filter(({ t }) => scope === "all" || (t.dueDate && t.dueDate <= until));

  const out: string[] = [title];
  if (!rows.length) out.push("없어요 👍");
  else out.push(...rows.slice(0, 30).map(({ t, n }) => line(t, n, today)));
  if (rows.length > 30) out.push(`… 외 ${rows.length - 30}건`);

  // 총무 업무(gongmu_tasks_v1) 중 기한이 범위 안이고 미완료인 것 — 조회만
  const g = gongmu
    .filter((t) => t.due && t.status !== "done" && t.due <= (scope === "all" ? addDays(today, 7) : until))
    .sort((a, b) => ((a.due ?? "") < (b.due ?? "") ? -1 : 1));
  if (g.length) {
    out.push("", "🗂 총무 업무" + (scope === "all" ? "(7일 이내)" : ""));
    out.push(...g.slice(0, 10).map((t) => `• ${t.title} — ${fmtDue(t.due ?? "", today)}`));
  }
  if (rows.length) out.push("", "완료하려면 \"완료 번호\", 삭제는 \"삭제 번호\"");
  return out.join("\n");
}

async function cmdComplete(arg: string, remove: boolean): Promise<string> {
  const today = kstToday();
  const todos = await loadTodos();
  const pending = pendingSorted(todos);
  let target: Todo | undefined;
  if (/^\d+$/.test(arg)) target = pending[Number(arg) - 1];
  else if (arg) {
    const hits = pending.filter((t) => t.title.includes(arg));
    if (hits.length > 1) {
      return `"${arg}"에 해당하는 할 일이 ${hits.length}개예요. 번호로 알려주세요.\n` +
        hits.slice(0, 10).map((t) => line(t, pending.indexOf(t) + 1, today)).join("\n");
    }
    target = hits[0];
  }
  if (!target) return `해당 할 일을 찾지 못했어요. "할일"로 목록과 번호를 확인해 주세요.`;

  const now = new Date().toISOString();
  const next = remove
    ? todos.filter((t) => t.id !== target!.id)
    : todos.map((t) => (t.id === target!.id ? { ...t, isCompleted: true, completedAt: now, updatedAt: now } : t));
  await sbSet("todos_v2", next);
  return remove ? `🗑 삭제했어요: ${target.title}` : `✅ 완료 처리했어요: ${target.title}`;
}

async function cmdAdd(text: string): Promise<string> {
  const today = kstToday();
  const parsed = await parseAI(text, today, parseRule(text, today));
  const now = new Date().toISOString();
  const todo: Todo = {
    id: uid(),
    title: parsed.title,
    memo: [parsed.time ? `⏰ ${parsed.time}` : "", `카카오톡: ${text}`].filter(Boolean).join("\n"),
    priority: parsed.priority,
    categoryId: "",
    dueDate: parsed.dueDate,
    tags: ["카톡"],
    isCompleted: false,
    completedAt: null,
    subTasks: [],
    createdAt: now,
    updatedAt: now,
  };
  const todos = await loadTodos();
  todos.unshift(todo);
  await sbSet("todos_v2", todos);
  const n = pendingSorted(todos).findIndex((t) => t.id === todo.id) + 1;
  const meta = [parsed.dueDate ? `📅 ${fmtDue(parsed.dueDate, today)}` : "📅 기한 없음", parsed.time ? `⏰ ${parsed.time}` : ""]
    .filter(Boolean).join("  ");
  return `📝 할 일에 추가했어요 (${n}번)\n${PRIORITY_LABEL[todo.priority]} ${todo.title}\n${meta}\n\n잘못 들어갔으면 "삭제 ${n}"`;
}

const HELP = [
  "🤖 총무 할 일 비서 사용법",
  "",
  "• 그냥 보내기 → 할 일 추가",
  "  예) 내일 오전 10시 회의 준비",
  "  예) 10/2 소방점검 업체 연락 급함",
  "• 할일 · 목록 → 남은 할 일 전체",
  "• 오늘 · 내일 · 이번주 → 기간별 보기",
  "• 완료 2 / 완료 소방 → 완료 처리",
  "• 삭제 2 → 삭제",
].join("\n");

async function handle(utterance: string): Promise<string> {
  const u = utterance.trim().replace(/\s+/g, " ");
  if (!u) return HELP;
  if (/^(도움말|help|\?|사용법|메뉴)$/i.test(u)) return HELP;
  if (/^(할\s*일|할일\s*목록|목록|전체|리스트)$/.test(u)) return cmdList("all");
  if (/^오늘(\s*할\s*일)?$/.test(u)) return cmdList("today");
  if (/^내일(\s*할\s*일)?$/.test(u)) return cmdList("tomorrow");
  if (/^이번\s*주(\s*할\s*일)?$/.test(u)) return cmdList("week");
  let m = u.match(/^(완료|끝|done)\s*(.*)$/i);
  if (m) return cmdComplete(m[2].trim(), false);
  m = u.match(/^(삭제|지워|취소)\s*(.*)$/);
  if (m) return cmdComplete(m[2].trim(), true);
  return cmdAdd(u);
}

/* ── 카카오 스킬 응답 ───────────────────────────────────────────── */
function kakaoText(text: string): Response {
  // simpleText 최대 1000자
  const t = text.length > 1000 ? text.slice(0, 990) + "\n…(생략)" : text;
  return new Response(
    JSON.stringify({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: t } }],
        quickReplies: [
          { label: "오늘", action: "message", messageText: "오늘" },
          { label: "이번주", action: "message", messageText: "이번주" },
          { label: "전체 목록", action: "message", messageText: "할일" },
          { label: "도움말", action: "message", messageText: "도움말" },
        ],
      },
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  if (!SKILL_TOKEN || url.searchParams.get("key") !== SKILL_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }

  let body: { userRequest?: { utterance?: string; user?: { id?: string } } };
  try {
    body = await req.json();
  } catch (_e) {
    return new Response("bad request", { status: 400 });
  }
  const userId = body.userRequest?.user?.id ?? "";
  const utterance = body.userRequest?.utterance ?? "";

  // 개인 비서: 등록된 본인만 사용. 미등록이면 내 ID를 알려줘서 KAKAO_OWNER_ID에 넣게 한다.
  if (!OWNER_ID) {
    return kakaoText(`🔧 등록 모드입니다.\n아래 ID를 Supabase Secrets의 KAKAO_OWNER_ID에 저장하세요.\n\n${userId}`);
  }
  if (userId !== OWNER_ID) return kakaoText("이 봇은 등록된 사용자만 쓸 수 있어요.");

  try {
    return kakaoText(await handle(utterance));
  } catch (e) {
    return kakaoText(`⚠️ 처리 중 오류가 났어요: ${(e as Error).message}`);
  }
});
