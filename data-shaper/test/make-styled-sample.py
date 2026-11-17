"""서식 있는 가짜 데이터·템플릿 생성 (openpyxl 필요). 실행: python3 test/make-styled-sample.py"""
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

OUT = Path(__file__).parent / 'samples'
OUT.mkdir(exist_ok=True)
thin = Side(style='thin', color='FF999999')

wb = Workbook()
ws = wb.active
ws.title = '거래'
ws['A1'] = '2026년 10월 거래 내역'
ws['A1'].font = Font(bold=True, size=14)
head = ['거래일', '거래처', '품목', '수량', '단가', '금액', '비고']
for i, h in enumerate(head, 1):
    c = ws.cell(row=3, column=i, value=h)
    c.font = Font(bold=True, color='FFFFFFFF')
    c.fill = PatternFill('solid', fgColor='FF2F5597')
    c.alignment = Alignment(horizontal='center')
    c.border = Border(bottom=thin)
rows = [
    (date(2026, 10, 1), '가나상사', '볼트', 120, 350), (date(2026, 10, 2), '다라물산', '너트', 300, 120),
    (date(2026, 10, 2), '가나상사', '와셔', 500, 40), (date(2026, 10, 5), '마바산업', '볼트', 80, 360),
    (date(2026, 10, 7), '다라물산', '볼트', 200, 340), (date(2026, 10, 9), '마바산업', '너트', 150, 125),
]
for r, (d, v, item, q, p) in enumerate(rows, 4):
    ws.cell(row=r, column=1, value=d).number_format = 'yyyy"년" m"월" d"일"'
    ws.cell(row=r, column=2, value=v)
    ws.cell(row=r, column=3, value=item).alignment = Alignment(horizontal='center')
    ws.cell(row=r, column=4, value=q).number_format = '#,##0"개"'
    ws.cell(row=r, column=5, value=p).number_format = '#,##0"원"'
    c = ws.cell(row=r, column=6, value=q * p)
    c.number_format = '#,##0"원"'
    c.font = Font(color='FF1F6F3F')
    ws.cell(row=r, column=7, value='긴급' if r == 5 else None).fill = PatternFill('solid', fgColor='FFFFF2CC')
for col, w in zip('ABCDEFG', (16, 12, 8, 10, 10, 14, 10)):
    ws.column_dimensions[col].width = w
wb.save(OUT / '가짜_서식있는_거래.xlsx')

tpl = Workbook()
t = tpl.active
t.title = '보고 양식'
for i, h in enumerate(['일자', '업체', '품목', '금액'], 1):
    c = t.cell(row=1, column=i, value=h)
    c.font = Font(bold=True, color='FF7F1D1D')
    c.fill = PatternFill('solid', fgColor='FFFDE2E2')
    c.border = Border(bottom=Side(style='medium', color='FF7F1D1D'))
    d = t.cell(row=2, column=i)
    d.border = Border(bottom=Side(style='hair', color='FFCCCCCC'))
t.cell(row=2, column=4).number_format = '#,##0'
for col, w in zip('ABCD', (14, 18, 10, 16)):
    t.column_dimensions[col].width = w
tpl.save(OUT / '가짜_서식_템플릿.xlsx')
print('styled samples ->', OUT)
