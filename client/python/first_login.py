"""최초 1회: 네이버에 직접 로그인해서 세션 저장

사용:
    python first_login.py [user_id]
    (user_id 생략 시 test_user)

브라우저가 열리면 직접 손으로 ID/PW 입력 + 캡차/2차인증 통과해주세요.
로그인 완료되면 자동으로 감지 후 종료합니다. (최대 5분 대기)
"""

import sys
import os
import time

# Python embeddable 호환
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from playwright.sync_api import sync_playwright
from naver_blog import get_profile_dir, USER_AGENT

USER_ID = sys.argv[1] if len(sys.argv) > 1 else "test_user"
MAX_WAIT_SEC = 300  # 5분

profile_dir = get_profile_dir(USER_ID)
print(f"세션 저장 위치: {profile_dir}", flush=True)

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir=str(profile_dir),
        headless=False,
        viewport={"width": 1280, "height": 900},
        user_agent=USER_AGENT,
        locale="ko-KR",
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://nid.naver.com/nidlogin.login")

    print("", flush=True)
    print("=" * 60, flush=True)
    print(" 브라우저 창에서 직접 네이버 로그인 해주세요", flush=True)
    print(" 로그인 성공하면 자동 감지 후 종료됩니다 (최대 5분)", flush=True)
    print("=" * 60, flush=True)

    # 로그인 완료 자동 감지 (URL 변화 + 쿠키 폴링)
    start = time.time()
    success = False
    while time.time() - start < MAX_WAIT_SEC:
        try:
            cur_url = page.url
            # 로그인 페이지/2차인증 페이지가 아니면 성공
            if ("nidlogin" not in cur_url
                and "nid.naver.com/nidlogin" not in cur_url
                and "nid.naver.com/user2" not in cur_url
                and "nid.naver.com/login" not in cur_url):
                print(f"\n로그인 감지됨! 현재 URL: {cur_url}", flush=True)
                success = True
                break
            # 쿠키로도 감지 (NID_AUT 또는 NID_SES 존재 시)
            cookies = context.cookies("https://naver.com")
            cookie_names = {c["name"] for c in cookies}
            if "NID_AUT" in cookie_names or "NID_SES" in cookie_names:
                print(f"\n로그인 감지됨 (쿠키)! 현재 URL: {cur_url}", flush=True)
                success = True
                break
        except Exception:
            pass
        time.sleep(2)

    if success:
        # 안전하게 몇 초 더 대기 (쿠키 완전 저장)
        try:
            page.wait_for_timeout(3000)
        except Exception:
            time.sleep(3)
        print("세션 저장 완료. 다음부터는 자동 로그인됩니다.", flush=True)
    else:
        print("5분 타임아웃. 로그인 안 됐거나 페이지 이동 안 됨.", flush=True)

    try:
        context.close()
    except Exception:
        pass
