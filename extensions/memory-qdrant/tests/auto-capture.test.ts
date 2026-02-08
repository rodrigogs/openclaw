/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { shouldCapture, detectCategory } from "../index.ts";

describe("shouldCapture", () => {
  describe("should capture", () => {
    it("explicit memory requests in English", () => {
      expect(shouldCapture("Remember that I prefer dark mode")).toBe(true);
      expect(shouldCapture("Remind me that my login is foo")).toBe(true);
      expect(shouldCapture("Don't forget: my birthday is May 10")).toBe(true);
      expect(shouldCapture("Please remember that I like tea")).toBe(true);
      expect(shouldCapture("Note this: I live in Porto Alegre")).toBe(true);
      expect(shouldCapture("Save this: my email is test@example.com")).toBe(true);
    });

    it("explicit memory requests in Portuguese", () => {
      expect(shouldCapture("Lembra que eu prefiro café sem açúcar")).toBe(true);
      expect(shouldCapture("Salva isso: meu email é teste@email.com")).toBe(true);
      expect(shouldCapture("Não esquece: meu aniversário é 25 de março")).toBe(true);
      expect(shouldCapture("Nao esquecer: meu endereço é Rua X")).toBe(true);
      expect(shouldCapture("Memoriza que tenho 3 gatos")).toBe(true);
      expect(shouldCapture("Por favor lembra que prefiro reuniões à tarde")).toBe(true);
    });

    it("preferences in English", () => {
      expect(shouldCapture("I like using TypeScript for new projects")).toBe(true);
      expect(shouldCapture("I prefer vim over emacs")).toBe(true);
      expect(shouldCapture("I hate meetings before 10am")).toBe(true);
    });

    it("preferences in Portuguese", () => {
      expect(shouldCapture("Eu prefiro trabalhar de manhã")).toBe(true);
      expect(shouldCapture("Não gosto de reuniões longas")).toBe(true);
      expect(shouldCapture("Adoro café expresso")).toBe(true);
    });

    it("decisions", () => {
      expect(shouldCapture("We decided to use PostgreSQL")).toBe(true);
      expect(shouldCapture("Decidimos usar o framework Next.js")).toBe(true);
      expect(shouldCapture("I chose Python for this project")).toBe(true);
    });

    it("phone numbers", () => {
      expect(shouldCapture("My phone number is +5511999887766")).toBe(true);
      expect(shouldCapture("Call me at +14155551234")).toBe(true);
    });

    it("email addresses", () => {
      expect(shouldCapture("My email is john.doe@company.com")).toBe(true);
      expect(shouldCapture("Contact me at support@example.org")).toBe(true);
    });

    it("identity statements", () => {
      expect(shouldCapture("My name is John Smith")).toBe(true);
      expect(shouldCapture("Meu nome é Maria Silva")).toBe(true);
      expect(shouldCapture("Me chamo Pedro Santos")).toBe(true);
    });

    it("facts with possessives", () => {
      expect(shouldCapture("My timezone is America/Sao_Paulo")).toBe(true);
      expect(shouldCapture("Meu fuso horário é GMT-3")).toBe(true);
    });

    it("important qualifiers", () => {
      expect(shouldCapture("This is always important to remember")).toBe(true);
      expect(shouldCapture("Never deploy on Fridays")).toBe(true);
      expect(shouldCapture("Isso é crucial para o projeto")).toBe(true);
    });
  });

  describe("should NOT capture", () => {
    it("very short text", () => {
      expect(shouldCapture("ok")).toBe(false);
      expect(shouldCapture("sure")).toBe(false);
      expect(shouldCapture("hi there")).toBe(false);
    });

    it("very long text", () => {
      const longText = "a".repeat(550);
      expect(shouldCapture(longText)).toBe(false);
    });

    it("questions", () => {
      expect(shouldCapture("What do you prefer?")).toBe(false);
      expect(shouldCapture("Do you like coffee?")).toBe(false);
    });

    it("agent confirmations", () => {
      expect(shouldCapture("Pronto!")).toBe(false);
      expect(shouldCapture("Done!")).toBe(false);
      expect(shouldCapture("Entendi, vou fazer isso")).toBe(false);
    });

    it("XML/tool output", () => {
      expect(shouldCapture("<tool>result</tool>")).toBe(false);
    });

    it("code blocks", () => {
      expect(shouldCapture("```typescript\nconst x = 1;\n```")).toBe(false);
    });

    it("multiple code blocks (non-greedy regex)", () => {
      const multiBlock = "```js\ncode1\n```\nI prefer dark mode\n```js\ncode2\n```";
      expect(shouldCapture(multiBlock)).toBe(false);
      expect(shouldCapture("I prefer dark mode")).toBe(true);
    });

    it("markdown lists", () => {
      expect(shouldCapture("- Item 1\n- Item 2")).toBe(false);
      expect(shouldCapture("* First\n* Second")).toBe(false);
    });

    it("already injected memories", () => {
      expect(shouldCapture("I prefer <relevant-memories>test</relevant-memories> this")).toBe(
        false,
      );
    });

    it("emoji-heavy content", () => {
      expect(shouldCapture("🎉🎉🎉🎉 Great job!")).toBe(false);
    });
  });
});

describe("detectCategory", () => {
  it("detects preferences", () => {
    expect(detectCategory("I prefer dark mode")).toBe("preference");
    expect(detectCategory("Eu prefiro café")).toBe("preference");
    expect(detectCategory("I love TypeScript")).toBe("preference");
    expect(detectCategory("I hate bugs")).toBe("preference");
  });

  it("detects projects", () => {
    expect(detectCategory("We decided to use React")).toBe("project");
    expect(detectCategory("Decidimos usar PostgreSQL")).toBe("project");
    expect(detectCategory("I chose this framework")).toBe("project");
    expect(detectCategory("Projeto de memória local")).toBe("project");
  });

  it("detects personal", () => {
    expect(detectCategory("My phone is +5511999887766")).toBe("personal");
    expect(detectCategory("Email: test@example.com")).toBe("personal");
    expect(detectCategory("My name is John")).toBe("personal");
    expect(detectCategory("Me chamo Maria")).toBe("personal");
    expect(detectCategory("Eu moro em Porto Alegre")).toBe("personal");
  });

  it("returns other for unclassified", () => {
    expect(detectCategory("Random unclassified text")).toBe("other");
  });
});

describe("Additional shouldCapture edge cases", () => {
  it("returns false for text not matching any pattern", () => {
    const result = shouldCapture("Just some plain text without patterns");
    expect(result).toBe(false);
  });

  it("rejects emoji-heavy content", () => {
    const emojiText = "🎉🎊✨🌟 Remember this! 🚀🔥💯🎯";
    expect(shouldCapture(emojiText)).toBe(false);
  });
});
