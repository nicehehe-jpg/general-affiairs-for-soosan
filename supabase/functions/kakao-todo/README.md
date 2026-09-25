# 카카오톡 할 일 비서 (kakao-todo)

카카오톡 채널 챗봇에 메시지를 보내면 총무관리시스템의 **할 일(todos_v2)** 을 추가·조회·완료·삭제합니다.
앱(할 일 관리 · 메인 대시보드)과 같은 Supabase `app_store` 데이터를 쓰므로 카톡에서 넣은 항목이 앱에 바로 보입니다.

```
나의 카카오톡 ──▶ 카카오톡 채널 챗봇(오픈빌더, 폴백 블록 → 스킬)
                         │ POST (5초 안에 응답)
                         ▼
              Supabase Edge Function  kakao-todo
                ├─ 규칙 기반 파싱(오늘/내일/모레/N일 후/10월 2일/10/2/다음주 수요일/오후 3시 반)
                ├─ (선택) Gemini로 자유 문장 정리 — 2.5초 넘으면 규칙 결과 사용
                └─ app_store: todos_v2 읽기/쓰기, gongmu_tasks_v1 조회
                         ▼
              총무관리시스템 todo.html / index.html
```

## 사용법 (카톡에서)

| 보내는 말 | 동작 |
|---|---|
| `내일 오전 10시 회의 준비해야 해` | 할 일 추가 (기한 내일, 메모 ⏰ 10:00, 태그 `카톡`) |
| `10/2 소방점검 업체 연락 급함` | 할 일 추가 (우선순위 높음) |
| `할일` / `목록` | 남은 할 일 전체 + 7일 이내 총무 업무 |
| `오늘` / `내일` / `이번주` | 기간별 보기(지난 것 포함) |
| `완료 2` / `완료 소방` | 번호 또는 제목 일부로 완료 처리 |
| `삭제 2` | 삭제 |
| `도움말` | 사용법 |

번호는 "미완료 할 일을 기한순으로 정렬한 순서"라서 어떤 목록에서 봐도 같은 항목을 가리킵니다.

## 설치 순서

### 1. Edge Function 배포
1. Supabase 대시보드 → Edge Functions → **kakao-todo** 생성 → `index.ts` 붙여넣기 → Deploy
2. 함수 설정에서 **Enforce JWT verification 끄기** (카카오는 Supabase 토큰을 보내지 않음)
   - CLI라면 `supabase functions deploy kakao-todo --no-verify-jwt`
3. Settings → Edge Functions → Secrets
   - `KAKAO_SKILL_TOKEN` : 길고 임의인 문자열 (예: 비밀번호 생성기로 32자)
   - `GEMINI_API_KEY` : (선택) 자유 문장 AI 정리용
   - `KAKAO_OWNER_ID` : 3단계에서 확인 후 입력

### 2. 카카오톡 채널 + 챗봇
1. [카카오톡 채널 관리자센터](https://center-pf.kakao.com)에서 개인용 채널 생성 (비공개/검색 비허용 권장)
2. [카카오 i 오픈빌더](https://i.kakao.com)에서 봇 생성 → 채널 연결
3. **스킬** 메뉴 → 스킬 생성
   - URL: `https://<프로젝트>.supabase.co/functions/v1/kakao-todo?key=<KAKAO_SKILL_TOKEN>`
4. **시나리오 → 폴백 블록** → 봇 응답을 "스킬데이터 사용"으로, 위 스킬 연결
   (모든 메시지가 이 스킬로 가도록. 웰컴 블록도 같은 스킬로 연결해 두면 편함)
5. 배포

### 3. 본인 등록
1. `KAKAO_OWNER_ID`를 비운 상태로 채널에 아무 말이나 보내면 봇이 **내 사용자 ID**를 답합니다.
2. 그 값을 Secrets의 `KAKAO_OWNER_ID`에 저장 → 이후 본인 외에는 "등록된 사용자만" 응답.

## 보안
- 스킬 URL의 `key`가 틀리면 403 → 외부에서 함수를 직접 호출해도 데이터 접근 불가
- `KAKAO_OWNER_ID`와 다른 카카오 사용자는 거절
- DB 접근은 서버 쪽 `SUPABASE_SERVICE_ROLE_KEY`로만 (브라우저에 노출되지 않음)

## 참고
- 오픈빌더 스킬은 5초 안에 응답해야 합니다. 그래서 AI 호출은 2.5초에서 끊고 규칙 기반 결과로 대체합니다.
- 앱과 동시에 수정할 때: todo.html은 저장 직전에 클라우드를 다시 읽어 카톡에서 추가·수정된 항목을 합친 뒤 올리고,
  탭으로 돌아올 때마다 클라우드 내용을 다시 불러옵니다.
