"""봇 실행 진입점 (Electron이 subprocess로 호출)

CLI:
    python runner.py run-once          # 즉시 1개 발행
    python runner.py verify            # 메이킷 계정 검증만

config: %APPDATA%\\NaverBotSaaS\\config.json (Electron이 저장)
비밀번호: Windows Credential Manager (keyring)
- 네이버 계정 PW: service="NaverBotSaaS", username=naver_id
- 메이킷 계정 PW: service="NaverBotSaaS_Makeit", username=email

stdout JSON 한 줄 → Electron 파싱
"""

import json
import os
import sys
from pathlib import Path

# Python embeddable 배포판 호환: 스크립트 디렉터리를 sys.path에 강제 추가
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from account import verify_account
from content_fetcher import fetch_post
from naver_blog import publish_to_naver_blog
from naver_cafe import publish_to_cafe

try:
    import keyring
except ImportError:
    keyring = None

NAVER_KEYRING = "NaverBotSaaS"
MAKEIT_KEYRING = "NaverBotSaaS_Makeit"


def get_config_path() -> Path:
    appdata = os.environ.get("APPDATA", str(Path.home()))
    return Path(appdata) / "NaverBotSaaS" / "config.json"


def load_config() -> dict:
    path = get_config_path()
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_password(service: str, username: str) -> str | None:
    if keyring is None or not username:
        return None
    try:
        return keyring.get_password(service, username)
    except Exception:
        return None


def analyze_keyword(keyword: str) -> dict:
    """네이버 상위 노출 블로그 글을 클라이언트에서 크롤링 + 서버 Claude 분석"""
    import requests
    import re
    from urllib.parse import quote

    cfg = load_config()
    access_token = cfg.get("makeit_access_token", "")
    email = cfg.get("makeit_email", "")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9",
    }
    clean_tag = re.compile(r'<[^>]+>')

    # 1. 네이버 블로그 검색 (클라이언트에서 직접)
    print(f"[분석] 네이버 검색: {keyword}", file=__import__('sys').stderr, flush=True)
    search_url = f"https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={quote(keyword)}"
    try:
        resp = requests.get(search_url, headers=headers, timeout=15)
        html = resp.text
    except Exception as e:
        return {"status": "error", "message": f"네이버 검색 실패: {e}"}

    # 2. 제목 추출 (여러 패턴 시도)
    patterns = [
        re.compile(r'class="title_link[^"]*"[^>]*>(.*?)</a>', re.DOTALL),
        re.compile(r'class="api_txt_lines[^"]*"[^>]*>(.*?)</a>', re.DOTALL),
        re.compile(r'<a[^>]+class="[^"]*title[^"]*"[^>]*>(.*?)</a>', re.DOTALL),
        re.compile(r'class="[^"]*tit[^"]*"[^>]*>(.*?)</(?:a|div|span)>', re.DOTALL),
        re.compile(r'"title":"([^"]{10,80})"'),  # JSON 응답 내 제목
    ]
    titles = []
    for pat in patterns:
        raw = pat.findall(html)
        for t in raw[:10]:
            cleaned = clean_tag.sub('', t).strip()
            if cleaned and len(cleaned) > 5 and cleaned not in titles:
                titles.append(cleaned)
        if len(titles) >= 5:
            break
    titles = titles[:10]

    # URL 추출
    url_pattern = re.compile(r'href="(https?://blog\.naver\.com/[^"]+)"')
    urls = list(dict.fromkeys(url_pattern.findall(html)))[:5]

    # 3. 상위 3개 본문 가져오기
    print(f"[분석] 상위글 {len(urls)}개 크롤링 중...", file=__import__('sys').stderr, flush=True)
    top_contents = []
    for url in urls[:3]:
        try:
            mobile_url = url.replace("blog.naver.com", "m.blog.naver.com")
            r = requests.get(mobile_url, headers=headers, timeout=10)
            body_match = re.search(r'class="se-main-container">(.*?)</div>\s*</div>\s*</div>', r.text, re.DOTALL)
            if not body_match:
                body_match = re.search(r'id="postViewArea"[^>]*>(.*?)</div>', r.text, re.DOTALL)
            if not body_match:
                body_match = re.search(r'class="post_ct"[^>]*>(.*?)</div>', r.text, re.DOTALL)
            if body_match:
                body_text = clean_tag.sub('\n', body_match.group(1))
                body_text = re.sub(r'\n{3,}', '\n\n', body_text).strip()
                idx = len(top_contents)
                top_contents.append({
                    "title": titles[idx] if idx < len(titles) else "",
                    "body": body_text[:2000]
                })
        except Exception:
            continue

    if not titles and not top_contents:
        return {"status": "error", "message": "검색 결과를 찾을 수 없습니다"}

    # 4. 서버 Claude API로 분석 (크롤링 데이터를 보냄)
    print(f"[분석] Claude 분석 요청 중 (제목 {len(titles)}개, 본문 {len(top_contents)}개)...", file=__import__('sys').stderr, flush=True)
    try:
        resp = requests.post(
            "https://snsmakeit.com/api/naverbot/analyze-keyword",
            json={
                "access_token": access_token,
                "email": email,
                "password": load_password(MAKEIT_KEYRING, email) or "",
                "keyword": keyword,
                "crawled_titles": titles,
                "crawled_contents": top_contents,
            },
            timeout=60,
        )
        data = resp.json() if resp.content else {}
        if data.get("ok"):
            analysis = data.get("analysis", {})
            return {
                "status": "ok",
                "suggested_titles": analysis.get("suggested_titles", titles[:5]),
                "structure_summary": analysis.get("structure_summary", ""),
                "extra_prompt": analysis.get("extra_prompt", ""),
                "top_titles": titles,
            }
    except Exception:
        pass

    # 서버 실패 시 폴백: 로컬 간단 분석
    extra = f'"{keyword}" 관련 상위 노출 글들의 제목 스타일을 참고하여 작성. '
    if titles:
        extra += f'참고 제목: {", ".join(titles[:3])}. '
    extra += "구체적 숫자와 실전 경험 위주로 작성할 것."

    structure = f"상위 {len(titles)}개 글 분석 완료."
    if top_contents:
        avg_len = sum(len(c["body"]) for c in top_contents) // max(len(top_contents), 1)
        structure = f"평균 본문 약 {avg_len}자. " + structure

    # 제목이 없으면 키워드 기반 제목 자동 생성
    suggested = titles[:5] if titles else [
        f"{keyword}, 이것만 알면 초보 탈출! 핵심 정리 7가지",
        f"2025년 {keyword} 완벽 가이드 — 전문가가 알려주는 비법",
        f"{keyword} 시작하는 분들이 꼭 알아야 할 5가지",
        f"요즘 난리난 {keyword}, 진짜 현실은 이렇습니다",
        f"{keyword} 제대로 하는 법 — 실전 경험에서 배운 팁",
    ]

    return {
        "status": "ok",
        "suggested_titles": suggested,
        "structure_summary": structure,
        "extra_prompt": extra,
        "top_titles": titles,
    }


