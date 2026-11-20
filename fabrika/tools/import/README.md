# Import from the previous platform

A one-off move of the previous platform's data: its D1 database, exported to a SQLite file, and its screenshot
bucket. Rows go through the `migration.*` procedures of the machine mount; the source is only read. Run it from
`fabrika/`.

## 1. Prepare the target

- An operator creates each project in the dashboard under its old slug and name, and notes its id. A machine key
  cannot create a project.
- An installation administrator mints a service key (`px_…`) for the `opice` application with the global action
  `data.import`, and puts it into truhla as `OPICE_IMPORT_KEY`, with `OPICE_IMPORT_ENDPOINT` set to the application's
  origin. Revoke the key once the import is done.

## 2. Export the old database

`cf d1 export` returns a download URL once the export finishes, and has to be polled until then. While it runs, the
old database answers no queries, so the old platform pauses for that time.

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account of the old platform>
dir=$(mktemp -d); echo "$dir"
npx cf d1 export <old database id> --output-format polling          # repeat with --current-bookmark <bookmark> until it answers a signed URL
curl -fsS -o "$dir/old.sql" '<signed url>'
sqlite3 "$dir/old.sqlite" < "$dir/old.sql"
```

## 3. Read access to the old bucket

Temporary, read-only credentials scoped to the bucket, signed with an R2 API token's access key id. They go into
truhla, never into a file:

```bash
npx cf r2 temporary-credentials create --bucket prod-opice-screenshots --permission object-read-only \
  --ttl-seconds 43200 --parent-access-key-id <the R2 token's access key id>
```

Set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_SESSION_TOKEN` from the answer, and
`R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`. `R2_BUCKET` defaults to `prod-opice-screenshots`.

## 4. Run

```bash
truhla run -- bun tools/import/main.ts --source "$dir/old.sqlite" --state "$dir/state.json" \
  --project <old slug>=<new project id> [--project …] --dry-run
truhla run -- bun tools/import/main.ts --source "$dir/old.sqlite" --state "$dir/state.json" \
  --project <old slug>=<new project id> [--project …]
```

- `--screenshots-since <ISO date>|all|none` picks the runs whose screenshots are copied (by when the run started).
  The default is 30 days before now; every other row is imported either way, a step without its picture.
- `--concurrency <n>` (default 4) bounds the runs imported at once; the target is one Durable Object.
- The state file holds ids and cursors only. Rerun with the same file to continue: nothing is inserted twice.
- A 429, 500 or 503 is retried. A dropped connection or a gateway answer on an insert stops the import and marks the
  run, because its rows may already be in. Look at that run on the dashboard, then rerun with `--retry-uncertain`,
  which sends that batch again.
- A screenshot over 2 MiB, one that is not a PNG, or a missing object is skipped and counted.
- The summary on stdout counts the rows read and imported per table, the screenshots copied, their bytes and the
  skipped ones.

Remove the `migration` slice from the contract once the move is done.
