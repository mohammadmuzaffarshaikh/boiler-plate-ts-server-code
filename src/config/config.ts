import dotenv from "dotenv";
import path from "path";
import Joi from "joi";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "../../.env") });

// Define the types for the configuration
interface DatabaseConfig {
  url: string;
}

interface JwtConfig {
  secret: string;
  accessExpirationMinutes: number;
  refreshExpirationMinutes: number;
  resetPasswordExpirationMinutes: number;
  userInviteExpirationMinutes: number;
}

interface SocialLoginConfig {
  google: {
    clientId: string;
  };
}

interface ReCaptchaConfig {
  secret: string;
}

interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  s3Bucket: string;
  region: string;
}

interface CRON {
  tokenCleanup: string; // Add more as needed
}
interface Config {
  env: string;
  port: number;
  siteUrl: string;
  database: DatabaseConfig;
  jwt: JwtConfig;
  socialLogin: SocialLoginConfig;
  reCaptcha: ReCaptchaConfig;
  aws: AwsConfig;
  cron: CRON;
}

// Joi schema for environment variables
const envVarsSchema = Joi.object({
  NODE_ENV: Joi.string().valid("production", "development", "test").required(),
  PORT: Joi.number().default(3000),
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

  GOOGLE_CLIENT_ID: Joi.string().description(
    "Google Client ID for social login"
  ),
  GOOGLE_RECAPTCHA_SECRET: Joi.string().description(
    "Google reCAPTCHA secret key"
  ),
  AWS_ACCESS_KEY_ID: Joi.string().description("Aws access key"),
  AWS_SECRET_ACCESS_KEY: Joi.string().description("Aws secret access key"),
  AWS_S3_BUCKET: Joi.string().description("Aws S3 bucket name"),
  AWS_REGION: Joi.string().description("Aws region"),

  CLEANUP_TOKENS_CRON: Joi.string()
    .description("CRON expression for token cleanup job")
    .default("0 0 * * *"),
}).unknown();

// Validate environment variables
const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: "key" } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

// Export the configuration
const config: Config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  siteUrl: envVars.SITE_URL,
  database: {
    url: `${envVars.DATABASE_URL}`,
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationMinutes: envVars.JWT_REFRESH_EXPIRATION_MINUTES,
    resetPasswordExpirationMinutes:
      envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    userInviteExpirationMinutes: envVars.JWT_INVITE_USER_EXPIRATION_MINUTES,
  },
  socialLogin: {
    google: {
      clientId: envVars.GOOGLE_CLIENT_ID,
    },
  },
  reCaptcha: {
    secret: envVars.GOOGLE_RECAPTCHA_SECRET,
  },
  aws: {
    accessKeyId: envVars.AWS_ACCESS_KEY_ID,
    secretAccessKey: envVars.AWS_SECRET_ACCESS_KEY,
    s3Bucket: envVars.AWS_S3_BUCKET,
    region: envVars.AWS_REGION,
  },
  cron: {
    tokenCleanup: envVars.CLEANUP_TOKENS_CRON,
  }
};

export default config;