def fetch_news_topics(theme: str, count: int = 3) -> list[str]:
    """테마 관련 최신 뉴스/트렌드에서 블로그 글감 추출"""
    import requests
    import re
    from urllib.parse import quote

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9",
    }
    clean_tag = re.compile(r'<[^>]+>')
    topics = []

    # 1. 네이버 뉴스 검색
    try:
        url = f"https://search.naver.com/search.naver?where=news&query={quote(theme)}&sort=1"
        resp = requests.get(url, headers=headers, timeout=10)
        title_pat = re.compile(r'class="news_tit"[^>]*title="([^"]+)"', re.DOTALL)
        news_titles = title_pat.findall(resp.text)[:10]
        if not news_titles:
            alt_pat = re.compile(r'<a[^>]+class="[^"]*news_tit[^"]*"[^>]*>(.*?)</a>', re.DOTALL)
            news_titles = [clean_tag.sub('', t).strip() for t in alt_pat.findall(resp.text)[:10]]
        topics.extend(news_titles)
    except Exception:
        pass

    # 2. 네이버 블로그 검색 (인기 글 제목)
    try:
        url = f"https://search.naver.com/search.naver?ssc=tab.blog.all&query={quote(theme)}&sort=1"
        resp = requests.get(url, headers=headers, timeout=10)
        blog_pat = re.compile(r'class="title_link[^"]*"[^>]*>(.*?)</a>', re.DOTALL)
        blog_titles = [clean_tag.sub('', t).strip() for t in blog_pat.findall(resp.text)[:10]]
        if not blog_titles:
            alt_pat = re.compile(r'class="api_txt_lines[^"]*"[^>]*>(.*?)</a>', re.DOTALL)
            blog_titles = [clean_tag.sub('', t).strip() for t in alt_pat.findall(resp.text)[:10]]
        topics.extend(blog_titles)
    except Exception:
        pass

    # 3. Google News RSS
    try:
        url = f"https://news.google.com/rss/search?q={quote(theme)}&hl=ko&gl=KR&ceid=KR:ko"
        resp = requests.get(url, headers=headers, timeout=10)
        g_pat = re.compile(r'<title><!\[CDATA\[(.*?)\]\]></title>')
        g_titles = g_pat.findall(resp.text)
        if not g_titles:
            g_pat2 = re.compile(r'<title>(.*?)</title>')
            g_titles = g_pat2.findall(resp.text)
        # 첫 번째는 피드 제목이므로 제외
        topics.extend(g_titles[1:11])
    except Exception:
        pass

    if not topics:
        # 폴백: 테마 자체를 변형
        return [f"{theme} 최신 트렌드", f"{theme} 초보자 가이드", f"{theme} 실전 팁"][:count]

    return topics[:count * 3]  # 충분한 후보 반환


