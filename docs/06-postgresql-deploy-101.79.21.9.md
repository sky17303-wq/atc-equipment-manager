# PostgreSQL 전환 및 101.79.21.9 배포 절차

## 전제

서버 주소는 `101.79.21.9`로 둔다. 실제 배포에는 서버 SSH/RDP 접속 권한, PostgreSQL 관리자 계정, 방화벽 설정 권한이 필요하다.

현재 적용된 배포 URL:

```text
https://class4edu.co.kr/equipment/
```

기존 IP 주소 `http://101.79.21.9/equipment/`는 같은 로그인 쿠키를 쓰기 위해 `https://class4edu.co.kr/equipment/`로 리다이렉트한다.

현재 서버에서 확인된 PostgreSQL은 표준 `5432`가 아니라 `127.0.0.1:5433`에서 실행 중이다.

## 2026-06-04 실제 반영 현황

현재 `101.79.21.9` 서버에는 다음 값으로 배포되어 있다.

| 항목 | 값 |
| --- | --- |
| 공개 URL | `https://class4edu.co.kr/equipment/` |
| 기존 IP URL | `http://101.79.21.9/equipment/` -> `https://class4edu.co.kr/equipment/` |
| 앱 경로 | `/opt/equipment-manager` |
| systemd 서비스 | `equipment-manager` |
| Node 실행 포트 | `127.0.0.1:5173` |
| 저장소 | PostgreSQL |
| 인증 모드 | `AUTH_MODE=supabase` |
| PostgreSQL 접속 | `127.0.0.1:5433` |
| DB 이름 | `equipment_manager` |
| DB 사용자 | `equipment_user` |
| 도메인 Nginx 설정 파일 | `/etc/nginx/sites-enabled/class4edu.co.kr.ssl` |
| IP Nginx 설정 파일 | `/etc/nginx/sites-enabled/atc` |
| Nginx 백업 파일 | `/etc/nginx/sites-enabled/class4edu.co.kr.ssl.bak.20260604223905`, `/etc/nginx/sites-enabled/atc.bak.20260604223905` |

DB 비밀번호는 문서에 기록하지 않는다. 운영 서버의 `/opt/equipment-manager/.env`에만 보관한다.

운영 확인 명령:

```bash
systemctl status equipment-manager
curl -k https://class4edu.co.kr/equipment/api/health
```

현재 앱은 다음 방식으로 동작한다.

| 설정 | 저장소 |
| --- | --- |
| `STORAGE_DRIVER=json` 또는 미설정 | `data/runtime-state.json` |
| `STORAGE_DRIVER=postgres` 또는 `DATABASE_URL/PGHOST` 설정 | PostgreSQL |

## 1. PostgreSQL 설치

Ubuntu 예시:

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
```

Windows Server라면 PostgreSQL 공식 설치 관리자로 설치한다.

## 2. DB와 사용자 생성

PostgreSQL 서버에서 실행한다.

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE equipment_manager;
CREATE USER equipment_user WITH PASSWORD '여기에_강한_비밀번호';
GRANT ALL PRIVILEGES ON DATABASE equipment_manager TO equipment_user;
\c equipment_manager
GRANT ALL ON SCHEMA public TO equipment_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO equipment_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO equipment_user;
```

PostgreSQL이 앱 서버와 같은 서버에 있으면 외부 DB 포트는 열지 않는 것을 권장한다. DB를 외부에서 접속해야 한다면 `postgresql.conf`, `pg_hba.conf`, 방화벽에서 `5432` 접근 허용 범위를 제한한다.

## 3. 앱 업로드

서버 경로 예시:

```bash
sudo mkdir -p /opt/equipment-manager
sudo chown -R $USER:$USER /opt/equipment-manager
```

프로젝트 파일을 `/opt/equipment-manager`에 업로드한다.

## 4. Node 의존성 설치

```bash
cd /opt/equipment-manager
npm install --omit=dev
```

