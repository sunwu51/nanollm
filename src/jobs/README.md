# jobs

Scheduled model jobs defined in `jobs.yaml`: config store and validation (`jobs`), run history (`job-run-store`), executor, cron scheduler, HTTP routes, model name catalog and the jobs page.

Entry points: `JobConfigStore`, `JobScheduler`, `createJobRoutes`.
Imports: `core`, `proxy`, `storage`, `converters`.
