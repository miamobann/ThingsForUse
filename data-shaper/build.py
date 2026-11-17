#!/usr/bin/env python3
"""src/ 파일과 vendor 라이브러리를 HTML 하나로 합침 → data-shaper.html"""
from pathlib import Path

ROOT = Path(__file__).parent


def inline_js(code: str) -> str:
    # 스크립트 안의 </script 가 태그를 닫지 않게 처리
    return code.replace('</script', '<\\/script')


def main():
    html = (ROOT / 'src/index.html').read_text(encoding='utf-8')
    css = (ROOT / 'src/style.css').read_text(encoding='utf-8')
    app = (ROOT / 'src/app.js').read_text(encoding='utf-8')
    xlsx = (ROOT / 'vendor/xlsx.full.min.js').read_text(encoding='utf-8')
    for key, val in (('/*@@STYLE@@*/', css), ('/*@@XLSX@@*/', inline_js(xlsx)), ('/*@@APP@@*/', inline_js(app))):
        assert html.count(key) == 1, key
        html = html.replace(key, val)
    out = ROOT / 'data-shaper.html'
    out.write_text(html, encoding='utf-8')
    print(f'{out.name} {out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
