# ATC 교구 관리 시스템

컴퓨팅교사협회 교구 대여 운영 시스템입니다. 현재 버전은 다음을 포함합니다.

- DB 구조와 ERD 문서
- 화면 메뉴 구조 문서
- AI 대여 신청 시나리오 문서
- Gemini API 연동 골격
- 예약/대여중 데이터를 반영한 대여 가능 수량 계산
- 개별 번호가 없는 교구의 수량형 반납 검수
- 신청 제출, 승인, 반출, 반납, 검수 상태 흐름 + 다품목 품목별 부분 검수
- 파손/수리 검수 시 수리 티켓 자동 생성과 재고 복귀 처리
- 승인/반려/반출/반납/검수·반납 임박·연체 이메일 알림 큐 (SMTP 미설정 시 기록만)
- 실제 QR 이미지 라벨 인쇄와 카메라 QR 스캔 (미지원 브라우저 수동 입력 폴백)
- 엑셀(.xlsx)/CSV 일괄 반영 (한국어 헤더 자동 매핑)
- 기간별 운영 리포트 (사용률/파손율/연체/수리)
- ERP 권한 연동(모의/운영), 회원/기관 관리, 관리자 교구 CRUD, 통계
- ERP/Supabase 로그인 세션을 이용한 교구 회원 자동 연결
- 조회 API 로그인 필수 + 신청자 본인 데이터 범위 제한

코드 구조: `server.js`(엔트리) + `lib/`(config/storage/auth/domain/api 모듈) + `public/`(바닐라 JS SPA). 서버 런타임 의존성은 `pg` 하나입니다.

## 배포와 백업

- 배포: 로컬에서 `powershell -File scripts/deploy.ps1` (dev 브랜치 push → 서버 워킹트리 갱신 → 재시작 → 헬스체크)
- DB 백업: 서버 크론에서 `scripts/backup-db.sh` 일일 실행 (보관 14일, /var/backups/equipment-manager)

## 실행

외부 패키지 설치 없이 Node.js 기본 기능만 사용합니다.

```powershell
npm start
```

브라우저에서 다음 주소를 엽니다.

```text
http://localhost:5173
```

PowerShell 실행 정책 때문에 `npm`이 막히면 `npm.cmd`를 사용합니다.

```powershell
npm.cmd start
```

## 검증

문법 검사는 다음 명령으로 실행합니다.

```powershell
npm.cmd run check
```

신청 제출부터 승인, 반출, 반납, 검수, 관리자 품목 추가, 회원/기관 관리, 통계/라벨 API까지 확인하려면 다음 명령을 실행합니다.

```powershell
npm.cmd run verify
```

## PostgreSQL 전환

서버 운영에서는 `.env`에 `STORAGE_DRIVER=postgres`와 DB 접속 정보를 설정한 뒤 마이그레이션과 시드를 실행합니다.

```powershell
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
```

Linux 서버에서는 다음처럼 실행합니다.

```bash
npm install --omit=dev
npm run db:migrate
npm run db:seed
```

배포 세부 절차는 [docs/06-postgresql-deploy-101.79.21.9.md](docs/06-postgresql-deploy-101.79.21.9.md)를 참고합니다.

## Gemini API 키 설정

API 키는 코드에 저장하지 않습니다. `.env.example`을 복사해 `.env`를 만들고 값을 채워 넣습니다.

```powershell
Copy-Item .env.example .env
```

`.env` 예시:

```text
GEMINI_API_KEY=여기에_실제_키_입력
GEMINI_MODEL=gemini-3.5-flash
```

키가 없으면 서버는 로컬 규칙 기반 파서로 신청서를 만듭니다. 실제 키가 있으면 서버가 Gemini `generateContent` REST API를 호출해 자연어 신청을 구조화합니다.

## ERP 로그인 자동 연결

운영에서는 교구 사이트를 `https://class4edu.co.kr/equipment/` 아래에 두고, ERP의 Supabase 세션 쿠키를 검증해 교구 회원과 자동 연결합니다.

```env
AUTH_MODE=supabase
SUPABASE_URL=ERP와 같은 Supabase URL
SUPABASE_ANON_KEY=ERP와 같은 Supabase anon key
ERP_LOGIN_URL=/erp/login?from=/equipment/
```

운영 환경에서는 로그인 사용자의 Supabase access token으로 ERP `users.is_super_admin`과 `memberships.job_role`을 읽어 교구 권한을 자동 동기화한다. ERP 슈퍼관리자/대표/회사관리자는 `admin`, 회계 담당자는 `auditor`, 일반 직원은 `applicant`로 매핑하며 ERP 등록 사용자는 `active`로 전환한다. 단, 교구 관리자가 `suspended` 또는 `archived`로 막은 회원은 자동으로 다시 활성화하지 않는다.

## 주요 파일

- [docs/01-service-direction.md](docs/01-service-direction.md): 전체 개발 방향
- [docs/02-db-erd.md](docs/02-db-erd.md): DB 구조와 ERD
- [docs/03-screen-menu-structure.md](docs/03-screen-menu-structure.md): 화면 메뉴 구조
- [docs/04-ai-rental-scenarios.md](docs/04-ai-rental-scenarios.md): AI 신청 시나리오
- [docs/05-development-roadmap.md](docs/05-development-roadmap.md): 1차~5차 개발 반영 현황
- [docs/06-postgresql-deploy-101.79.21.9.md](docs/06-postgresql-deploy-101.79.21.9.md): PostgreSQL 전환과 서버 배포
- [database/schema.sql](database/schema.sql): PostgreSQL 기준 스키마 초안
- [database/app-postgres.sql](database/app-postgres.sql): 현재 앱 실행용 PostgreSQL 마이그레이션
- [server.js](server.js): 로컬 API 서버
- [public/index.html](public/index.html): 로컬 웹 프로토타입

## 번호 없는 교구 처리

교구 번호가 없는 품목은 개별 자산 추적 대신 반출 묶음과 반납 검수 수량으로 관리합니다.

```text
반출 80대
반납 검수: 정상 77대, 파손 2대, 수리필요 1대, 분실 0대
재고 복귀: 정상 77대
대여 제외: 3대
```

## 보안 메모

공개 채팅, 이미지, 문서에 노출된 API 키는 재발급하거나 사용 제한을 걸어두는 것을 권장합니다. 운영 전에는 Google Cloud/API Console에서 HTTP referrer, IP, 사용량 제한을 적용해야 합니다.
