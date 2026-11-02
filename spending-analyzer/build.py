"""src/ 의 파일들을 합쳐 웹페이지 파일 하나로 만든다.

- 개인판: 지출분석.html, apps-script/Index.html
- 범용판(남에게 주는 것): share/ 아래. src/app.js 의 /*MINE*/ ~ /*END MINE*/ 사이(개인 가게 분류)를 뺀다.
"""
import re
import shutil
from pathlib import Path

here = Path(__file__).parent
src = here / "src"


def page(generic):
    html = (src / "index.html").read_text(encoding="utf-8")
    for mark, name in (("/*STYLE*/", "style.css"), ("/*CORE*/", "core.js"), ("/*APP*/", "app.js")):
        text = (src / name).read_text(encoding="utf-8")
        if generic:
            text = re.sub(r"[ \t]*/\*MINE\*/.*?/\*END MINE\*/[ \t]*\n?", "", text, flags=re.S)
        html = html.replace(mark, text.replace("</script", "<\\/script"))
    if generic:
        for w in ("MINE", "Min", "명조", "윗치폼", "파이어볼트", "지에스넷", "메타크래프트", "스텔라", "달빛", "비바리"):
            assert w not in html, f"범용판에 개인 내용이 남았어요: {w}"
    return html


mine, shared = page(False), page(True)
(here / "지출분석.html").write_text(mine, encoding="utf-8")
(here / "apps-script" / "Index.html").write_text(mine, encoding="utf-8")
share = here / "share"
share.mkdir(exist_ok=True)
(share / "지출분석.html").write_text(shared, encoding="utf-8")
(share / "Index.html").write_text(shared, encoding="utf-8")
shutil.copy(here / "apps-script" / "Code.gs", share / "Code.gs")
print("지출분석.html", len(mine.encode()) // 1024, "KB · share/", len(shared.encode()) // 1024, "KB")
