# -*- coding: utf-8 -*-
# 공급업체 관리.xlsx → vendors_dir.js (업체명→사업자등록번호 마스터) 생성
# 구매업무(purchase.html)에서 거래처 입력 시 사업자등록번호 자동입력에 사용된다.
# 사용: python gen-vendors.py  (엑셀 경로는 아래 XLSX 변수에서 수정)
import os, io, re, json
try:
    import openpyxl
except ImportError:
    raise SystemExit("openpyxl 필요: pip install openpyxl")

# 원본 엑셀 경로 (공급업체 관리 파일). 필요 시 수정.
XLSX = r"D:\1. 업무중\1. 상시 업무_구매업무\공급업체 관리\공급업체 관리.xlsx"
here = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(here, "vendors_dir.js")

# 열 위치: B=공급업체명(idx 1), C=사업자등록번호(idx 2). 1행은 헤더.
NAME_COL, BIZ_COL = 1, 2
biz_re = re.compile(r"^\d{3}-\d{2}-\d{5}$")

wb = openpyxl.load_workbook(XLSX, data_only=True)
mapping = {}
for ws in wb.worksheets:
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:  # header
            continue
        if len(row) <= BIZ_COL:
            continue
        name, biz = row[NAME_COL], row[BIZ_COL]
        if not name or not biz:
            continue
        name, biz = str(name).strip(), str(biz).strip()
        # 첫 등장 우선(같은 이름이면 앞 시트/앞 행 값 유지)
        mapping.setdefault(name, biz)

header = "/* 공급업체 관리 엑셀에서 추출한 업체명→사업자등록번호 마스터 (자동 생성물) */\n"
header += "/* 생성: gen-vendors.py · 원본: 공급업체 관리.xlsx (제조/외주용역 시트) */\n"
body = "window.VENDOR_SEED = " + json.dumps(mapping, ensure_ascii=False, sort_keys=True) + ";\n"
io.open(OUT, "w", encoding="utf-8").write(header + body)
print("vendors_dir.js 생성 완료:", len(mapping), "개 업체")
