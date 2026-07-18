# P0-A Sidecar API Contract

대상: Electron main이 기동하는 로컬 Python 사이드카. 참조는 `/tmp/photo-dedup-ref`의 실제 `photodedup` 코어와 FastAPI 웹 앱을 읽어 정리했다.

## 참조 구현 증거

### photodedup 모듈과 공개 시그니처

| 모듈 | 공개 함수/클래스 |
|---|---|
| `cleanup.py` | `CleanupPlanItem`, `CleanupSummary`, `is_shared_path(path)`, `ensure_quarantine_destination_safe(path, icloud_root=...)`, `dated_quarantine_dir(root=..., today=None)`, `build_dryrun_plan(db_path, quarantine_dir=None, *, icloud_root=..., group_id=None)`, `build_keep_selection_plan(db_path, group_id, keep_image_id, quarantine_dir=None, *, icloud_root=...)`, `build_image_quarantine_plan(db_path, image_id, quarantine_dir=None, *, icloud_root=...)`, `build_images_quarantine_plan(db_path, image_ids, quarantine_dir=None, *, icloud_root=...)`, `summarize_plan(plan)`, `plan_to_dict(plan)`, `plan_to_json(plan)`, `quarantine_plan(db_path, plan, *, icloud_root=..., allow_keep_ids=None)`, `restore_quarantine(db_path, *, quarantine_id=None, date=None, restore_all=False, icloud_root=...)`, `list_quarantine(db_path)` |
| `cli.py` | `human_bytes(value)`, `run_scan(folder, db_path, threshold, rescan=False, progress_cb=None, include_keep_all=False)`, `run_regroup(db_path, threshold, progress_cb=None, include_keep_all=False)`, `run_backfill_taken_at(db_path, batch_size=500)`, `build_parser()`, `main(argv=None)` |
| `grouping.py` | `GroupableImage`, `UnionFind.find(self, value)`, `UnionFind.union(self, left, right)`, `BKTree.add(self, item)`, `BKTree.query(self, item, max_distance)`, `threshold_to_max_distance(threshold)`, `group_images(images, threshold=90, progress_cb=None)` |
| `hashing.py` | `ImageFingerprint`, `color_histogram(path)`, `fingerprint(path)`, `hamming_similarity(left_hex, right_hex)`, `histogram_correlation(left, right)`, `similarity_percent(left_phash, left_dhash, left_histogram, right_phash, right_dhash, right_histogram)`, `hash_distance(left_hex, right_hex)` |
| `manifest.py` | `CachedImage`, `utc_now()`, `Manifest.close(self)`, `Manifest.init_schema(self)`, `Manifest.backfill_keep_all_is_keep(self)`, `Manifest.cache_lookup(self, image)`, `Manifest.upsert_image(self, image, *, sharpness, phash, dhash, quality_score, histogram)`, `Manifest.backfill_taken_at(self, batch_size=500)`, `Manifest.set_thumb(self, image_id, thumb_path)`, `Manifest.replace_groups(self, groups, keep_by_group, threshold, preserve_keep_all=True, preserve_resolved=True)`, `Manifest.regroup(self, threshold, progress_cb=None, include_keep_all=False)`, `Manifest.set_meta(self, key, value)`, `Manifest.summary(self)` |
| `quality.py` | `sharpness_score(path)`, `has_original_capture_info(path, fmt)`, `quality_score(*, path, width, height, size_bytes, fmt, sharpness=None)`, `choose_keep(image_ids, quality_scores)` |
| `scanner.py` | `ImageFile`, `register_heif()`, `iter_image_paths(root)`, `taken_at_for_path(path, mtime=None)`, `scan_folder(root)` |
| `thumbs.py` | `make_thumbnail(source, thumbnails_dir, image_id, max_side=400)` |
| `web/app.py` | `ScanJobState.snapshot(self)`, `consume_snapshot(self)`, `start(self, kind)`, `progress(self, job_id, processed, total, phase)`, `done(self, job_id, summary)`, `error(self, job_id, exc)`, `create_app(db_path)`, `create_env_app()` |

### 기존 웹 라우트

`/tmp/photo-dedup-ref/photodedup/web/app.py`는 FastAPI 앱이다.

