"""네이버 카페 자동 글쓰기 모듈 (실제 카페 UI 기반)

디버그 스크린샷 분석 결과:
- 게시판: 드롭다운 "게시판을 선택해 주세요."
- 제목: placeholder "제목을 입력해 주세요."
- 본문: placeholder "내용을 입력하세요." (contenteditable)
- 등록: 우상단 파란 "등록" 버튼
- iframe 없음 (메인 페이지에서 모두 동작)
"""

import os
import logging
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

logger = logging.getLogger("naver-cafe")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEBUG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "NaverBotSaaS" / "debug"


def get_profile_dir(user_id: str) -> Path:
    base = Path(os.environ.get("APPDATA", str(Path.home()))) / "NaverBotSaaS" / "profiles" / user_id
    base.mkdir(parents=True, exist_ok=True)
    return base


def _debug(page, prefix: str):
    try:
        DEBUG_DIR.mkdir(exist_ok=True)
        page.screenshot(path=str(DEBUG_DIR / f"cafe_{prefix}.png"), full_page=True)
    except Exception:
        pass


def _find_photo_button(page):
    """카페 에디터 사진 버튼 찾기"""
    for sel in ["button:has-text('사진')", "button[aria-label*='사진']", "button[data-name='image']"]:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                return el
        except Exception:
            continue
    for btn in page.query_selector_all('.tool_area button, .se-toolbar button, button'):
        try:
            text = (btn.inner_text() or "").strip()
            label = btn.get_attribute("aria-label") or ""
            if "사진" in text or "사진" in label:
                return btn
        except Exception:
            continue
    return None


def _upload_cafe_image(page, img_url: str) -> bool:
    """이미지 URL 다운로드 → 카페 에디터에 업로드"""
    try:
        tmp_dir = Path(tempfile.gettempdir()) / "naverbot_images"
        tmp_dir.mkdir(exist_ok=True)
        tmp_path = str(tmp_dir / f"cafe_{int(time.time())}.jpg")
        req = urllib.request.Request(img_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as r, open(tmp_path, "wb") as f:
            f.write(r.read())

        photo_btn = _find_photo_button(page)
        if photo_btn:
            with page.expect_file_chooser(timeout=5000) as fc_info:
                photo_btn.click()
            fc_info.value.set_files(tmp_path)
            page.wait_for_timeout(5000)  # 이미지 로딩 충분히 대기
            logger.info("카페 이미지 업로드 성공")
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            return True
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"카페 이미지 업로드 실패: {e}")
    return False


