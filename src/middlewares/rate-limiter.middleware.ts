import rateLimit from "express-rate-limit";

// Define the authLimiter with rate limit settings
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes in milliseconds
  max: 20, // Maximum number of requests
  skipSuccessfulRequests: true, // Skip counting for successful requests
});

// Define more rate-limiter here.

export { authLimiter };