| 메서드 | 경로 | 역할 |
|---|---|---|
| GET | `/healthz` | manifest summary 기반 헬스 체크 |
| GET/HEAD | `/favicon.ico` | 정적 favicon |
| GET/POST | `/login` | 웹 UI 로그인 |
| GET | `/logout` | 세션 종료 |
| GET | `/` | 그룹 리뷰 화면 |
| GET | `/cleanup` | 정리 화면 |
| GET | `/api/cleanup/plan` | 격리 대상 dry-run 계획 |
| GET | `/api/cleanup/quarantine` | 격리 이력 목록 |
| GET | `/api/scan/status` | 스캔 작업 상태 |
| GET | `/api/grouping/status` | 그룹핑 작업 상태 |
| POST | `/api/cleanup/quarantine` | 격리 실행 |
| POST | `/api/cleanup/restore` | 격리 복원 |
| GET | `/thumb/{image_id}` | 썸네일 파일 응답 |
| POST | `/group/{group_id}/keep` | 그룹 keep 지정 |
| POST | `/group/{group_id}/keep/confirm` | keep 지정 확인 후 삭제 |
| POST | `/groups/{group_id}/keep` | 그룹 keep 토글 |
| POST | `/image/{image_id}/delete` | 이미지 단건 격리 |
| POST | `/groups/{group_id}/keep-all` | 그룹 전체 유지 |
| POST | `/groups/{group_id}/keep-all/undo` | 전체 유지 취소 |
| POST | `/groups/{group_id}/delete-all` | 그룹 전체 삭제 |
| POST | `/groups/bulk-keep-delete` | 여러 그룹 추천 keep 후 삭제 |
| POST | `/groups/bulk-delete-all` | 여러 그룹 전체 삭제 |
| POST | `/groups/bulk-keep-all` | 여러 그룹 전체 유지 |
| POST | `/groups/apply` | 그룹별 액션 맵 일괄 적용 |
| POST | `/regroup` | 기존 manifest 재그룹핑 |
| POST | `/rescan` | 파일 재스캔 |

### 스캔 phase와 진행률

`run_scan()`은 `collecting -> scanning -> thumbnails -> grouping -> done` 순서다. 시작 시 `progress_cb(0, 0, "collecting")` 후 파일 목록을 만들며, 수집 중에는 발견 파일 수를 `done`으로 보고하고 `total`은 0으로 둔다. 수집 완료 후 `scanning`의 total은 `scan_folder(folder)` 결과 파일 수다. 진행률 emit은 `_maybe_progress()`가 `force`, `processed == 0`, `processed == total`, `processed % 50 == 0`, 또는 `processed % max(1, total // 100) == 0`일 때 발생한다.

`thumbnails`의 total은 읽기 성공/캐시 재사용 후 `rows` 수이며 `make_thumbnail()` 처리마다 done을 증가시킨다. `grouping`의 total은 groupable image 수이며 `group_images()` 내부에서 0, 완료, 200개 단위 또는 0.5초 이상 간격으로 emit한다. 웹 `ScanJobState`는 `percent = processed / total * 100`, `elapsed_seconds`, `message`를 계산한다.

## 사이드카 수명과 인증

사이드카는 Electron main이 앱 시작 시 child process로 실행하고 `127.0.0.1:{random_port}`에만 바인딩한다. 외부 네트워크 인터페이스는 열지 않는다.

Electron main은 매 실행마다 충분히 긴 난수 토큰을 생성하고 모든 REST 요청에 `X-PD-Token` 헤더로 전달한다. 사이드카는 `/healthz`를 포함한 모든 endpoint에서 토큰을 검증한다. 토큰 불일치는 `401 unauthorized`이며, CORS는 Electron renderer origin만 허용한다.

