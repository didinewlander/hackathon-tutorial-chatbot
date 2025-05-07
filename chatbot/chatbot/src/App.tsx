import React, { useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type RateLimitInfo = {
  limit: number;
  remaining: number;
  reset: Date | null;
  isLimited: boolean;
};

// Type for the response data from our streaming endpoint
type StreamResponse = {
  content?: string;
  finish_reason?: string;
  error?: string;
  done?: boolean;
};

const ChatBot: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo>({
    limit: 1,
    remaining: 1,
    reset: null,
    isLimited: false
  });
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Function to check if we're rate limited
  const isRateLimited = () => {
    return rateLimit.isLimited || rateLimit.remaining <= 0;
  };

  // Calculate time remaining until rate limit reset
  const getTimeUntilReset = () => {
    if (!rateLimit.reset) return null;
    const now = new Date();
    const resetTime = new Date(rateLimit.reset);
    const diffMs = resetTime.getTime() - now.getTime();
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0; // Return seconds
  };

  // Scroll to bottom of chat when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send message function
  const sendMessage = async () => {
    if (!input.trim() || isTyping || isRateLimited()) return;

    const userMessage: ChatMessage = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    
    // Add temporary assistant message
    setMessages([...updatedMessages, { role: "assistant", content: "" }]);
    setInput("");
    setIsTyping(true);
    setError(null);

    try {
      const response = await fetch("http://localhost:3001/chat-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      // Handle rate limit headers
      const limit = response.headers.get("x-ratelimit-limit");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");

      setRateLimit({
        limit: Number(limit) || 0,
        remaining: Number(remaining) || 0,
        reset: reset ? new Date(reset) : null,
        isLimited: response.status === 429
      });

      // If we got a 429 Too Many Requests
      if (response.status === 429) {
        const rateLimitData = await response.json();
        setError(`Rate limited: ${rateLimitData.error}. Try again later.`);
        // Remove the temporary assistant message
        setMessages(updatedMessages);
        setIsTyping(false);
        return;
      }

      // Handle other errors
      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response reader");
      }

      const decoder = new TextDecoder("utf-8");
      let assistantMessage = "";
      let responseFinished = false;

      while (!responseFinished) {
        const { value, done } = await reader.read();
        if (done) {
          responseFinished = true;
          break;
        }

        const chunk = decoder.decode(value);
        // Split by double newlines, which is how SSE data is formatted
        const lines = chunk.split("\n\n").filter(line => line.startsWith("data: "));
        
        for (const line of lines) {
          try {
            const rawData = line.replace(/^data: /, "");
            // Parse the JSON data
            const data: StreamResponse = JSON.parse(rawData);
            
            // Handle content
            if (data.content) {
              assistantMessage += data.content;
              setMessages(prev => [
                ...prev.slice(0, -1),
                { role: "assistant", content: assistantMessage }
              ]);
            }
            
            // Handle completion
            if (data.finish_reason || data.done) {
              responseFinished = true;
            }
            
            // Handle errors
            if (data.error) {
              setError(`Error: ${data.error}`);
              responseFinished = true;
            }
          } catch (e) {
            // Handle parsing errors
            console.error("Failed to parse server message:", line, e);
          }
        }
      }
    } catch (err) {
      console.error("Error sending message:", err);
      setError(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      // Remove the temporary assistant message if there was an error
      setMessages(updatedMessages);
    } finally {
      setIsTyping(false);
    }
  };

  // Format the countdown timer
  const formatCountdown = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-4">
      <div className="flex-grow overflow-auto mb-4 p-4 border rounded-lg">
        {messages.map((message, i) => (
          <div 
            key={i}
            className={`mb-4 p-3 rounded-lg ${
              message.role === "user" ? "bg-blue-50 ml-8" : "bg-gray-50 mr-8"
            }`}
          >
            <div className="font-bold mb-1">
              {message.role === "user" ? "You" : "Assistant"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
          </div>
        ))}
        {isTyping && (
          <div className="mb-4 p-3 rounded-lg bg-gray-50 mr-8">
            <div className="font-bold mb-1">Assistant</div>
            <div className="animate-pulse">typing...</div>
          </div>
        )}
        {error && (
          <div className="p-3 my-2 bg-red-100 text-red-700 rounded-lg">
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t pt-4">
        {rateLimit.reset && rateLimit.remaining <= 0 && (
          <div className="text-sm text-amber-600 mb-2">
            Rate limited. Reset in {formatCountdown(getTimeUntilReset() || 0)}
          </div>
        )}
        
        <div className="text-xs text-gray-500 mb-2">
          Messages left: {rateLimit.remaining} / {rateLimit.limit}
          {rateLimit.reset && (
            <> · Resets at {rateLimit.reset.toLocaleTimeString()}</>
          )}
        </div>

        <div className="flex">
          <input
            className="flex-grow border rounded-l-lg p-2"
            value={input}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setInput(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Type a message..."
            disabled={isTyping || isRateLimited()}
          />
          <button
            className={`px-4 py-2 rounded-r-lg ${
              isTyping || isRateLimited() || !input.trim()
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-blue-500 hover:bg-blue-600 text-white"
            }`}
            onClick={sendMessage}
            disabled={isTyping || isRateLimited() || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatBot;