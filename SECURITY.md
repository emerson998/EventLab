# Security

EventLab is a local educational laboratory with one shared workspace. It does not process real payments or provide tenant isolation.

## Reporting

Do not disclose secrets, private data or a working exploit in a public issue. Use GitHub's private vulnerability reporting for this repository if the maintainer has enabled it. Otherwise open a public issue requesting a private contact channel without including sensitive details. Never send production credentials or real customer exports.

## Deployment expectations

- Docker ports bind to loopback by default.
- Configure `EVENTLAB_API_TOKEN` before sharing access; it authorizes the entire lab.
- Add TLS and infrastructure rate/connection limits for any nonlocal deployment.
- Do not treat CORS as authentication. Health/schema endpoints remain public.
- The frontend keeps the bearer token in sessionStorage; do not use it on an untrusted shared browser.
- SQLite and its directory must be writable only by the intended application operator.
- Requests are bounded and unknown properties rejected, but there is no global quota or automated data retention.
- A same-origin deployment is supported through Nginx. Never put bearer tokens into query strings or `VITE_*` variables.

Supported security fixes target the current main branch. Review dependency audit results and rerun tests before upgrading. No security certification or production-commerce suitability is claimed.
