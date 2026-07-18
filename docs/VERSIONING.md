# 버전관리 체계

PhotoDedup은 SemVer `X.Y.Z` 형식을 사용한다. 버전의 단일 진실은 `shell/package.json`의 `"version"`이며, `renderer/package.json`의 `"version"`은 항상 같은 값으로 동기화한다.

## 증가 기준

- 패치 `Z`: 버그 수정, UI 문구/스타일 수정, 테스트 보강처럼 기존 기능의 호환성을 유지하는 변경
- 마이너 `Y`: 기존 사용 흐름을 깨지 않는 기능 추가
- 메이저 `X`: 설정, 데이터, 릴리스 산출물, 사용자 워크플로 등에서 호환성을 깨는 변경

## 릴리스 절차

1. `renderer/package.json`과 `shell/package.json` 두 곳의 버전을 같은 `X.Y.Z` 값으로 올린다.
2. 사설 저장소 `main`에 커밋하고 push한다.
3. `scripts/release-public.sh vX.Y.Z`를 실행해 공개 미러 `lisyoen/photodedup`에 동기화하고 태그를 push한다.
4. 공개 미러 태그 push 후 CI가 GitHub Releases 산출물을 생성한다.

## 앱 내 버전 노출

설정 모달 하단에는 현재 실행 중인 앱 버전을 표시한다. renderer는 preload를 통해 `app.getVersion()` 값을 IPC로 요청하며, 표시는 `shell/package.json` 버전과 일치해야 한다.

## 실행 시 업데이트 확인

앱은 준비 완료 후 메인 윈도우 로드가 끝나면 GitHub 공개 릴리스의 최신 버전을 1회 확인한다. 네트워크 실패, GitHub rate limit, 타임아웃은 앱 실행을 막지 않고 조용히 무시한다. 소스 설치본은 사용자가 승인하면 `git pull origin main`과 renderer/shell 빌드를 순차 실행한 뒤 재시작 버튼을 제공한다. 패키징 설치본은 자동 업데이트 대신 릴리스 페이지를 연다.