DB 경로는 `%LOCALAPPDATA%\PhotoDedupDesktop\manifest.db`, 썸네일 캐시는 `%LOCALAPPDATA%\PhotoDedupDesktop\thumbs\`로 고정한다. 사이드카 프로세스 수명은 Electron 앱 수명에 종속되며, 종료 시 진행 중인 scan/cleanup job은 `cancel_requested` 상태로 DB에 남긴다.

## 책임 분리

휴지통 삭제는 Electron main의 `shell.trashItem`이 수행한다. 플랫폼별 권한, OS 휴지통 통합, 사용자 환경별 동작 차이를 Electron/Chromium 레이어가 더 안정적으로 처리하기 때문이다. 사이드카는 삭제 대상 목록 산출, 경로 안전성 검증, 예상 reclaimable 계산, 실행 후 결과 수신과 DB 반영만 담당한다.

격리 저장소는 기존 이력과 복원 기능을 위해 앱 데이터 폴더 하위 `quarantine`에 유지한다. P0-C의 전체 적용 실행 모드는 `trash`와 `permanent`이며, `POST /restore`는 격리 이력이 있는 항목의 원위치 복원에만 사용한다.

## 공통 규약

### 에러 응답

```json
{
  "error": {
    "code": "not_found",
    "message": "group not found",
    "details": {"group_id": 12},
    "request_id": "req_..."
  }
}
```

| HTTP | code | 의미 |
|---|---|---|
| 400 | `invalid_request` | 요청 schema 또는 값 범위 오류 |
| 401 | `unauthorized` | `X-PD-Token` 누락/불일치 |
| 404 | `not_found` | scan/group/image/job 없음 |
| 409 | `conflict` | 이미 실행 중, 취소 불가, 상태 충돌 |
| 422 | `unsafe_path` | 루트 밖 경로, 공유/클라우드 placeholder 등 안전성 실패 |
| 500 | `internal_error` | 처리 중 예외 |

### 페이지네이션

그룹 수천 개를 기본 전제로 한다. 목록 endpoint는 `limit` 기본 50, 최대 200, `cursor` 기반 페이지네이션을 사용한다. 응답은 `items`, `next_cursor`, `total_estimate`를 포함한다. 정렬은 `created_at`, `group_size`, `reclaimable_bytes`, `similarity`, `quality` 중 하나를 선택하고 기본은 `reclaimable_bytes desc`다.

## 선택 모델

P0-C 선택 UX의 단일 진실은 `images.mark`다. 값은 `keep`, `delete`, `none` 중 하나이며 추천 사진은 그룹 생성 직후 `keep`, 나머지 사진은 `none`으로 초기화한다. `keep`과 `none`은 적용 실행 시 파일을 변경하지 않고, `delete`만 `/apply` 대상이 된다.

그룹 헤더의 `apply_recommended`, `keep_all`, `delete_all` 체크 상태는 별도 DB 상태로 저장하지 않는다. 클라이언트와 사이드카는 현재 그룹의 사진 `mark` 집합이 정확히 특정 패턴과 일치하는지로만 파생 계산한다. 개별 사진 변경으로 패턴을 벗어나면 그룹 체크는 혼합 상태로 모두 해제된다.

`POST /groups/{id}/action`은 그룹 상태를 저장하는 endpoint가 아니라 그룹 내 사진 `mark`를 일괄 갱신하는 편의 endpoint다. 응답에는 갱신된 이미지 `mark` 목록을 포함해 클라이언트가 단일 진실을 즉시 재계산할 수 있게 한다.

`POST /apply`는 `mark="delete"` 사진을 일괄 실행한다. `group_ids`를 지정하면 해당 그룹만 대상으로 하고, 생략하면 하위 호환을 위해 모든 그룹을 대상으로 한다. `mode:"trash"`는 기본값이며 실제 Windows 휴지통 이동은 Electron main의 `shell.trashItem`에 위임한다. 사이드카는 대상 검증, 진행 job 관리, DB 반영, 격리/이력 저장을 담당한다. `mode:"permanent"`는 휴지통을 거치지 않는 삭제이며 실행 전 UI 확인 모달이 필수다.

## REST Endpoint

| 메서드 | 경로 | 요청 | 응답 | 주요 에러 |
|---|---|---|---|---|
| GET | `/healthz` | 없음 | `{status, version, db_path, thumbs_dir}` | 401, 500 |
| POST | `/scan` | `{roots, recursive, extensions, threshold}` | `{scan_id, status}` | 400, 401, 409 |
| GET | `/scan/{id}` | path id | `{scan_id, status, phase, done, total, eta_sec, cancellable, summary}` | 401, 404 |
| POST | `/scan/{id}/cancel` | path id | `{scan_id, status}` | 401, 404, 409 |
| GET | `/groups` | `limit`, `cursor`, `sort`, `status`, `min_size`, `max_size`, `min_similarity` | `{items, next_cursor, total_estimate}` | 400, 401 |
| GET | `/groups/{id}` | path id | `{group, images}` | 401, 404 |
| PATCH | `/images/{id}` | `{mark}` where `mark` is `keep`, `delete`, `none` | `{image}` | 400, 401, 404, 409 |
| POST | `/groups/{id}/action` | `{action}` where `action` is `apply_recommended`, `keep_all`, `delete_all` | `{group, images}` | 400, 401, 404, 409 |
| POST | `/apply` | `{mode, group_ids?}` where `mode` is `trash` or `permanent` | 202 `{job_id, status, targets}` | 400, 401, 409, 422 |
| GET | `/cleanup/{id}` | path id | `{job_id, status, phase, done, total, summary}` | 401, 404 |
| POST | `/restore` | `{quarantine_ids, restore_all}` | `{restored, failed}` | 400, 401, 404, 422 |
| GET | `/thumbs/{image_id}` | path id | image bytes, `X-PD-Thumb-Cache: hit|miss` | 401, 404, 500 |
| GET | `/settings` | 없음 | `{threshold, recursive, extensions, cleanup_mode}` | 401 |
| PUT | `/settings` | settings object | settings object | 400, 401 |

## WebSocket

`WS /ws/progress`도 `X-PD-Token`을 요구한다. 폴링보다 WS push를 기본으로 사용하고, renderer는 재연결 시 REST 상태 조회로 누락분을 보정한다.

메시지 schema:

```json
{
  "type": "progress",
  "job_type": "scan",
  "job_id": "scan_...",
  "status": "running",
  "phase": "grouping",
  "done": 420,
  "total": 1000,
  "eta_sec": 18,
  "message": "grouping 420/1000",
  "summary": null
}
```

`job_type`은 `scan` 또는 `cleanup`, `status`는 `queued`, `running`, `cancel_requested`, `done`, `error`, `cancelled` 중 하나다. `phase`는 scan에서 `collecting`, `scanning`, `thumbnails`, `grouping`, `done`, cleanup에서 `planning`, `waiting_for_trash`, `quarantine`, `db_update`, `done`을 사용한다. `/apply`로 시작한 작업도 cleanup job으로 보고 동일한 progress channel과 `GET /cleanup/{id}`를 재사용한다.
