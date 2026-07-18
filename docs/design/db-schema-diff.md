# P0-A DB Schema Diff

대상: 데스크톱 `manifest.db` 신규 설계. 참조는 `/tmp/photo-dedup-ref`의 `photo-dedup` shallow clone만 사용했다.

## 참조 스키마 증거

`/tmp/photo-dedup-ref/photodedup/manifest.py`의 `Manifest.init_schema()` 원문 기준:

```sql
CREATE TABLE IF NOT EXISTS images(
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE,
    size_bytes INT,
    mtime REAL,
    taken_at TEXT,
    width INT,
    height INT,
    format TEXT,
    sharpness REAL,
    phash TEXT,
    dhash TEXT,
    quality_score REAL,
    thumb_path TEXT,
    group_id INT,
    is_keep INT DEFAULT 0,
    scanned_at TEXT,
    resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS groups(
    group_id INTEGER PRIMARY KEY,
    member_count INT,
    keep_image_id INT,
    reclaimable_bytes INT,
    threshold INT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS scan_meta(
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS image_histograms(
    image_id INTEGER PRIMARY KEY,
    histogram TEXT NOT NULL,
    FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS quarantine(
    id INTEGER PRIMARY KEY,
    image_id INT,
    original_path TEXT,
    quarantine_path TEXT,
    size INT,
    phash TEXT,
    group_id INT,
    moved_at TEXT,
    restored_at TEXT,
    status TEXT,
    FOREIGN KEY(image_id) REFERENCES images(id)
);
```

동일 함수의 보강 마이그레이션은 `images.taken_at`, `images.is_quarantined`, `images.keep_all`, `images.resolved_at`, `groups.keep_all`을 `ALTER TABLE`로 추가한다. 참조 레포에서 `CREATE INDEX` / `CREATE UNIQUE INDEX` 문은 발견되지 않았다.

## 참조 테이블 요약

| 테이블 | 컬럼 | 인덱스 |
|---|---|---|
| `images` | `id`, `path`, `size_bytes`, `mtime`, `taken_at`, `width`, `height`, `format`, `sharpness`, `phash`, `dhash`, `quality_score`, `thumb_path`, `group_id`, `is_keep`, `scanned_at`, `resolved_at`, 추가 컬럼 `is_quarantined`, `keep_all` | `path TEXT UNIQUE`의 자동 유니크 인덱스 |
| `groups` | `group_id`, `member_count`, `keep_image_id`, `reclaimable_bytes`, `threshold`, `created_at`, 추가 컬럼 `keep_all` | primary key |
| `scan_meta` | `key`, `value` | primary key |
| `image_histograms` | `image_id`, `histogram` | primary key, `images(id)` FK |
| `quarantine` | `id`, `image_id`, `original_path`, `quarantine_path`, `size`, `phash`, `group_id`, `moved_at`, `restored_at`, `status` | primary key, `images(id)` FK |

## 데스크톱 데이터 경로