def run_autopilot() -> dict:
    """자동 운영 모드: 테마 기반 뉴스 분석 → 다중 글 발행"""
    import time
    import random

    cfg = load_config()
    ap = cfg.get("autopilot", {})
    if not ap.get("active"):
        return {"status": "error", "message": "자동 운영이 비활성화 상태"}

    theme = ap.get("theme", "")
    posts_per_day = ap.get("posts_per_day", 3)
    duration_days = ap.get("duration_days", 0)
    started_at = ap.get("started_at", "")

    if not theme:
        return {"status": "error", "message": "테마 미설정"}

    # 기간 체크
    if duration_days > 0 and started_at:
        from datetime import datetime, timedelta
        try:
            start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            if datetime.now(start.tzinfo) > start + timedelta(days=duration_days):
                # 기간 만료 → 자동 중지
                cfg["autopilot"]["active"] = False
                save_config_to_file(cfg)
                return {"status": "ok", "message": "자동 운영 기간 만료 — 자동 중지됨", "posts": []}
        except Exception:
            pass

    email = cfg.get("makeit_email", "")
    access_token = cfg.get("makeit_access_token", "")
    naver_id = cfg.get("naver_id", "")
    write = cfg.get("write", {})

    # 1. 메이킷 계정 확인
    emit({"status": "progress", "step": "account", "message": "메이킷 계정 확인 중..."})
    if access_token:
        acc = verify_account(access_token=access_token)
    else:
        makeit_pw = load_password(MAKEIT_KEYRING, email)
        acc = verify_account(email=email, password=makeit_pw or "")
    if not acc.valid:
        return {"status": "error", "step": "account", "message": acc.error}

    # 2. 네이버 비번
    if not naver_id:
        return {"status": "error", "message": "네이버 ID 미설정"}
    naver_pw = load_password(NAVER_KEYRING, naver_id)
    if not naver_pw:
        return {"status": "error", "message": "네이버 비밀번호 미저장"}

    # 3. 뉴스/트렌드에서 글감 추출
    emit({"status": "progress", "step": "analyze", "message": f"'{theme}' 관련 최신 뉴스/트렌드 분석 중..."})
    raw_topics = fetch_news_topics(theme, posts_per_day)

    # 4. 다중 발행
    results = []
    for i in range(posts_per_day):
        # 글감 선택 (랜덤으로 하나)
        if raw_topics:
            topic = raw_topics.pop(random.randint(0, min(len(raw_topics) - 1, 2)))
        else:
            topic = f"{theme} 관련 정보"

        # 글감을 테마와 결합
        keyword = f"{theme} — {topic}" if theme not in topic else topic

        emit({"status": "progress", "step": "generate", "message": f"[{i+1}/{posts_per_day}] 글 생성: {keyword[:40]}..."})

        fields = {
            "keyword": keyword,
            "target": write.get("target", ""),
            "extra": write.get("extra", f"'{theme}' 주제의 최신 트렌드를 반영하여 작성. 최근 뉴스/기사 내용을 참고하되 독자적 관점 포함."),
        }

        post = fetch_post(
            access_token=access_token,
            email=email,
            password=load_password(MAKEIT_KEYRING, email) or "",
            subtype=write.get("subtype", "info"),
            tone=write.get("tone", "friendly"),
            speech=write.get("speech", "polite_yo"),
            word_count=write.get("wordCount", "medium"),
            fields=fields,
        )
        if post.error:
            emit({"status": "progress", "step": "generate", "message": f"[{i+1}] 생성 실패: {post.error}"})
            results.append({"topic": keyword, "error": post.error})
            continue

        emit({"status": "progress", "step": "publish", "message": f"[{i+1}/{posts_per_day}] 블로그 발행 중..."})

        result = publish_to_naver_blog(
            user_id=naver_id,
            naver_id=naver_id,
            naver_pw=naver_pw,
            title=post.title,
            blocks=post.blocks,
            tags=post.tags,
            template_name=write.get("naver_template", ""),
            headless=True,
        )

        if result["success"]:
            results.append({"topic": keyword, "title": post.title, "url": result["post_url"]})
            emit({"status": "progress", "step": "publish", "message": f"[{i+1}] 발행 성공: {post.title}"})
        else:
            results.append({"topic": keyword, "error": result["error"]})
            emit({"status": "progress", "step": "publish", "message": f"[{i+1}] 발행 실패: {result['error']}"})

        # 다음 글 발행 전 랜덤 대기 (1~3분)
        if i < posts_per_day - 1:
            wait = random.randint(60, 180)
            emit({"status": "progress", "step": "wait", "message": f"다음 글 발행까지 {wait}초 대기..."})
            time.sleep(wait)

    success_count = sum(1 for r in results if "url" in r)
    return {
        "status": "ok",
        "message": f"자동 운영 완료: {success_count}/{posts_per_day}개 발행 성공",
        "theme": theme,
        "posts": results,
    }


