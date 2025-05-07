const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 1, // 1 request per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // Get milliseconds until reset
    const remainingMs = req.rateLimit.resetTime - Date.now();

    res.status(429).json({
      error: "Too many requests",
      limit: req.rateLimit.limit,
      remaining: req.rateLimit.remaining,
      resetTime: new Date(req.rateLimit.resetTime).toISOString(),
      retryAfterMs: remainingMs > 0 ? remainingMs : 60000, // Default to 1 minute if calculation fails
    });
  },
});

// Initialize OpenAI with API key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat-stream", chatLimiter, async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid messages format" });
  }

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Add rate limit headers
  if (req.rateLimit) {
    res.setHeader("X-RateLimit-Limit", req.rateLimit.limit);
    res.setHeader("X-RateLimit-Remaining", req.rateLimit.remaining);
    if (req.rateLimit.resetTime) {
      res.setHeader(
        "X-RateLimit-Reset",
        new Date(req.rateLimit.resetTime).toISOString()
      );
    }
  }

  // Ensure the connection stays alive
  res.flushHeaders();

  // Handle client disconnect
  const onClientDisconnect = () => {
    console.log("Client disconnected");
    res.end();
  };
  req.on("close", onClientDisconnect);

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      // Check if client is still connected
      if (res.writableEnded || !res.writable) {
        break;
      }

      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }

      // Handle completion
      if (chunk.choices?.[0]?.finish_reason) {
        const finishReason = chunk.choices[0].finish_reason;
        res.write(
          `data: ${JSON.stringify({ finish_reason: finishReason })}\n\n`
        );
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("OpenAI API Error:", err);

    // Only send error if client is still connected
    if (res.writable && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ error: err.message || "Unknown error" })}\n\n`
      );
      res.end();
    }
  } finally {
    // Clean up event listener
    req.removeListener("close", onClientDisconnect);
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Add this endpoint to your server.js file

// Create a separate limiter for the status endpoint with a higher limit
const statusLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Allow more frequent status checks
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit status endpoint
app.get("/rate-limit-status", statusLimiter, (req, res) => {
  // Get the rate limit store for the chat endpoint
  const chatLimiterStore = chatLimiter.store;

  // Get the current IP address or identifier
  const identifier = req.ip;

  // Get the current hits for this user from the store
  chatLimiterStore.get(identifier, (err, hitCount) => {
    if (err) {
      console.error("Error getting rate limit data:", err);
      return res
        .status(500)
        .json({ error: "Failed to retrieve rate limit status" });
    }

    // If no hits found, the user is not rate limited
    if (!hitCount) {
      return res.status(200).json({
        isRateLimited: false,
        limit: chatLimiter.options.max,
        remaining: chatLimiter.options.max,
        resetTime: new Date(
          Date.now() + chatLimiter.options.windowMs
        ).toISOString(),
      });
    }

    // Calculate remaining requests
    const remaining = Math.max(0, chatLimiter.options.max - hitCount.totalHits);

    res.status(200).json({
      isRateLimited: remaining <= 0,
      limit: chatLimiter.options.max,
      remaining: remaining,
      resetTime: new Date(hitCount.resetTime).toISOString(),
    });
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
