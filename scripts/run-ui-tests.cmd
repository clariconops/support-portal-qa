@echo off
setlocal

REM Resolve infra-nginx-1 IP on infra_default network
for /f "tokens=*" %%i in ('docker inspect infra-nginx-1 --format "{{.NetworkSettings.Networks.infra_default.IPAddress}}" 2^>nul') do set NGINX_IP=%%i

if "%NGINX_IP%"=="" (
    echo Error: Could not determine infra-nginx-1 IP. Is docker running?
    exit /b 1
)

echo Target Nginx IP on infra_default: %NGINX_IP%
set SPEC=%1
if "%SPEC%"=="" set SPEC=specs/auth/auth.ui.spec.ts

echo Running Playwright test for %SPEC%...
docker run --rm --network infra_default --add-host=mycompany.clariconops.test:%NGINX_IP% -e QA_BASE_URL=http://mycompany.clariconops.test -e QA_ADMIN_EMAIL=admin@mycompany.com -e QA_ADMIN_PASSWORD=Admin123! -v c:/Users/USER/Documents/support-portal/qa-framework:/w -w /w mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test %SPEC% %2 %3 %4