def publish_to_cafe(
    user_id: str,
    naver_id: str,
    naver_pw: str,
    cafe_id: str,
    cafe_number: str,
    menu_id: str,
    board_name: str,
    title: str,
    body: str = "",
    blocks: list[dict] | None = None,
    headless: bool = True,
) -> dict:
    profile_dir = get_profile_dir(user_id)

    # blocks → body (텍스트) + 이미지 URL 수집
    image_urls = []
    if blocks and not body:
        parts = []
        for blk in blocks:
            if blk.get("type") == "text":
                parts.append(blk.get("content", ""))
            elif blk.get("type") == "image" and blk.get("url"):
                image_urls.append(blk["url"])
        body = "\n\n".join(parts)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=headless,
            viewport={"width": 1280, "height": 900},
            user_agent=USER_AGENT,
            locale="ko-KR",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.pages[0] if context.pages else context.new_page()

        try:
            # 1. 글쓰기 페이지
            write_url = f"https://cafe.naver.com/ca-fe/cafes/{cafe_number}/articles/write?boardType=L&menuId={menu_id}"
            page.goto(write_url, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)
            _debug(page, "01_loaded")

            if "nidlogin" in page.url or "nid.naver.com" in page.url:
                return {"success": False, "post_url": None, "error": "로그인 필요 — 계정 설정에서 '네이버 로그인'을 먼저 실행하세요"}

            # 2. 게시판 선택 — 드롭다운 클릭 → 목록에서 선택
            try:
                # 드롭다운 트리거: "게시판을 선택해 주세요." 텍스트를 포함하는 클릭 가능 요소
                board_sel = page.query_selector('[class*="select"] >> text="게시판을 선택해 주세요"')
                if not board_sel:
                    # 폴백: 드롭다운 영역 전체 클릭
                    board_sel = page.query_selector('.board_select, .ArticleWriteBoard select, .category_select')
                if not board_sel:
                    # 최종 폴백: 화면에서 텍스트 찾아 부모 클릭
                    page.evaluate("""
                        () => {
                            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                            while (walker.nextNode()) {
                                if (walker.currentNode.textContent.includes('게시판을 선택')) {
                                    let el = walker.currentNode.parentElement;
                                    // 부모 중 클릭 가능한 요소까지 올라가기
                                    for (let i = 0; i < 5 && el; i++) {
                                        if (el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.role === 'button' || el.classList.contains('select_box')) {
                                            el.click();
                                            return true;
                                        }
                                        el = el.parentElement;
                                    }
                                    // 못 찾으면 그냥 텍스트 부모 클릭
                                    walker.currentNode.parentElement.click();
                                    return true;
                                }
                            }
                            return false;
                        }
                    """)
                else:
                    board_sel.click()
                page.wait_for_timeout(2000)
                _debug(page, "02a_dropdown_open")

                if board_name:
                    # 열린 목록에서 게시판 이름 매칭 — Playwright locator 사용
                    try:
                        page.locator(f"text='{board_name}'").first.click(timeout=3000)
                        selected = board_name
                    except Exception:
                        # JS 폴백
                        selected = page.evaluate(f"""
                            () => {{
                                const all = document.querySelectorAll('li, option, [role="option"], .item, a, button, span, div');
                                for (const el of all) {{
                                    const text = (el.innerText || el.textContent || '').trim();
                                    if (text === '{board_name}') {{
                                        el.click();
                                        return text;
                                    }}
                                }}
                                // 부분 매칭
                                for (const el of all) {{
                                    const text = (el.innerText || el.textContent || '').trim();
                                    if (text.includes('{board_name}')) {{
                                        el.click();
                                        return text;
                                    }}
                                }}
                                return null;
                            }}
                        """)
                    if selected:
                        logger.info(f"게시판 선택: {selected}")
                    else:
                        logger.warning(f"게시판 '{board_name}' 못 찾음")
                page.wait_for_timeout(1000)
            except Exception as e:
                logger.warning(f"게시판 선택 실패: {e}")

            _debug(page, "02_board")

            # 3. 제목 입력 — placeholder "제목을 입력해 주세요"
            try:
                page.evaluate(f"""
                    () => {{
                        // textarea 또는 input에서 제목 찾기
                        const candidates = document.querySelectorAll('textarea, input[type="text"], [contenteditable]');
                        for (const el of candidates) {{
                            const ph = el.placeholder || el.getAttribute('data-placeholder') || '';
                            if (ph.includes('제목')) {{
                                el.focus();
                                el.value = '{title.replace("'", "\\'")}';
                                el.dispatchEvent(new Event('input', {{bubbles: true}}));
                                el.dispatchEvent(new Event('change', {{bubbles: true}}));
                                return 'filled';
                            }}
                        }}
                        // contenteditable 제목 영역
                        const titleArea = document.querySelector('.title_area, .ArticleWriteTitle');
                        if (titleArea) {{
                            const editable = titleArea.querySelector('[contenteditable], textarea, input');
                            if (editable) {{
                                editable.focus();
                                if (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') {{
                                    editable.value = '{title.replace("'", "\\'")}';
                                }} else {{
                                    editable.textContent = '{title.replace("'", "\\'")}';
                                }}
                                editable.dispatchEvent(new Event('input', {{bubbles: true}}));
                                return 'filled-area';
                            }}
                        }}
                        return 'not-found';
                    }}
                """)
                page.wait_for_timeout(500)
            except Exception as e:
                logger.warning(f"제목 JS 입력 실패: {e}")
                # 폴백: keyboard 입력
                try:
                    title_el = page.query_selector('[placeholder*="제목"]')
                    if title_el:
                        title_el.click()
                        title_el.fill(title)
                except Exception:
                    pass

            # 제목에서 벗어나기
            page.keyboard.press("Tab")
            page.wait_for_timeout(500)
            _debug(page, "03_title")

            # 4. 본문 + 이미지를 blocks 순서대로 입력
            try:
                # 에디터 클릭
                body_clicked = page.evaluate("""
                    () => {
                        const byPh = document.querySelector('[data-placeholder*="내용을 입력"]');
                        if (byPh) { byPh.focus(); byPh.click(); return true; }
                        const sePara = document.querySelector('.se-text-paragraph');
                        if (sePara) { sePara.focus(); sePara.click(); return true; }
                        const eds = document.querySelectorAll('[contenteditable="true"]');
                        for (const ed of eds) { if (ed.getBoundingClientRect().top > 300) { ed.focus(); ed.click(); return true; } }
                        if (eds.length) { eds[eds.length-1].focus(); eds[eds.length-1].click(); return true; }
                        return false;
                    }
                """)
                page.wait_for_timeout(1000)
                if not body_clicked:
                    return {"success": False, "post_url": None, "error": "본문 에디터를 찾을 수 없음"}

                kb = page.keyboard
                kb.press("Control+a")
                kb.press("Backspace")
                page.wait_for_timeout(300)

                # blocks 순서대로: 텍스트 → 이미지 → 텍스트 → 이미지
                if blocks:
                    for blk in blocks:
                        btype = blk.get("type")
                        if btype == "text":
                            content = blk.get("content", "").strip()
                            if not content:
                                continue
                            for line in content.split("\n"):
                                line = line.strip()
                                if line:
                                    kb.type(line, delay=5)
                                kb.press("Enter")
                            kb.press("Enter")
                        elif btype == "image" and blk.get("url"):
                            if _upload_cafe_image(page, blk["url"]):
                                # 이미지 로딩 완료 대기
                                page.wait_for_timeout(2000)
                                # 이미지 아래로 커서 이동 (Escape로 이미지 선택 해제 → End → Enter)
                                kb.press("Escape")
                                page.wait_for_timeout(300)
                                kb.press("End")
                                kb.press("Enter")
                                kb.press("Enter")
                                page.wait_for_timeout(500)
                        elif btype in ("subtitle", "quote"):
                            content = blk.get("content", "").strip()
                            if content:
                                kb.press("Enter")
                                kb.type(content, delay=5)
                                kb.press("Enter")
                                kb.press("Enter")
                else:
                    for line in body.split("\n"):
                        line = line.strip()
                        if line:
                            kb.type(line, delay=5)
                        kb.press("Enter")

                logger.info("본문+이미지 입력 완료")
            except Exception as e:
                return {"success": False, "post_url": None, "error": f"본문 입력 실패: {e}"}

            page.wait_for_timeout(2000)
            _debug(page, "04_body")

            # 5. 등록 버튼 — 우상단 파란 "등록" 버튼
            try:
                clicked = page.evaluate("""
                    () => {
                        // 우상단 등록 버튼 (파란색)
                        const btns = document.querySelectorAll('button, a[role="button"]');
                        for (const btn of btns) {
                            const text = btn.textContent.trim();
                            const cls = btn.className || '';
                            // "등록" 텍스트 + "임시등록"이 아닌 버튼
                            if (text === '등록' && !cls.includes('temp') && !text.includes('임시')) {
                                btn.click();
                                return 'clicked';
                            }
                        }
                        return 'not-found';
                    }
                """)
                page.wait_for_timeout(3000)

                # 확인 팝업 처리
                page.evaluate("""
                    () => {
                        const btns = document.querySelectorAll('button');
                        for (const b of btns) {
                            if (b.textContent.trim() === '확인') { b.click(); return; }
                        }
                    }
                """)
                page.wait_for_timeout(5000)
            except Exception as e:
                return {"success": False, "post_url": None, "error": f"등록 버튼 클릭 실패: {e}"}

            _debug(page, "05_submitted")

            post_url = page.url
            if "/write" not in post_url:
                return {"success": True, "post_url": post_url, "error": None}
            else:
                _debug(page, "06_still_write")
                return {"success": False, "post_url": None, "error": "등록 실패 — 게시판 미선택 또는 제목 미입력 가능성"}

        except Exception as e:
            _debug(page, "99_error")
            return {"success": False, "post_url": None, "error": str(e)}
        finally:
            context.close()