def save_config_to_file(cfg: dict):
    """config.json 직접 저장"""
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def run_once() -> dict:
    cfg = load_config()

    email = cfg.get("makeit_email", "")
    access_token = cfg.get("makeit_access_token", "")
    naver_id = cfg.get("naver_id", "")
    write = cfg.get("write", {})

    # 1. 메이킷 계정 + 구독 확인 (token 우선, 없으면 email/pw fallback)
    emit({"status": "progress", "step": "account", "message": "메이킷 계정 확인 중..."})
    if access_token:
        acc = verify_account(access_token=access_token)
    else:
        makeit_pw = load_password(MAKEIT_KEYRING, email)
        if not email or not makeit_pw:
            return {"status": "error", "step": "account", "message": "메이킷 계정 로그인 필요"}
        acc = verify_account(email=email, password=makeit_pw)
    if not acc.valid:
        return {"status": "error", "step": "account", "message": acc.error}

    # 3. 네이버 비번 로드
    if not naver_id:
        return {"status": "error", "step": "naver", "message": "네이버 ID 미설정"}
    naver_pw = load_password(NAVER_KEYRING, naver_id)
    if not naver_pw:
        return {"status": "error", "step": "naver", "message": "네이버 비밀번호 미저장"}

    # 4. 키워드
    keyword = write.get("keyword", "").strip()
    if not keyword:
        return {"status": "error", "step": "config", "message": "키워드/주제 미입력"}

    # 5. 서버에서 글 생성
    emit({"status": "progress", "step": "generate", "message": f"글 생성 중 (주제: {keyword})..."})
    fields = {
        "keyword": keyword,
        "target": write.get("target", ""),
        "extra": write.get("extra", ""),
        "location": write.get("location", ""),
        "visitDate": write.get("visitDate", ""),
        "rating": write.get("rating", ""),
        "duration": write.get("duration", ""),
        "budget": write.get("budget", ""),
        "productName": write.get("productName", ""),
        "price": write.get("price", ""),
        "pros": write.get("pros", ""),
        "cons": write.get("cons", ""),
        "mainPoint": write.get("mainPoint", ""),
    }

    # 카페 모드면 글 스타일 다르게
    cafe = cfg.get("cafe", {})
    is_cafe = cfg.get("_cafe_mode", False)
    cafe_extra = ""
    cafe_word_count = write.get("wordCount", "medium")
    if is_cafe:
        cafe_extra = (
            "네이버 카페 게시글 형식으로 작성. "
            "블로그와 달리 짧고 핵심 위주로 작성 (1000~1500자). "
            "소제목 없이 자연스러운 대화체로, 카페 회원들끼리 정보 공유하는 톤. "
            "[image: english keyword] 마커를 본문에 정확히 2개만 삽입 (첫 문단 뒤 1개, 글 중간 1개). 3개 이상 넣지 말 것. "
            "마무리에 '댓글로 의견 남겨주세요' 같은 참여 유도 포함. "
        )
        cafe_word_count = "short"

    user_extra = write.get("extra", "")
    if cafe_extra:
        user_extra = cafe_extra + user_extra

    post = fetch_post(
        access_token=access_token,
        email=email,
        password=load_password(MAKEIT_KEYRING, email) or "",
        subtype=write.get("subtype", "info"),
        tone=write.get("tone", "friendly"),
        speech=write.get("speech", "polite_yo"),
        word_count=cafe_word_count if is_cafe else write.get("wordCount", "medium"),
        fields=fields,
        user_prompt=user_extra,
    )
    if post.error:
        return {"status": "error", "step": "generate", "message": post.error}

    # 선택된 제목이 있으면 AI 제목 대신 사용
    selected_title = cfg.get("_selected_title", "")
    if selected_title:
        post.title = selected_title

    # 6. 발행 (블로그 or 카페)
    if is_cafe and cafe.get("cafe_number"):
        emit({"status": "progress", "step": "publish", "message": f"카페 발행 중 ({len(post.blocks)} blocks)..."})
        result = publish_to_cafe(
            user_id=naver_id,
            naver_id=naver_id,
            naver_pw=naver_pw,
            cafe_id=cafe.get("cafe_id", ""),
            cafe_number=cafe["cafe_number"],
            menu_id=cafe.get("menu_id", ""),
            board_name=cafe.get("board_name", ""),
            title=post.title,
            blocks=post.blocks,
            headless=True,
        )
    else:
        emit({"status": "progress", "step": "publish", "message": f"블로그 발행 중 ({len(post.blocks)} blocks)..."})
        result = publish_to_naver_blog(
            user_id=naver_id,
            naver_id=naver_id,
            naver_pw=naver_pw,
            title=post.title,
            blocks=post.blocks,
            tags=post.tags,
            template_name=write.get("naver_template", ""),
            headless=True,
        )

    # _cafe_mode 플래그 정리
    if is_cafe:
        cfg["_cafe_mode"] = False
        save_config_to_file(cfg)

    if not result["success"]:
        return {"status": "error", "step": "publish", "message": result["error"]}

    return {
        "status": "ok",
        "topic": keyword,
        "title": post.title,
        "post_url": result["post_url"],
        "quota": post.quota,
        "images_inserted": sum(1 for b in post.blocks if b.get("type") == "image"),
    }


