# Boiler Plate Code for express server with prisma

A TypeScript Express boilerplate using Prisma 7 (Postgres via pg driver adapter), JWT + cookie-based auth, sessions persisted in DB, login-attempt lockout, and scheduled cleanup jobs.

## Steps to run

1. Clone or fork the repo and install dependencies:

   ```bash
   pnpm install
   ```

2. Install Docker if you don't have it already.

3. Create a Docker volume for Postgres:

   ```bash
   sudo docker volume create postgres_data
   ```

4. Start a Postgres container:

   ```bash
   sudo docker run -e POSTGRES_PASSWORD=mysecretpassword -d -p 5432:5432 -v postgres_data:/var/lib/postgresql/data postgres
   ```

5. Create your `.env` file (see [Environment variables](#environment-variables) below):

   ```bash
   cp .env.example .env
   ```

6. Migrate the database:

   ````bash
   pnpm prisma:migrate
   ```;

   ````

7. Start the dev server:

   ```bash
   pnpm dev
   ```

## Environment variables

Copy `.env.example` to `.env` and fill in the values. Required keys are marked **required**; everything else has a sensible default.

### Core

| Variable       | Required | Default | Description                                                                 |
| -------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `NODE_ENV`     | ✅       | —       | One of `development`, `production`, `test`                                  |
| `PORT`         |          | `8080`  | HTTP port the server binds to                                               |
| `SITE_URL`     |          | —       | Public site URL used in password reset links (e.g. `http://localhost:5173`) |
| `DATABASE_URL` | ✅       | —       | Postgres connection string used by Prisma and the `pg` driver adapter       |

### JWT

| Variable                                | Required | Default      | Description                                                       |
| --------------------------------------- | -------- | ------------ | ----------------------------------------------------------------- |
| `JWT_SECRET`                            | ✅       | —            | Secret used to sign access/refresh JWTs. Use a long random string |
| `JWT_ACCESS_EXPIRATION_MINUTES`         |          | `30`         | Access token lifetime                                             |
| `JWT_REFRESH_EXPIRATION_MINUTES`        |          | `10080` (7d) | Refresh token / session lifetime                                  |
| `JWT_RESET_PASSWORD_EXPIRATION_MINUTES` |          | `10`         | Password reset token lifetime                                     |
| `JWT_INVITE_USER_EXPIRATION_MINUTES`    |          | `10080` (7d) | Invite token lifetime                                             |

### Auth — login lockout

| Variable                    | Default | Description                                                |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `MAX_LOGIN_ATTEMPTS`        | `10`    | Failed login attempts before the account locks             |
| `ACCOUNT_LOCK_TIME_MINUTES` | `15`    | How long an account stays locked after exceeding the limit |

### Cookies & CORS

| Variable          | Default | Description                                                                                               |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `COOKIE_DOMAIN`   | —       | Optional domain for production cross-subdomain cookies (e.g. `.example.com`). Leave blank for same-origin |
| `ALLOWED_ORIGINS` | —       | Comma-separated list of allowed CORS origins. Leave blank in dev to allow any origin                      |

### Cron schedules (UTC)

| Variable                | Default     | Description                                                                   |
| ----------------------- | ----------- | ----------------------------------------------------------------------------- |
| `CLEANUP_TOKENS_CRON`   | `0 0 * * *` | When to delete expired reset-password tokens (default: daily at 00:00 UTC)    |
| `CLEANUP_SESSIONS_CRON` | `0 2 * * *` | When to delete expired or long-revoked sessions (default: daily at 02:00 UTC) |

### AWS S3 (optional)

| Variable                | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | AWS access key (optional — only required if you use S3) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key                                   |
| `AWS_S3_BUCKET`         | S3 bucket name                                          |
| `AWS_REGION`            | AWS region (e.g. `us-east-1`)                           |

## Available scripts

### Run / build

| Script            | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`        | nodemon → `ts-node src/index.ts`, watches `src/`, sets `NODE_ENV=development` |
| `pnpm build`      | `tsc` — emits `dist/`                                                         |
| `pnpm start`      | `node dist/index.js` (run `pnpm build` first)                                 |
| `pnpm start:prod` | pm2 daemonless using `ecosystem.config.json` (uses `dist/index.js`)           |

### Code quality

| Script           | What it does                             |
| ---------------- | ---------------------------------------- |
| `pnpm typecheck` | `tsc --noEmit` — type-check without emit |
| `pnpm lint`      | ESLint flat config                       |
| `pnpm lint:fix`  | ESLint with autofix                      |

### Prisma

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `pnpm prisma:generate` | regenerate Prisma client (also runs automatically on `postinstall`) |
| `pnpm prisma:migrate`  | `prisma migrate dev` — interactive dev migration                    |
| `pnpm prisma:deploy`   | `prisma migrate deploy` — apply migrations in production            |
| `pnpm prisma:push`     | `prisma db push` — sync schema without migration files (fast dev)   |
| `pnpm prisma:studio`   | open Prisma Studio                                                  |

### Docker compose

| Script             | What it does                    |
| ------------------ | ------------------------------- |
| `pnpm docker:dev`  | bring up the dev compose stack  |
| `pnpm docker:prod` | bring up the prod compose stack |
| `pnpm docker:test` | bring up the test compose stack |

## Typical flows

- **First-time setup**: `pnpm install` → copy `.env.example` to `.env` and fill values → `pnpm prisma:push` (or `pnpm prisma:migrate --name init`) → `pnpm dev`
- **Production deploy**: `pnpm install` → `pnpm build` → `pnpm prisma:deploy` → `pnpm start` (or `pnpm start:prod` for pm2)