| 항목 | 경로 |
|---|---|
| SQLite manifest | `%LOCALAPPDATA%\PhotoDedupDesktop\manifest.db` |
| 썸네일 캐시 | `%LOCALAPPDATA%\PhotoDedupDesktop\thumbs\` |
| 격리 저장소 | `%LOCALAPPDATA%\PhotoDedupDesktop\quarantine\` |

## 제안 스키마

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE roots(
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    display_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_scanned_at TEXT
);

CREATE TABLE scan_sessions(
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    cancelled_at TEXT,
    options_json TEXT NOT NULL,
    summary_json TEXT,
    error_code TEXT,
    error_message TEXT
);

CREATE TABLE images(
    id INTEGER PRIMARY KEY,
    root_id INTEGER,
    path TEXT NOT NULL UNIQUE,
    relative_path TEXT,
    size_bytes INTEGER NOT NULL,
    mtime REAL NOT NULL,
    taken_at TEXT,
    width INTEGER,
    height INTEGER,
    format TEXT,
    sharpness REAL,
    phash TEXT,
    dhash TEXT,
    quality_score REAL,
    thumb_path TEXT,
    group_id INTEGER,
    mark TEXT NOT NULL DEFAULT 'none'
        CHECK(mark IN ('keep', 'delete', 'none')),
    recommended_keep INTEGER NOT NULL DEFAULT 0,
    is_quarantined INTEGER NOT NULL DEFAULT 0,
    trashed_at TEXT,
    scanned_at TEXT,
    resolved_at TEXT,
    last_scan_id TEXT,
    FOREIGN KEY(root_id) REFERENCES roots(id),
    FOREIGN KEY(last_scan_id) REFERENCES scan_sessions(id)
);

CREATE TABLE image_histograms(
    image_id INTEGER PRIMARY KEY,
    histogram TEXT NOT NULL,
    FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE TABLE groups(
    group_id INTEGER PRIMARY KEY,
    member_count INTEGER NOT NULL,
    recommended_keep_image_id INTEGER,
    max_similarity REAL,
    reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
    threshold INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    last_scan_id TEXT,
    FOREIGN KEY(recommended_keep_image_id) REFERENCES images(id),
    FOREIGN KEY(last_scan_id) REFERENCES scan_sessions(id)
);

CREATE TABLE cleanup_jobs(
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    requested_at TEXT NOT NULL,
    finished_at TEXT,
    request_json TEXT NOT NULL,
    summary_json TEXT,
    error_code TEXT,
    error_message TEXT
);

CREATE TABLE quarantine(
    id INTEGER PRIMARY KEY,
    cleanup_job_id TEXT,
    image_id INTEGER,
    original_path TEXT NOT NULL,
    quarantine_path TEXT NOT NULL,
    size_bytes INTEGER,
    phash TEXT,
    group_id INTEGER,
    moved_at TEXT NOT NULL,
    restored_at TEXT,
    status TEXT NOT NULL,
    FOREIGN KEY(cleanup_job_id) REFERENCES cleanup_jobs(id),
    FOREIGN KEY(image_id) REFERENCES images(id)
);

CREATE TABLE trash_history(
    id INTEGER PRIMARY KEY,
    cleanup_job_id TEXT,
    image_id INTEGER,
    path TEXT NOT NULL,
    size_bytes INTEGER,
    group_id INTEGER,
    requested_at TEXT NOT NULL,
    trashed_at TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    FOREIGN KEY(cleanup_job_id) REFERENCES cleanup_jobs(id),
    FOREIGN KEY(image_id) REFERENCES images(id)
);

CREATE TABLE settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_images_group_id ON images(group_id);
CREATE INDEX idx_images_root_id ON images(root_id);
CREATE INDEX idx_images_scan_id ON images(last_scan_id);
CREATE INDEX idx_images_mark ON images(mark, group_id);
CREATE INDEX idx_images_state ON images(is_quarantined, trashed_at, resolved_at);
CREATE INDEX idx_groups_member_count ON groups(member_count);
CREATE INDEX idx_quarantine_status ON quarantine(status, moved_at);
CREATE INDEX idx_trash_history_job ON trash_history(cleanup_job_id, status);
```

## Diff

