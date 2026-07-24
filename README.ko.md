[English](README.md) | 한국어

# PhotoDedup

PhotoDedup은 중복 사진과 시각적으로 유사한 사진을 찾아 정리하는 데스크톱 앱입니다. 로컬 폴더를 스캔하고 perceptual hash로 후보 그룹을 만든 뒤, 불필요한 파일을 보관 폴더나 시스템 휴지통으로 이동할 수 있게 도와줍니다.

앱은 로컬 우선 구조입니다. 사진은 사용자의 컴퓨터에 그대로 남고, 스캔 데이터는 로컬 SQLite 데이터베이스에 저장됩니다. PhotoDedup은 이미지나 스캔 결과를 원격 서비스로 업로드하지 않습니다.

![PhotoDedup 메인 화면](docs/images/screenshot-main.png)

## 주요 기능

- Perceptual hash 기반 중복 및 유사 사진 그룹핑
- 플랫폼 이미지 라이브러리가 지원되는 환경에서 HEIC/HEIF 지원
- 해상도, 파일 크기, 선명도, 메타데이터를 활용한 보관 추천
- 선택한 파일을 보관 폴더 또는 시스템 휴지통으로 이동
- 보관 폴더로 이동한 파일 복원
- 설정에서 그룹 목록 캐시 확인 및 비우기
- 한국어, 영어, 일본어 UI 라벨
- Electron 데스크톱 shell과 로컬 Python FastAPI sidecar 구조

## 설치

GitHub Releases에서 최신 바이너리를 다운로드하세요.

- Windows: 설치본(`.exe`) 또는 portable 빌드
- Linux: AppImage

릴리스 페이지:

https://github.com/lisyoen/photodedup/releases

## 릴리스 이력

| 버전 | 날짜 | 요약 |
|------|------|------|
| v0.1.6 | 2026-07-24 | 1분 주기 업데이트 체크·60초 토스트. |
| v0.1.4 | 2026-07-18 | 증분 스캔 캐시 통계를 표시하고, 신규 파일이 없으면 그룹핑을 생략하며, 소스 설치 업데이트 수정 사항을 최신 상태로 유지했습니다. |
| v0.1.3 | 2026-07-18 | 소스 설치 업데이트 명령이 올바른 패키지 디렉터리에서 실행되도록 수정했습니다. |
| v0.1.2 | 2026-07-18 | 시작 시 업데이트 확인, 버전 배지 표시, 업데이트 흐름 테스트를 추가했습니다. |
| v0.1.1 | 2026-07-18 | 공개 README 현지화 링크, 스크린샷, 설정 캐시 제어, 모달 레이아웃 동작을 개선했습니다. |
| v0.1.0 | 2026-07-18 | 로컬 중복 사진 스캔, 품질 기반 보관 추천, 정리, 복원, 다국어 UI를 포함한 첫 공개 릴리스입니다. |

## 개발 셋업

PhotoDedup은 세 부분으로 구성됩니다.

- `renderer/`: React + Vite UI
- `shell/`: Electron main process 및 preload 스크립트
- `engine/`: Python FastAPI sidecar 및 사진 처리 엔진

renderer 설치 및 빌드:

```bash
cd renderer
npm ci
npm run build
```

Electron shell 설치 및 빌드:

```bash
cd shell
npm ci
npm run build
```

Python engine 환경 생성:

```bash
cd engine
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

필요한 테스트 실행:

```bash
cd renderer && npm test
cd shell && npm test
cd engine && . .venv/bin/activate && pytest
```

## 아키텍처

PhotoDedup은 데스크톱 창과 플랫폼 연동을 담당하는 Electron shell, 사용자 인터페이스를 담당하는 React renderer, 스캔·해시·그룹핑·썸네일·정리 계획을 담당하는 Python FastAPI sidecar로 구성됩니다.

Electron 프로세스는 `127.0.0.1`의 임시 포트와 토큰으로 sidecar를 시작합니다. renderer는 preload bridge를 통해 로컬 sidecar에만 접근합니다. 사진, 썸네일, manifest는 모두 로컬 머신에 남습니다.

## License

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
