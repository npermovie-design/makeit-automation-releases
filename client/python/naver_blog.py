"""네이버 블로그 자동 발행 모듈 (Playwright sync, 사용자별 세션 유지)

메이킷 shorts-factory/naver_publisher.py 베이스로 다음을 보강:
- launch_persistent_context로 사용자별 세션 영속화 (캡차 회피)
- async -> sync 변환 (Electron subprocess 호환)
- 셀렉터 폴백 강화
"""

import os
import re
import time
import logging
import tempfile
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, Page, BrowserContext, TimeoutError as PWTimeout

logger = logging.getLogger("naver-blog")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def get_profile_dir(user_id: str) -> Path:
    """사용자별 browser_profile 경로 (%APPDATA%\\NaverBotSaaS\\profiles\\{user_id})"""
    base = Path(os.environ.get("APPDATA", str(Path.home()))) / "NaverBotSaaS" / "profiles" / user_id
    base.mkdir(parents=True, exist_ok=True)
    return base


def _try_selectors(page_or_frame, selectors: list[str], timeout: int = 5000):
    """여러 셀렉터를 순차 시도. 첫 매칭 요소 반환, 없으면 None."""
    for sel in selectors:
        try:
            el = page_or_frame.wait_for_selector(sel, timeout=timeout, state="visible")
            if el:
                return el
        except PWTimeout:
            continue
        except Exception:
            continue
    return None


def _is_logged_in(page: Page) -> bool:
    """현재 페이지가 로그인 상태인지 확인 (URL 기반)"""
    url = page.url
    return "nidlogin" not in url and "nid.naver.com/nidlogin" not in url


