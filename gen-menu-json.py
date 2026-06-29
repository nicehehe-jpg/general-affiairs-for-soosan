# -*- coding: utf-8 -*-
# index.html 의 MEAL_DATA(식단 데이터)를 menu.json 으로 추출한다.
# 슬랙 /식단표 슬래시 명령(Supabase Edge Function 'sikdan')이 이 menu.json 을 읽는다.
# 사용: python gen-menu-json.py   (같은 폴더의 index.html → menu.json)
import os, io, re, json

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "index.html")
out = os.path.join(here, "menu.json")

html = io.open(src, encoding="utf-8").read()
m = re.search(r"const\s+MEAL_DATA\s*=\s*\{", html)
if not m:
    raise SystemExit("index.html 에서 MEAL_DATA 를 찾지 못했습니다")

start = m.end() - 1  # '{'
depth = 0
i = start
end = None
while i < len(html):
    c = html[i]
    if c == "{":
        depth += 1
    elif c == "}":
        depth -= 1
        if depth == 0:
            end = i
            break
    i += 1
if end is None:
    raise SystemExit("MEAL_DATA 블록의 끝을 찾지 못했습니다")

block = html[start:end + 1]
j = block.replace("'", '"')                              # 작은따옴표 → 큰따옴표
j = re.sub(r"(\blunch\b|\bdinner\b)\s*:", r'"\1":', j)   # 키에 따옴표
j = re.sub(r",(\s*[}\]])", r"\1", j)                     # 트레일링 콤마 제거
data = json.loads(j)                                     # 유효성 검증

io.open(out, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=1))
print("menu.json 생성 완료:", len(data), "일치")