Windows Server PowerShell에서 `npm.ps1` 실행 정책 문제가 있으면 다음처럼 실행한다.

```powershell
npm.cmd install --omit=dev
```

## 5. `.env` 설정

`/opt/equipment-manager/.env`:

```env
PORT=5173
HOST=127.0.0.1
BASE_PATH=/equipment
STORAGE_DRIVER=postgres
PGHOST=127.0.0.1
PGPORT=5433
PGDATABASE=equipment_manager
PGUSER=equipment_user
PGPASSWORD=여기에_강한_비밀번호
PGSSL=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
AUTH_MODE=supabase
ERP_LOGIN_URL=/erp/login?from=/equipment/
EQUIPMENT_AUTO_MEMBER_STATUS=pending
SUPABASE_URL=ERP와_같은_Supabase_URL
SUPABASE_ANON_KEY=ERP와_같은_Supabase_anon_key
```

표준 PostgreSQL 기본 포트 `5432`를 쓰는 서버라면 `PGPORT=5432`로 바꾼다. DB가 별도 서버이거나 직접 `101.79.21.9`로 접속해야 한다면:

```env
PORT=5173
HOST=127.0.0.1
BASE_PATH=/equipment
STORAGE_DRIVER=postgres
PGHOST=101.79.21.9
PGPORT=5433
PGDATABASE=equipment_manager
PGUSER=equipment_user
PGPASSWORD=여기에_강한_비밀번호
PGSSL=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
```

## 6. 마이그레이션과 시드

```bash
npm run db:migrate
npm run db:seed
```

Windows Server:

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
```

## 7. 실행 확인

```bash
npm start
```

다른 터미널에서 확인:

```bash
curl http://127.0.0.1:5173/equipment/api/health
curl -k https://class4edu.co.kr/equipment/api/health
```

응답의 `storageMode`가 `runtime-json`으로 보이면 JSON 모드다. PostgreSQL 모드 확인은 앱에서 `/api/inventory`, 신청/승인 테스트 후 DB 테이블에 데이터가 쌓이는지 확인한다.

## 8. systemd 서비스 등록

`/etc/systemd/system/equipment-manager.service`:

```ini
[Unit]
Description=ATC Equipment Manager
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/equipment-manager
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable equipment-manager
sudo systemctl start equipment-manager
sudo systemctl status equipment-manager
```

## 9. Nginx reverse proxy

운영에서는 `5173`을 직접 열기보다 `https://class4edu.co.kr/equipment/`으로 받고 내부 `localhost:5173`으로 전달한다.

```nginx
location = /equipment {
    return 301 /equipment/;
}

location ^~ /equipment/ {
    proxy_pass         http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 60s;
}
```

IP 주소용 `101.79.21.9` 서버 블록에서는 같은 쿠키 도메인을 유지하기 위해 교구 경로를 canonical 도메인으로 보낸다.

```nginx
location = /equipment {
    return 301 https://class4edu.co.kr/equipment/;
}

location ^~ /equipment/ {
    return 301 https://class4edu.co.kr$request_uri;
}
```

## 10. 백업

PostgreSQL 백업:

```bash
pg_dump -U equipment_user -h 127.0.0.1 equipment_manager > equipment_manager_$(date +%Y%m%d).sql
```

추가 백업 대상:

- `.env`
- `public/assets`
- `data/seed-inventory.json`

## 배포 전 체크리스트

- [x] 서버에 Node.js 18 이상 설치
- [x] PostgreSQL DB/사용자 생성
- [x] `npm install --omit=dev` 실행
- [x] `.env`에 `STORAGE_DRIVER=postgres` 설정
- [x] `npm run db:migrate` 성공
- [x] `npm run db:seed` 성공
- [x] systemd 서비스 등록
- [x] Nginx reverse proxy 설정
- [x] 외부 URL `/equipment/api/health` 확인
- [ ] PostgreSQL 백업 정책 설정
