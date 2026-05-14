import dotenv from "dotenv";
import path from "path";
import Joi from "joi";

dotenv.config({ path: path.join(__dirname, "../../.env") });

interface DatabaseConfig {
  URL: string;
}

interface JwtConfig {
  SECRET: string;
  ACCESS_EXPIRATION_MINUTES: number;
  REFRESH_EXPIRATION_MINUTES: number;
  RESET_PASSWORD_EXPIRATION_MINUTES: number;
  USER_INVITE_EXPIRATION_MINUTES: number;
}

interface CronConfig {
  TOKEN_CLEANUP: string;
  SESSION_CLEANUP: string;
}

interface AuthConfig {
  MAX_LOGIN_ATTEMPTS: number;
  LOCK_TIME_MINUTES: number;
}

interface CookieConfig {
  DOMAIN?: string;
}

interface CorsConfig {
  ALLOWED_ORIGINS: string[];
}

interface Config {
  ENV: string;
  PORT: number;
  SITE_URL?: string;
  DATABASE: DatabaseConfig;
  JWT: JwtConfig;
  CRON: CronConfig;
  AUTH: AuthConfig;
  COOKIE: CookieConfig;
  CORS: CorsConfig;
}

const envVarsSchema = Joi.object({
  NODE_ENV: Joi.string().valid("production", "development", "test").required(),
  PORT: Joi.number().default(8080),
  SITE_URL: Joi.string().description("Public site URL"),
  DATABASE_URL: Joi.string().required().description("DB url"),

  JWT_SECRET: Joi.string().required().description("JWT secret key"),
  JWT_ACCESS_EXPIRATION_MINUTES: Joi.number()
    .default(30)
    .description("minutes after which access tokens expire")
    .required(),
  JWT_REFRESH_EXPIRATION_MINUTES: Joi.number()
    .default(1770)
    .description("minutes after which refresh token expire")
    .required(),
  JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
    .default(10)
    .description("minutes after which reset password token expires")
    .required(),
  JWT_INVITE_USER_EXPIRATION_MINUTES: Joi.number()
    .default(60 * 24 * 7)
    .description("minutes after which invite user token expires"),

  CLEANUP_TOKENS_CRON: Joi.string()
    .description("CRON expression for token cleanup job")
    .default("0 0 * * *"),
  CLEANUP_SESSIONS_CRON: Joi.string()
    .description("CRON expression for session cleanup job")
    .default("0 2 * * *"),

  MAX_LOGIN_ATTEMPTS: Joi.number()
    .default(10)
    .description("Failed login attempts before account is locked"),
  ACCOUNT_LOCK_TIME_MINUTES: Joi.number()
    .default(15)
    .description("Minutes to lock the account after exceeding attempts"),

  COOKIE_DOMAIN: Joi.string()
    .description(
      "Optional cookie domain (e.g. .example.com) for production cross-subdomain cookies",
    )
    .optional(),

  ALLOWED_ORIGINS: Joi.string()
    .default("")
    .description("Comma-separated list of allowed CORS origins"),
}).unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: "key" } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const config: Config = {
  ENV: envVars.NODE_ENV,
  PORT: envVars.PORT,
  SITE_URL: envVars.SITE_URL,
  DATABASE: {
    URL: `${envVars.DATABASE_URL}`,
  },
  JWT: {
    SECRET: envVars.JWT_SECRET,
    ACCESS_EXPIRATION_MINUTES: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    REFRESH_EXPIRATION_MINUTES: envVars.JWT_REFRESH_EXPIRATION_MINUTES,
    RESET_PASSWORD_EXPIRATION_MINUTES:
      envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    USER_INVITE_EXPIRATION_MINUTES: envVars.JWT_INVITE_USER_EXPIRATION_MINUTES,
  },
  CRON: {
    TOKEN_CLEANUP: envVars.CLEANUP_TOKENS_CRON,
    SESSION_CLEANUP: envVars.CLEANUP_SESSIONS_CRON,
  },
  AUTH: {
    MAX_LOGIN_ATTEMPTS: envVars.MAX_LOGIN_ATTEMPTS,
    LOCK_TIME_MINUTES: envVars.ACCOUNT_LOCK_TIME_MINUTES,
  },
  COOKIE: {
    DOMAIN: envVars.COOKIE_DOMAIN,
  },
  CORS: {
    ALLOWED_ORIGINS: (envVars.ALLOWED_ORIGINS as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export default config;
