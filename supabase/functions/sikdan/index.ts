// 슬랙 /식단표 슬래시 명령 핸들러 (Supabase Edge Function, Deno)
// 오늘(KST)의 매곡테크노파크 식단을 menu.json에서 읽어 슬랙에 응답한다.
//
// 배포: Supabase 대시보드 → Edge Functions → "sikdan" 생성 후 이 코드 붙여넣기 → Deploy
// 환경변수(Settings → Edge Functions → Secrets): SLACK_SIGNING_SECRET = 슬랙 앱의 Signing Secret
// 슬랙 앱: Slash Commands → /식단표 → Request URL = 이 함수의 URL

const MENU_URL = "https://nicehehe-jpg.github.io/general-affiairs-for-soosan/menu.json";
const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
const DAY = ["일", "월", "화", "수", "목", "금", "토"];

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 슬랙 요청 서명 검증 (HMAC-SHA256) + 5분 리플레이 방지
async function verifySlack(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig || !SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + toHex(mac);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// 오늘 날짜(KST, UTC+9)
function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const rawBody = await req.text();
  if (!(await verifySlack(req, rawBody))) {
    return new Response("invalid signature", { status: 401 });
  }

  const now = kstNow();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const dow = DAY[now.getUTCDay()];

  let menu: Record<string, { lunch?: string[]; dinner?: string[] | null }> = {};
  try {
    const r = await fetch(MENU_URL, { headers: { "cache-control": "no-cache" } });
    if (r.ok) menu = await r.json();
  } catch (_e) { /* 네트워크 실패 시 아래에서 안내 */ }

  const d = menu[today];
  let text: string;
  if (d && d.lunch && d.lunch.length) {
    const lunch = d.lunch.map((x) => "• " + x).join("\n");
    const dinner = d.dinner && d.dinner.length
      ? "\n\n*🌙 저녁*\n" + d.dinner.map((x) => "• " + x).join("\n")
      : "";
    text = `*🍱 매곡테크노파크 식단표 — ${today} (${dow})*\n\n*☀️ 점심*\n${lunch}${dinner}`;
  } else {
    text = `🚫 오늘(${today}) 식단 정보가 없습니다.\n주말·공휴일이거나 아직 갱신 전일 수 있어요. https://www.stxfood.com/archives/menu/list 에서 확인해 주세요.`;
  }

  // response_type: "ephemeral" = 명령 입력한 본인만 봄. 모두에게 보이려면 "in_channel"
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    headers: { "content-type": "application/json" },
  });
});
