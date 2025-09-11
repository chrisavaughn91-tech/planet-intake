# Known-good deployment

Date: $(date -u +"%Y-%m-%d %H:%M UTC")

## Apps Script Web App
Name: v4 canonical  
Version: 10  
Deployment ID: xCWeejP1... (paste full)  
Execute as: Me  
Who has access: Anyone  
Web App URL: https://script.google.com/macros/s/AKfycbwm-xCWee.../exec

## Health Check
Verify JSON health endpoint:

    curl -s "https://script.google.com/macros/s/AKfycbwm-xCWeejP10bWRAkPXMhKMyBJcIx4wzKqMIwaQYc4rQ0dE0Mu_rTTf7Rz3dF-yPwJ/exec?action=health"

Expected fields:

    ok, version, tag, deployedAt

## Local E2E Settings
E2E_LIMIT: 200  
E2E_SMOKE_LIMIT: 600   # canonical (test harness also accepts legacy E2E_WAIT_S)  
MAX_LEADS_DEFAULT: 200

## Notes
- e2e timeout increased; test waits up to 600s.
- Restored Codespace; env points to this Web App URL.
