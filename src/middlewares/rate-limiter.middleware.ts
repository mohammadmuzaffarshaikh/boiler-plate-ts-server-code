import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";

const authLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
});

export { authLimiter };