def _login(page: Page, naver_id: str, naver_pw: str) -> bool:
    """네이버 로그인. JS 주입 방식으로 봇 탐지 우회.

    Returns:
        True: 로그인 성공
        False: 캡차/2차인증 등으로 실패 (사용자 개입 필요)
    """
    page.goto("https://nid.naver.com/nidlogin.login", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    if _is_logged_in(page):
        logger.info("이미 로그인 상태")
        return True

    # JS로 직접 주입
    page.evaluate(
        """([id, pw]) => {
            const idEl = document.querySelector('#id');
            const pwEl = document.querySelector('#pw');
            if (idEl) { idEl.value = id; idEl.dispatchEvent(new Event('input', {bubbles: true})); }
            if (pwEl) { pwEl.value = pw; pwEl.dispatchEvent(new Event('input', {bubbles: true})); }
        }""",
        [naver_id, naver_pw],
    )
    page.wait_for_timeout(500)

    # 로그인 버튼 클릭
    btn = _try_selectors(page, [".btn_login", "#log\\.login", "button[type='submit']"], timeout=3000)
    if btn:
        btn.click()

    # 최대 30초 로그인 대기
    for _ in range(30):
        page.wait_for_timeout(1000)
        if _is_logged_in(page):
            logger.info("로그인 성공")
            return True

    # 캡차/2차인증
    if "captcha" in page.url.lower() or "deviceConfirm" in page.url:
        logger.warning("캡차/2차인증 감지 - 사용자 개입 필요")
        return False

    logger.warning(f"로그인 실패. URL={page.url}")
    return False


_POPUP_CLOSE_JS = """
() => {
  let closed = 0;
  // 취소 버튼 강제 클릭
  document.querySelectorAll(
    '.se-popup-button-cancel, .se-popup-alert button.se-popup-button-cancel, ' +
    'button.se-popup-button[data-name="cancel"], .se-popup-alert-confirm button'
  ).forEach(btn => {
    try {
      const txt = (btn.textContent || '').trim();
      if (txt.includes('취소') || txt.includes('닫기') || txt.includes('나가기') || btn.classList.contains('se-popup-button-cancel')) {
        btn.click();
        closed++;
      }
    } catch(e) {}
  });
  // 팝업 요소 자체를 DOM에서 제거 (마지막 수단)
  document.querySelectorAll('.se-popup, .se-popup-dim, [class*="se-popup-alert"]').forEach(el => {
    try { el.remove(); closed++; } catch(e) {}
  });
  return closed;
}
"""


def _select_naver_template(page: Page, target, template_name: str) -> bool:
    """네이버 블로그 글쓰기 페이지에서 '내 템플릿' 선택.

    절차:
    1. 우상단 '템플릿' 버튼 클릭 → 패널 열림
    2. '내 템플릿' 탭 클릭
    3. template_name과 일치하는 목록 아이템 클릭
    4. 템플릿 로드 완료 대기
    """
    if not template_name:
        return False

    logger.info(f"템플릿 선택 시도: {template_name}")

    # 1. 템플릿 버튼 클릭 (우상단 툴바)
    template_btn_selectors = [
        "button.se-template-button",
        "button[data-name='template']",
        "button[aria-label*='템플릿']",
        "button[title*='템플릿']",
        ".se-toolbar-button[data-type='template']",
        ".se-top-btn button[data-type='template']",
        ".tool_area button:has-text('템플릿')",
        ".header_tool button:has-text('템플릿')",
        "button:has-text('템플릿')",
        "a:has-text('템플릿')",
        "[class*='template']:has-text('템플릿')",
        "[class*='tpl']",
    ]

    def find_template_button_in(ctx):
        # 우선 CSS selector 시도
        for sel in template_btn_selectors:
            try:
                if hasattr(ctx, "query_selector_all"):
                    els = ctx.query_selector_all(sel)
                    for el in els:
                        try:
                            if el.is_visible():
                                return el
                        except Exception:
                            continue
            except Exception:
                continue

        # 마지막 폴백: JavaScript로 전체 DOM 텍스트 검색
        try:
            handle = ctx.evaluate_handle("""
                () => {
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
                    for (const el of candidates) {
                        const text = (el.innerText || el.textContent || '').trim();
                        if (text === '템플릿' || text.startsWith('템플릿')) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                return el;
                            }
                        }
                    }
                    return null;
                }
            """)
            if handle:
                try:
                    el = handle.as_element()
                    if el:
                        return el
                except Exception:
                    pass
        except Exception:
            pass
        return None

    tmpl_btn = find_template_button_in(target) or find_template_button_in(page)
    if not tmpl_btn and hasattr(target, "child_frames"):
        for cf in target.child_frames:
            tmpl_btn = find_template_button_in(cf)
            if tmpl_btn:
                break

    if not tmpl_btn:
        logger.warning("템플릿 버튼을 찾을 수 없음 — 스킵")
        # 디버그용 스크린샷
        try:
            debug_dir = Path(__file__).parent / "debug"
            debug_dir.mkdir(exist_ok=True)
            page.screenshot(path=str(debug_dir / "template_button_not_found.png"), full_page=True)
        except Exception:
            pass
        return False

    # 클릭 가로막는 헤더/배너 제거
    try:
        page.evaluate("""
            () => {
                document.querySelectorAll('.se-help-header, .se-help-header-dark, .se-popup-alert-confirm, .se-guide-popup').forEach(el => el.remove());
                for (const f of window.frames) {
                    try { f.document.querySelectorAll('.se-help-header, .se-help-header-dark, .se-popup-alert-confirm, .se-guide-popup').forEach(el => el.remove()); } catch {}
                }
            }
        """)
        page.wait_for_timeout(300)
    except Exception:
        pass

    try:
        tmpl_btn.click(timeout=10000)
        page.wait_for_timeout(1500)
    except Exception as e:
        # JS 직접 클릭 폴백
        try:
            tmpl_btn.evaluate("el => el.click()")
            page.wait_for_timeout(1500)
        except Exception:
            logger.warning(f"템플릿 버튼 클릭 실패: {e}")
            return False

    # 2. '내 템플릿' 탭 클릭
    my_tab_selectors = [
        "button:has-text('내 템플릿')",
        "a:has-text('내 템플릿')",
        ".se-template-tab:has-text('내 템플릿')",
        "[role='tab']:has-text('내 템플릿')",
    ]
    my_tab = _try_selectors(target, my_tab_selectors, timeout=3000)
    if not my_tab:
        my_tab = _try_selectors(page, my_tab_selectors, timeout=2000)
    if my_tab:
        try:
            my_tab.click()
            page.wait_for_timeout(1000)
        except Exception:
            pass

    # 3. 템플릿 목록에서 이름 매칭
    try:
        # 다양한 selector로 목록 아이템 탐색
        item_selectors = [
            ".se-template-item",
            "li.se-template-list-item",
            ".se-template-content li",
            "[class*='template-item']",
        ]
        found = False
        for sel in item_selectors:
            try:
                items = (target if hasattr(target, "query_selector_all") else page).query_selector_all(sel)
                if not items:
                    continue
                for item in items:
                    try:
                        text = (item.inner_text() or "").strip()
                        if template_name in text or text.startswith(template_name):
                            item.click()
                            found = True
                            break
                    except Exception:
                        continue
                if found:
                    break
            except Exception:
                continue

        if not found:
            logger.warning(f"템플릿 '{template_name}' 이름 매칭 실패 — 스킵")
            # 템플릿 패널 닫기
            try:
                close_btn = page.query_selector("button[aria-label*='닫기'], .se-template-close")
                if close_btn:
                    close_btn.click()
            except Exception:
                pass
            return False

        # 4. 템플릿 로드 대기
        page.wait_for_timeout(2500)
        logger.info(f"템플릿 '{template_name}' 적용됨")
        return True
    except Exception as e:
        logger.warning(f"템플릿 선택 실패: {e}")
        return False


def _click_quote_button(page: Page, target) -> bool:
    """에디터 툴바의 인용구 버튼 클릭."""
    selectors = [
        "button.se-quotation-toolbar-button",
        "button[data-name='quotation']",
        "button[aria-label*='인용구']",
        ".se-toolbar button[data-type='quotation']",
        "button:has-text('인용구')",
    ]
    btn = None
    for sel in selectors:
        try:
            btn = (target if hasattr(target, "query_selector") else page).query_selector(sel)
            if btn and btn.is_visible():
                break
        except Exception:
            continue
    if not btn and hasattr(target, "child_frames"):
        for cf in target.child_frames:
            for sel in selectors:
                try:
                    el = cf.query_selector(sel)
                    if el and el.is_visible():
                        btn = el
                        break
                except Exception:
                    continue
            if btn:
                break
    if not btn:
        return False
    try:
        btn.click()
        page.wait_for_timeout(400)
        return True
    except Exception:
        return False


def _dismiss_popups(page: Page, target=None) -> int:
    """SmartEditor의 임시저장/알림 팝업을 강제로 모두 닫음.

    여러 방법 시도:
    1. 모든 frame에서 취소/닫기 버튼 찾아 클릭
    2. page.evaluate로 직접 DOM 조작 (overlay 우회)
    3. ESC 키
    Returns: 닫은 팝업 개수
    """
    closed = 0
    cancel_selectors = [
        ".se-popup-button-cancel",
        ".se-popup-alert button.se-popup-button-cancel",
        ".se-popup-alert-confirm button.se-popup-button-cancel",
        "button.se-popup-button[data-name='cancel']",
        "button.se-popup-button:has-text('취소')",
        ".se-popup button:has-text('취소')",
        ".se-popup button:has-text('닫기')",
        ".se-popup button:has-text('나가기')",
        "button:has-text('취소')",
    ]

    contexts = [page] + list(page.frames)
    if target and target not in contexts:
        contexts.insert(0, target)

    for ctx in contexts:
        for sel in cancel_selectors:
            try:
                btns = ctx.query_selector_all(sel) if hasattr(ctx, "query_selector_all") else []
                for btn in btns:
                    try:
                        if btn.is_visible():
                            btn.click()
                            page.wait_for_timeout(300)
                            closed += 1
                    except Exception:
                        continue
            except Exception:
                continue

    # JavaScript 강제 닫기 (DOM 직접 제거, overlay 우회)
    try:
        for ctx in contexts:
            if hasattr(ctx, "evaluate"):
                try:
                    n = ctx.evaluate(_POPUP_CLOSE_JS)
                    closed += int(n or 0)
                except Exception:
                    continue
    except Exception:
        pass

    # ESC 키 폴백
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        page.keyboard.press("Escape")
    except Exception:
        pass

    return closed


def _enter_write_page(page: Page) -> Page | object:
    """블로그 글쓰기 페이지로 이동, 에디터 frame 또는 page 반환

    네이버 블로그 글쓰기는 보통 mainFrame iframe 안에 SmartEditor가 들어있음.
    구조: page → iframe[name=mainFrame] → SmartEditor
    """
    page.goto("https://blog.naver.com/GoBlogWrite.naver", wait_until="domcontentloaded")
    page.wait_for_timeout(5000)  # SmartEditor 로딩 대기

    # mainFrame iframe 우선 탐색
    main_frame = None
    for frame in page.frames:
        name = frame.name or ""
        url = frame.url or ""
        if name == "mainFrame" or "PostWriteForm" in url or "editor" in url.lower():
            main_frame = frame
            break

    if main_frame:
        logger.info(f"에디터 frame 발견: {main_frame.name} ({main_frame.url[:60]})")
        try:
            main_frame.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:
            pass
        page.wait_for_timeout(2000)

    # 팝업 닫기 (최대 3회 시도)
    for attempt in range(3):
        n = _dismiss_popups(page, main_frame)
        if n == 0:
            break
        logger.info(f"팝업 {n}개 닫음 (attempt {attempt+1})")
        page.wait_for_timeout(500)

    return main_frame if main_frame else page


def _input_title(target, title: str, page: Page = None) -> bool:
    """제목 입력. target은 page 또는 frame, page는 keyboard 폴백용."""
    # 클릭 전 팝업 재확인 (동적으로 뜰 수 있음)
    if page:
        _dismiss_popups(page, target)

    selectors = [
        ".se-title-text",
        ".se-title-text [contenteditable]",
        ".se_editArea .se-title-text",
        '[placeholder*="제목"]',
        ".title__input",
        ".se_title input",
        'textarea[placeholder*="제목"]',
        "textarea.se-title-text",
        "span.se-placeholder",
    ]
    el = _try_selectors(target, selectors, timeout=10000)

    # 자식 frame 재탐색
    if not el and hasattr(target, "child_frames"):
        for cf in target.child_frames:
            el = _try_selectors(cf, selectors, timeout=3000)
            if el:
                target = cf
                break

    kb = page.keyboard if page else None

    if el:
        # 팝업이 클릭을 가로챌 수 있으니 재시도 루프
        for attempt in range(3):
            try:
                el.click(timeout=5000)
                # 기존 텍스트 전체 선택 후 삭제 (템플릿 기본 제목 제거)
                if kb:
                    kb.press("Control+a")
                    kb.press("Backspace")
                try:
                    el.fill(title)
                    return True
                except Exception:
                    if kb:
                        kb.type(title, delay=20)
                        return True
            except Exception as e:
                logger.warning(f"제목 클릭 실패 (attempt {attempt+1}): {e}")
                # 팝업 다시 닫고 재시도
                if page:
                    _dismiss_popups(page, target)
                    page.wait_for_timeout(500)

    # 디버그 저장
    if page:
        try:
            debug_dir = Path(__file__).parent / "debug"
            debug_dir.mkdir(exist_ok=True)
            page.screenshot(path=str(debug_dir / "title_not_found.png"), full_page=True)
            with open(debug_dir / "title_not_found.html", "w", encoding="utf-8") as f:
                f.write(page.content())
            with open(debug_dir / "frames.txt", "w", encoding="utf-8") as f:
                for fr in page.frames:
                    f.write(f"name={fr.name} url={fr.url}\n")
            logger.info(f"디버그 파일 저장: {debug_dir}")
        except Exception as e:
            logger.warning(f"디버그 저장 실패: {e}")
    return False


def _input_body_blocks(target, blocks: list[dict], page: Page = None) -> bool:
    """blocks(text/image 순서) 그대로 에디터에 입력.

    blocks 예:
        [{"type":"text","content":"첫 단락..."},
         {"type":"image","local_path":"C:/.../img.jpg"},
         {"type":"text","content":"다음 단락..."}, ...]
    """
    # 에디터 클릭 전 팝업 한 번 더 닫기
    if page:
        _dismiss_popups(page, target)

    # 에디터 포커스
    selectors = [
        ".se-component.se-text .se-text-paragraph",
        ".se-text-paragraph",
        ".se-main-container .se-text-paragraph",
        ".se-component-content .se-text-paragraph",
        '[contenteditable="true"]',
    ]
    el = _try_selectors(target, selectors, timeout=10000)
    if not el and hasattr(target, "child_frames"):
        for cf in target.child_frames:
            el = _try_selectors(cf, selectors, timeout=3000)
            if el:
                target = cf
                break

    if not el:
        logger.error("본문 에디터를 찾을 수 없음")
        if page:
            try:
                debug_dir = Path(__file__).parent / "debug"
                debug_dir.mkdir(exist_ok=True)
                page.screenshot(path=str(debug_dir / "body_not_found.png"), full_page=True)
            except Exception:
                pass
        return False

    try:
        el.click()
        if hasattr(target, "wait_for_timeout"):
            target.wait_for_timeout(1000)
        kb = page.keyboard if page else target.keyboard
        # 기존 템플릿 본문 내용 전체 삭제
        kb.press("Control+a")
        kb.press("Backspace")
        if hasattr(target, "wait_for_timeout"):
            target.wait_for_timeout(500)

        first_block = True
        for blk in blocks:
            btype = blk.get("type")
            if btype == "text":
                content = blk.get("content", "").strip()
                if not content:
                    continue
                # 첫 블록 입력 전 에디터 안정화 대기
                if first_block:
                    if hasattr(target, "wait_for_timeout"):
                        target.wait_for_timeout(500)
                    first_block = False
                for line in content.split("\n"):
                    line = line.strip()
                    if line:
                        kb.type(line, delay=5)
                    kb.press("Enter")
                kb.press("Enter")
            elif btype == "subtitle":
                # 소제목 — 빈 줄 + 텍스트 + 빈 줄
                content = blk.get("content", "").strip()
                if not content:
                    continue
                kb.press("Enter")
                kb.type(content, delay=3)
                kb.press("Enter")
                kb.press("Enter")
            elif btype == "quote":
                # 인용구 — 툴바 버튼 클릭 → 텍스트 입력 → 엔터로 블록 탈출
                content = blk.get("content", "").strip()
                if not content:
                    continue
                quoted = _click_quote_button(page, target)
                if not quoted:
                    # 폴백: 일반 텍스트로 입력 (앞뒤에 " " 추가해서 시각적 강조)
                    kb.type(f'"{content}"', delay=3)
                    kb.press("Enter")
                    kb.press("Enter")
                else:
                    kb.type(content, delay=3)
                    kb.press("Enter")
                    kb.press("Enter")  # 한 번 더 Enter로 quote 블록 탈출
            elif btype == "image":
                local = blk.get("local_path")
                if not local:
                    continue
                _upload_image_to_editor(page, target, local)
                kb.press("End")
                kb.press("Enter")

        return True
    except Exception as e:
        logger.error(f"본문 입력 실패: {e}")
        return False


def _input_body(target, body_text: str, page: Page = None, image_paths: list[str] = None) -> bool:
    """[Legacy] 평문 본문 입력. blocks 미사용 시 폴백."""
    # SmartEditor ONE 본문 영역 셀렉터 (우선순위 순)
    selectors = [
        ".se-component.se-text .se-text-paragraph",
        ".se-text-paragraph",
        ".se-main-container .se-text-paragraph",
        ".se-component-content .se-text-paragraph",
        ".se-main-container .se-section-text",
        ".se-content [contenteditable='true']",
        '[contenteditable="true"]',
        ".se_component_wrap [contenteditable]",
        "div.se-text",
    ]

    el = _try_selectors(target, selectors, timeout=10000)

    # 못 찾으면 자식 frame까지 재탐색
    if not el and hasattr(target, "child_frames"):
        for cf in target.child_frames:
            el = _try_selectors(cf, selectors, timeout=3000)
            if el:
                target = cf
                logger.info(f"본문 에디터를 child frame에서 찾음: {cf.url[:60]}")
                break

    if not el:
        logger.error("본문 에디터를 찾을 수 없음")
        # 디버그용 스크린샷 + HTML 저장
        if page:
            try:
                debug_dir = Path(__file__).parent / "debug"
                debug_dir.mkdir(exist_ok=True)
                page.screenshot(path=str(debug_dir / "body_not_found.png"), full_page=True)
                with open(debug_dir / "body_not_found.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
                # frame 정보도 저장
                with open(debug_dir / "frames.txt", "w", encoding="utf-8") as f:
                    for fr in page.frames:
                        f.write(f"name={fr.name} url={fr.url}\n")
                logger.info(f"디버그 파일 저장: {debug_dir}")
            except Exception as e:
                logger.warning(f"디버그 저장 실패: {e}")
        return False

    try:
        el.click()
        target.wait_for_timeout(500) if hasattr(target, "wait_for_timeout") else None
        kb = page.keyboard if page else target.keyboard
        kb.press("End")

        # 본문을 단락 단위로 분할
        paragraphs = [p for p in body_text.split("\n") if p.strip()]
        n_imgs = len(image_paths or [])

        if n_imgs == 0:
            # 이미지 없음 — 그냥 전체 입력
            for line in paragraphs:
                kb.type(line, delay=3)
                kb.press("Enter")
                kb.press("Enter")
            return True

        # 이미지 균등 배치: 본문을 n_imgs+1 등분
        chunk_size = max(1, len(paragraphs) // (n_imgs + 1))
        img_idx = 0

        for i, line in enumerate(paragraphs):
            kb.type(line, delay=3)
            kb.press("Enter")
            kb.press("Enter")
            # chunk 경계 + 아직 삽입할 이미지 남았으면
            if img_idx < n_imgs and (i + 1) % chunk_size == 0 and i < len(paragraphs) - 1:
                _upload_image_to_editor(page, target, image_paths[img_idx])
                img_idx += 1
                kb.press("End")
                kb.press("Enter")

        # 남은 이미지가 있으면 마지막에 추가
        while img_idx < n_imgs:
            _upload_image_to_editor(page, target, image_paths[img_idx])
            img_idx += 1
            kb.press("End")
            kb.press("Enter")

        return True
    except Exception as e:
        logger.error(f"본문 입력 실패: {e}")
        return False


def _download_image(url: str, idx: int) -> str | None:
    """이미지 URL 1개 다운로드, 로컬 경로 반환."""
    if not url:
        return None
    tmp_dir = Path(tempfile.gettempdir()) / "naverbot_images"
    tmp_dir.mkdir(exist_ok=True)
    try:
        local = tmp_dir / f"img_{int(time.time())}_{idx}.jpg"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        )
        with urllib.request.urlopen(req, timeout=15) as r, open(local, "wb") as f:
            f.write(r.read())
        logger.info(f"이미지 다운로드: {local.name}")
        return str(local)
    except Exception as e:
        logger.warning(f"이미지 다운로드 실패 ({url[:50]}): {e}")
        return None


def _download_blocks_images(blocks: list[dict]) -> list[dict]:
    """blocks 안의 image 블록들 미리 다운로드해서 local_path 추가."""
    out = []
    for i, blk in enumerate(blocks):
        if blk.get("type") == "image":
            local = _download_image(blk.get("url", ""), i)
            if local:
                out.append({**blk, "local_path": local})
            # 다운로드 실패 시 그 블록은 스킵
        else:
            out.append(blk)
    return out


def _upload_image_to_editor(page: Page, target, image_path: str) -> bool:
    """네이버 블로그 에디터에 이미지 1장 업로드."""
    if not os.path.exists(image_path):
        return False

    # 사진 버튼 셀렉터 (toolbar)
    photo_selectors = [
        "button.se-image-toolbar-button",
        "button[data-name='image']",
        "button[aria-label*='사진']",
        ".se-toolbar button[data-type='image']",
        ".se-toolbar button.se-document-toolbar-basic-button",
    ]

    btn = None
    for sel in photo_selectors:
        try:
            elements = (target if hasattr(target, "query_selector_all") else page).query_selector_all(sel)
            for el in elements:
                label = el.get_attribute("aria-label") or ""
                if "사진" in label or "image" in label.lower() or sel != ".se-toolbar button.se-document-toolbar-basic-button":
                    btn = el
                    break
            if btn:
                break
        except Exception:
            continue

    if not btn:
        logger.warning("사진 버튼 못 찾음")
        return False

    try:
        with page.expect_file_chooser(timeout=8000) as fc_info:
            btn.click()
        chooser = fc_info.value
        chooser.set_files(image_path)
        page.wait_for_timeout(3500)  # 업로드 대기
        # 업로드 후 원본 사이즈 다이얼로그 처리
        try:
            for sel in ['button:has-text("원본")', 'button:has-text("적용")']:
                b = page.query_selector(sel)
                if b and b.is_visible():
                    b.click()
                    page.wait_for_timeout(500)
                    break
        except Exception:
            pass
        logger.info(f"이미지 삽입 완료: {os.path.basename(image_path)}")
        return True
    except Exception as e:
        logger.warning(f"이미지 업로드 실패: {e}")
        return False


def _input_tags(target, tags: list[str]) -> None:
    if not tags:
        return
    selectors = ['.tag__input', '[placeholder*="태그"]', 'input[class*="tag"]']
    el = _try_selectors(target, selectors, timeout=3000)
    if not el:
        logger.warning("태그 입력란 못 찾음 - 스킵")
        return
    try:
        for tag in tags[:10]:
            el.fill(tag)
            target.keyboard.press("Enter")
            target.wait_for_timeout(200)
    except Exception as e:
        logger.warning(f"태그 입력 부분 실패: {e}")


def _publish(page: Page, target=None) -> bool:
    """발행 버튼 2단계 클릭 처리.

    1단계: 우상단 "발행" 버튼 → 사이드 패널 열림
    2단계: 사이드 패널 안 "발행" 버튼 → 실제 발행
    """
    search_in = target if target else page

    # 1단계: 우상단 발행 버튼 (사이드패널 열기)
    step1_selectors = [
        "button.publish_btn__m9KHH",  # 신형 클래스
        "button.btn_publish",
        ".header button.publish_btn",
        "button[class*='publish']:has-text('발행')",
        ".btn_area button:has-text('발행')",
        "button:has-text('발행')",
    ]
    step1 = _try_selectors(search_in, step1_selectors, timeout=5000)
    if not step1:
        # frame 재탐색
        if hasattr(search_in, "child_frames"):
            for cf in search_in.child_frames:
                step1 = _try_selectors(cf, step1_selectors, timeout=2000)
                if step1:
                    search_in = cf
                    break
    if not step1:
        logger.error("1단계 발행 버튼 못 찾음")
        return False

    try:
        step1.click()
        logger.info("1단계 발행 버튼 클릭 → 사이드패널 대기")
    except Exception as e:
        logger.error(f"1단계 클릭 실패: {e}")
        return False

    page.wait_for_timeout(2500)  # 사이드패널 애니메이션 대기

    # 2단계: 사이드패널 안 진짜 발행 버튼
    step2_selectors = [
        "button.confirm_btn__WEaBq",  # 신형
        ".publish_btn_area button.confirm_btn",
        "button.btn_confirm:has-text('발행')",
        ".layer_publish button:has-text('발행')",
        ".publish_layer button:has-text('발행')",
        "[class*='publish'] button:has-text('발행')",
        "button:has-text('발행'):not([class*='cancel'])",
    ]
    step2 = _try_selectors(search_in, step2_selectors, timeout=5000)
    if not step2:
        # 마지막으로 page 전체에서 발행 버튼 찾기 (사이드패널이 다른 frame일 수도)
        step2 = _try_selectors(page, step2_selectors, timeout=3000)

    if not step2:
        logger.error("2단계 발행 버튼 못 찾음 (사이드패널)")
        try:
            debug_dir = Path(__file__).parent / "debug"
            debug_dir.mkdir(exist_ok=True)
            page.screenshot(path=str(debug_dir / "publish_step2.png"), full_page=True)
        except Exception:
            pass
        return False

    try:
        step2.click()
        logger.info("2단계 발행 버튼 클릭")
    except Exception as e:
        logger.error(f"2단계 클릭 실패: {e}")
        return False

    page.wait_for_timeout(5000)  # 발행 처리 대기

    # 발행 확인 — URL이 GoBlogWrite/PostWriteForm 에서 벗어났는지
    final_url = page.url
    logger.info(f"발행 후 URL: {final_url}")
    if any(s in final_url for s in ["GoBlogWrite", "PostWriteForm", "Redirect=Write"]):
        return False
    return True


def publish_to_naver_blog(
    user_id: str,
    naver_id: str,
    naver_pw: str,
    title: str,
    body: str = "",
    tags: list[str] | None = None,
    images: list[dict] | None = None,
    blocks: list[dict] | None = None,
    template_name: str = "",
    headless: bool = True,
) -> dict:
    """네이버 블로그에 글 발행.

    Args:
        user_id: SaaS 내부 사용자 ID (browser_profile 폴더명)
        naver_id, naver_pw: 네이버 로그인 정보
        title: 글 제목
        body: 본문 (텍스트, 줄바꿈 유지)
        tags: 태그 리스트 (최대 10개)
        headless: 헤드리스 모드 (캡차 발생 시 False로 재실행 권장)

    Returns:
        {"success": bool, "post_url": str | None, "error": str | None}
    """
    profile_dir = get_profile_dir(user_id)

    # blocks 우선, 없으면 legacy 방식
    use_blocks = bool(blocks)
    if use_blocks:
        prepared_blocks = _download_blocks_images(blocks)
    else:
        prepared_blocks = None
        image_paths = []  # legacy 폴백 (사용 안함)

    with sync_playwright() as p:
        context: BrowserContext = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=headless,
            viewport={"width": 1280, "height": 900},
            user_agent=USER_AGENT,
            locale="ko-KR",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        page = context.pages[0] if context.pages else context.new_page()

        try:
            # 1. 로그인 (세션 살아있으면 즉시 통과)
            page.goto("https://blog.naver.com", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            if not _is_logged_in(page):
                ok = _login(page, naver_id, naver_pw)
                if not ok:
                    return {
                        "success": False,
                        "post_url": None,
                        "error": "로그인 실패 - 캡차/2차인증 의심. headless=False로 수동 로그인 1회 필요.",
                    }

            # 2. 글쓰기 페이지
            target = _enter_write_page(page)

            # 임시저장 팝업 닫기 (있으면)
            try:
                cancel = page.query_selector('button:has-text("취소")')
                if cancel and cancel.is_visible():
                    cancel.click()
                    page.wait_for_timeout(500)
            except Exception:
                pass

            # 2.5. 템플릿 선택 (설정된 경우)
            if template_name:
                _select_naver_template(page, target, template_name)
                _dismiss_popups(page, target)

            # 3. 제목
            if not _input_title(target, title, page=page):
                return {"success": False, "post_url": None, "error": "제목 입력 실패"}

            page.wait_for_timeout(500)

            # 4. 본문 (+ 이미지 자동 삽입)
            if use_blocks:
                if not _input_body_blocks(target, prepared_blocks, page=page):
                    return {"success": False, "post_url": None, "error": "본문 입력 실패"}
            else:
                if not _input_body(target, body, page=page, image_paths=[]):
                    return {"success": False, "post_url": None, "error": "본문 입력 실패"}

            # 5. 태그
            _input_tags(target, tags or [])

            # 6. 발행
            if not _publish(page, target=target):
                return {"success": False, "post_url": None, "error": "발행 실패 (사이드패널/2단계 버튼 확인 필요)"}

            post_url = page.url
            logger.info(f"발행 성공: {post_url}")
            return {"success": True, "post_url": post_url, "error": None}

        except Exception as e:
            logger.exception("발행 중 예외")
            return {"success": False, "post_url": None, "error": str(e)[:300]}
        finally:
            context.close()


if __name__ == "__main__":
    # 단독 테스트
    import sys
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 4:
        print("Usage: python naver_blog.py <user_id> <naver_id> <naver_pw>")
        sys.exit(1)
    result = publish_to_naver_blog(
        user_id=sys.argv[1],
        naver_id=sys.argv[2],
        naver_pw=sys.argv[3],
        title="[테스트] 자동 포스팅",
        body="이 글은 자동 포스팅 테스트입니다.\n정상 등록 시 삭제해주세요.",
        tags=["테스트"],
        headless=False,
    )
    print(result)
