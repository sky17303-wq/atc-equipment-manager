# 1차~5차 개발 반영 현황

## 현재 방향

현재 구현은 외부 패키지 없이 실행되는 로컬 운영 베타다. 실제 운영 DB는 PostgreSQL 스키마를 기준으로 이전하되, 지금은 `data/runtime-state.json`을 런타임 저장소로 사용한다.

이 구조는 다음 운영 데이터를 한 파일에 모아 PostgreSQL 테이블로 옮기기 쉽게 만든다.

- 신청
- 예약
- 반출 loan
- 반납 검수
- 교구 추가/수정
- 운영 이벤트
- 정책 설정

## 1차: DB 연결과 신청/예약 흐름

반영됨:

- 신청 제출 시 `submitted` 신청 생성
- 신청 제출 즉시 24시간 `tentative` 예약 생성
- 승인 시 `confirmed` 예약으로 전환
- 반려 시 예약 취소
- 가용 수량 계산에서 본인 신청 예약은 승인 검증 시 제외
- `@ssem.re.kr` 이메일 제출 검증

운영 전 추가 대상:

- `runtime-state.json`을 PostgreSQL 테이블로 이전
- 마이그레이션 도구 확정
- ERP 사용자/기관 식별자 연결

## 2차: 반출/반납/검수

반영됨:

- 승인 완료 신청을 `checked_out`으로 전환
- 반출 시 loan 생성
- 반납 접수 시 `returned`와 검수 대기 상태로 전환
- 번호 없는 교구 수량형 검수 기록
- 정상/파손/수리/분실 수량 합계 검증
- 검수 완료 시 신청 `closed` 처리

운영 전 추가 대상:

- 다품목 신청의 품목별 부분 검수
- 자산형 QR 스캔 검수
- 수리 티켓 자동 생성

## 3차: 권한과 관리자 CRUD

반영됨:

- 모의 ERP 세션과 역할 선택
- 역할: applicant, staff, admin, auditor
- 담당자/관리자만 승인, 반출, 반납, 검수 가능
- 관리자만 교구 등록/수정 가능
- 품목 코드 중복 검증
- 회원/기관 관리 API와 관리자 화면
- 회원 역할, 상태, 기관 소속 수정
- 회원/기관 변경 감사 이벤트 기록
- ERP/Supabase 세션 쿠키 검증 기반 자동 회원 연결
- 운영 인증 모드 `AUTH_MODE=supabase`와 로컬 목업 모드 분리

운영 전 추가 대상:

- Supabase 신규 사용자 자동 생성 후 관리자 승인 정책 고도화
- 신청/조회 API의 사용자별 데이터 범위 제한
- 권한 감사 로그 화면 강화

## 4차: AI, QR, 모바일

반영됨:

- AI 신청에 명시 시작일/종료일 입력 추가
- Gemini 키가 없을 때 로컬 파서 유지
- 기간별 예약 점유를 반영한 신청 초안 생성
- QR/바코드 라벨 데이터 API
- 라벨 미리보기와 인쇄용 CSS
- 모바일에서 주요 그리드가 단일 열로 전환

운영 전 추가 대상:

- 실제 QR 이미지 생성 또는 라벨 프린터 양식
- 모바일 카메라 스캔
- 품목명 애매할 때 후보 선택 UI

## 5차: 통계, 업로드, 운영 검증

반영됨:

- 운영 통계 API
- 카테고리별 총수량/대여 기준/제외 수량 집계
- CSV 일괄 추가/수정 API와 화면
- 통합 검증 스크립트 `npm run verify`
- 문법 검사 스크립트 `npm run check`

운영 전 추가 대상:

- 엑셀 파일 직접 업로드
- 사용률, 파손율, 연체율 기간별 리포트
- 이메일/문자/카카오 알림
- 백업, 로그 보관, 배포 설정

## 상태 흐름

```text
draft
  -> submitted
  -> approved / rejected
  -> checked_out
  -> returned
  -> closed
```

예약 상태는 신청 상태에 따라 파생된다.

```text
submitted -> tentative
approved -> confirmed
checked_out -> checked_out
returned/closed -> returned
rejected -> canceled
```

## 검증

PowerShell에서는 `npm.ps1` 실행 정책 때문에 `npm run ...`이 막힐 수 있다. 이 경우 다음처럼 실행한다.

```powershell
npm.cmd run check
npm.cmd run verify
```
