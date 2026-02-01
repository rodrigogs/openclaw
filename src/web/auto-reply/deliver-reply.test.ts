import { describe, it, expect, vi } from "vitest";
import { deliverWebReply } from "./deliver-reply.js";

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("fake"),
    kind: "image",
    contentType: "image/jpeg",
  }),
}));

describe("deliverWebReply", () => {
  const mockMsg = () => ({
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
    from: "123@s.whatsapp.net",
    to: "me",
    id: "msg-id-123",
  });

  const logger = { info: vi.fn(), warn: vi.fn() };

  it("sends single text chunk with quote", async () => {
    const msg = mockMsg();
    await deliverWebReply({
      replyResult: { text: "hello" },
      msg: msg as any,
      maxMediaBytes: 1024,
      textLimit: 1000,
      replyLogger: logger,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("hello", { quote: true });
  });

  it("sends multiple text chunks with quote only on first", async () => {
    const msg = mockMsg();
    // Force chunks by setting small limit and length mode
    await deliverWebReply({
      replyResult: { text: "part1part2" }, // 10 chars
      msg: msg as any,
      maxMediaBytes: 1024,
      textLimit: 5,
      chunkMode: "length",
      replyLogger: logger,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "part1", { quote: true });
    expect(msg.reply).toHaveBeenNthCalledWith(2, "part2", { quote: false });
  });

  it("sends media with quote and remaining text without quote", async () => {
    const msg = mockMsg();

    await deliverWebReply({
      replyResult: {
        text: "caption\nremaining",
        mediaUrl: "http://example.com/image.jpg",
      },
      msg: msg as any,
      maxMediaBytes: 1024,
      textLimit: 10, // allows "caption" (7) and "remaining" (9) fits
      chunkMode: "newline",
      replyLogger: logger,
    });

    // Check if it split correctly
    // If it splits into ["caption", "remaining"]
    // 1. caption -> image
    // 2. remaining -> text reply

    expect(msg.sendMedia).toHaveBeenCalledTimes(1);
    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "caption",
      }),
      { quote: true },
    );

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("remaining");
  });
});
