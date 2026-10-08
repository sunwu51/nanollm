# Railway template maintenance

Published template: https://railway.com/deploy/nanollm

Template ID: `13ec61fd-57bc-48cc-8950-a8b3d715b005`

On 2026-10-02 the template was expanded to two services, both sourced from `dev`
and deployed to `us-west2`. nanollm mounts `/data`, generates its access token,
sets the heap limit to `256`, and uses `NANOLLM_SQLITE_URL` referencing sqld's
private domain. sqld builds `/.railway/quicsql`, mounts `/var/lib/sqld`, checks
`/_health`, and exposes no public networking. Its build watch patterns are
restricted to `/.railway/quicsql/**`. quicSQL uses `rwc` to create a database on
new volumes without replacing existing data. The existing production sqld
service remains an uploaded build and is not bound to GitHub auto-deploys.

The template enables `deploy.sleepApplication` for sqld and disables it for
nanollm. This applies to new template deployments, not the existing live project.
The gateway probes with `SELECT 1` before the first HTTP database request after
60 seconds without a successful response or after a failed request, retrying
only that probe; ambiguous write failures are not replayed. No idle polling is
added. Cold-start savings still depend on actual quiet periods.

`template.json` is a snapshot of Railway's serialized template configuration, not a file automatically applied during repository deployments. Edit the template in [Railway's template editor](https://railway.com/workspace/templates/13ec61fd-57bc-48cc-8950-a8b3d715b005) and apply the changes there. Keep this snapshot aligned with the saved template.

`template-readme.md` contains the marketplace overview. After authenticating with the Railway CLI, update the overview with:

```powershell
npx --yes @railway/cli templates update 13ec61fd-57bc-48cc-8950-a8b3d715b005 --category AI/ML --description 'Lightweight LLM gateway with web admin and persistent storage.' --readme-file .railway/template-readme.md
```

Keep gateway keys generated with `${{secret(32)}}`. Do not copy real API keys, subscription credentials, or Turso credentials into this template.
