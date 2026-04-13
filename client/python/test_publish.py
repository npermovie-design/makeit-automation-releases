"""geongangjeogyeogsu 계정 발행 테스트 — 세션 로그인 + 더미 글 발행"""

import sys, os
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from naver_blog import publish_to_naver_blog

NAVER_ID = "geongangjeogyeogsu"

# 더미 블록 (텍스트 2개 + 이미지 1개)
blocks = [
    {"type": "text", "content": "이것은 메이킷 SNS 자동화 발행 테스트입니다.\n\n세션 로그인이 정상 작동하는지 확인하기 위한 글입니다."},
    {"type": "image", "keyword": "automation", "url": "https://images.pexels.com/photos/3861969/pexels-photo-3861969.jpeg?auto=compress&cs=tinysrgb&w=800"},
    {"type": "text", "content": "발행이 성공하면 세션 유지가 정상적으로 작동하는 것입니다.\n\n테스트 완료 후 이 글은 삭제해도 됩니다."},
]

result = publish_to_naver_blog(
    user_id=NAVER_ID,       # 프로필 폴더명 = 네이버 아이디
    naver_id=NAVER_ID,
    naver_pw="",            # 세션 있으면 비번 불필요
    title="[테스트] 메이킷 자동화 발행 테스트",
    blocks=blocks,
    tags=["테스트", "자동화"],
    headless=False,         # 눈으로 확인용
)

if result["success"]:
    print(f"\n발행 성공! URL: {result['post_url']}")
else:
    print(f"\n발행 실패: {result['error']}")