def main() -> int:
    if len(sys.argv) < 2:
        emit({"status": "error", "message": "command required"})
        return 1

    cmd = sys.argv[1]

    if cmd == "verify":
        cfg = load_config()
        email = cfg.get("makeit_email", "")
        token = cfg.get("makeit_access_token", "")
        if token:
            acc = verify_account(access_token=token)
        else:
            pw = load_password(MAKEIT_KEYRING, email)
            acc = verify_account(email=email, password=pw or "")
        emit({
            "status": "ok" if acc.valid else "error",
            "plan": acc.plan,
            "expires_at": acc.expires_at,
            "nick": acc.nick,
            "email": acc.email or email,
            "trial": acc.trial,
            "trial_used": acc.trial_used,
            "trial_limit": acc.trial_limit,
            "error": acc.error,
        })
        return 0 if acc.valid else 1

    if cmd == "run-once":
        # autopilot 모드가 활성화되어 있으면 자동 운영으로 전환
        cfg = load_config()
        if cfg.get("autopilot", {}).get("active"):
            emit(run_autopilot())
        else:
            emit(run_once())
        return 0

    if cmd == "autopilot":
        emit(run_autopilot())
        return 0

    if cmd == "analyze":
        keyword = sys.argv[2] if len(sys.argv) > 2 else ""
        if not keyword:
            emit({"status": "error", "message": "키워드 필요"})
            return 1
        result = analyze_keyword(keyword)
        emit(result)
        return 0

    emit({"status": "error", "message": f"unknown command: {cmd}"})
    return 1


if __name__ == "__main__":
    sys.exit(main())