| 기존 photo-dedup | 데스크톱 제안 | 판정 | 이유 |
|---|---|---|---|
| `images` | `images` | 변경 유지 | 기존 해시/품질/그룹 FK 역할은 유지하되 다중 루트, 스캔 세션, 추천 유지, 격리/휴지통 상태를 한 행에서 조회해야 한다. |
| `images.path TEXT UNIQUE` | 동일 | 유지 | 파일 단위 캐시 키로 검증 완료된 동작이며 데스크톱도 절대 경로 기준 중복 삽입을 막아야 한다. |
| `images.thumb_path` | 동일, 경로 루트는 `...\thumbs\` | 유지/경로 변경 | 기존 썸네일 캐시 재사용 모델을 유지하되 데스크톱 앱 데이터 폴더로 고정한다. |
| `images.is_keep` | `images.mark TEXT NOT NULL DEFAULT 'none' CHECK(mark IN ('keep','delete','none'))` | 대체 | P0-C 선택 모델은 사진별 `keep`/`delete`/`none` 3상태가 단일 진실이다. 추천 사진은 그룹 생성 시 `keep`, 나머지는 `none`으로 초기화한다. |
| `images.keep_all` | 제거 | 삭제 | 그룹 전체 유지/삭제/추천 적용은 사진 `mark` 일괄 갱신 결과로만 표현하며 이미지별 별도 중복 플래그는 두지 않는다. |
| `images.resolved_at` | 동일 | 유지 | 미처리/처리됨 필터의 빠른 조건으로 필요하다. |
| 없음 | `images.root_id`, `relative_path` | 신규 | 데스크톱은 다중 로컬 폴더 스캔과 루트별 재스캔을 지원한다. |
| 없음 | `images.recommended_keep` | 신규 | 품질 점수 기반 추천 유지 대상과 사용자가 선택한 keep 상태를 분리해야 한다. |
| 없음 | `images.trashed_at` | 신규 | 휴지통 삭제 이후 목록에서 제외하고 이력을 연결하기 위한 상태값이다. |
| 없음 | `images.last_scan_id` | 신규 | 스캔 세션별 결과/오류 추적과 취소 후 부분 결과 표시가 필요하다. |
| `image_histograms` | `image_histograms` | 유지 | histogram JSON/TEXT 분리 저장은 기존 그룹핑 코어와 호환된다. |
| `groups` | `groups` | 변경 유지 | 기존 그룹 요약 구조에 추천 keep, 최대 유사도, 세션 연결을 추가하되 선택 상태는 저장하지 않는다. |
| `groups.keep_image_id` | 제거 | 삭제 | 사용자 선택 keep은 `images.mark='keep'`에서만 읽는다. 추천 기준은 `groups.recommended_keep_image_id`로 분리한다. |
| `groups.keep_all` | 제거 | 삭제 | 그룹 헤더 체크박스는 사진 `mark` 집합에서 파생 계산하며 그룹 상태로 저장하지 않는다. |
| 없음 | `groups.recommended_keep_image_id` | 신규 | 품질 점수 기반 추천 사진을 표시하고 `apply_recommended` 일괄 갱신 기준으로 사용한다. |
| 없음 | 그룹 액션 저장 컬럼 없음 | 유지 | `apply_recommended`, `keep_all`, `delete_all`은 `images.mark`를 일괄 갱신하는 API 동작이며 그룹 자체 처리 상태는 저장하지 않는다. |
| 없음 | `groups.max_similarity` | 신규 | 그룹 목록의 유사도 정렬/필터를 DB에서 수행한다. |
| `scan_meta` | `scan_sessions`, `settings` | 변경/분리 | key-value 메타는 동시/과거 작업 이력에 부족하므로 작업 세션과 사용자 설정을 분리한다. |
| 없음 | `roots` | 신규 | 여러 폴더 루트를 enable/disable하고 마지막 스캔 시점을 보관한다. |
| 없음 | `group_actions` 없음 | 유지 | P0-C는 그룹 체크 상태를 저장하지 않으므로 그룹 액션 로그 테이블도 P0 범위에서는 두지 않는다. 필요하면 P2 이후 감사 로그로 별도 재검토한다. |
| `quarantine` | `quarantine` | 변경 유지 | 기존 격리/복원 모델은 유지하되 cleanup job 연결과 byte 컬럼명을 정리한다. |
| 없음 | `cleanup_jobs` | 신규 | 정리 작업은 장시간 작업이며 REST/WS에서 진행률과 결과 요약을 조회해야 한다. |
| 없음 | `trash_history` | 신규 | 휴지통 삭제는 Electron main이 수행하므로 사이드카가 요청/결과와 DB 반영 이력을 남겨야 한다. |
| 없음 | 명시 `CREATE INDEX` 7개 | 신규 | 기존 웹은 소규모/서버 상태에 의존했지만 데스크톱은 수천 그룹 페이지네이션과 사진 `mark` 기반 필터를 로컬 DB에서 빠르게 처리해야 한다. |

## 마이그레이션 결론

데스크톱은 기존 웹 manifest를 직접 이관하지 않고 신규 생성한다. 이유는 운영 중인 `photo-dedup` manifest가 단일 루트/웹 액션 중심이고, 데스크톱은 `%LOCALAPPDATA%\PhotoDedupDesktop\manifest.db`에 다중 루트, 스캔 세션, 휴지통 이력, settings를 초기에 갖춰야 하기 때문이다.

단, `photodedup` 코어의 캐시 재사용 구조는 유지한다. 향후 가져오기 기능이 필요해지면 기존 `images`, `groups`, `image_histograms`, `quarantine`에서 호환 컬럼만 읽어 새 DB에 append하는 별도 import 작업으로 처리한다.
