# 로컬 → 서버 배포 스크립트
# 사용: powershell -File scripts/deploy.ps1
# 흐름: dev 브랜치를 서버 저장소에 push(updateInstead로 워킹트리 자동 갱신) → npm install → 서비스 재시작 → 헬스체크
$ErrorActionPreference = "Stop"
$KEY = "C:/ai/class.pem"
$SERVER = "root@101.79.21.9"

Write-Host "[1/4] GitHub(origin)와 서버(server)로 dev 푸시"
$env:GIT_SSH_COMMAND = "ssh -i $KEY"
git push origin dev
git push server dev

Write-Host "[2/4] 서버: 의존성 설치 + 마이그레이션"
ssh -i $KEY $SERVER "cd /opt/equipment-manager; npm install --omit=dev --no-audit --no-fund; npm run db:migrate"

Write-Host "[3/4] 서비스 재시작"
ssh -i $KEY $SERVER "systemctl restart equipment-manager; sleep 2; systemctl is-active equipment-manager"

Write-Host "[4/4] 헬스체크"
ssh -i $KEY $SERVER "curl -s http://127.0.0.1:5173/api/health | head -8"
