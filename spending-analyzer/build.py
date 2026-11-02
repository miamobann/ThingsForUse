"""src/ 의 파일들을 합쳐 웹페이지 파일 하나(지출분석.html)로 만든다."""
from pathlib import Path
here = Path(__file__).parent
src = here / "src"
html = (src / "index.html").read_text(encoding="utf-8")
for mark, name in (("/*STYLE*/", "style.css"), ("/*CORE*/", "core.js"), ("/*APP*/", "app.js")):
    html = html.replace(mark, (src / name).read_text(encoding="utf-8").replace("</script", "<\\/script"))
(here / "지출분석.html").write_text(html, encoding="utf-8")
print("지출분석.html", len(html.encode()) // 1024, "KB")

# 앱스 스크립트용: 같은 화면을 Index.html 로 (Code.gs 는 apps-script/ 에 있음)
(here / "apps-script" / "Index.html").write_text(html, encoding="utf-8")
print("apps-script/Index.html")
