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
  verifyEmailExpirationMinutes: number;
  userInviteExpirationMinutes: number;
}

interface SocialLoginConfig {
  google: {
    clientId: string;
  };
  facebook: {
    clientId: string;
  };
}

interface ReCaptchaConfig {
  secret: string;
}

interface EmailConfig {
  provider: string;
  key: string;
  smtp: {
    host: string;
    port: number;
    auth: {
      user: string;
      pass: string;
    };
  };
  from: string;
}

interface Config {
  env: string;
  port: number;
  siteUrl: string;
  database: DatabaseConfig;
  jwt: JwtConfig;
  socialLogin: SocialLoginConfig;
  reCaptcha: ReCaptchaConfig;
  email: EmailConfig;
}

// Joi schema for environment variables
const envVarsSchema = Joi.object({
  NODE_ENV: Joi.string().valid("production", "development", "test").required(),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required().description("DB url"),
  JWT_SECRET: Joi.string().required().description("JWT secret key"),
  JWT_ACCESS_EXPIRATION_MINUTES: Joi.number()
    .default(30)
    .description("minutes after which access tokens expire"),
  JWT_REFRESH_EXPIRATION_MINUTES: Joi.number()
    .default(1770)
    .description("minutes after which refresh token expire"),
  JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
    .default(10)
    .description("minutes after which reset password token expires"),
  JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
    .default(10)
    .description("minutes after which verify email token expires"),
  GOOGLE_CLIENT_ID: Joi.string().description(
    "Google Client ID for social login"
  ),
  FACEBOOK_APP_ID: Joi.string().description("Facebook App ID for social login"),
  GOOGLE_RECAPTCHA_SECRET: Joi.string().description(
    "Google reCAPTCHA secret key"
  ),
  EMAIL_PROVIDER: Joi.string().description(
    "Email provider (sendgrid, aws, nodemailer)"
  ),
  EMAIL_PROVIDER_KEY: Joi.string().description(
    "Key for email provider (sendgrid, aws)"
  ),
  SMTP_HOST: Joi.string().description("SMTP server host"),
  SMTP_PORT: Joi.number().description("SMTP server port"),
  SMTP_USERNAME: Joi.string().description("SMTP username"),
  SMTP_PASSWORD: Joi.string().description("SMTP password"),
  EMAIL_FROM: Joi.string().description('The "from" email address'),
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
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
    userInviteExpirationMinutes: envVars.JWT_INVITE_USER_EXPIRATION_MINUTES,
  },
  socialLogin: {
    google: {
      clientId: envVars.GOOGLE_CLIENT_ID,
    },
    facebook: {
      clientId: envVars.FACEBOOK_APP_ID,
    },
  },
  reCaptcha: {
    secret: envVars.GOOGLE_RECAPTCHA_SECRET,
  },
  email: {
    provider: envVars.EMAIL_PROVIDER,
    key: envVars.EMAIL_PROVIDER_KEY,
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
  },
};

export default config;
