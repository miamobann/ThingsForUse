"""네이버페이 결제내역 CSV 정리 (3단계)

2-내보내기.js로 받은 CSV를 읽어서
  - 같은 결제가 두 번 들어간 행(같은 id)을 지우고
  - 결제대행사 이름(케이지이니시스, DEGICA 등)을 실제 가게 이름으로 바꾸고
  - 중복 의심, 금액 없음, 가게를 알 수 없는 건을 메모에 [확인] 표시해서
정리된 CSV와 확인할 목록(.md)을 만들어요.

사용법: python3 3-정리.py 네이버페이_결제내역_....csv
"""
import csv
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# 결제대행사(PG)나 영문 코드로 찍히는 가게 이름들. 원래가게명에는 그대로 남겨요.
PG_NAMES = {
    '케이지이니시스', 'Alipay Plus', '나이스페이먼츠 정기결제 카드', '나이스_카드(마스터)', 'DEGICA',
    'KOMOJU', '엑심베이(카드)', 'NHNKCP', '토스페이먼츠 주식회사', 'KICC(카드)',
    '한국결제네트웍스_카드', 'Google', '구글 플레이', 'NAVER_PLUS_MEMBERSHIP',
}

# (원래 가게명, 상품명 패턴) → 실제 가게 이름. 위에서부터 먼저 맞는 것을 써요.
RULES = [
    ('케이지이니시스', r'^스토어 - (.+?)의 ', None),           # "스토어 - 스텔라이브의 …" → 스텔라이브
    ('케이지이니시스', r'^멤버십 - (스텔라이브)', None),
    (None, r'^Steam', 'Steam'),
    (None, r'OPENAI|CHATGPT', 'OpenAI (ChatGPT)'),
    (None, r'X CORP', 'X (트위터)'),
    (None, r'^Google One', 'Google One'),
    ('구글 플레이', r'.', '구글 플레이'),
    ('NAVER_PLUS_MEMBERSHIP', r'.', '네이버플러스 멤버십'),
    (None, r'CJ대한통운', 'CJ대한통운'),
    (None, r'TOEIC', 'TOEIC'),
    (None, r'^인터넷증명서', '인터넷증명서'),
    (None, r'일러스타 페스', '일러스타 페스'),
]


def real_merchant(pg, product):
    for name, pattern, fixed in RULES:
        if name and name != pg:
            continue
        m = re.search(pattern, product)
        if m:
            return fixed or m.group(1).strip()
    return None


def main(path):
    src = Path(path)
    with src.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames
        rows = list(reader)

    # 1) 같은 id 지우기
    seen, clean, removed = set(), [], []
    for r in rows:
        if r['id'] in seen:
            removed.append(r)
            continue
        seen.add(r['id'])
        clean.append(r)

    checks = []  # (분류, 행, 설명)

    def flag(r, kind, why):
        r['메모'] = f"{r['메모']} / [확인] {why}"
        checks.append((kind, r, why))

    # 2) 가게 이름 정리
    renamed = 0
    for r in clean:
        r['가게명'] = r['가게명'].strip()
        r['원래가게명'] = r['원래가게명'].strip()
        product = r['메모'].split(' / ')[0]
        if r['원래가게명'] in PG_NAMES:
            name = real_merchant(r['원래가게명'], product)
            if name:
                r['가게명'] = name
                renamed += 1
            else:
                flag(r, '가게 모름', f"결제대행사({r['원래가게명']})만 찍혀 실제 가게를 모름")

    # 3) 금액 없음
    for r in clean:
        if not r['금액']:
            flag(r, '금액 없음', '목록에 금액이 없음')

    # 4) 중복 의심: 같은 날, 같은 가게, 같은 금액, 같은 상품, 30분 안
    groups = defaultdict(list)
    for r in clean:
        if r['취소됨'] == 'Y':
            continue
        groups[(r['날짜'], r['원래가게명'], r['금액'], r['메모'].split(' / ')[0])].append(r)
    for g in groups.values():
        if len(g) < 2:
            continue
        g.sort(key=lambda r: r['시각'])
        t = [datetime.strptime(r['시각'], '%H:%M') for r in g]
        if (t[-1] - t[0]).total_seconds() <= 8 * 3600:
            for r in g[1:]:
                flag(r, '중복 의심', f"같은 날 같은 상품·금액이 {g[0]['시각']}에도 있음")

    # 저장
    out_csv = src.with_name(src.stem + '_정리.csv')
    with out_csv.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator='\r\n')
        w.writeheader()
        w.writerows(clean)

    lines = [
        f'# 네이버페이 결제내역 정리 결과',
        '',
        f'- 원본 {len(rows)}건 → 정리 후 {len(clean)}건 (같은 id 중복 {len(removed)}건 삭제)',
        f'- 결제대행사 이름을 실제 가게로 바꾼 건: {renamed}건',
        f"- 취소된 건: {sum(r['취소됨'] == 'Y' for r in clean)}건 (금액은 그대로, 취소됨=Y)",
        f'- 확인이 필요한 건: {len(checks)}건',
        '',
    ]
    for kind in ['중복 의심', '금액 없음', '가게 모름']:
        items = [(r, why) for k, r, why in checks if k == kind]
        if not items:
            continue
        lines += [f'## {kind} ({len(items)}건)', '', '| 날짜 | 시각 | 금액 | 가게 | 상품 | 설명 |', '|---|---|---|---|---|---|']
        for r, why in items:
            product = r['메모'].split(' / ')[0].replace('|', '/')
            lines.append(f"| {r['날짜']} | {r['시각']} | {r['금액']} | {r['원래가게명']} | {product} | {why} |")
        lines.append('')
    out_md = src.with_name(src.stem + '_확인목록.md')
    out_md.write_text('\n'.join(lines), encoding='utf-8')
    print(out_csv)
    print(out_md)


if __name__ == '__main__':
    main(sys.argv[1])
